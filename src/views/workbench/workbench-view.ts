// 工作台视图：卡片集合容器，负责加载模板、渲染卡片、管理卡片实例。
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type { CardTemplate, CardMode } from '../../datatypes/form';
import type { CardInstance, WorkbenchData } from '../../datatypes/card';
import { DEFAULT_LAYOUT_ID } from '../../datatypes/card';
import type { WorkbenchRepo } from '../../repos/workbench-repo';
import type { GtdRepo } from '../../repos/gtd-repo';
import { loadAllTemplates } from '../../cardmake/engine/template-loader';
import type { EventBlock, ExecutionRecord } from '../../datatypes/domain';
import type { InboxItem } from '../../datatypes/domain';
import { t } from '../../i18n';
import { LayoutModal } from './layout-modal';
import { CardComponent } from '../../cardmake/card-component';

/** 网格单位（像素）：卡片位置与尺寸均吸附到该值的整数倍 */
const GRID = 30;
/** 卡片默认宽高（像素，均为 GRID 的整数倍） */
const DEFAULT_W = 300;
const DEFAULT_H = 240;
/** 自动排布时每行放置的卡片数 */
const CARDS_PER_ROW = 3;

/** 吸附到网格：四舍五入到 GRID 的整数倍 */
function snap(v: number): number {
    return Math.round(v / GRID) * GRID;
}

/**
 * 工作台视图：与 YearView / TodayView 一致，通过 renderInto 渲染到指定容器。
 * 持有工作台数据引用 + 保存回调 + 数据访问回调（供 stats 卡片统计）。
 */
