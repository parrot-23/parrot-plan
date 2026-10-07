import type { App } from 'obsidian';

import type { TimeBlockCategoryData } from './week-view/timeblock-category-manager';
import type { InboxData, InboxItem } from '../datatypes/domain';
import { renderTaskPanel } from '../shared/task-panel';
import type { ExecutionRecord, EventBlock } from '../datatypes/domain';
import { parseWeekKey } from './week-view/timeblock-data';
import { t } from '../i18n';
import { aggregate } from '../cardmake/data/aggregators';
import { renderHeatmap } from '../cardmake/engine/chart-renderer';
import { createDataProvider } from '../cardmake/data/provider';

/**
 * 项目全景图视图：从上到下的页面结构。
 * 第一行：项目名称大标题 + 右侧搜索按钮（可切换中心主题）；
 * 第二行：左侧任务面板 + 右侧泳道图（W1–W52 从左到右排列，高度为原来的一半）；
 * 第三行及以下：板块区域（占位，后续放置各种板块 / 卡片）。
 * 通过 renderInto 渲染到指定容器（与 WeekScheduleView / YearView 一致）。
 */
export class SwimlaneView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: TimeBlockCategoryData;
    private save: () => Promise<void>;
    /** 获取执行记录（用于绘制执行线） */
    private getExecutions: () => ExecutionRecord[];
    /** 获取计划事件（用于绘制计划事件热力图） */
    private getEvents: () => EventBlock[];
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 当前显示的年份（用于顶部年份切换） */
    private currentYear: number = new Date().getFullYear();
    /** 是否展开搜索框 */
    private searchOpen = false;
    /** 搜索关键词 */
    private searchQuery = '';

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: TimeBlockCategoryData,
        save: () => Promise<void>,
        getExecutions: () => ExecutionRecord[],
        getEvents: () => EventBlock[],
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.save = save;
        this.getExecutions = getExecutions;
        this.getEvents = getEvents;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('swimlane-view');

        // ===== 第一行：项目名称大标题 + 右侧搜索按钮 =====
        this.renderHeader(container);

        // ===== 第二行：左侧任务面板 + 右侧泳道图（高度为原来的一半）=====
        const boardRow = container.createDiv({ cls: 'swimlane-board-row' });

        // 左侧：任务面板
        const taskPanel = boardRow.createDiv({ cls: 'swimlane-task-panel' });
        renderTaskPanel(
            this.app,
            taskPanel,
            this.inboxData,
            this.categoryData,
            async () => {
                await this.save();
            },
            () => {
                void this.refresh();
            },
            undefined,
            async () => {
                await this.save();
            },
        );

        // 右侧：泳道图
        const board = boardRow.createDiv({ cls: 'swimlane-board' });
        this.renderBoard(board);

        // ===== 第三行及以下：板块区域（当前项目的热力活跃图）=====
        const sectionArea = container.createDiv({ cls: 'swimlane-section-area' });
        this.renderActivityHeatmap(sectionArea);
    }

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
    }

    /** 第一行：项目名称大标题 + 右侧搜索按钮（点击展开搜索框与结果列表） */
    private renderHeader(container: HTMLElement) {
        const header = container.createDiv({ cls: 'swimlane-header' });

        // 标题：优先显示当前聚焦的项目名称，否则显示默认标题
        const focusId = this.inboxData.projectFocusId;
        const focusItem = focusId
            ? this.inboxData.items.find(i => i.id === focusId && !i.removed)
            : undefined;
        header.createDiv({
            cls: 'swimlane-title',
            text: focusItem?.title ?? t('projectPicture.defaultTitle'),
        });

        // 右侧：搜索按钮（外层容器相对定位，用于承载下方悬浮的结果列表）
        const searchWrap = header.createDiv({ cls: 'swimlane-search-wrap' });
        const searchBtn = searchWrap.createEl('button', {
            cls: 'swimlane-search-btn',
            text: t('projectPicture.search'),
        });
        searchBtn.toggleClass('is-active', this.searchOpen);

        // 搜索面板容器：展开/收起只操作此容器，避免重建整个视图导致泳道图闪动
        const panelHost = searchWrap.createDiv({ cls: 'swimlane-search-panel-host' });
        if (this.searchOpen) {
            this.renderSearchPanel(panelHost);
        }

        searchBtn.onclick = () => {
            this.searchOpen = !this.searchOpen;
            if (!this.searchOpen) this.searchQuery = '';
            searchBtn.toggleClass('is-active', this.searchOpen);
            // 局部更新：仅重建搜索面板，不触发整个视图 refresh
            panelHost.empty();
            if (this.searchOpen) {
                this.renderSearchPanel(panelHost);
            }
        };
    }

    /** 搜索面板：输入框 + 匹配到的项目结果列表，点击结果切换中心主题 */
    private renderSearchPanel(searchWrap: HTMLElement) {
        const panel = searchWrap.createDiv({ cls: 'swimlane-search-panel' });

        const input = panel.createEl('input', {
            cls: 'swimlane-search-input',
            type: 'text',
            placeholder: t('projectPicture.searchPlaceholder'),
        });
        input.value = this.searchQuery;
        input.oninput = () => {
            this.searchQuery = input.value;
            this.renderSearchResults(resultsEl);
        };
        // 阻止冒泡，避免触发外层点击
        input.onclick = (e) => e.stopPropagation();

        const resultsEl = panel.createDiv({ cls: 'swimlane-search-results' });
        this.renderSearchResults(resultsEl);

        // 自动聚焦输入框
        window.setTimeout(() => input.focus(), 0);
    }

    /** 渲染搜索结果列表（按关键词过滤未移除的任务） */
    private renderSearchResults(resultsEl: HTMLElement) {
        resultsEl.empty();
        const query = this.searchQuery.trim().toLowerCase();
        const matches = this.inboxData.items.filter(i =>
            !i.removed && (query === '' || i.title.toLowerCase().includes(query)),
        );

        if (matches.length === 0) {
            resultsEl.createDiv({
                cls: 'swimlane-search-empty',
                text: t('projectPicture.searchEmpty'),
            });
            return;
        }

        for (const item of matches) {
            const row = resultsEl.createDiv({ cls: 'swimlane-search-item' });
            if (item.id === this.inboxData.projectFocusId) row.addClass('is-active');

            const cat = item.categoryId
                ? this.categoryData.categories.find(c => c.id === item.categoryId)
                : undefined;
            if (cat) {
                const dot = row.createSpan({ cls: 'inbox-category-dot' });
                dot.setCssProps({ '--dot-color': cat.color });
            }
            row.createSpan({ cls: 'swimlane-search-item-name', text: item.title });

            row.onclick = () => {
                // 切换项目全景图的中心主题：聚焦到该任务
                this.inboxData.projectFocusId = item.id;
                this.searchOpen = false;
                this.searchQuery = '';
                void (async () => {
                    await this.save();
                    await this.refresh();
                })();
            };
        }
    }

    /** 渲染泳道图网格（W1–W52 从左到右） */
    private renderBoard(board: HTMLElement) {
        const totalWeeks = 52;

        // ===== 顶部：年份切换 + 图例（与年视图日历顶部一致）=====
        const topBar = board.createDiv({ cls: 'swimlane-top-bar' });
        this.renderYearNav(topBar);
        this.renderLegend(topBar);

        // 表头行：周号
        const headerRow = board.createDiv({ cls: 'swimlane-header-row' });
        for (let w = 1; w <= totalWeeks; w++) {
            headerRow.createDiv({
                cls: 'swimlane-header-cell',
                text: t('projectPicture.weekLabel', { week: w }),
            });
        }

        // 按任务面板的显示顺序，从上到下渲染每个任务的计划项与执行记录
        const tasks = this.collectVisibleTasks();
        const executions = this.getExecutions();

        // 记录选中任务最早出现的一周，用于渲染后滚动定位
        let selectedFirstWeek: number | undefined;

        for (const task of tasks) {
            // 计划周集合（来自任务的 assignedWeekKeys，仅当前年份）
            const planWeeks = new Set<number>();
            if (task.assignedWeekKeys) {
                for (const key of task.assignedWeekKeys) {
                    const parsed = parseWeekKey(key);
                    if (parsed.year === this.currentYear) planWeeks.add(parsed.week);
                }
            }

            // 执行周集合（来自执行记录，按 inboxId 匹配，仅当前年份）
            const execWeeks = new Set<number>();
            for (const rec of executions) {
                if (rec.inboxId === task.id && rec.weekKey) {
                    const parsed = parseWeekKey(rec.weekKey);
                    if (parsed.year === this.currentYear) execWeeks.add(parsed.week);
                }
            }

            // 任务标题行（左侧固定，横向滚动时保持可见）
            const titleRow = board.createDiv({ cls: 'swimlane-task-row' });
            const cat = task.categoryId
                ? this.categoryData.categories.find(c => c.id === task.categoryId)
                : undefined;
            if (cat) {
                const dot = titleRow.createSpan({ cls: 'inbox-category-dot' });
                dot.setCssProps({ '--dot-color': cat.color });
            }
            titleRow.createSpan({ cls: 'swimlane-task-name', text: task.title });
            if (this.inboxData.selectedId === task.id) titleRow.addClass('is-selected');

            // 计划线
            const planRow = board.createDiv({ cls: 'swimlane-lane-row' });
            for (let w = 1; w <= totalWeeks; w++) {
                const cell = planRow.createDiv({ cls: 'swimlane-cell' });
                if (planWeeks.has(w)) cell.addClass('is-plan');
            }

            // 执行线
            const execRow = board.createDiv({ cls: 'swimlane-lane-row' });
            for (let w = 1; w <= totalWeeks; w++) {
                const cell = execRow.createDiv({ cls: 'swimlane-cell' });
                if (execWeeks.has(w)) cell.addClass('is-exec');
            }

            // 选中任务：记录其最早出现的一周
            if (this.inboxData.selectedId === task.id) {
                const weeks = Array.from(planWeeks).concat(Array.from(execWeeks));
                if (weeks.length > 0) {
                    selectedFirstWeek = Math.min.apply(null, weeks);
                }
            }
        }

        // 选中任务时：横向滚动到最早出现的时间点（计划 / 执行周中最小的一周）
        if (selectedFirstWeek !== undefined) {
            const firstWeek = selectedFirstWeek;
            // 每格宽 60px，滚动到该周前留出一点边距
            const targetLeft = (firstWeek - 1) * 60 - 12;
            window.setTimeout(() => {
                board.scrollLeft = Math.max(0, targetLeft);
            }, 0);
        }
    }

    /**
     * 按任务面板的显示顺序收集可见任务（深度优先，跳过已折叠任务的子任务）。
     * 与 task-panel 的 renderList / renderItem 顺序保持一致。
     */
    private collectVisibleTasks(): InboxItem[] {
        const result: InboxItem[] = [];
        const collapsed = this.inboxData.collapsedIds ?? [];

        const walk = (parentId: string | undefined) => {
            const children = this.inboxData.items.filter(
                i => !i.removed && i.parentId === parentId,
            );
            for (const child of children) {
                result.push(child);
                if (!collapsed.includes(child.id)) walk(child.id);
            }
        };
        walk(undefined);
        return result;
    }

    /** 顶部年份切换（‹ 年份 › + 今年），与年视图日历顶部一致 */
    private renderYearNav(board: HTMLElement) {
        const nav = board.createDiv({ cls: 'swimlane-year-nav' });

        const prevBtn = nav.createEl('button', { text: '‹', cls: 'year-week-nav-btn' });
        prevBtn.onclick = () => {
            this.currentYear -= 1;
            void this.refresh();
        };

        nav.createDiv({ cls: 'year-week-nav-year', text: String(this.currentYear) });

        const nextBtn = nav.createEl('button', { text: '›', cls: 'year-week-nav-btn' });
        nextBtn.onclick = () => {
            this.currentYear += 1;
            void this.refresh();
        };

        const todayBtn = nav.createEl('button', {
            text: t('year.thisYear'),
            cls: 'year-week-nav-btn year-week-nav-today',
        });
        todayBtn.toggleClass('is-active', this.currentYear === new Date().getFullYear());
        todayBtn.onclick = () => {
            this.currentYear = new Date().getFullYear();
            void this.refresh();
        };
    }

    /** 图例：说明计划项 / 执行记录的固定颜色 */
    private renderLegend(container: HTMLElement) {
        const legend = container.createDiv({ cls: 'swimlane-legend' });

        const items: { labelKey: 'projectPicture.legendPlan' | 'projectPicture.legendExec'; color: string }[] = [
            { labelKey: 'projectPicture.legendPlan', color: 'var(--interactive-accent)' },
            { labelKey: 'projectPicture.legendExec', color: 'var(--color-green, #43b581)' },
        ];

        for (const item of items) {
            const row = legend.createDiv({ cls: 'swimlane-legend-item' });
            const swatch = row.createSpan({ cls: 'swimlane-legend-color' });
            swatch.setCssProps({ '--swatch-color': item.color });
            row.createSpan({ text: t(item.labelKey) });
        }
    }

    /** 板块区域：绘制当前聚焦项目的热力活跃图（执行记录 + 计划事件） */
    private renderActivityHeatmap(sectionArea: HTMLElement) {
        sectionArea.empty();
        sectionArea.addClass('swimlane-section-area');

        // 构建数据提供者（复用统计聚合逻辑）
        const provider = createDataProvider(
            this.getEvents,
            this.getExecutions,
            () => this.inboxData.items,
        );

        // 聚焦项目 id（未聚焦时统计全部任务）
        const projectId = this.inboxData.projectFocusId;

        // 执行记录热力活跃图
        this.renderHeatmapBlock(
            sectionArea,
            t('projectPicture.heatmapTitle'),
            t('projectPicture.heatmapEmpty'),
            'activity-heatmap',
            provider,
            projectId,
        );

        // 计划事件热力活跃图
        this.renderHeatmapBlock(
            sectionArea,
            t('projectPicture.planHeatmapTitle'),
            t('projectPicture.planHeatmapEmpty'),
            'plan-heatmap',
            provider,
            projectId,
        );
    }

    /** 渲染单个热力图块（标题 + 热力图或空提示） */
    private renderHeatmapBlock(
        sectionArea: HTMLElement,
        title: string,
        emptyText: string,
        sourceType: string,
        provider: ReturnType<typeof createDataProvider>,
        projectId: string | undefined,
    ) {
        const wrapper = sectionArea.createDiv({ cls: 'swimlane-heatmap-wrap' });
        wrapper.createDiv({ cls: 'swimlane-heatmap-title', text: title });

        const result = aggregate(
            {
                type: sourceType,
                params: { metric: 'duration', projectId },
            },
            provider,
        );

        if (!result.heatmap || result.heatmap.data.length === 0) {
            wrapper.createDiv({ cls: 'swimlane-heatmap-empty', text: emptyText });
            return;
        }

        renderHeatmap(wrapper, result.heatmap);
    }
}
