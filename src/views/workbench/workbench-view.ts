// 工作台视图：卡片集合容器，负责加载模板、渲染卡片、管理卡片实例。
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type { CardTemplate } from '../../datatypes/form';
import type { CardInstance, WorkbenchData } from '../../datatypes/card';
import { ensureDefaultLayout } from '../../datatypes/card';
import { loadAllTemplates } from '../../cardmake/data/template-loader';
import { getCardRenderer } from '../../cardmake/cards/card-registry';
import type { CardRenderContext } from '../../datatypes/renderer';
import { createDataProvider } from '../../cardmake/data/provider';
import type { EventBlock, ExecutionRecord } from '../../datatypes/domain';
import type { InboxItem } from '../../datatypes/domain';
import { t } from '../../i18n';
import { LayoutModal } from './layout-modal';

/** 网格列数（卡片按列/行坐标定位） */
const GRID_COLS = 4;
/** 卡片最小宽高（像素） */
const MIN_CARD_W = 200;
const MIN_CARD_H = 120;

/**
 * 工作台视图：与 YearView / TodayView 一致，通过 renderInto 渲染到指定容器。
 * 持有工作台数据引用 + 保存回调 + 数据访问回调（供 stats 卡片统计）。
 */
export class WorkbenchView {
    private app: App;
    private workbenchData: WorkbenchData;
    private save: () => Promise<void>;
    /** 获取全部事件（stats 统计用） */
    private getEvents: () => EventBlock[];
    /** 获取全部执行记录（stats 统计用） */
    private getExecutions: () => ExecutionRecord[];
    /** 获取收集盒任务（stats 统计用） */
    private getInboxItems: () => InboxItem[];
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 已加载的模板列表 */
    private templates: CardTemplate[] = [];
    /** 是否处于「编辑布局」状态（控制添加卡片按钮显隐） */
    private editingLayout = false;
    /** 进入编辑布局时的卡片快照（用于取消时还原） */
    private editSnapshot: CardInstance[] | null = null;