export class WorkbenchView {
    private app: App;
    private workbenchData: WorkbenchData;
    private workbenchRepo: WorkbenchRepo;
    private save: () => Promise<void>;
    /** 获取全部事件（stats 统计用） */
    private getEvents: () => EventBlock[];
    /** 获取全部执行记录（stats 统计用） */
    private getExecutions: () => ExecutionRecord[];
    /** 获取收集盒任务（stats 统计用） */
    private getInboxItems: () => InboxItem[];
    /** 追加一条 GTD 收集箱条目（collect 卡片用） */
    private addGtdItem: (content: string) => Promise<void>;
    /** GTD 领域仓库（collect 卡片读取/删除收集箱条目用，与 GTD 视图共用同一数据源） */
    private gtdRepo: GtdRepo;
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
        workbenchRepo: WorkbenchRepo,
        save: () => Promise<void>,
        getEvents: () => EventBlock[],
        getExecutions: () => ExecutionRecord[],
        getInboxItems: () => InboxItem[],
        addGtdItem: (content: string) => Promise<void>,
        gtdRepo: GtdRepo,
    ) {
        this.app = app;
        this.workbenchData = workbenchData;
        this.workbenchRepo = workbenchRepo;
        this.save = save;
        this.getEvents = getEvents;
        this.getExecutions = getExecutions;
        this.getInboxItems = getInboxItems;
        this.addGtdItem = addGtdItem;
        this.gtdRepo = gtdRepo;
    }

    /** 当前激活布局的名称（用于工作台标题，与布局管理中的名称保持一致） */
    getActiveLayoutName(): string {
        const layouts = this.workbenchData.layouts ?? [];
        const activeId = this.workbenchData.activeLayoutId ?? DEFAULT_LAYOUT_ID;
        const active = layouts.find(l => l.id === activeId);
        return active?.name ?? t('layout.defaultName');
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('workbench-view');

        // 确保默认布局存在，且始终对应当前工作台展示的内容
        this.workbenchRepo.ensureDefaultLayout(t('layout.defaultName'));

        // 加载模板（首次或缓存失效时）
        if (this.templates.length === 0) {
            this.templates = await loadAllTemplates();
        }

        // 顶部工具栏：标题 + 编辑布局按钮 + 添加卡片按钮（仅编辑态显示）+ 布局方案按钮
        const toolbar = container.createDiv({ cls: 'wb-toolbar' });
        toolbar.createDiv({ cls: 'wb-toolbar-title', text: this.getActiveLayoutName() });
        const actions = toolbar.createDiv({ cls: 'wb-toolbar-actions' });

        // 编辑态：依次显示「添加系统卡片 / 添加图表卡片 / 添加表单卡片 / 添加装饰卡片 / 退出编辑」
        if (this.editingLayout) {
            // 系统卡片：按「任务 / OKR / PDCA / GTD」分组展示（含原收集卡片 + 从图表卡片移入的统计卡片）
            const systemBtn = actions.createEl('button', {
                cls: 'wb-add-btn',
                text: t('workbench.addSystemCard'),
            });
            systemBtn.onclick = () => this.showAddCardMenu(systemBtn, 'system', [
                { key: 'workbench.group.task', match: (tpl) => ['task-stats', 'executed-task-count', 'execution-total-duration', 'day-execution-chart'].includes(tpl.id) },
                { key: 'workbench.group.okr', match: (tpl) => tpl.id === 'event-completion' },
                { key: 'workbench.group.pdca', match: (tpl) => ['category-distribution', 'usage-days'].includes(tpl.id) },
                { key: 'workbench.group.gtd', match: (tpl) => tpl.id === 'collect-inbox' },
            ]);

            // 图表卡片：按「指标展示 / 比较排名 / 趋势分布 / 占比构成 / 流程关系 / 特殊展示」分组
            const chartBtn = actions.createEl('button', {
                cls: 'wb-add-btn',
                text: t('workbench.addIconCard'),
            });
            chartBtn.onclick = () => this.showAddCardMenu(chartBtn, 'chart', [
                { key: 'workbench.group.metric', match: (tpl) => ['metric-card', 'activity-heatmap'].includes(tpl.id) },
                { key: 'workbench.group.compare', match: (tpl) => ['bar-chart', 'hbar-chart'].includes(tpl.id) },
                { key: 'workbench.group.trend', match: (tpl) => ['line-chart', 'area-chart', 'scatter-chart'].includes(tpl.id) },
                { key: 'workbench.group.proportion', match: (tpl) => ['pie-chart', 'donut-chart'].includes(tpl.id) },
                { key: 'workbench.group.flow', match: (tpl) => tpl.id === 'funnel-chart' },
                { key: 'workbench.group.special', match: (tpl) => ['wordcloud-chart', 'radar-chart'].includes(tpl.id) },
            ]);

            // 表单卡片：周期填写 + 固定填写 + 自定义列表
            const formBtn = actions.createEl('button', {
                cls: 'wb-add-btn',
                text: t('workbench.addFormCard'),
            });
            formBtn.onclick = () => this.showAddCardMenu(formBtn, 'form', [
                { match: () => true },
            ]);

            // 装饰卡片：日历 + 时钟
            const decoBtn = actions.createEl('button', {
                cls: 'wb-add-btn',
                text: t('workbench.addDecoCard'),
            });
            decoBtn.onclick = () => this.showAddCardMenu(decoBtn, 'deco', [
                { match: () => true },
            ]);

            // 退出编辑按钮：退出编辑态并持久化
            const exitBtn = actions.createEl('button', {
                cls: 'wb-exit-edit-btn',
                text: t('workbench.exitEdit'),
            });
            exitBtn.onclick = () => {
                this.editingLayout = false;
                this.editSnapshot = null;
                void this.save().then(() => {
                    if (this.container) void this.renderInto(this.container);
                });
            };
        }

        // 编辑布局按钮：切换编辑态（编辑态下隐藏，避免重复触发）
        if (!this.editingLayout) {
            const editBtn = actions.createEl('button', {
                cls: 'wb-edit-layout-btn',
                text: t('workbench.editLayout'),
            });
            editBtn.onclick = () => {
                this.editingLayout = true;
                // 进入编辑态时记录快照
                this.editSnapshot = this.workbenchData.instances.map((i) => ({ ...i }));
                void this.renderInto(container);
            };

            const layoutBtn = actions.createEl('button', {
                cls: 'wb-layout-btn',
                text: t('workbench.layoutScheme'),
            });
            layoutBtn.onclick = () => new LayoutModal(this.app, this.workbenchData).open();
        }

        // 卡片画布（绝对定位 + 30px 网格）
        const grid = container.createDiv({ cls: 'wb-grid' });
        // 编辑态：画布显示网格交叉点背景
        if (this.editingLayout) grid.addClass('is-editing');

        if (this.workbenchData.instances.length === 0) {
            grid.createDiv({ cls: 'wb-empty', text: t('workbench.empty') });
            return;
        }

        // 计算每张卡片的网格坐标（未定位的按顺序自动排布），并写回实例，保证坐标持久一致
        const positions = this.computePositions();
        for (const instance of this.workbenchData.instances) {
            const pos = positions.get(instance.id);
            if (pos) {
                this.workbenchRepo.updateInstance(instance.id, { col: pos.col, row: pos.row });
            }
        }

        // 卡片组件：封装单张卡片的外壳渲染与编辑态交互
        const cardComponent = new CardComponent({
            app: this.app,
            workbenchRepo: this.workbenchRepo,
            save: this.save,
            refresh: () => void this.renderInto(container),
            resolveCollisions: () => this.resolveCollisions(),
            getEvents: this.getEvents,
            getExecutions: this.getExecutions,
            getInboxItems: this.getInboxItems,
            addGtdItem: this.addGtdItem,
            gtdRepo: this.gtdRepo,
            templates: this.templates,
        });

        for (const instance of this.workbenchData.instances) {
            const pos = positions.get(instance.id);
            if (!pos) continue;
            cardComponent.render(grid, instance, pos, this.editingLayout);
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
        // 底部始终预留 50px 空白（距最低卡片）
        grid.style.setProperty('min-height', `${Math.max(300, maxBottom + 50)}px`);
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

    /**
     * 弹出添加卡片菜单：按分组列出模板供选择。
     * 每个分组可带行标题（key），分组内每个类型为一个「图标 + 文字」方块，从左到右排列。
     * @param anchor 触发按钮（菜单挂在其内部）
     * @param mode 卡片分类（先按分类过滤，再按 groups 细分）
     * @param groups 分组定义列表；key 存在则渲染行标题，否则平铺
     */
    private showAddCardMenu(
        anchor: HTMLElement,
        mode: CardMode,
        groups: Array<{ key?: string; match: (tpl: CardTemplate) => boolean }>,
    ) {
        const menu = anchor.createDiv({ cls: 'wb-add-menu' });
        anchor.addClass('is-menu-open');
        const candidates = this.templates.filter((tpl) => tpl.mode === mode);

        for (const group of groups) {
            const items = candidates.filter((tpl) => group.match(tpl));

            if (group.key) {
                // 带标题的分组：即使无匹配项也保留标题行（底下留空位）
                const section = menu.createDiv({ cls: 'wb-add-section' });
                section.createDiv({ cls: 'wb-add-section-title', text: t(group.key as never) });
                const grid = section.createDiv({ cls: 'wb-add-section-grid' });
                for (const tpl of items) {
                    this.renderAddCardItem(grid, tpl, menu);
                }
            } else {
                // 无标题分组：无匹配项则跳过
                if (items.length === 0) continue;
                const grid = menu.createDiv({ cls: 'wb-add-section-grid' });
                for (const tpl of items) {
                    this.renderAddCardItem(grid, tpl, menu);
                }
            }
        }

        // 点击外部关闭
        const close = (e: MouseEvent) => {
            if (!menu.contains(e.target as Node)) {
                menu.remove();
                anchor.removeClass('is-menu-open');
                document.removeEventListener('click', close);
            }
        };
        window.setTimeout(() => document.addEventListener('click', close), 0);
    }

    /** 渲染单个「图标 + 文字」方块选项 */
    private renderAddCardItem(grid: HTMLElement, tpl: CardTemplate, menu: HTMLElement) {
        const item = grid.createDiv({ cls: 'wb-add-menu-item' });
        item.createDiv({ cls: 'wb-add-menu-item-icon', text: this.iconForTemplate(tpl) });
        item.createDiv({ cls: 'wb-add-menu-item-label', text: tpl.name });
        item.onclick = () => {
            this.addCard(tpl);
            menu.remove();
            menu.parentElement?.removeClass('is-menu-open');
        };
    }

    /** 根据模板类型返回一个示例图标（emoji） */
    private iconForTemplate(tpl: CardTemplate): string {
        const byId: Record<string, string> = {
            'usage-days': '📅',
            'executed-task-count': '✅',
            'execution-total-duration': '⏱️',
            'activity-heatmap': '🔥',
            'category-distribution': '🍩',
            'day-execution-chart': '📊',
            'event-completion': '🎯',
            'task-stats': '📋',
            'year-goal': '🏆',
            'weekly-review': '🗓️',
            'daily-mood': '😊',
            'calendar': '📆',
            'clock': '🕐',
            'collect-inbox': '📥',
            'metric-card': '🔢',
            'bar-chart': '📊',
            'line-chart': '📈',
            'hbar-chart': '📊',
            'area-chart': '📉',
            'pie-chart': '🥧',
            'donut-chart': '🍩',
            'radar-chart': '🕸️',
            'scatter-chart': '✨',
            'funnel-chart': '🔻',
            'wordcloud-chart': '☁️',
            'custom-list': '📝',
        };
        return byId[tpl.id] ?? '🧩';
    }

    /** 添加一张卡片实例 */
    private addCard(template: CardTemplate) {
        const instance: CardInstance = {
            id: crypto.randomUUID(),
            templateId: template.id,
            mode: template.mode,
            title: template.name,
        };
        if (template.renderer === 'stats' && template.source) {
            instance.source = template.source;
        }
        this.workbenchRepo.addInstance(instance);
        void this.save().then(() => {
            new Notice(t('workbench.cardAdded', { name: template.name }));
            if (this.container) void this.renderInto(this.container);
        });
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
                            this.workbenchRepo.updateInstance(lower.inst.id, { row: newRow });
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
