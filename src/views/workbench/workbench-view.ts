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

/** 网格单位（像素）：卡片位置与尺寸均吸附到该值的整数倍 */
const GRID = 30;
/** 卡片默认宽高（像素，均为 GRID 的整数倍） */
const DEFAULT_W = 300;
const DEFAULT_H = 240;
/** 卡片最小宽高（像素，均为 GRID 的整数倍） */
const MIN_W = 180;
const MIN_H = 120;
/** 自动排布时每行放置的卡片数 */
const CARDS_PER_ROW = 3;

/** 吸附到网格：四舍五入到 GRID 的整数倍 */
function snap(v: number): number {
    return Math.round(v / GRID) * GRID;
}

/** 向上取整到 GRID 的整数倍（用于调整尺寸结束时的最终尺寸） */
function snapUp(v: number): number {
    return Math.ceil(v / GRID) * GRID;
}

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

        // 卡片画布（绝对定位 + 30px 网格）
        const grid = container.createDiv({ cls: 'wb-grid' });

        if (this.workbenchData.instances.length === 0) {
            grid.createDiv({ cls: 'wb-empty', text: t('workbench.empty') });
            return;
        }

        // 计算每张卡片的网格坐标（未定位的按顺序自动排布），并写回实例，保证坐标持久一致
        const positions = this.computePositions();
        for (const instance of this.workbenchData.instances) {
            const pos = positions.get(instance.id);
            if (pos) {
                instance.col = pos.col;
                instance.row = pos.row;
            }
        }

        for (const instance of this.workbenchData.instances) {
            const template = this.templates.find((t) => t.id === instance.templateId);
            if (!template) continue;

            const card = grid.createDiv({ cls: 'wb-card' });
            // 网格坐标定位（单位 30px）
            const pos = positions.get(instance.id);
            if (pos) {
                card.style.setProperty('left', `${pos.col * GRID}px`);
                card.style.setProperty('top', `${pos.row * GRID}px`);
            }
            // 应用尺寸（吸附到 30px 网格）
            const w = snap(instance.width ?? DEFAULT_W);
            const h = snap(instance.height ?? DEFAULT_H);
            card.style.setProperty('width', `${w}px`);
            card.style.setProperty('height', `${h}px`);

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
                    this.attachCardDrag(titleEl, card, instance);
                }
            }
        }

        // 根据卡片最大底部/右侧位置设置画布尺寸，避免绝对定位卡片溢出被裁剪
        let maxBottom = 0;
        let maxRight = 0;
        for (const instance of this.workbenchData.instances) {
            const pos = positions.get(instance.id);
            if (!pos) continue;
            const w = snap(instance.width ?? DEFAULT_W);
            const h = snap(instance.height ?? DEFAULT_H);
            const bottom = pos.row * GRID + h;
            const right = pos.col * GRID + w;
            if (bottom > maxBottom) maxBottom = bottom;
            if (right > maxRight) maxRight = right;
        }
        grid.style.setProperty('min-height', `${Math.max(300, maxBottom + GRID)}px`);
        grid.style.setProperty('min-width', `${maxRight + GRID}px`);
    }

    /**
     * 计算每张卡片的网格坐标（单位 30px）。
     * 已设置 col/row 的卡片使用其坐标；未设置的按 instances 顺序自动排布：
     * 从左到右、从上到下，每行放 CARDS_PER_ROW 张，卡片占默认尺寸（10×8 格）。
     * 返回 instance.id → { col, row } 映射。
     */
    private computePositions(): Map<string, { col: number; row: number }> {
        const result = new Map<string, { col: number; row: number }>();
        const occupied = new Set<string>();
        const key = (c: number, r: number) => `${c},${r}`;

        // 卡片占用的网格格数（默认尺寸）
        const cardCols = DEFAULT_W / GRID;
        const cardRows = DEFAULT_H / GRID;

        // 先登记已显式定位的卡片（占用其覆盖的所有网格格）
        for (const inst of this.workbenchData.instances) {
            if (inst.col !== undefined && inst.row !== undefined) {
                result.set(inst.id, { col: inst.col, row: inst.row });
                for (let r = 0; r < cardRows; r++) {
                    for (let c = 0; c < cardCols; c++) {
                        occupied.add(key(inst.col + c, inst.row + r));
                    }
                }
            }
        }

        // 未定位的卡片：按顺序找第一个空位（行优先，每行 CARDS_PER_ROW 张）
        let cursor = 0;
        for (const inst of this.workbenchData.instances) {
            if (result.has(inst.id)) continue;
            while (true) {
                const col = (cursor % CARDS_PER_ROW) * cardCols;
                const row = Math.floor(cursor / CARDS_PER_ROW) * cardRows;
                // 检查该槽位是否被占用
                let free = true;
                for (let r = 0; r < cardRows && free; r++) {
                    for (let c = 0; c < cardCols && free; c++) {
                        if (occupied.has(key(col + c, row + r))) free = false;
                    }
                }
                if (free) break;
                cursor++;
            }
            const col = (cursor % CARDS_PER_ROW) * cardCols;
            const row = Math.floor(cursor / CARDS_PER_ROW) * cardRows;
            result.set(inst.id, { col, row });
            for (let r = 0; r < cardRows; r++) {
                for (let c = 0; c < cardCols; c++) {
                    occupied.add(key(col + c, row + r));
                }
            }
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
     * 绑定尺寸调整：按住手柄/边框拖动，按方向调整卡片宽高（吸附 30px 网格）。
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
                if (dir.includes('e')) w = Math.max(MIN_W, startW + dx);
                if (dir.includes('w')) w = Math.max(MIN_W, startW - dx);
                if (dir.includes('s')) h = Math.max(MIN_H, startH + dy);
                if (dir.includes('n')) h = Math.max(MIN_H, startH - dy);
                // 拖动过程中连续变化，不吸附网格
                card.style.setProperty('width', `${w}px`);
                card.style.setProperty('height', `${h}px`);
            };

            const onUp = (ev: MouseEvent) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                let w = startW;
                let h = startH;
                if (dir.includes('e')) w = Math.max(MIN_W, startW + dx);
                if (dir.includes('w')) w = Math.max(MIN_W, startW - dx);
                if (dir.includes('s')) h = Math.max(MIN_H, startH + dy);
                if (dir.includes('n')) h = Math.max(MIN_H, startH - dy);
                // 松开时向上取整到 30 的倍数
                instance.width = snapUp(w);
                instance.height = snapUp(h);
                // 调整尺寸后做碰撞避让
                this.resolveCollisions();
                void this.save().then(() => {
                    if (this.container) void this.renderInto(this.container);
                });
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
    }

    /**
     * 绑定卡片位置拖动：按住标题拖动整张卡片，落点吸附 30px 网格并做碰撞避让。
     */
    private attachCardDrag(
        titleEl: HTMLElement,
        card: HTMLElement,
        instance: CardInstance,
    ) {
        titleEl.onmousedown = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            card.addClass('is-dragging');
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = card.offsetLeft;
            const startTop = card.offsetTop;
            // 画布宽度（卡片父容器），用于限制左右边界
            const gridWidth = card.parentElement?.clientWidth ?? 0;
            const cardW = card.offsetWidth;

            // 将 left 限制在 [0, gridWidth - cardW] 范围内
            const clampLeft = (raw: number) => {
                const maxLeft = Math.max(0, gridWidth - cardW);
                return Math.max(0, Math.min(raw, maxLeft));
            };

            const onMove = (ev: MouseEvent) => {
                // 跟随鼠标位移，吸附到 30px 网格；限制不超出画布顶部/左右边界
                const left = clampLeft(snap(startLeft + (ev.clientX - startX)));
                const top = Math.max(0, snap(startTop + (ev.clientY - startY)));
                card.style.setProperty('left', `${left}px`);
                card.style.setProperty('top', `${top}px`);
            };

            const onUp = (ev: MouseEvent) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                card.removeClass('is-dragging');

                // 落点吸附网格，写回实例坐标；超出左右边界时贴边
                const left = clampLeft(snap(startLeft + (ev.clientX - startX)));
                const top = Math.max(0, snap(startTop + (ev.clientY - startY)));
                instance.col = Math.round(left / GRID);
                instance.row = Math.round(top / GRID);
                // 拖动后做碰撞避让
                this.resolveCollisions();
                void this.save().then(() => {
                    if (this.container) void this.renderInto(this.container);
                });
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
    }

    /**
     * 碰撞避让：检测所有卡片间的矩形重叠。
     * 重叠时，位于下方的卡片向下移动（row 增加）直到不重叠；
     * 其下方所有卡片连锁向下移动，直到整体无重叠。
     */
    private resolveCollisions() {
        const rectOf = (inst: CardInstance) => {
            const col = inst.col ?? 0;
            const row = inst.row ?? 0;
            const w = snap(inst.width ?? DEFAULT_W);
            const h = snap(inst.height ?? DEFAULT_H);
            return { col, row, w, h };
        };

        const items = this.workbenchData.instances.map((inst) => ({
            inst,
            rect: rectOf(inst),
        }));

        const overlaps = (a: { col: number; row: number; w: number; h: number }, b: { col: number; row: number; w: number; h: number }) =>
            a.col * GRID < b.col * GRID + b.w &&
            a.col * GRID + a.w > b.col * GRID &&
            a.row * GRID < b.row * GRID + b.h &&
            a.row * GRID + a.h > b.row * GRID;

        // 迭代处理：反复检测所有卡片对的重叠，直到无重叠（上限防止死循环）
        const maxIter = this.workbenchData.instances.length * 4;
        for (let iter = 0; iter < maxIter; iter++) {
            let changed = false;
            // 按行坐标升序，保证「上方卡片」先处理
            items.sort((a, b) => a.rect.row - b.rect.row);
            for (let i = 0; i < items.length; i++) {
                for (let j = i + 1; j < items.length; j++) {
                    const upper = items[i];
                    const lower = items[j];
                    if (overlaps(upper.rect, lower.rect)) {
                        // 下方卡片向下移动到上方卡片底部
                        const newRow = Math.round((upper.rect.row * GRID + upper.rect.h) / GRID);
                        if (newRow > lower.rect.row) {
                            lower.inst.row = newRow;
                            lower.rect.row = newRow;
                            changed = true;
                        }
                    }
                }
            }
            if (!changed) break;
        }
    }
}