    constructor(
        app: App,
        workbenchData: WorkbenchData,
        save: () => Promise<void>,
        getEvents: () => EventBlock[],
        getExecutions: () => ExecutionRecord[],
        getInboxItems: () => InboxItem[],
    ) {
        this.app = app;
        this.workbenchData = workbenchData;
        this.save = save;
        this.getEvents = getEvents;
        this.getExecutions = getExecutions;
        this.getInboxItems = getInboxItems;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('workbench-view');

        // 确保默认布局存在，且始终对应当前工作台展示的内容
        ensureDefaultLayout(this.workbenchData, t('layout.defaultName'));

        // 加载模板（首次或缓存失效时）
        if (this.templates.length === 0) {
            this.templates = await loadAllTemplates();
        }

        // 顶部工具栏：标题 + 编辑布局按钮 + 添加卡片按钮（仅编辑态显示）+ 布局方案按钮
        const toolbar = container.createDiv({ cls: 'wb-toolbar' });
        toolbar.createDiv({ cls: 'wb-toolbar-title', text: t('workbench.title') });
        const actions = toolbar.createDiv({ cls: 'wb-toolbar-actions' });

        // 添加卡片按钮：仅编辑态显示
        if (this.editingLayout) {
            const addBtn = actions.createEl('button', {
                cls: 'wb-add-btn',
                text: t('workbench.addCard'),
            });
            addBtn.onclick = () => this.showAddCardMenu(addBtn);

            // 保存按钮：退出编辑态并持久化
            const saveBtn = actions.createEl('button', {
                cls: 'wb-save-btn',
                text: t('workbench.saveLayout'),
            });
            saveBtn.onclick = () => {
                this.editingLayout = false;
                this.editSnapshot = null;
                void this.save().then(() => {
                    if (this.container) void this.renderInto(this.container);
                });
            };

            // 取消按钮：还原到进入编辑态前的快照
            const cancelBtn = actions.createEl('button', {
                cls: 'wb-cancel-btn',
                text: t('workbench.cancelLayout'),
            });
            cancelBtn.onclick = () => {
                if (this.editSnapshot) {
                    this.workbenchData.instances = this.editSnapshot.map((i) => ({ ...i }));
                }
                this.editingLayout = false;
                this.editSnapshot = null;
                void this.renderInto(container);
            };
        }

        // 编辑布局按钮：切换编辑态（编辑态下显示为「编辑中」，位于添加/保存/取消之后）
        const editBtn = actions.createEl('button', {
            cls: 'wb-edit-layout-btn',
            text: this.editingLayout ? t('workbench.editLayoutActive') : t('workbench.editLayout'),
        });
        editBtn.toggleClass('is-active', this.editingLayout);
        editBtn.onclick = () => {
            this.editingLayout = !this.editingLayout;
            // 进入编辑态时记录快照，退出时清空
            this.editSnapshot = this.editingLayout
                ? this.workbenchData.instances.map((i) => ({ ...i }))
                : null;
            void this.renderInto(container);
        };

        const layoutBtn = actions.createEl('button', {
            cls: 'wb-layout-btn',
            text: t('workbench.layoutScheme'),
        });
        layoutBtn.onclick = () => new LayoutModal(this.app, this.workbenchData).open();

        // 卡片网格
        const grid = container.createDiv({ cls: 'wb-grid' });
        grid.setCssProps({ '--wb-grid-cols': String(GRID_COLS) });

        if (this.workbenchData.instances.length === 0) {
            grid.createDiv({ cls: 'wb-empty', text: t('workbench.empty') });
            return;
        }

        // 计算每张卡片的网格坐标（未定位的按顺序自动排布）
        const positions = this.computePositions();

        for (const instance of this.workbenchData.instances) {
            const template = this.templates.find((t) => t.id === instance.templateId);
            if (!template) continue;

            const card = grid.createDiv({ cls: 'wb-card' });
            // 网格坐标定位
            const pos = positions.get(instance.id);
            if (pos) {
                card.style.setProperty('grid-column', `${pos.col + 1}`);
                card.style.setProperty('grid-row', `${pos.row + 1}`);
            }
            // 应用自定义尺寸（编辑布局时拖拽调整过）
            if (instance.width) card.setCssProps({ '--wb-card-width': `${instance.width}px` });
            if (instance.height) card.setCssProps({ '--wb-card-height': `${instance.height}px` });
            if (instance.width || instance.height) card.addClass('has-custom-size');

            // 卡片头部操作（删除）：仅编辑布局时显示删除按钮
            if (this.editingLayout) {
                card.addClass('is-editing');
                const header = card.createDiv({ cls: 'wb-card-header' });
                const delBtn = header.createEl('button', {
                    cls: 'wb-card-delete',
                    text: '×',
                });
                delBtn.onclick = () => this.removeCard(instance);

                // 编辑态：边框 + 四角圆点（八方向调整尺寸）
                this.renderResizeHandles(card, instance);
            }

            const body = card.createDiv({ cls: 'wb-card-content' });
            const renderer = getCardRenderer(instance.mode);
            const ctx: CardRenderContext = {
                app: this.app,
                save: this.save,
                refresh: () => void this.renderInto(container),
                provider: createDataProvider(this.getEvents, this.getExecutions, this.getInboxItems),
            };
            renderer.render(body, instance, template, ctx);

            // 编辑态：标题可按住拖动整张卡片位置
            if (this.editingLayout) {
                const titleEl = card.querySelector<HTMLElement>('.wb-card-title');
                if (titleEl) {
                    titleEl.addClass('is-draggable');
                    this.attachCardDrag(titleEl, card, instance, grid);
                }
            }
        }
    }

    /**
     * 计算每张卡片的网格坐标。
     * 已设置 col/row 的卡片使用其坐标；未设置的按 instances 顺序自动排布到第一个空位。
     * 返回 instance.id → { col, row } 映射。
     */
    private computePositions(): Map<string, { col: number; row: number }> {
        const result = new Map<string, { col: number; row: number }>();
        const occupied = new Set<string>();
        const key = (c: number, r: number) => `${c},${r}`;

        // 先登记已显式定位的卡片
        for (const inst of this.workbenchData.instances) {
            if (inst.col !== undefined && inst.row !== undefined) {
                result.set(inst.id, { col: inst.col, row: inst.row });
                occupied.add(key(inst.col, inst.row));
            }
        }

        // 未定位的卡片：按顺序找第一个空位
        let cursor = 0;
        for (const inst of this.workbenchData.instances) {
            if (result.has(inst.id)) continue;
            while (occupied.has(key(cursor % GRID_COLS, Math.floor(cursor / GRID_COLS)))) {
                cursor++;
            }
            const col = cursor % GRID_COLS;
            const row = Math.floor(cursor / GRID_COLS);
            result.set(inst.id, { col, row });
            occupied.add(key(col, row));
            cursor++;
        }
        return result;
    }

    /** 弹出添加卡片菜单：列出所有模板供选择 */
    private showAddCardMenu(anchor: HTMLElement) {
        const menu = anchor.createDiv({ cls: 'wb-add-menu' });
        for (const tpl of this.templates) {
            const item = menu.createDiv({ cls: 'wb-add-menu-item', text: tpl.name });
            item.onclick = () => {
                this.addCard(tpl);
                menu.remove();
            };
        }
        // 点击外部关闭
        const close = (e: MouseEvent) => {
            if (!menu.contains(e.target as Node)) {
                menu.remove();
                document.removeEventListener('click', close);
            }
        };
        window.setTimeout(() => document.addEventListener('click', close), 0);
    }

    /** 添加一张卡片实例 */
    private addCard(template: CardTemplate) {
        const instance: CardInstance = {
            id: crypto.randomUUID(),
            templateId: template.id,
            mode: template.mode,
            title: template.name,
        };
        if (template.mode === 'stats' && template.source) {
            instance.source = template.source;
        }
        this.workbenchData.instances.push(instance);
        void this.save().then(() => {
            new Notice(t('workbench.cardAdded', { name: template.name }));
            if (this.container) void this.renderInto(this.container);
        });
    }

    /** 删除一张卡片实例 */
    private removeCard(instance: CardInstance) {
        this.workbenchData.instances = this.workbenchData.instances.filter(
            (i) => i.id !== instance.id,
        );
        void this.save().then(() => {
            if (this.container) void this.renderInto(this.container);
        });
    }

    /**
     * 渲染编辑态下的尺寸调整手柄：卡片边框 + 四角圆点。
     * 边框与圆点均支持八方向拖动调整卡片宽高，松开后持久化。
     */
    private renderResizeHandles(card: HTMLElement, instance: CardInstance) {
        // 四角圆点：nw / ne / sw / se
        const corners: Array<'nw' | 'ne' | 'sw' | 'se'> = ['nw', 'ne', 'sw', 'se'];
        for (const corner of corners) {
            const dot = card.createDiv({ cls: `wb-card-handle wb-card-handle-${corner}` });
            this.attachResize(dot, card, instance, corner);
        }
        // 四条边：n / s / w / e
        const edges: Array<'n' | 's' | 'w' | 'e'> = ['n', 's', 'w', 'e'];
        for (const edge of edges) {
            const bar = card.createDiv({ cls: `wb-card-edge wb-card-edge-${edge}` });
            this.attachResize(bar, card, instance, edge);
        }
    }

    /**
     * 绑定尺寸调整：按住手柄/边框拖动，按方向调整卡片宽高。
     * dir 为八方向之一（n/s/w/e/nw/ne/sw/se）。
     */
    private attachResize(
        handle: HTMLElement,
        card: HTMLElement,
        instance: CardInstance,
        dir: 'n' | 's' | 'w' | 'e' | 'nw' | 'ne' | 'sw' | 'se',
    ) {
        handle.onmousedown = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            const startX = e.clientX;
            const startY = e.clientY;
            const startW = card.offsetWidth;
            const startH = card.offsetHeight;

            const onMove = (ev: MouseEvent) => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                let w = startW;
                let h = startH;
                if (dir.includes('e')) w = Math.max(MIN_CARD_W, startW + dx);
                if (dir.includes('w')) w = Math.max(MIN_CARD_W, startW - dx);
                if (dir.includes('s')) h = Math.max(MIN_CARD_H, startH + dy);
                if (dir.includes('n')) h = Math.max(MIN_CARD_H, startH - dy);
                card.setCssProps({
                    '--wb-card-width': `${w}px`,
                    '--wb-card-height': `${h}px`,
                });
                card.addClass('has-custom-size');
            };

            const onUp = (ev: MouseEvent) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                let w = startW;
                let h = startH;
                if (dir.includes('e')) w = Math.max(MIN_CARD_W, startW + dx);
                if (dir.includes('w')) w = Math.max(MIN_CARD_W, startW - dx);
                if (dir.includes('s')) h = Math.max(MIN_CARD_H, startH + dy);
                if (dir.includes('n')) h = Math.max(MIN_CARD_H, startH - dy);
                instance.width = Math.round(w);
                instance.height = Math.round(h);
                void this.save();
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
    }

    /**
     * 绑定卡片位置拖动：按住标题拖动整张卡片，落点按网格坐标计算并插入式重排。
     */
    private attachCardDrag(
        titleEl: HTMLElement,
        card: HTMLElement,
        instance: CardInstance,
        grid: HTMLElement,
    ) {
        titleEl.onmousedown = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            card.addClass('is-dragging');
            const startX = e.clientX;
            const startY = e.clientY;

            const onMove = (ev: MouseEvent) => {
                // 跟随鼠标位移，给出拖动反馈
                card.style.setProperty(
                    'transform',
                    `translate(${ev.clientX - startX}px, ${ev.clientY - startY}px)`,
                );
            };

            const onUp = (ev: MouseEvent) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                card.removeClass('is-dragging');
                card.style.removeProperty('transform');

                // 计算落点所在的网格坐标
                const target = this.resolveDropCell(grid, card, ev.clientX, ev.clientY);
                if (target) {
                    this.moveCardTo(instance, target.col, target.row);
                }
                void this.save().then(() => {
                    if (this.container) void this.renderInto(this.container);
                });
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
    }

    /** 根据鼠标位置计算落点网格坐标（相对网格容器） */
    private resolveDropCell(
        grid: HTMLElement,
        card: HTMLElement,
        clientX: number,
        clientY: number,
    ): { col: number; row: number } | null {
        const gridRect = grid.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        // 以鼠标位置作为落点参考
        const relX = clientX - gridRect.left;
        const relY = clientY - gridRect.top;
        const colW = gridRect.width / GRID_COLS;
        const rowH = cardRect.height + 12; // 卡片高度 + gap
        const col = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(relX / colW)));
        const row = Math.max(0, Math.floor(relY / rowH));
        return { col, row };
    }

    /**
     * 将卡片移动到目标网格坐标，并做插入式重排：
     * 目标位置及之后的卡片依次后移，避免重叠与空洞。
     */
    private moveCardTo(instance: CardInstance, col: number, row: number) {
        const positions = this.computePositions();
        const targetIndex = row * GRID_COLS + col;

        // 按当前排布顺序（行优先）排列卡片
        const ordered = this.workbenchData.instances
            .map((inst) => ({ inst, pos: positions.get(inst.id)! }))
            .filter((x) => x.pos)
            .sort((a, b) => (a.pos.row - b.pos.row) || (a.pos.col - b.pos.col));

        const fromIdx = ordered.findIndex((x) => x.inst.id === instance.id);
        if (fromIdx < 0) return;
        const [moved] = ordered.splice(fromIdx, 1);
        const insertIdx = Math.max(0, Math.min(ordered.length, targetIndex));
        ordered.splice(insertIdx, 0, moved);

        // 重新按行优先顺序分配坐标
        ordered.forEach((x, i) => {
            x.inst.col = i % GRID_COLS;
            x.inst.row = Math.floor(i / GRID_COLS);
        });
    }
}
