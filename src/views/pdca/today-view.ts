import type { App } from 'obsidian';
import { Notice, setIcon } from 'obsidian';

import type { PlanCategoryData } from '../../shared/plan-category-manager';
import { UNCATEGORIZED_CATEGORY_ID } from '../../shared/plan-category-manager';
import type { InboxData, InboxItem, ChecklistData, StepsData, HabitData, FileData } from '../../datatypes/domain';
import { SECTION_TYPE_META } from '../../datatypes/domain';
import { getCurrentDayKey, getISOWeek, makeDayKey, makeDayKeyFromWeek, makeWeekKey } from '../../shared/plan-data';
import type { DailyRange } from '../../shared/plan-data';
import type { EventBlock, ExecutionRecord, RunningTask } from '../../datatypes/domain';
import { getWeekDays, t } from '../../i18n';
import { EVENT_STATUS_EMOJI, EVENT_STATUS_LABEL_KEY, getEventStatus, type EventStatus } from '../../datatypes/domain';
import type { PdcaRepo } from '../../repos/pdca-repo';
import type { InboxRepo } from '../../repos/inbox-repo';
import { renderTaskPanel } from '../../shared/task-panel';

/** 时间轴每小时格子的最小高度（px）：面板较矮时保持该高度并出现滚动条 */
const MIN_HOUR_HEIGHT = 30;

/** 把分钟数格式化为 HH:MM */
function formatMinutes(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 把分钟数格式化为小时（如 1.5h），用于周目标清单每行末尾的总时长 */
function formatHours(minutes: number): string {
    const hours = minutes / 60;
    // 保留一位小数，去掉多余的 .0
    return `${Number(hours.toFixed(1))}h`;
}

/** 把分钟数格式化为「Xh Ym」/「Ym」形式（与周计划卡片一致） */
function formatDuration(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h > 0 && m > 0) return `${h}h${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
}

/**
 * 当日执行视图：左侧任务面板 + 中间执行区 + 右侧当天时间轴。
 * 通过 renderInto 渲染到指定容器（与 WeekScheduleView / YearView 一致）。
 */
export class TodayView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: PlanCategoryData;
    private save: () => Promise<void>;
    /** 获取全部事件（用于在时间轴上展示今天的计划事件） */
    private getEvents: () => EventBlock[];
    /** 获取全部执行记录（用于「完成执行计划任务」写入） */
    private getExecutions: () => ExecutionRecord[];
    /** PDCA 领域仓库（执行记录增删） */
    private pdcaRepo: PdcaRepo;
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 红线定时器 */
    private timer?: number;
    /** 时间轴上被选中的事件 id（用于在中心方框展示详情） */
    private selectedEventId?: string;
    /** 时间轴上被选中的「新增」执行记录 id（与计划事件选中互斥） */
    private selectedExecId?: string;
    /** 上一次渲染时任务面板选中的任务 id（用于检测选中变化） */
    private lastSelectedItemId?: string;
    /** 是否处于「新增非计划事件」模式（点击时间轴触发） */
    private addUnplannedMode = false;
    /** 新增非计划事件的起始分钟（由点击时间轴的位置换算） */
    private addUnplannedStart = 0;
    /** 新增非计划事件的时长（分钟，默认 30，可由用户填写） */
    private addUnplannedDuration = 30;
    /** 「当天任务」详情中待执行的起始分钟（选中任务时默认取当前时刻，可编辑） */
    private detailStart = 0;
    /** 「当天任务」详情中待执行的结束分钟（与起始/时长联动，可编辑） */
    private detailEnd = 30;
    /** 上一次渲染详情时选中的任务 id（用于切换任务时重置待执行时间区间） */
    private lastDetailItemId?: string;
    /** 当前正在执行的事件 id（点击「进入执行」后设置，用于顶部执行卡片） */
    private executingEventId?: string;
    /**
     * 当前「进行中」的任务（点击「开始任务」后设置）。
     * 在时间轴上以透明色块呈现，点击可选中并「完成」/「中断」。
     * 随主数据一起持久化（通过 pdcaRepo.setRunningTask 写回）。
     */
    private runningTask?: RunningTask;
    /** 是否选中了「进行中任务」色块（用于操作区显示「完成 / 中断」按钮） */
    private selectedRunningTask = false;
    /** 跳转到项目全景图的回调（由 MainView 注入，负责切换 tab 并选中当前项目） */
    private onNavigateToProjectPicture?: (projectId: string) => void;
    /** 获取当前激活方案的单日区间配置（用于时间轴左侧分类色条） */
    private getPlanSchemeDays: () => DailyRange[];
    /** 当前查看的日期（默认今天；可切换到昨天以补充昨日执行信息） */
    private viewDate: Date = new Date();
    /** 收集盒领域仓库（任务选中状态走仓库方法，保证跨视图一致） */
    private inboxRepo?: InboxRepo;
    /** 进行中任务变化回调（开始/完成/中断时通知宿主刷新导航栏卡片） */
    private onRunningTaskChange?: () => void;
    /** 右侧内容区当前选项卡：今日情况 / 当天任务 / 额外任务 / 本周情况 / 板块信息 */
    private rightTab: 'today' | 'dayTasks' | 'extraTasks' | 'week' | 'sections' = 'today';

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: PlanCategoryData,
        save: () => Promise<void>,
        getEvents: () => EventBlock[],
        getExecutions: () => ExecutionRecord[],
        pdcaRepo: PdcaRepo,
        initialExecutingEventId?: string,
        onNavigateToProjectPicture?: (projectId: string) => void,
        getPlanSchemeDays?: () => DailyRange[],
        initialRunningTask?: RunningTask,
        inboxRepo?: InboxRepo,
        onRunningTaskChange?: () => void,
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.save = save;
        this.getEvents = getEvents;
        this.getExecutions = getExecutions;
        this.pdcaRepo = pdcaRepo;
        this.executingEventId = initialExecutingEventId;
        this.onNavigateToProjectPicture = onNavigateToProjectPicture;
        this.getPlanSchemeDays = getPlanSchemeDays ?? (() => []);
        this.runningTask = initialRunningTask;
        this.inboxRepo = inboxRepo;
        this.onRunningTaskChange = onRunningTaskChange;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        this.clearTimer();
        // 保存时间轴滚动位置，重建 DOM 后恢复，避免刷新时滚动条重置
        const prevScrollTop = container
            .querySelector('.today-timeline-panel')?.scrollTop ?? 0;
        // 保存左侧任务面板的滚动位置（当天任务面板自身滚动；全部任务面板为内部列表滚动）
        const prevTaskPanelScrollTop = container
            .querySelector<HTMLElement>('.today-task-panel')?.scrollTop ?? 0;
        const prevTaskListScrollTop = container
            .querySelector<HTMLElement>('.today-task-panel .inbox-list')?.scrollTop ?? 0;
        container.empty();
        container.addClass('today-view');

        // 任务面板选中项发生变化时，清除时间轴事件选中（两者互斥）
        if (this.inboxData.selectedId !== this.lastSelectedItemId) {
            this.lastSelectedItemId = this.inboxData.selectedId;
            this.selectedEventId = undefined;
            this.selectedExecId = undefined;
        }

        // ===== 左侧：任务面板 =====
        // 「额外任务」选项卡下显示全部任务（与任务计划视图一致）；其余情况仅显示当天安排的任务
        const taskPanel = container.createDiv({ cls: 'today-task-panel' });
        if (this.rightTab === 'extraTasks') {
            this.renderAllTasksPanel(taskPanel);
        } else {
            this.renderTodayTaskPanel(taskPanel);
        }
        // 恢复左侧任务面板的滚动位置，实现无感刷新
        taskPanel.scrollTop = prevTaskPanelScrollTop;
        if (prevTaskListScrollTop > 0) {
            const listEl = taskPanel.querySelector<HTMLElement>('.inbox-list');
            if (listEl) listEl.scrollTop = prevTaskListScrollTop;
        }

        // ===== 中间：当天时间轴（紧贴左侧任务面板）=====
        const timelinePanel = container.createDiv({ cls: 'today-timeline-panel' });
        this.renderTimeline(timelinePanel);
        // 恢复时间轴滚动位置
        timelinePanel.scrollTop = prevScrollTop;

        // ===== 右侧：日期方框 + 选项卡 + 选项卡内容 + 操作按钮 =====
        const centerPanel = container.createDiv({ cls: 'today-center-panel' });
        this.renderDateBox(centerPanel);
        // 选项卡行（今日情况 / 当天任务 / 额外任务）
        this.renderRightTabs(centerPanel);
        // 进行中任务进度方框（位于选项卡下方）
        this.renderRunningProgressBox(centerPanel);
        // 选项卡内容区
        this.renderRightTabContent(centerPanel);
    }

    /** 右侧内容区选项卡行：今日情况 / 当天任务 / 额外任务 / 本周情况 / 板块信息 */
    private renderRightTabs(panel: HTMLElement): void {
        const tabs: { id: 'today' | 'dayTasks' | 'extraTasks' | 'week' | 'sections'; labelKey: Parameters<typeof t>[0] }[] = [
            { id: 'today', labelKey: 'today.tabToday' },
            { id: 'dayTasks', labelKey: 'today.tabDayTasks' },
            { id: 'extraTasks', labelKey: 'today.tabExtraTasks' },
            { id: 'week', labelKey: 'today.tabWeek' },
            { id: 'sections', labelKey: 'today.tabSections' },
        ];
        const row = panel.createDiv({ cls: 'today-right-tabs' });
        for (const tab of tabs) {
            const btn = row.createEl('button', {
                cls: 'today-right-tab-btn',
                text: t(tab.labelKey),
                attr: { 'data-tab': tab.id },
            });
            if (tab.id === this.rightTab) btn.addClass('is-active');
            btn.onclick = () => {
                this.rightTab = tab.id;
                // 切到「额外任务」时进入新增非计划事件模式；切走时退出该模式
                if (tab.id === 'extraTasks') {
                    this.addUnplannedMode = true;
                } else {
                    this.addUnplannedMode = false;
                }
                void this.refresh();
            };
        }
    }

    /** 根据当前选项卡渲染右侧内容区 */
    private renderRightTabContent(panel: HTMLElement): void {
        if (this.rightTab === 'extraTasks') {
            // 额外任务：执行非计划事件方框
            this.renderAddUnplannedBox(panel);
            return;
        }
        if (this.rightTab === 'dayTasks') {
            // 当天任务：任务层级方框 + 任务详情方框
            this.renderHierarchyBox(panel);
            this.renderDetailBox(panel);
            return;
        }
        if (this.rightTab === 'week') {
            // 本周情况：本周各分类已执行时长 + 周目标卡片方框
            this.renderWeekCategoryDurationBox(panel);
            this.renderWeekGoalBox(panel);
            return;
        }
        if (this.rightTab === 'sections') {
            // 板块信息：单独方框展示当前任务的板块卡片
            this.renderSectionsBox(panel);
            return;
        }
        // 今日情况：今日各分类已执行时长 + 今日任务占比（左右各一半）+ 今日目标
        const statsRow = panel.createDiv({ cls: 'today-stats-row' });
        this.renderCategoryDurationBox(statsRow);
        this.renderTaskShareBox(statsRow);
        this.renderTodayGoalBox(panel);
    }

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
    }

    /** 重置查看日期为今天（由宿主在进入日执行视图时调用） */
    resetToToday(): void {
        this.viewDate = new Date();
    }

    /**
     * 取事件来源任务的「习惯时间点」（分钟）。
     * 仅当来源任务存在且已启用习惯时间点时返回，否则返回 null。
     */
    private getEventHabitTime(ev: EventBlock): number | null {
        if (!ev.inboxId) return null;
        const item = this.inboxData.items.find(i => i.id === ev.inboxId && !i.removed);
        if (!item || !item.habitTimeEnabled) return null;
        return typeof item.habitTime === 'number' ? item.habitTime : null;
    }

    /**
     * 按分类聚合事件：同一分类的事件连续排列，分类之间保持首次出现的顺序，
     * 分类内部保持原有顺序。
     */
    private groupEventsByCategory(events: EventBlock[]): EventBlock[] {
        const order: string[] = [];
        const groups = new Map<string, EventBlock[]>();
        for (const ev of events) {
            const key = ev.categoryId ?? '';
            if (!groups.has(key)) {
                groups.set(key, []);
                order.push(key);
            }
            groups.get(key)!.push(ev);
        }
        const result: EventBlock[] = [];
        for (const key of order) {
            for (const ev of groups.get(key)!) result.push(ev);
        }
        return result;
    }

    /**
     * 左侧「当天任务面板」：仅显示安排在当天的任务（来自当天的计划事件）。
     * 点击任务项可选中（写入 inboxData.selectedId），供右侧任务详情方框展示。
     */
    private renderTodayTaskPanel(panel: HTMLElement) {
        panel.empty();
        panel.addClass('today-task-list-panel');

        const { day, weekKey } = this.getViewDayInfo();

        // 当天计划事件（统一为全天事件）
        const dayEvents = this.getEvents()
            .filter(ev => ev.day === day && ev.weekKey === weekKey);

        // 按来源任务是否启用习惯时间点拆分：习惯时间点任务单独成组
        const habitEvents = dayEvents
            .filter(ev => this.getEventHabitTime(ev) !== null)
            // 习惯时间点任务按时间点先后顺序排列
            .sort((a, b) => (this.getEventHabitTime(a) ?? 0) - (this.getEventHabitTime(b) ?? 0));
        // 当天任务按分类聚合：同分类的任务连续排列（保持分类内原有顺序）
        const normalEvents = this.groupEventsByCategory(
            dayEvents.filter(ev => this.getEventHabitTime(ev) === null),
        );

        // 渲染单个当天计划事件卡片
        const renderDayEvent = (list: HTMLElement, ev: EventBlock) => {
            const item = ev.inboxId
                ? this.inboxData.items.find(i => i.id === ev.inboxId && !i.removed)
                : undefined;
            const cat = ev.categoryId
                ? this.categoryData.categories.find(c => c.id === ev.categoryId)
                : undefined;

            // 预估时长取自周计划设置；已执行时长取自当前执行记录（0 为有效值）
            const estMinutes = typeof ev.estimatedMinutes === 'number' && ev.estimatedMinutes >= 0
                ? ev.estimatedMinutes
                : undefined;
            // 已执行时长：按 eventId 或 inboxId 匹配（「开始任务→完成」路径写入的记录只有 inboxId），
            // 且只统计当前查看日期当天的执行记录，而非该任务所有历史累计
            const viewInfo = this.getViewDayInfo();
            const execMinutes = this.getExecutions()
                .filter(ex => !ex.replaced
                    && ex.weekKey === viewInfo.weekKey
                    && ex.day === viewInfo.day
                    && (ex.eventId === ev.id || (ev.inboxId && ex.inboxId === ev.inboxId)))
                .reduce((sum, ex) => sum + Math.max(0, ex.end - ex.start), 0);

            this.renderTaskCard(list, {
                title: ev.title,
                color: cat?.color,
                estMinutes,
                execMinutes,
                // 手动标记为已完成的任务同样显示勾选图标
                done: item ? this.isDayTaskDone(item.id) : undefined,
                habitTime: this.getEventHabitTime(ev) ?? undefined,
                selected: !!item && this.inboxData.selectedId === item.id,
                onSelect: () => this.selectTaskItem(item),
            });
        };

        // ===== 习惯时间点任务（当天任务中已启用习惯时间点的任务）=====
        if (habitEvents.length > 0) {
            panel.createDiv({ cls: 'today-task-list-title', text: t('today.habitTaskListTitle') });
            const habitList = panel.createDiv({ cls: 'today-task-list' });
            for (const ev of habitEvents) renderDayEvent(habitList, ev);
        }

        // ===== 当天任务（来自当天的计划事件）=====
        panel.createDiv({
            cls: habitEvents.length > 0 ? 'today-task-list-title is-added' : 'today-task-list-title',
            text: t('today.taskListTitle'),
        });

        const list = panel.createDiv({ cls: 'today-task-list' });

        if (normalEvents.length === 0) {
            list.createDiv({ cls: 'today-task-list-empty', text: t('today.taskListEmpty') });
        } else {
            for (const ev of normalEvents) renderDayEvent(list, ev);
        }

        // ===== 新增任务（计划外任务的执行记录）=====
        // 习惯任务 / 当天任务被执行属于「已执行」，不归入新增
        const addedExecs = this.getExecutions()
            .filter(ex =>
                ex.day === day
                && ex.weekKey === weekKey
                && this.getExecStatus(ex, dayEvents) === 'added',
            )
            // 新增事项按起始时间先后顺序排列
            .sort((a, b) => a.start - b.start);
        if (addedExecs.length === 0) return;

        panel.createDiv({ cls: 'today-task-list-title is-added', text: t('today.addedListTitle') });
        const addedList = panel.createDiv({ cls: 'today-task-list' });
        for (const ex of addedExecs) {
            const item = ex.inboxId
                ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                : undefined;
            const cat = item?.categoryId
                ? this.categoryData.categories.find(c => c.id === item.categoryId)
                : undefined;

            // 新增任务无预估时长，已执行时长取该条执行记录时长
            const execMinutes = Math.max(0, ex.end - ex.start);

            this.renderTaskCard(addedList, {
                title: item?.title ?? t('today.statusAdded'),
                color: cat?.color,
                estMinutes: undefined,
                execMinutes,
                selected: !!item && this.inboxData.selectedId === item.id,
                onSelect: () => this.selectTaskItem(item),
            });
        }
    }

    /** 渲染单个任务卡片（标题 + 预估/已执行时长 + 完成图标） */
    private renderTaskCard(
        list: HTMLElement,
        opts: {
            title: string;
            color?: string;
            estMinutes?: number;
            execMinutes: number;
            /** 已完成标记（提供时以此为准，用于手动标记等场景） */
            done?: boolean;
            /** 习惯时间点（分钟），设置后显示在卡片右上角 */
            habitTime?: number;
            selected: boolean;
            onSelect: () => void;
        },
    ): void {
        const row = list.createDiv({ cls: 'today-task-list-item' });
        row.setCssProps({ '--chip-color': opts.color ?? '#888888' });

        // 选中态高亮（与时间轴事件选中互斥，这里以任务来源 id 判断）
        if (opts.selected) row.addClass('is-selected');

        // 第一行：标题
        const nameEl = row.createSpan({ cls: 'today-task-list-name', text: opts.title });

        // 右上角：习惯时间点（仅设置了习惯时间点的任务显示）
        if (opts.habitTime !== undefined) {
            // 标题预留右侧空间，避免与习惯时间点重叠
            nameEl.addClass('has-habit');
            row.createSpan({
                cls: 'today-task-list-habit',
                text: formatMinutes(opts.habitTime),
            });
        }

        // 预估时长（取自周计划设置）与已执行时长（取自当前执行记录）分两行显示
        const estLine = row.createDiv({ cls: 'today-task-list-meta' });
        estLine.createSpan({
            cls: 'today-task-list-est',
            text: t('today.taskEst', {
                duration: opts.estMinutes !== undefined ? formatDuration(opts.estMinutes) : '—',
            }),
        });

        const execLine = row.createDiv({ cls: 'today-task-list-meta' });
        execLine.createSpan({
            cls: 'today-task-list-exec',
            text: t('today.taskExec', { duration: formatDuration(opts.execMinutes) }),
        });

        // 完成图标：无预估时长（或预估为 0）时，只要有执行记录即视为完成；
        // 有预估时长时，需已执行时长达到预估时长才显示。
        const done = opts.done ?? this.isTaskDone(opts.estMinutes, opts.execMinutes);
        if (done) {
            const doneIcon = execLine.createSpan({ cls: 'today-task-list-done' });
            setIcon(doneIcon, 'check-circle');
        }

        row.onclick = (e) => {
            e.stopPropagation();
            opts.onSelect();
        };
    }

    /**
     * 是否视为「已完成」：无预估时长（或预估为 0）时，只要有执行记录即完成；
     * 否则需已执行时长达到预估时长。
     */
    private isTaskDone(estMinutes: number | undefined, execMinutes: number): boolean {
        if (estMinutes === undefined || estMinutes === 0) return execMinutes > 0;
        return execMinutes >= estMinutes;
    }

    /**
     * 判断某个任务在当前查看日期是否已完成（与左侧当天任务卡片的判定规则一致）：
     * 预估时长取自当天的计划事件；已执行时长取当天执行记录中匹配该事件 / 任务的累计时长。
     */
    private isDayTaskDone(inboxId: string): boolean {
        // 手动标记优先：标记为未完成时，即使已执行时长达到预估也不显示已完成
        const item = this.inboxData.items.find(i => i.id === inboxId && !i.removed);
        if (item && (item.undoneDayKeys ?? []).includes(this.getViewDayInfo().dayKey)) return false;
        // 手动标记为已完成（点击详情中的勾选按钮）
        if (this.isManuallyDone(inboxId)) return true;

        const { day, weekKey } = this.getViewDayInfo();
        const ev = this.getEvents().find(e =>
            e.day === day && e.weekKey === weekKey && e.inboxId === inboxId);
        const estMinutes = ev
            && typeof ev.estimatedMinutes === 'number' && ev.estimatedMinutes >= 0
            ? ev.estimatedMinutes
            : undefined;
        const execMinutes = this.getExecutions()
            .filter(ex => !ex.replaced
                && ex.weekKey === weekKey
                && ex.day === day
                && (ex.inboxId === inboxId || (!!ev && ex.eventId === ev.id)))
            .reduce((sum, ex) => sum + Math.max(0, ex.end - ex.start), 0);
        return this.isTaskDone(estMinutes, execMinutes);
    }

    /** 该任务是否已被手动标记为当前查看日期的「已完成」 */
    private isManuallyDone(inboxId: string): boolean {
        const item = this.inboxData.items.find(i => i.id === inboxId && !i.removed);
        if (!item) return false;
        return (item.doneDayKeys ?? []).includes(this.getViewDayInfo().dayKey);
    }

    /** 手动标记当前查看日期的完成状态：done=true 标记为已完成，false 标记为未完成 */
    private async markTaskDayState(inboxId: string, done: boolean): Promise<void> {
        const item = this.inboxData.items.find(i => i.id === inboxId && !i.removed);
        if (!item) return;
        const { dayKey } = this.getViewDayInfo();

        const doneKeys = item.doneDayKeys ?? [];
        const undoneKeys = item.undoneDayKeys ?? [];
        // 两个标记互斥：标记完成时清除未完成标记，反之亦然
        item.doneDayKeys = done
            ? (doneKeys.includes(dayKey) ? doneKeys : [...doneKeys, dayKey])
            : doneKeys.filter(k => k !== dayKey);
        item.undoneDayKeys = done
            ? undoneKeys.filter(k => k !== dayKey)
            : (undoneKeys.includes(dayKey) ? undoneKeys : [...undoneKeys, dayKey]);

        await this.save();
        await this.refresh();
    }

    /** 点击任务卡片：选中/取消选中该任务，并清除时间轴事件选中 */
    private selectTaskItem(item: InboxItem | undefined): void {
        if (!item) return;
        this.selectedEventId = undefined;
        this.selectedExecId = undefined;
        this.selectedRunningTask = false;
        if (this.inboxData.selectedId === item.id) {
            if (this.inboxRepo) this.inboxRepo.setSelectedId(undefined);
            else this.inboxData.selectedId = undefined;
        } else {
            if (this.inboxRepo) this.inboxRepo.setSelectedId(item.id);
            else this.inboxData.selectedId = item.id;
            // 选中当天任务时自动切到「当天任务」选项卡
            this.rightTab = 'dayTasks';
        }
        void this.refresh();
    }

    /**
     * 左侧「全部任务面板」：复用任务计划视图的任务面板组件，显示全部任务。
     * 仅在「额外任务」选项卡下使用，便于从任意任务中挑选要执行的任务。
     */
    private renderAllTasksPanel(panel: HTMLElement): void {
        panel.empty();
        renderTaskPanel(
            this.app,
            panel,
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
            { enableProjectFocus: true, inboxRepo: this.inboxRepo },
        );
    }

    /** 渲染当前查看日期的年月日方框 + 右侧日目标完成情况 */
    private renderDateBox(panel: HTMLElement) {
        const now = this.viewDate;
        const box = panel.createDiv({ cls: 'today-date-box' });

        // 左侧：日期（点击日期区域 → 取消所有选中，恢复显示周目标 / 日目标）
        const dateSide = box.createDiv({ cls: 'today-date-side' });
        // 日期导航：左箭头（前一天） + 日期信息 + 右箭头（后一天）
        const dateNav = dateSide.createDiv({ cls: 'today-date-nav' });
        const prevBtn = dateNav.createEl('button', {
            cls: 'today-date-nav-btn',
            text: '‹',
            attr: { 'aria-label': t('today.prevDay') },
        });
        prevBtn.onclick = (e) => {
            e.stopPropagation();
            this.shiftViewDate(-1);
        };

        const dateInfo = dateNav.createDiv({ cls: 'today-date-info' });
        dateInfo.createDiv({ cls: 'today-date-year', text: `${now.getFullYear()}` });
        dateInfo.createDiv({ cls: 'today-date-md' })
            .setText(`${String(now.getMonth() + 1).padStart(2, '0')} / ${String(now.getDate()).padStart(2, '0')}`);
        dateInfo.createDiv({ cls: 'today-date-weekday', text: getWeekDays()[(now.getDay() + 6) % 7] });
        // 状态标识：今天 / 昨天 / X 天前
        dateInfo.createDiv({ cls: 'today-date-badge', text: this.viewDateBadgeText() });

        const nextBtn = dateNav.createEl('button', {
            cls: 'today-date-nav-btn',
            text: '›',
            attr: { 'aria-label': t('today.nextDay') },
        });
        // 不能超过今天：查看今天时禁用「后一天」按钮
        if (this.isViewingToday()) {
            nextBtn.disabled = true;
            nextBtn.addClass('is-disabled');
        } else {
            nextBtn.onclick = (e) => {
                e.stopPropagation();
                this.shiftViewDate(1);
            };
        }

        dateSide.addClass('is-clickable');
        dateSide.onclick = () => {
            // 点击日期区域：取消所有选中，并切回「今日情况」选项卡
            this.rightTab = 'today';
            this.clearAllSelection();
        };

        // 中间：正在执行的任务卡片 + 进行中任务卡片（并排）
        const midSide = box.createDiv({ cls: 'today-date-mid' });
        this.renderExecutingCard(midSide);
        this.renderRunningCard(midSide);

        // 右侧：日目标完成情况（大卡片 + 两张小卡片）
        const stats = this.computeDayStats();
        const statsSide = box.createDiv({ cls: 'today-date-stats' });

        // 左侧大卡片：计划总数 / 已完成
        const doneRatio = stats.total > 0 ? stats.executed / stats.total : 0;
        this.renderStatCard(statsSide, {
            label: t('today.statTotalDoneLabel'),
            values: [
                { text: String(stats.total), cls: 'is-total' },
                { text: String(stats.executed), cls: 'is-done' },
            ],
            ratio: doneRatio,
            barCls: 'is-done',
            size: 'large',
        });

        // 右侧：上下两张小卡片
        const smallCol = statsSide.createDiv({ cls: 'today-stat-small-col' });

        // 右上：待执行 / 已执行
        const breakdownTotal = stats.planned + stats.executed;
        this.renderStatCard(smallCol, {
            label: t('today.statBreakdownLabel'),
            values: [
                { text: String(stats.planned), cls: 'is-planned' },
                { text: String(stats.executed), cls: 'is-executed' },
            ],
            ratio: breakdownTotal > 0 ? stats.executed / breakdownTotal : 0,
            barCls: 'is-executed',
            size: 'small',
        });

        // 右下：新增
        this.renderStatCard(smallCol, {
            label: t('today.statAddedLabel'),
            values: [{ text: String(stats.added), cls: 'is-added' }],
            ratio: stats.added > 0 ? 1 : 0,
            barCls: 'is-added',
            size: 'small',
        });
    }

    /**
     * 渲染「正在执行」卡片（位于日期信息旁边）。
     * 有正在执行的任务时展示任务内容，背景使用斜向条纹突出进行中；无则不显示。
     */
    private renderExecutingCard(box: HTMLElement) {
        const ev = this.executingEventId
            ? this.getEvents().find(e => e.id === this.executingEventId)
            : undefined;
        if (!ev) return;

        const card = box.createDiv({ cls: 'today-executing-card' });
        // 条纹与底色跟随事件分类颜色（同色系，保持与黄色警示色一致的对比度）
        const cat = ev.categoryId
            ? this.categoryData.categories.find(c => c.id === ev.categoryId)
            : undefined;
        card.setCssProps({ '--exec-color': cat?.color ?? '#e0b400' });
        card.createDiv({ cls: 'today-executing-label', text: t('today.executingLabel') });
        card.createDiv({ cls: 'today-executing-name', text: ev.title });
        card.createDiv({ cls: 'today-executing-time', text: t('today.allDay') });

        // 点击卡片 → 选中该事件，同步更新任务层级 / 任务详情 / 操作按钮
        card.addClass('is-clickable');
        if (this.selectedEventId === ev.id) card.addClass('is-selected');
        card.onclick = () => {
            this.toggleEventSelection(ev.id);
        };
    }

    /**
     * 渲染「进行中」任务卡片（位于日期信息旁边）。
     * 点击「开始任务」后展示任务内容与起始时间，背景使用斜向条纹突出进行中；无则不显示。
     */
    private renderRunningCard(box: HTMLElement) {
        const running = this.runningTask;
        if (!running) return;
        // 仅当进行中任务属于当前查看日期时显示
        const { dayKey } = this.getViewDayInfo();
        if (running.dayKey !== dayKey) return;

        const item = this.inboxData.items.find(i => i.id === running.inboxId && !i.removed);
        if (!item) return;

        const card = box.createDiv({ cls: 'today-executing-card today-running-card' });
        const cat = item.categoryId
            ? this.categoryData.categories.find(c => c.id === item.categoryId)
            : undefined;
        card.setCssProps({ '--exec-color': cat?.color ?? '#4c8dff' });
        card.createDiv({ cls: 'today-executing-label', text: t('today.runningLabel') });
        card.createDiv({ cls: 'today-executing-name', text: item.title });
        card.createDiv({
            cls: 'today-executing-time',
            text: `${formatMinutes(running.start)} - ${formatMinutes(this.nowMinutes())}`,
        });

        // 点击卡片 → 选中该进行中任务，同步更新任务层级 / 进度方框 / 操作按钮
        card.addClass('is-clickable');
        if (this.selectedRunningTask) card.addClass('is-selected');
        card.onclick = () => {
            this.toggleRunningTaskSelection();
        };
    }

    /** 当前时刻换算为当天分钟数 */
    private nowMinutes(): number {
        const now = new Date();
        return now.getHours() * 60 + now.getMinutes();
    }

    /**
     * 当前查看日期对应的信息：星期几（1=周一 ... 7=周日）、周键、日期键。
     * 所有「今天」相关的计算都应基于此，以支持切换到昨天查看。
     */
    private getViewDayInfo(): { day: number; weekKey: string; dayKey: string } {
        const d = this.viewDate;
        const day = (d.getDay() + 6) % 7 + 1;
        const weekKey = makeWeekKey(d.getFullYear(), getISOWeek(d));
        return { day, weekKey, dayKey: makeDayKey(d) };
    }

    /** 当前查看的是否为今天 */
    private isViewingToday(): boolean {
        return makeDayKey(this.viewDate) === getCurrentDayKey();
    }

    /** 查看日期与今天相差的天数（今天为 0，昨天为 1，前天为 2……） */
    private daysBeforeToday(): number {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const view = new Date(this.viewDate);
        view.setHours(0, 0, 0, 0);
        return Math.round((today.getTime() - view.getTime()) / (24 * 60 * 60 * 1000));
    }

    /** 日期状态标识文案：今天 / 昨天 / X 天前 */
    private viewDateBadgeText(): string {
        const diff = this.daysBeforeToday();
        if (diff <= 0) return t('today.todayBadge');
        if (diff === 1) return t('today.yesterdayBadge');
        return t('today.daysAgoBadge', { days: String(diff) });
    }

    /** 渲染单张统计卡片（标签 + 数值 + 进度条） */
    private renderStatCard(
        parent: HTMLElement,
        opts: {
            label: string;
            values: { text: string; cls: string }[];
            ratio: number;
            barCls: string;
            size: 'large' | 'small';
        },
    ) {
        const card = parent.createDiv({ cls: `today-stat-card is-${opts.size}` });
        card.createDiv({ cls: 'today-stat-label', text: opts.label });

        const valueRow = card.createDiv({ cls: 'today-stat-values' });
        opts.values.forEach((v, i) => {
            if (i > 0) valueRow.createSpan({ cls: 'today-stat-sep', text: '/' });
            valueRow.createSpan({ cls: `today-stat-value ${v.cls}`, text: v.text });
        });

        const bar = card.createDiv({ cls: 'today-stat-bar' });
        const fill = bar.createDiv({ cls: `today-stat-bar-fill ${opts.barCls}` });
        const pct = Math.max(0, Math.min(1, opts.ratio)) * 100;
        fill.setCssProps({ '--stat-fill': `${pct}%` });
    }

    /**
     * 判定一条执行记录的状态（仅两种）：
     * - 已执行：关联了计划事件，或来源任务当天有习惯任务 / 当天任务（即计划内的任务）
     * - 新增：计划外的任务被执行
     */
    private getExecStatus(ex: ExecutionRecord, dayEvents: EventBlock[]): 'executed' | 'added' {
        if (ex.eventId) return 'executed';
        if (ex.inboxId && dayEvents.some(ev => ev.inboxId === ex.inboxId)) return 'executed';
        return 'added';
    }

    /** 统计当前查看日期的日目标完成情况（含全天事件） */
    private computeDayStats(): {
        total: number;
        planned: number;
        executed: number;
        added: number;
    } {
        const { day, weekKey } = this.getViewDayInfo();
        const executions = this.getExecutions();

        // 当前查看日期的计划事件（含全天）
        const events = this.getEvents().filter(ev =>
            ev.day === day && ev.weekKey === weekKey,
        );

        let planned = 0;
        let executed = 0;
        for (const ev of events) {
            const status = getEventStatus(ev, executions);
            if (status === 'executed') executed++;
            else planned++;
        }

        // 新增：计划外任务的执行记录
        const added = executions.filter(ex =>
            ex.day === day
            && ex.weekKey === weekKey
            && this.getExecStatus(ex, events) === 'added',
        ).length;

        return { total: events.length, planned, executed, added };
    }

    /** 渲染任务层级方框（展示当前任务的所有父级任务树） */
    private renderHierarchyBox(panel: HTMLElement) {
        // 当前任务：优先时间轴选中事件的来源任务，其次任务面板选中任务
        const selectedEvent = this.selectedEventId
            ? this.getEvents().find(ev => ev.id === this.selectedEventId)
            : undefined;
        const currentItem = selectedEvent?.inboxId
            ? this.inboxData.items.find(i => i.id === selectedEvent.inboxId && !i.removed)
            : this.getSelectedItem();

        // 无当前任务时不显示层级方框
        if (!currentItem) return;

        const box = panel.createDiv({ cls: 'today-hierarchy-box' });
        box.createDiv({ cls: 'today-hierarchy-title', text: t('today.hierarchyTitle') });

        const body = box.createDiv({ cls: 'today-hierarchy-body' });

        // 沿 parentId 向上收集父级链（从当前任务到顶层）
        const chain: InboxItem[] = [];
        let cursor: InboxItem | undefined = currentItem;
        const visited = new Set<string>();
        while (cursor && !visited.has(cursor.id)) {
            visited.add(cursor.id);
            chain.push(cursor);
            cursor = cursor.parentId
                ? this.inboxData.items.find(i => i.id === cursor!.parentId && !i.removed)
                : undefined;
        }
        // 反转：从顶层父级到当前任务
        chain.reverse();

        chain.forEach((item, index) => {
            const isCurrent = item.id === currentItem.id;
            const row = body.createDiv({ cls: 'today-hierarchy-item' });
            row.setCssProps({ '--hierarchy-depth': String(index) });
            if (isCurrent) row.addClass('is-current');

            // 层级连接符
            row.createSpan({ cls: 'today-hierarchy-branch', text: index === 0 ? '' : '└' });

            // 分类色点
            const cat = item.categoryId
                ? this.categoryData.categories.find(c => c.id === item.categoryId)
                : undefined;
            if (cat) {
                const dot = row.createSpan({ cls: 'inbox-category-dot' });
                dot.setCssProps({ '--dot-color': cat.color });
            }

            row.createSpan({ cls: 'today-hierarchy-name', text: item.title });
        });
    }

    /**
     * 进行中任务进度方框：仅在选中「进行中任务」时显示（位于任务层级方框下方）。
     * 从左到右展示进度：左侧为起始时间点，右侧为不断增加的末尾时间点。
     */
    private renderRunningProgressBox(panel: HTMLElement) {
        const running = this.runningTask;
        if (!running || !this.selectedRunningTask) return;
        // 仅当进行中任务属于当前查看日期时显示
        const { dayKey } = this.getViewDayInfo();
        if (running.dayKey !== dayKey) return;

        const item = this.inboxData.items.find(i => i.id === running.inboxId && !i.removed);
        if (!item) return;

        const box = panel.createDiv({ cls: 'today-running-progress-box' });
        box.createDiv({ cls: 'today-running-progress-title', text: t('today.runningProgressTitle') });

        const body = box.createDiv({ cls: 'today-running-progress-body' });

        // 进度条：左侧起始时间，右侧当前（末尾）时间
        const bar = body.createDiv({ cls: 'today-running-progress-bar' });
        bar.createSpan({ cls: 'today-running-progress-start', text: formatMinutes(running.start) });
        const track = bar.createDiv({ cls: 'today-running-progress-track' });
        track.createDiv({ cls: 'today-running-progress-fill' });
        bar.createSpan({ cls: 'today-running-progress-end', text: formatMinutes(this.nowMinutes()) });
    }

    /** 是否存在选中项（时间轴事件 / 新增执行记录 / 进行中任务 / 任务面板任务） */
    private hasSelection(): boolean {
        if (this.selectedEventId) return true;
        if (this.selectedExecId) return true;
        if (this.selectedRunningTask && this.runningTask) return true;
        return !!this.getSelectedItem();
    }

    /** 渲染任务详情方框（展示左侧选中任务或时间轴选中事件的详情） */
    private renderDetailBox(panel: HTMLElement) {
        const box = panel.createDiv({ cls: 'today-detail-box' });

        // 优先展示时间轴上选中的事件；否则展示任务面板选中的任务
        const selectedEvent = this.selectedEventId
            ? this.getEvents().find(ev => ev.id === this.selectedEventId)
            : undefined;
        const selectedExec = this.selectedExecId
            ? this.getExecutions().find(ex => ex.id === this.selectedExecId)
            : undefined;
        const selectedItem = this.inboxData.selectedId
            ? this.inboxData.items.find(i => i.id === this.inboxData.selectedId && !i.removed)
            : undefined;

        // 当前项目：优先选中任务，其次进行中任务，再次事件/执行记录来源任务
        const currentProjectId = selectedItem?.id
            ?? (this.selectedRunningTask && this.runningTask
                ? this.inboxData.items.find(i => i.id === this.runningTask!.inboxId && !i.removed)?.id
                : undefined)
            ?? (selectedEvent?.inboxId
                ? this.inboxData.items.find(i => i.id === selectedEvent.inboxId && !i.removed)?.id
                : undefined)
            ?? (selectedExec?.inboxId
                ? this.inboxData.items.find(i => i.id === selectedExec.inboxId && !i.removed)?.id
                : undefined);

        // 标题栏：左侧标题 + 右上角「进入项目全景图」按钮
        const titleRow = box.createDiv({ cls: 'today-detail-title-row' });
        titleRow.createDiv({ cls: 'today-detail-title', text: t('today.detailTitle') });
        if (currentProjectId && this.onNavigateToProjectPicture) {
            const navBtn = titleRow.createEl('button', {
                cls: 'today-detail-nav-btn',
                text: t('today.enterProjectPicture'),
            });
            navBtn.onclick = (e) => {
                e.stopPropagation();
                this.onNavigateToProjectPicture?.(currentProjectId);
            };
        }

        const body = box.createDiv({ cls: 'today-detail-body' });

        // 选中「进行中任务」：展示其来源任务详情
        const runningItem = this.selectedRunningTask && this.runningTask
            ? this.inboxData.items.find(i => i.id === this.runningTask!.inboxId && !i.removed)
            : undefined;

        if (runningItem) {
            // 进行中任务：不显示待执行时间编辑器（已在执行中）
            this.renderItemDetail(body, runningItem, false);
        } else if (selectedEvent) {
            this.renderEventDetail(body, selectedEvent);
        } else if (selectedExec) {
            this.renderExecDetail(body, selectedExec);
        } else if (selectedItem) {
            this.renderItemDetail(body, selectedItem);
        } else {
            body.createDiv({ cls: 'today-detail-empty', text: t('today.noSelection') });
        }

        // 方框底部操作按钮
        this.renderActionButtons(box);
    }

    /**
     * 渲染「执行非计划事件方框」（点击时间轴触发，占据任务详情方框的位置）。
     * 顶部为等待选择任务的提示框，下方为事件时间区间（起始时间由点击位置换算，时长可填写）。
     */
    private renderAddUnplannedBox(panel: HTMLElement) {
        const box = panel.createDiv({ cls: 'today-detail-box today-addunplanned-box' });
        const titleRow = box.createDiv({ cls: 'today-detail-title-row' });
        titleRow.createDiv({ cls: 'today-detail-title', text: t('today.detailTitle') });

        const body = box.createDiv({ cls: 'today-detail-body' });

        // 顶部：等待选择任务的方框
        const item = this.getSelectedItem();
        const picker = body.createDiv({ cls: 'today-addunplanned-picker' });
        if (item) {
            const cat = item.categoryId
                ? this.categoryData.categories.find(c => c.id === item.categoryId)
                : undefined;
            if (cat) {
                const dot = picker.createSpan({ cls: 'inbox-category-dot' });
                dot.setCssProps({ '--dot-color': cat.color });
            }
            picker.createSpan({ cls: 'today-addunplanned-name', text: item.title });
        } else {
            picker.createDiv({ cls: 'today-addunplanned-hint', text: t('today.addUnplannedHint') });
        }

        // 时间区间：起始 / 结束 / 时长 三个输入框，改任一个联动更新其余
        this.renderTimeRangeEditor(
            body,
            this.addUnplannedStart,
            this.addUnplannedStart + this.addUnplannedDuration,
            (start, end) => {
                this.addUnplannedStart = start;
                this.addUnplannedDuration = Math.max(5, end - start);
                void this.refresh();
            },
        );

        // 方框底部操作按钮：确认新增 / 取消
        this.renderActionButtons(box);
    }

    /**
     * 渲染时间区间编辑器：起始时间 / 结束时间 / 时长。
     * 起始、结束时间采用「习惯时间点」的小时 / 分钟下拉方式，时长采用「预估执行时长」的输入框方式。
     * 修改任一项时联动更新其余两项（以起始时间为锚点，结束 = 起始 + 时长）。
     * onChange 回调返回规范化后的 (start, end)（分钟）。
     */
    private renderTimeRangeEditor(
        container: HTMLElement,
        start: number,
        end: number,
        onChange: (start: number, end: number) => void,
    ): void {
        const clamp = (v: number) => Math.max(0, Math.min(24 * 60, Math.round(v)));

        const editor = container.createDiv({ cls: 'today-time-editor' });

        // 小时 / 分钟下拉（与「习惯时间点」一致；分钟以 5 为步长，并保留当前分钟以保证选中值有效）
        const buildTimeSelects = (
            parent: HTMLElement,
            minutes: number,
            onApply: (value: number) => void,
        ) => {
            const group = parent.createDiv({ cls: 'task-plan-habit-group' });
            const hourSelect = group.createEl('select', { cls: 'task-plan-habit-select' });
            for (let h = 0; h < 24; h++) {
                hourSelect.createEl('option', { text: String(h).padStart(2, '0'), value: `${h}` });
            }
            hourSelect.value = `${Math.floor(minutes / 60)}`;

            group.createSpan({ cls: 'task-plan-habit-sep', text: ':' });

            const minuteSelect = group.createEl('select', { cls: 'task-plan-habit-select' });
            const minuteSet = new Set<number>();
            for (let m = 0; m < 60; m += 5) minuteSet.add(m);
            minuteSet.add(minutes % 60);
            for (const m of Array.from(minuteSet).sort((a, b) => a - b)) {
                minuteSelect.createEl('option', { text: String(m).padStart(2, '0'), value: `${m}` });
            }
            minuteSelect.value = `${minutes % 60}`;

            const apply = () => onApply(clamp(Number(hourSelect.value) * 60 + Number(minuteSelect.value)));
            hourSelect.onchange = apply;
            minuteSelect.onchange = apply;
        };

        // 第一行：起始时间 → 结束时间
        const rangeRow = editor.createDiv({ cls: 'today-time-range' });

        const startField = rangeRow.createDiv({ cls: 'today-time-field' });
        startField.createDiv({ cls: 'today-time-field-label', text: t('today.startTime') });
        buildTimeSelects(startField, start, (value) => {
            // 修改起始时间：保持时长不变，结束时间随之平移
            const duration = Math.max(5, end - start);
            onChange(value, clamp(value + duration));
        });

        rangeRow.createSpan({ cls: 'today-time-arrow', text: '→' });

        const endField = rangeRow.createDiv({ cls: 'today-time-field' });
        endField.createDiv({ cls: 'today-time-field-label', text: t('today.endTime') });
        buildTimeSelects(endField, end, (value) => {
            // 修改结束时间：起始时间不变，时长随之变化
            onChange(start, Math.max(start + 5, value));
        });

        // 第二行：时长（小时 / 分钟输入框，与「预估执行时长」一致）
        const durationRow = editor.createDiv({ cls: 'today-time-duration' });
        durationRow.createDiv({ cls: 'today-time-field-label', text: t('today.addUnplannedDuration') });
        const durationGroup = durationRow.createDiv({ cls: 'task-plan-habit-input-group' });

        const duration = Math.max(0, end - start);
        const durHourInput = durationGroup.createEl('input', {
            cls: 'task-plan-habit-input',
            type: 'number',
            attr: { min: '0', step: '1' },
        });
        durHourInput.value = String(Math.floor(duration / 60));
        durationGroup.createSpan({ cls: 'task-plan-habit-unit', text: t('weekPanel.hourUnit') });

        const durMinuteInput = durationGroup.createEl('input', {
            cls: 'task-plan-habit-input',
            type: 'number',
            attr: { min: '0', step: '5' },
        });
        durMinuteInput.value = String(duration % 60);
        durationGroup.createSpan({ cls: 'task-plan-habit-unit', text: t('weekPanel.minuteUnit') });

        const applyDuration = () => {
            const hour = Math.max(0, Math.floor(Number(durHourInput.value)) || 0);
            const minute = Math.max(0, Math.floor(Number(durMinuteInput.value)) || 0);
            // 修改时长：起始时间不变，结束时间随之变化
            onChange(start, clamp(start + Math.max(5, hour * 60 + minute)));
        };
        durHourInput.onchange = applyDuration;
        durMinuteInput.onchange = applyDuration;
    }

    /**
     * 渲染「今日各分类已执行时长」方框（位于周目标 / 日目标方框上方）。
     * 按分类聚合当前查看日期的执行记录时长，用横向条形图展示。
     */
    private renderCategoryDurationBox(panel: HTMLElement) {
        const { day, weekKey } = this.getViewDayInfo();
        const executions = this.getExecutions().filter(
            ex => ex.day === day && ex.weekKey === weekKey,
        );

        // 按分类聚合执行时长（分钟）
        const minutesByCat = new Map<string, number>();
        for (const ex of executions) {
            const item = ex.inboxId
                ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                : undefined;
            const catId = item?.categoryId ?? UNCATEGORIZED_CATEGORY_ID;
            const minutes = Math.max(0, ex.end - ex.start);
            minutesByCat.set(catId, (minutesByCat.get(catId) ?? 0) + minutes);
        }

        const box = panel.createDiv({ cls: 'today-cat-duration-box' });
        box.createDiv({ cls: 'today-cat-duration-title', text: t('today.categoryDurationTitle') });

        if (minutesByCat.size === 0) {
            box.createDiv({ cls: 'today-cat-duration-empty', text: t('today.categoryDurationEmpty') });
            return;
        }

        // 按分类顺序排列，仅显示有时长的分类
        const rows = this.categoryData.categories
            .map(cat => ({ cat, minutes: minutesByCat.get(cat.id) ?? 0 }))
            .filter(r => r.minutes > 0);

        const chart = box.createDiv({ cls: 'today-cat-duration-chart' });
        for (const { cat, minutes } of rows) {
            const row = chart.createDiv({ cls: 'today-cat-duration-row' });
            row.createDiv({ cls: 'today-cat-duration-label', text: cat.label });
            // 用方块表示时长：每满 1 小时一个填满的方块，不足 1 小时的余数用部分填充的方块
            const blocks = row.createDiv({ cls: 'today-cat-duration-blocks' });
            const fullHours = Math.floor(minutes / 60);
            const remainder = minutes % 60;
            const blockCount = fullHours + (remainder > 0 ? 1 : 0);
            for (let i = 0; i < blockCount; i++) {
                const block = blocks.createDiv({ cls: 'today-cat-duration-block' });
                block.setCssProps({ '--block-color': cat.color ?? '#888888' });
                // 最后一个方块为不足 1 小时的余数时，按比例填充
                const isPartial = remainder > 0 && i === blockCount - 1;
                const fillPercent = isPartial ? Math.round((remainder / 60) * 100) : 100;
                const fill = block.createDiv({ cls: 'today-cat-duration-block-fill' });
                fill.setCssProps({ '--fill-width': `${fillPercent}%` });
            }
            row.createDiv({ cls: 'today-cat-duration-value', text: formatHours(minutes) });
        }
    }

    /**
     * 生成 SVG 饼图扇区路径（从 12 点方向顺时针计算角度）。
     * 角度跨度为 360° 时返回整圆路径。
     */
    private describePieSlice(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
        const span = endDeg - startDeg;
        if (span >= 359.999) {
            return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`;
        }
        const toPoint = (deg: number) => {
            const rad = ((deg - 90) * Math.PI) / 180;
            return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
        };
        const p0 = toPoint(startDeg);
        const p1 = toPoint(endDeg);
        const largeArc = span > 180 ? 1 : 0;
        return `M ${cx} ${cy} L ${p0.x} ${p0.y} A ${r} ${r} 0 ${largeArc} 1 ${p1.x} ${p1.y} Z`;
    }

    /**
     * 渲染「今日任务占比」方框：左侧为当天所有执行记录拼成的饼图，
     * 右侧为各任务的执行时长列表。饼图扇区按任务聚合，颜色取任务所属分类色。
     */
    private renderTaskShareBox(panel: HTMLElement) {
        const { day, weekKey } = this.getViewDayInfo();
        const executions = this.getExecutions().filter(
            ex => ex.day === day && ex.weekKey === weekKey,
        );

        const box = panel.createDiv({ cls: 'today-task-share-box' });
        box.createDiv({ cls: 'today-cat-duration-title', text: t('today.taskShareTitle') });

        if (executions.length === 0) {
            box.createDiv({ cls: 'today-cat-duration-empty', text: t('today.taskShareEmpty') });
            return;
        }

        // 按任务聚合执行时长（分钟），保持首次出现顺序
        const minutesByTask = new Map<string, number>();
        for (const ex of executions) {
            const key = ex.inboxId ?? ex.eventId ?? ex.id;
            const minutes = Math.max(0, ex.end - ex.start);
            minutesByTask.set(key, (minutesByTask.get(key) ?? 0) + minutes);
        }

        const totalMinutes = Array.from(minutesByTask.values()).reduce((a, b) => a + b, 0);
        if (totalMinutes <= 0) {
            box.createDiv({ cls: 'today-cat-duration-empty', text: t('today.taskShareEmpty') });
            return;
        }

        const content = box.createDiv({ cls: 'today-task-share-content' });

        // 左侧饼图：用 SVG 绘制扇区，扇区只填充不描边；
        // 相邻扇区的分界处另画白色半径线段，形成等宽隔离带（圆周不留白边）
        const pie = content.createDiv({ cls: 'today-task-share-pie' });
        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('class', 'today-task-share-svg');
        pie.appendChild(svg);

        const cx = 50;
        const cy = 50;
        const r = 50;
        const dividerWidth = 2;
        const slices: { label: string; midDeg: number; ratio: number }[] = [];
        let acc = 0;
        for (const [taskId, minutes] of Array.from(minutesByTask.entries())) {
            const item = this.inboxData.items.find(i => i.id === taskId && !i.removed);
            const cat = item?.categoryId
                ? this.categoryData.categories.find(c => c.id === item.categoryId)
                : undefined;
            const color = cat?.color ?? '#888888';
            const startDeg = (acc / totalMinutes) * 360;
            acc += minutes;
            const endDeg = (acc / totalMinutes) * 360;

            const path = document.createElementNS(svgNs, 'path');
            path.setAttribute('d', this.describePieSlice(cx, cy, r, startDeg, endDeg));
            path.setAttribute('fill', color);
            svg.appendChild(path);

            slices.push({
                label: item?.title ?? t('inbox.noCategory'),
                midDeg: (startDeg + endDeg) / 2,
                ratio: minutes / totalMinutes,
            });
        }

        // 分界白线：沿每条分界半径从圆心画到圆周（单扇区无需分界）
        if (minutesByTask.size > 1) {
            let boundaryDeg = 0;
            for (const minutes of Array.from(minutesByTask.values())) {
                const rad = ((boundaryDeg - 90) * Math.PI) / 180;
                const line = document.createElementNS(svgNs, 'line');
                line.setAttribute('x1', String(cx));
                line.setAttribute('y1', String(cy));
                line.setAttribute('x2', String(cx + r * Math.cos(rad)));
                line.setAttribute('y2', String(cy + r * Math.sin(rad)));
                line.setAttribute('stroke', '#ffffff');
                line.setAttribute('stroke-width', String(dividerWidth));
                svg.appendChild(line);
                boundaryDeg += (minutes / totalMinutes) * 360;
            }
        }

        // 扇形上的任务名标签：按扇区中心角度定位，占比过小的扇区不显示文字
        for (const slice of slices) {
            if (slice.ratio < 0.06) continue;
            const label = pie.createDiv({ cls: 'today-task-share-slice-label', text: slice.label });
            label.setCssProps({ '--slice-angle': `${slice.midDeg}deg` });
        }

        // 右侧：各任务时长列表（按时长从多到少排序）
        const list = content.createDiv({ cls: 'today-task-share-list' });
        const sortedEntries = Array.from(minutesByTask.entries()).sort((a, b) => b[1] - a[1]);
        for (const [taskId, minutes] of sortedEntries) {
            const item = this.inboxData.items.find(i => i.id === taskId && !i.removed);
            const cat = item?.categoryId
                ? this.categoryData.categories.find(c => c.id === item.categoryId)
                : undefined;
            const color = cat?.color ?? '#888888';
            const label = item?.title ?? t('inbox.noCategory');

            const row = list.createDiv({ cls: 'today-task-share-row' });
            const dot = row.createSpan({ cls: 'today-task-share-dot' });
            dot.setCssProps({ '--dot-color': color });
            row.createSpan({ cls: 'today-task-share-name', text: label });
            row.createSpan({ cls: 'today-task-share-value', text: formatHours(minutes) });
        }
    }

    /**
     * 渲染「今日目标」方框（「今日情况」选项卡底部）。
     * 列出今日安排的习惯任务与当天任务（复用左侧当天任务面板的卡片样式）。
     */
    private renderTodayGoalBox(panel: HTMLElement) {
        const { day, weekKey } = this.getViewDayInfo();

        // 当天计划事件（统一为全天事件）
        const dayEvents = this.getEvents()
            .filter(ev => ev.day === day && ev.weekKey === weekKey);

        // 习惯时间点任务与当天任务拆分（与左侧当天任务面板一致）
        const habitEvents = dayEvents
            .filter(ev => this.getEventHabitTime(ev) !== null)
            .sort((a, b) => (this.getEventHabitTime(a) ?? 0) - (this.getEventHabitTime(b) ?? 0));
        const normalEvents = this.groupEventsByCategory(
            dayEvents.filter(ev => this.getEventHabitTime(ev) === null),
        );

        const box = panel.createDiv({ cls: 'today-goal-box' });
        box.createDiv({ cls: 'today-cat-duration-title', text: t('today.todayGoalTitle') });

        if (habitEvents.length === 0 && normalEvents.length === 0) {
            box.createDiv({ cls: 'today-cat-duration-empty', text: t('today.todayGoalEmpty') });
            return;
        }

        // 渲染单个目标事件卡片（复用 renderTaskCard）
        const renderGoalEvent = (list: HTMLElement, ev: EventBlock) => {
            const item = ev.inboxId
                ? this.inboxData.items.find(i => i.id === ev.inboxId && !i.removed)
                : undefined;
            const cat = ev.categoryId
                ? this.categoryData.categories.find(c => c.id === ev.categoryId)
                : undefined;
            const estMinutes = typeof ev.estimatedMinutes === 'number' && ev.estimatedMinutes >= 0
                ? ev.estimatedMinutes
                : undefined;
            const viewInfo = this.getViewDayInfo();
            const execMinutes = this.getExecutions()
                .filter(ex => !ex.replaced
                    && ex.weekKey === viewInfo.weekKey
                    && ex.day === viewInfo.day
                    && (ex.eventId === ev.id || (ev.inboxId && ex.inboxId === ev.inboxId)))
                .reduce((sum, ex) => sum + Math.max(0, ex.end - ex.start), 0);

            this.renderTaskCard(list, {
                title: ev.title,
                color: cat?.color,
                estMinutes,
                execMinutes,
                done: item ? this.isDayTaskDone(item.id) : undefined,
                habitTime: this.getEventHabitTime(ev) ?? undefined,
                selected: !!item && this.inboxData.selectedId === item.id,
                onSelect: () => this.selectTaskItem(item),
            });
        };

        // 习惯任务
        if (habitEvents.length > 0) {
            box.createDiv({ cls: 'today-task-list-title', text: t('today.habitTaskListTitle') });
            const habitList = box.createDiv({ cls: 'today-task-list' });
            for (const ev of habitEvents) renderGoalEvent(habitList, ev);
        }

        // 当天任务
        if (normalEvents.length > 0) {
            box.createDiv({
                cls: habitEvents.length > 0 ? 'today-task-list-title is-added' : 'today-task-list-title',
                text: t('today.taskListTitle'),
            });
            const list = box.createDiv({ cls: 'today-task-list' });
            for (const ev of normalEvents) renderGoalEvent(list, ev);
        }
    }

    /**
     * 渲染「周目标」方框（「本周情况」选项卡）。
     * 列出已分配到当前查看日期所在周的任务，卡片显示任务名 + 本周已分配时长 / 次数。
     */
    private renderWeekGoalBox(panel: HTMLElement) {
        const { weekKey } = this.getViewDayInfo();

        const box = panel.createDiv({ cls: 'today-week-goal-box' });
        box.createDiv({ cls: 'today-week-goal-title', text: t('inbox.weekGoal') });

        // 已分配到本周的未移除任务
        const assignedItems = this.inboxData.items.filter(i =>
            !i.removed && (i.assignedWeekKeys ?? []).includes(weekKey),
        );
        if (assignedItems.length === 0) {
            box.createDiv({ cls: 'today-week-goal-empty', text: t('inbox.emptyWeekGoal') });
            return;
        }

        const cardList = box.createDiv({ cls: 'week-goal-card-list' });
        for (const item of assignedItems) {
            const card = cardList.createDiv({ cls: 'week-goal-card' });

            // 选中态高亮（与任务面板一致）
            if (this.inboxData.selectedId === item.id) card.addClass('selected');

            // 分类色点
            if (item.categoryId) {
                const cat = this.categoryData.categories.find(c => c.id === item.categoryId);
                if (cat) {
                    const dot = card.createSpan({ cls: 'inbox-category-dot' });
                    dot.setCssProps({ '--dot-color': cat.color });
                }
            }

            // 任务名称
            card.createDiv({ cls: 'week-goal-card-title', text: item.title });

            // 右上角：拥有的板块类型图标
            if (item.sections && item.sections.length > 0) {
                const iconsEl = card.createDiv({ cls: 'week-goal-card-section-icons' });
                for (const section of item.sections) {
                    const chip = iconsEl.createSpan({ cls: 'inbox-section-chip' });
                    setIcon(chip, SECTION_TYPE_META[section.type].icon);
                }
            }

            // 统计本周已分配的计划事件：时长（预估执行时长累加）与次数
            let totalMinutes = 0;
            let count = 0;
            for (const ev of this.getEvents()) {
                if (ev.inboxId === item.id && ev.weekKey === weekKey) {
                    totalMinutes += Math.max(0, ev.estimatedMinutes ?? 0);
                    count += 1;
                }
            }

            const meta = card.createDiv({ cls: 'week-goal-card-meta' });
            meta.createSpan({ cls: 'week-goal-card-assigned-label', text: t('inbox.weekGoalAssigned') });

            const durationEl = meta.createSpan({ cls: 'week-goal-card-duration' });
            durationEl.createSpan({ text: t('inbox.weekGoalDurationLabel') });
            durationEl.createSpan({ cls: 'week-goal-card-value', text: formatDuration(totalMinutes) });

            const countEl = meta.createSpan({ cls: 'week-goal-card-count' });
            countEl.createSpan({ text: t('inbox.weekGoalCountLabel') });
            countEl.createSpan({ cls: 'week-goal-card-value', text: `x${count}` });

            // 点击选中/取消选中该任务
            card.onclick = (e) => {
                e.stopPropagation();
                this.selectTaskItem(item);
            };
        }
    }

    /**
     * 渲染「本周各分类已执行时长」方框（「本周情况」选项卡）。
     * 按分类聚合当前查看日期所在周的执行记录时长，展示方式与「今日情况」一致。
     */
    private renderWeekCategoryDurationBox(panel: HTMLElement) {
        const { weekKey } = this.getViewDayInfo();
        const executions = this.getExecutions().filter(ex => ex.weekKey === weekKey);

        // 按分类聚合执行时长（分钟）
        const minutesByCat = new Map<string, number>();
        for (const ex of executions) {
            const item = ex.inboxId
                ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                : undefined;
            const catId = item?.categoryId ?? UNCATEGORIZED_CATEGORY_ID;
            const minutes = Math.max(0, ex.end - ex.start);
            minutesByCat.set(catId, (minutesByCat.get(catId) ?? 0) + minutes);
        }

        const box = panel.createDiv({ cls: 'today-cat-duration-box' });
        box.createDiv({ cls: 'today-cat-duration-title', text: t('today.weekCategoryDurationTitle') });

        if (minutesByCat.size === 0) {
            box.createDiv({ cls: 'today-cat-duration-empty', text: t('today.weekCategoryDurationEmpty') });
            return;
        }

        // 按分类顺序排列，仅显示有时长的分类
        const rows = this.categoryData.categories
            .map(cat => ({ cat, minutes: minutesByCat.get(cat.id) ?? 0 }))
            .filter(r => r.minutes > 0);

        const chart = box.createDiv({ cls: 'today-cat-duration-chart' });
        for (const { cat, minutes } of rows) {
            const row = chart.createDiv({ cls: 'today-cat-duration-row' });
            row.createDiv({ cls: 'today-cat-duration-label', text: cat.label });
            // 用方块表示时长：每满 1 小时一个填满的方块，不足 1 小时的余数用部分填充的方块
            const blocks = row.createDiv({ cls: 'today-cat-duration-blocks' });
            const fullHours = Math.floor(minutes / 60);
            const remainder = minutes % 60;
            const blockCount = fullHours + (remainder > 0 ? 1 : 0);
            for (let i = 0; i < blockCount; i++) {
                const block = blocks.createDiv({ cls: 'today-cat-duration-block' });
                block.setCssProps({ '--block-color': cat.color ?? '#888888' });
                // 最后一个方块为不足 1 小时的余数时，按比例填充
                const isPartial = remainder > 0 && i === blockCount - 1;
                const fillPercent = isPartial ? Math.round((remainder / 60) * 100) : 100;
                const fill = block.createDiv({ cls: 'today-cat-duration-block-fill' });
                fill.setCssProps({ '--fill-width': `${fillPercent}%` });
            }
            row.createDiv({ cls: 'today-cat-duration-value', text: formatHours(minutes) });
        }
    }

    /**
     * 渲染方框底部的操作按钮：5 行字体高的方块，图标居中、文字在下，从左到右排列。
     * 按钮集合随选中目标变化（进行中任务 / 执行记录 / 新增非计划 / 时间轴事件 / 左侧任务）。
     */
    private renderActionButtons(box: HTMLElement) {
        const selectedEvent = this.getSelectedEvent();
        const selectedItem = this.getSelectedItem();
        const actions: {
            labelKey: Parameters<typeof t>[0];
            icon: string;
            kind?: 'cta' | 'warning';
            disabled?: boolean;
            onClick: () => void;
        }[] = [];

        // 选中「进行中任务」色块：完成 / 中断（两者都会写入一条执行记录）
        if (this.selectedRunningTask && this.runningTask) {
            actions.push({
                labelKey: 'today.finishRunning',
                icon: 'check',
                kind: 'cta',
                onClick: () => {
                    void this.finishRunningTask();
                },
            });
            actions.push({
                labelKey: 'today.interruptRunning',
                icon: 'pause',
                kind: 'warning',
                onClick: () => {
                    void this.interruptRunningTask();
                },
            });
        } else if (this.selectedExecId) {
            // 选中「新增」执行记录：删除
            actions.push({
                labelKey: 'today.deleteExec',
                icon: 'trash-2',
                kind: 'warning',
                onClick: () => {
                    void this.deleteSelectedExec();
                },
            });
        } else if (this.addUnplannedMode) {
            // 额外任务（新增非计划事件）：开始任务 / 已完成任务 / 取消
            actions.push({
                labelKey: 'today.startTask',
                icon: 'play',
                kind: 'cta',
                // 必须先在左侧选中任务，才能开始
                disabled: !selectedItem,
                onClick: () => {
                    this.startUnplannedTask();
                },
            });
            actions.push({
                labelKey: 'today.finishTask',
                icon: 'check',
                disabled: !selectedItem,
                onClick: () => {
                    void this.confirmAddUnplanned();
                },
            });
            actions.push({
                labelKey: 'today.addUnplannedCancel',
                icon: 'x',
                onClick: () => {
                    this.cancelAddUnplanned();
                },
            });
        } else if (selectedEvent) {
            if (this.executingEventId === selectedEvent.id) {
                // 正在执行：完成执行 / 取消执行
                actions.push({
                    labelKey: 'today.finishExec',
                    icon: 'check',
                    kind: 'cta',
                    onClick: () => {
                        void this.finishExecuting();
                    },
                });
                actions.push({
                    labelKey: 'today.cancelExec',
                    icon: 'x',
                    onClick: () => {
                        this.cancelExecuting();
                    },
                });
            } else {
                // 仅「计划」状态显示「执行计划」按钮
                if (getEventStatus(selectedEvent, this.getExecutions()) === 'planned') {
                    actions.push({
                        labelKey: 'today.execPlanned',
                        icon: 'play',
                        onClick: () => {
                            void this.executePlannedEvent();
                        },
                    });
                }
                // 进入执行：切换当前任务的「正在执行」状态
                actions.push({
                    labelKey: 'today.enterExec',
                    icon: 'zap',
                    onClick: () => {
                        this.toggleExecuting(selectedEvent.id);
                    },
                });
            }
        } else if (selectedItem && this.rightTab !== 'today') {
            // 选中左侧任务：开始任务（「今日情况」选项卡下不显示）
            actions.push({
                labelKey: 'today.startTask',
                icon: 'play',
                kind: 'cta',
                onClick: () => {
                    this.startRunningTask();
                },
            });
        }

        // 无可执行操作时不渲染按钮行，避免方框底部出现空白条
        if (actions.length === 0) return;

        const row = box.createDiv({ cls: 'today-action-row' });
        for (const action of actions) {
            const btn = row.createEl('button', { cls: 'today-action-block' });
            if (action.kind === 'cta') btn.addClass('is-cta');
            if (action.kind === 'warning') btn.addClass('is-warning');
            btn.disabled = !!action.disabled;
            const iconEl = btn.createSpan({ cls: 'today-action-block-icon' });
            setIcon(iconEl, action.icon);
            btn.createSpan({ cls: 'today-action-block-label', text: t(action.labelKey) });
            btn.onclick = action.onClick;
        }
    }

    /**
     * 按天数偏移切换查看日期（delta 为 -1 表示前一天，+1 表示后一天）。
     * 切换后清除所有选中状态，避免详情方框残留旧数据。
     */
    private shiftViewDate(delta: number): void {
        const d = new Date(this.viewDate);
        d.setDate(d.getDate() + delta);
        this.viewDate = d;
        this.selectedEventId = undefined;
        this.selectedExecId = undefined;
        this.clearInboxSelection();
        void this.refresh();
    }

    /** 当前时间轴上选中的事件 */
    private getSelectedEvent(): EventBlock | undefined {
        return this.selectedEventId
            ? this.getEvents().find(ev => ev.id === this.selectedEventId)
            : undefined;
    }

    /** 当前任务面板选中的任务（未移除） */
    private getSelectedItem(): InboxItem | undefined {
        return this.inboxData.selectedId
            ? this.inboxData.items.find(i => i.id === this.inboxData.selectedId && !i.removed)
            : undefined;
    }

    /**
     * 开始任务：为左侧选中的任务创建一条「进行中」记录。
     * 在时间轴上以透明色块呈现，等待用户点击「完成」写入执行记录。
     * range 提供时以其时间区间为准（额外任务方框中填写的区间），否则取详情中编辑的时间。
     */
    private startRunningTask(range?: { start: number; end: number }): void {
        const item = this.getSelectedItem();
        if (!item) return;

        const { dayKey } = this.getViewDayInfo();
        // 起始时间取详情中编辑的起始时间（默认当前时刻）；结束时间取详情中编辑的结束时间
        this.runningTask = {
            inboxId: item.id,
            start: range?.start ?? this.detailStart,
            dayKey,
            end: range?.end ?? this.detailEnd,
        };
        // 写回插件数据源，随 saveAll 一起持久化
        this.pdcaRepo.setRunningTask(this.runningTask);
        // 开始后自动选中该进行中任务，便于直接点击「完成」
        this.selectedRunningTask = true;
        this.selectedEventId = undefined;
        this.selectedExecId = undefined;
        void this.save();
        this.onRunningTaskChange?.();
        void this.refresh();
    }

    /** 切换「进行中任务」色块的选中状态 */
    private toggleRunningTaskSelection(): void {
        this.selectedRunningTask = !this.selectedRunningTask;
        if (this.selectedRunningTask) {
            this.selectedEventId = undefined;
            this.selectedExecId = undefined;
            this.clearInboxSelection();
            // 选中进行中任务时自动切到「当天任务」选项卡（与选中事件/执行记录保持一致）
            this.rightTab = 'dayTasks';
        }
        void this.refresh();
    }

    /** 完成进行中任务：写入执行记录（start=开始时刻，end=当前时刻），并清除进行中状态 */
    private async finishRunningTask(): Promise<void> {
        const running = this.runningTask;
        if (!running) return;

        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const { day, weekKey } = this.getViewDayInfo();

        // 完成时：若实际经过时间小于用户填写的时长，则按填写的结束时间；否则按实际完成时刻
        const actualEnd = Math.max(running.start, nowMinutes);
        const plannedEnd = typeof running.end === 'number' ? running.end : actualEnd;
        const end = actualEnd < plannedEnd ? plannedEnd : actualEnd;

        this.pdcaRepo.addExecution({
            id: `exec_${Date.now()}`,
            inboxId: running.inboxId,
            day,
            start: running.start,
            end,
            weekKey,
        });
        const item = this.inboxData.items.find(i => i.id === running.inboxId && !i.removed);
        this.runningTask = undefined;
        this.pdcaRepo.setRunningTask(undefined);
        this.selectedRunningTask = false;
        await this.save();
        this.onRunningTaskChange?.();
        new Notice(t('today.completeDone', { title: item?.title ?? '' }));
        await this.refresh();
    }

    /** 中断进行中任务：写入执行记录（start=开始时刻，end=当前时刻），并清除进行中状态 */
    private async interruptRunningTask(): Promise<void> {
        const running = this.runningTask;
        if (!running) return;

        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const { day, weekKey } = this.getViewDayInfo();

        this.pdcaRepo.addExecution({
            id: `exec_${Date.now()}`,
            inboxId: running.inboxId,
            day,
            start: running.start,
            end: Math.max(running.start, nowMinutes),
            weekKey,
        });
        const item = this.inboxData.items.find(i => i.id === running.inboxId && !i.removed);
        this.runningTask = undefined;
        this.pdcaRepo.setRunningTask(undefined);
        this.selectedRunningTask = false;
        await this.save();
        this.onRunningTaskChange?.();
        new Notice(t('today.interruptDone', { title: item?.title ?? '' }));
        await this.refresh();
    }

    /** 进入「新增非计划事件」模式：记录点击时间轴换算出的起始分钟 */
    private startAddUnplanned(startMinutes: number): void {
        this.addUnplannedMode = true;
        this.addUnplannedStart = startMinutes;
        this.addUnplannedDuration = 30;
        // 与其它选中状态互斥
        this.selectedEventId = undefined;
        this.selectedExecId = undefined;
        // 点击时间轴空白新增时自动切到「额外任务」选项卡
        this.rightTab = 'extraTasks';
        void this.refresh();
    }

    /** 取消「新增非计划事件」 */
    private cancelAddUnplanned(): void {
        this.addUnplannedMode = false;
        // 取消后回到「今日情况」选项卡
        this.rightTab = 'today';
        void this.refresh();
    }

    /**
     * 额外任务方框中的「开始任务」：按方框内填写的时间区间开始执行左侧选中的任务，
     * 随后退出新增模式并切到「当天任务」选项卡（可直接点击「完成」写入执行记录）。
     */
    private startUnplannedTask(): void {
        const item = this.getSelectedItem();
        if (!item) return;

        const start = this.addUnplannedStart;
        const end = Math.min(24 * 60, start + this.addUnplannedDuration);
        this.addUnplannedMode = false;
        this.rightTab = 'dayTasks';
        this.startRunningTask({ start, end });
    }

    /** 确认新增非计划事件：用左侧选中任务生成一条执行记录 */
    private async confirmAddUnplanned(): Promise<void> {
        const item = this.getSelectedItem();
        if (!item) return;

        const { day, weekKey } = this.getViewDayInfo();
        const start = this.addUnplannedStart;
        const end = Math.min(24 * 60, start + this.addUnplannedDuration);

        this.pdcaRepo.addExecution({
            id: `exec_${Date.now()}`,
            inboxId: item.id,
            day,
            start,
            end,
            weekKey,
        });
        this.addUnplannedMode = false;
        // 新增完成后回到「今日情况」选项卡
        this.rightTab = 'today';
        await this.save();
        new Notice(t('today.completeDone', { title: item.title }));
        await this.refresh();
    }

    /** 执行计划：为时间轴上选中的事件生成一条执行记录 */
    private async executePlannedEvent(): Promise<void> {
        const ev = this.getSelectedEvent();
        if (!ev) return;

        const { day, weekKey } = this.getViewDayInfo();

        this.pdcaRepo.addExecution({
            id: `exec_${Date.now()}`,
            eventId: ev.id,
            inboxId: ev.inboxId,
            day,
            start: ev.start,
            end: ev.end,
            weekKey,
        });
        await this.save();
        new Notice(t('today.completeDone', { title: ev.title }));
        await this.refresh();
    }

    /**
     * 切换「正在执行」状态：点击「进入执行」时记录该事件为正在执行，
     * 再次点击时清除。仅影响顶部执行卡片，不写入执行记录。
     */
    private toggleExecuting(eventId: string): void {
        this.executingEventId = this.executingEventId === eventId ? undefined : eventId;
        this.pdcaRepo.setExecutingEventId(this.executingEventId);
        void this.save();
        void this.refresh();
    }

    /** 完成执行：为正在执行的事件写入执行记录，并清除「正在执行」状态 */
    private async finishExecuting(): Promise<void> {
        const ev = this.getSelectedEvent();
        if (!ev) return;

        const { day, weekKey } = this.getViewDayInfo();

        this.pdcaRepo.addExecution({
            id: `exec_${Date.now()}`,
            eventId: ev.id,
            inboxId: ev.inboxId,
            day,
            start: ev.start,
            end: ev.end,
            weekKey,
        });
        this.executingEventId = undefined;
        this.pdcaRepo.setExecutingEventId(undefined);
        await this.save();
        new Notice(t('today.completeDone', { title: ev.title }));
        await this.refresh();
    }

    /** 取消执行：清除「正在执行」状态，不写入执行记录 */
    private cancelExecuting(): void {
        this.executingEventId = undefined;
        this.pdcaRepo.setExecutingEventId(undefined);
        void this.save();
        void this.refresh();
    }

    /** 删除当前选中的执行记录 */
    private async deleteSelectedExec(): Promise<void> {
        if (!this.selectedExecId) return;
        this.pdcaRepo.removeExecution(this.selectedExecId);
        this.selectedExecId = undefined;
        await this.save();
        await this.refresh();
    }

    /**
     * 渲染详情方框中的任务名称行：左侧标题 + 右侧的「已完成」状态标记。
     * 已完成时显示放大的勾选图标，点击可重新标记为未完成；
     * 未完成时显示可点击的空勾选框，用于手动标记当天任务为已完成。
     * 判定规则与左侧当天任务卡片一致。
     */
    private renderDetailNameRow(container: HTMLElement, title: string, inboxId?: string): void {
        const row = container.createDiv({ cls: 'today-detail-name-row' });
        row.createDiv({ cls: 'today-detail-name', text: title });
        if (!inboxId) return;

        if (this.isDayTaskDone(inboxId)) {
            const doneIcon = row.createSpan({ cls: 'today-detail-done' });
            setIcon(doneIcon, 'check-circle');
            doneIcon.setAttribute('aria-label', t('today.unmarkDone'));
            doneIcon.onclick = (e) => {
                e.stopPropagation();
                void this.markTaskDayState(inboxId, false);
            };
            return;
        }

        // 未完成：空勾选框，点击后手动标记为「已完成」
        const toggleIcon = row.createSpan({ cls: 'today-detail-done-toggle' });
        setIcon(toggleIcon, 'square');
        toggleIcon.setAttribute('aria-label', t('today.markDone'));
        toggleIcon.onclick = (e) => {
            e.stopPropagation();
            void this.markTaskDayState(inboxId, true);
        };
    }

    /** 展示收集盒任务详情（showTimeEditor 为 true 时显示可编辑的待执行时间区间） */
    private renderItemDetail(body: HTMLElement, item: InboxItem, showTimeEditor = true) {
        this.renderDetailNameRow(body, item.title, item.id);
        body.createDiv({ cls: 'today-detail-desc' })
            .setText(item.description || t('today.noDescription'));

        // 时间区间：起始 / 结束 / 时长 三个输入框，改任一个联动更新其余
        // 切换任务时，起始时间默认取当前时刻，时长默认 30 分钟
        if (showTimeEditor) {
            if (this.lastDetailItemId !== item.id) {
                this.lastDetailItemId = item.id;
                const now = this.nowMinutes();
                this.detailStart = now;
                this.detailEnd = Math.min(24 * 60, now + 30);
            }
            this.renderTimeRangeEditor(body, this.detailStart, this.detailEnd, (start, end) => {
                this.detailStart = start;
                this.detailEnd = end;
                void this.refresh();
            });
        }

        const cat = item.categoryId
            ? this.categoryData.categories.find(c => c.id === item.categoryId)
            : undefined;
        if (cat) {
            const row = body.createDiv({ cls: 'today-detail-row' });
            row.createSpan({ cls: 'today-detail-label', text: `${t('today.category')}:` });
            const dot = row.createSpan({ cls: 'inbox-category-dot' });
            dot.setCssProps({ '--dot-color': cat.color });
            row.createSpan({ text: cat.label });
        }
    }

    /** 展示时间轴事件详情 */
    private renderEventDetail(body: HTMLElement, ev: EventBlock) {
        this.renderDetailNameRow(body, ev.title, ev.inboxId);

        const row = body.createDiv({ cls: 'today-detail-row' });
        row.createSpan({ cls: 'today-detail-label', text: `${t('today.timeRange')}:` });
        row.createSpan({ text: t('today.allDay') });

        const cat = ev.categoryId
            ? this.categoryData.categories.find(c => c.id === ev.categoryId)
            : undefined;
        if (cat) {
            const catRow = body.createDiv({ cls: 'today-detail-row' });
            catRow.createSpan({ cls: 'today-detail-label', text: `${t('today.category')}:` });
            const dot = catRow.createSpan({ cls: 'inbox-category-dot' });
            dot.setCssProps({ '--dot-color': cat.color });
            catRow.createSpan({ text: cat.label });
        }

        // 若事件来源于收集盒任务，补充任务描述
        const sourceItem = ev.inboxId
            ? this.inboxData.items.find(i => i.id === ev.inboxId && !i.removed)
            : undefined;
        if (sourceItem) {
            body.createDiv({ cls: 'today-detail-desc' })
                .setText(sourceItem.description || t('today.noDescription'));
        }
    }

    /** 展示「新增」执行记录详情 */
    private renderExecDetail(body: HTMLElement, ex: ExecutionRecord) {
        const item = ex.inboxId
            ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
            : undefined;
        this.renderDetailNameRow(body, item?.title ?? t('today.statusAdded'), item?.id);

        const row = body.createDiv({ cls: 'today-detail-row' });
        row.createSpan({ cls: 'today-detail-label', text: `${t('today.timeRange')}:` });
        row.createSpan({ text: `${formatMinutes(ex.start)} - ${formatMinutes(ex.end)}` });

        // 延长到现在：仅当该记录是当天最近一条执行记录时显示，
        // 点击后把终点时间更新为当前时间（不早于起始时间）
        if (this.isLatestExecOfDay(ex)) {
            const extendBtn = row.createEl('button', {
                cls: 'today-detail-extend-btn',
                text: t('today.extendToNow'),
            });
            extendBtn.onclick = (e) => {
                e.stopPropagation();
                void (async () => {
                    const now = new Date();
                    const nowMinutes = now.getHours() * 60 + now.getMinutes();
                    this.pdcaRepo.updateExecution(ex.id, {
                        end: Math.max(ex.start, Math.min(1440, nowMinutes)),
                    });
                    await this.save();
                    await this.refresh();
                })();
            };
        }

        // 时长（可编辑）：修改后按 start + 时长 重算 end，并保存刷新
        const durationRow = body.createDiv({ cls: 'today-detail-row' });
        durationRow.createSpan({ cls: 'today-detail-label', text: `${t('today.addUnplannedDuration')}:` });
        const durationInput = durationRow.createEl('input', {
            cls: 'today-detail-duration-input',
            type: 'number',
            attr: { min: '5', step: '5' },
        });
        durationInput.value = String(Math.max(0, ex.end - ex.start));
        durationInput.onchange = () => {
            void (async () => {
                const raw = durationInput.value.trim();
                const minutes = Math.max(5, Math.floor(Number(raw)));
                if (!Number.isFinite(minutes)) {
                    durationInput.value = String(Math.max(0, ex.end - ex.start));
                    return;
                }
                // 原地修改，保持数组引用不变（插件持有同一引用）
                this.pdcaRepo.updateExecution(ex.id, { end: Math.min(1440, ex.start + minutes) });
                await this.save();
                await this.refresh();
            })();
        };
        durationRow.createSpan({ cls: 'today-detail-label', text: t('today.addUnplannedMinutes') });

        const cat = item?.categoryId
            ? this.categoryData.categories.find(c => c.id === item.categoryId)
            : undefined;
        if (cat) {
            const catRow = body.createDiv({ cls: 'today-detail-row' });
            catRow.createSpan({ cls: 'today-detail-label', text: `${t('today.category')}:` });
            const dot = catRow.createSpan({ cls: 'inbox-category-dot' });
            dot.setCssProps({ '--dot-color': cat.color });
            catRow.createSpan({ text: cat.label });
        }

        if (item) {
            body.createDiv({ cls: 'today-detail-desc' })
                .setText(item.description || t('today.noDescription'));
        }
    }

    /**
     * 该执行记录是否为当前查看日期的「最近一条」执行记录。
     * 仅查看今天时才有意义（延长到现在只对当天有效）。
     */
    private isLatestExecOfDay(ex: ExecutionRecord): boolean {
        if (!this.isViewingToday()) return false;
        const { day, weekKey } = this.getViewDayInfo();
        const dayExecs = this.getExecutions().filter(e => e.day === day && e.weekKey === weekKey);
        if (dayExecs.length === 0) return false;
        // 以起始时间最晚者为准（相同则取结束时间更晚者）
        let latest = dayExecs[0];
        for (const e of dayExecs) {
            if (e.start > latest.start || (e.start === latest.start && e.end > latest.end)) {
                latest = e;
            }
        }
        return latest.id === ex.id;
    }

    /**
     * 当前选中目标（进行中任务 / 时间轴事件 / 执行记录 / 左侧任务）的来源任务。
     * 取自任务详情方框一致的优先级顺序。
     */
    private getDetailSourceItem(): InboxItem | undefined {
        const findItem = (id?: string) => id
            ? this.inboxData.items.find(i => i.id === id && !i.removed)
            : undefined;

        if (this.selectedRunningTask && this.runningTask) {
            const runningItem = findItem(this.runningTask.inboxId);
            if (runningItem) return runningItem;
        }

        const selectedEvent = this.getSelectedEvent();
        if (selectedEvent) {
            const evItem = findItem(selectedEvent.inboxId);
            if (evItem) return evItem;
        }

        const selectedExec = this.selectedExecId
            ? this.getExecutions().find(ex => ex.id === this.selectedExecId)
            : undefined;
        if (selectedExec) {
            const execItem = findItem(selectedExec.inboxId);
            if (execItem) return execItem;
        }

        return this.getSelectedItem();
    }

    /** 「板块信息」选项卡：单独用方框展示当前任务的板块卡片 */
    private renderSectionsBox(panel: HTMLElement) {
        const box = panel.createDiv({ cls: 'today-detail-box' });
        const titleRow = box.createDiv({ cls: 'today-detail-title-row' });
        titleRow.createDiv({ cls: 'today-detail-title', text: t('today.tabSections') });

        const body = box.createDiv({ cls: 'today-detail-body' });
        const item = this.getDetailSourceItem();
        if (!item) {
            body.createDiv({ cls: 'today-detail-empty', text: t('today.noSelection') });
            return;
        }
        if (!item.sections || item.sections.length === 0) {
            body.createDiv({ cls: 'today-detail-empty', text: t('today.noSections') });
            return;
        }
        this.renderDetailSections(body, item);
    }

    /** 渲染任务板块卡片（清单可勾选，其余只读，复用任务计划视图的卡片样式） */
    private renderDetailSections(body: HTMLElement, item: InboxItem): void {
        const sections = item.sections;
        if (!sections || sections.length === 0) return;

        const wrap = body.createDiv({ cls: 'today-detail-sections' });
        // 清单类型单独一行，其他类型（步骤/打卡/文件）一起放在下面一行
        const checklistRow = wrap.createDiv({ cls: 'today-detail-sections-row' });
        const otherRow = wrap.createDiv({ cls: 'today-detail-sections-row' });

        for (const section of sections) {
            const row = section.type === 'checklist' ? checklistRow : otherRow;
            const card = row.createDiv({ cls: 'swimlane-section-card' });

            // 卡片头部：类型图标 + 类型名 + 板块名
            const head = card.createDiv({ cls: 'swimlane-section-card-head' });
            const typeEl = head.createSpan({ cls: 'swimlane-section-card-type' });
            setIcon(typeEl.createSpan({ cls: 'swimlane-section-card-type-icon' }), SECTION_TYPE_META[section.type].icon);
            const typeLabel = t(SECTION_TYPE_META[section.type].labelKey as Parameters<typeof t>[0]);
            typeEl.createSpan({ text: typeLabel });
            head.createSpan({ cls: 'swimlane-section-card-name', text: section.title || typeLabel });

            // 条目列表（只读）
            const itemsEl = card.createDiv({ cls: 'swimlane-section-card-items' });
            const items = (section.data as { items?: unknown[] }).items ?? [];
            if (items.length === 0) {
                itemsEl.createDiv({ cls: 'swimlane-section-card-empty', text: t('section.emptyItems') });
                continue;
            }

            if (section.type === 'checklist') {
                for (const it of (section.data as ChecklistData).items) {
                    const itemEl = this.renderDetailSectionItem(itemsEl, it.done ? '☑' : '☐', it.text);
                    // 点击清单条目：切换勾选状态并持久化
                    itemEl.addClass('is-clickable');
                    if (it.done) itemEl.addClass('is-done');
                    itemEl.onclick = (e) => {
                        e.stopPropagation();
                        it.done = !it.done;
                        void (async () => {
                            await this.save();
                            await this.refresh();
                        })();
                    };
                }
            } else if (section.type === 'steps') {
                for (const it of (section.data as StepsData).items) {
                    const mark = it.status === 'done' ? '✅' : it.status === 'doing' ? '🔄' : '⬜';
                    this.renderDetailSectionItem(itemsEl, mark, it.text);
                }
            } else if (section.type === 'habit') {
                const data: HabitData = section.data;
                for (const it of data.items) {
                    const count = it.checkedDays?.length ?? 0;
                    this.renderDetailSectionItem(itemsEl, '🔁', it.text, String(count));
                }
            } else if (section.type === 'file') {
                for (const it of (section.data as FileData).items) {
                    const itemEl = this.renderDetailSectionItem(itemsEl, '📄', it.text || it.path);
                    // 点击文件条目：在新标签页打开对应 vault 文件
                    if (it.path) {
                        itemEl.addClass('is-clickable');
                        itemEl.onclick = (e) => {
                            e.stopPropagation();
                            void this.app.workspace.openLinkText(it.path, '', 'tab');
                        };
                    }
                }
            }
        }

        // 隐藏没有卡片的行，避免多余间距
        if (checklistRow.childElementCount === 0) checklistRow.remove();
        if (otherRow.childElementCount === 0) otherRow.remove();
    }

    /** 渲染板块卡片中的单条条目 */
    private renderDetailSectionItem(itemsEl: HTMLElement, mark: string, text: string, count?: string): HTMLElement {
        const itemEl = itemsEl.createDiv({ cls: 'swimlane-section-card-item' });
        itemEl.createSpan({ cls: 'swimlane-section-card-mark', text: mark });
        itemEl.createSpan({ cls: 'swimlane-section-card-text', text });
        if (count !== undefined) {
            itemEl.createSpan({ cls: 'swimlane-section-card-count', text: count });
        }
        return itemEl;
    }

    /** 渲染当天时间轴（时间刻度 + 今天的计划事件 + 当前时刻红线） */
    private renderTimeline(panel: HTMLElement) {
        const timeline = panel.createDiv({ cls: 'today-timeline' });

        // 每小时格子的高度（px）：随面板高度自适应，最小 30px
        const hourHeight = this.computeHourHeight(panel);
        // 通过 CSS 变量控制格子高度，刻度列与当天列保持一致
        timeline.setCssProps({ '--hour-height': `${hourHeight}px` });

        // 时间刻度（每小时一格，共 25 个刻度：00 ~ 24）
        const timeCol = timeline.createDiv({ cls: 'today-time-column' });
        for (let h = 0; h <= 24; h++) {
            timeCol.createDiv({ cls: 'time-cell hour' })
                .setText(h.toString().padStart(2, '0'));
        }

        // 方案时间区间分类色条：贴在时间刻度列内部最右侧（窄色条，不显示文字）
        this.renderSchemeBars(timeCol, hourHeight);

        // 点击左侧时间刻度列 → 新增非计划事件（起始时间按点击位置换算，吸附到 5 分钟）
        timeCol.onclick = (e) => {
            const rect = timeCol.getBoundingClientRect();
            const offsetY = e.clientY - rect.top;
            // 每 hourHeight 像素 = 1 小时（60 分钟）
            const rawMinutes = (offsetY / hourHeight) * 60;
            const snapped = Math.max(0, Math.min(24 * 60 - 5, Math.round(rawMinutes / 5) * 5));
            this.startAddUnplanned(snapped);
        };

        // 当天列（每小时一个背景格子，共 24 格）
        const col = timeline.createDiv({ cls: 'today-day-column' });
        for (let h = 0; h < 24; h++) {
            col.createDiv({ cls: 'hour-cell hour' });
        }

        // 今天的计划事件（按当前周键 + 今天星期几筛选）
        this.renderTodayEvents(col, hourHeight);

        // 已分配到当天、且设置了习惯时间点的任务：在对应时间点透明化显示
        this.renderHabitMarkers(col, hourHeight);

        // 进行中任务：从开始时刻到当前时刻的透明色块（按小时拆段）
        const runningBlocks = this.renderRunningTaskBlock(col, hourHeight);

        // 当前时刻红线
        const line = col.createDiv({ cls: 'current-time-line' });
        const updateLine = () => {
            const now = new Date();
            const totalMinutes = now.getHours() * 60 + now.getMinutes();
            line.setCssProps({ '--line-top': `${(totalMinutes / 60) * hourHeight}px` });
            // 进行中色块随时间增长：重新计算各段的位置与宽度
            if (runningBlocks.length > 0 && this.runningTask) {
                const start = Math.min(this.runningTask.start, totalMinutes);
                const end = Math.max(this.runningTask.start, totalMinutes);
                const segments = this.splitByHour(start, end);
                runningBlocks.forEach((block, i) => {
                    const seg = segments[i];
                    if (!seg) return;
                    block.setCssProps({
                        '--running-top': `${seg.hour * hourHeight}px`,
                        '--running-height': `${hourHeight}px`,
                        '--running-left': `${(seg.startMinute / 60) * 100}%`,
                        '--running-width': `${((seg.endMinute - seg.startMinute) / 60) * 100}%`,
                    });
                });
            }
        };
        updateLine();
        // 每分钟更新一次
        this.timer = window.setInterval(updateLine, 60 * 1000);
    }

    /**
     * 计算每小时格子的高度：让 24 小时正好铺满时间轴面板的可视高度，
     * 但最小不低于 30px（面板较矮时出现滚动条）。
     * 注意：刻度列有 25 个格子（00 ~ 24），最后一个刻度与当天列底部对齐，
     * 因此按 24 格计算高度，刻度列总高 = 25 × hourHeight，需预留 1 格避免纵向滚动条。
     */
    private computeHourHeight(panel: HTMLElement): number {
        const available = panel.clientHeight;
        if (!available || available <= 0) return MIN_HOUR_HEIGHT;
        // 当天列 24 格铺满可视高度；刻度列多出的第 25 格（24 点）与底部对齐，不额外占高
        return Math.max(MIN_HOUR_HEIGHT, Math.floor(available / 24));
    }

    /**
     * 渲染方案时间区间分类色条：贴在时间刻度列内部最右侧。
     * 窄色条（约 6-8px），实心分类色，不显示文字，不拦截点击。
     */
    private renderSchemeBars(timeCol: HTMLElement, hourHeight: number) {
        const { day } = this.getViewDayInfo();
        const dayData = this.getPlanSchemeDays().find(d => d.day === day);
        const ranges = dayData?.ranges ?? [];
        for (const range of ranges) {
            const bar = timeCol.createDiv({ cls: 'today-scheme-bar' });
            const cat = this.categoryData.categories.find(c => c.id === range.sort);
            const color = cat?.color ?? '#888888';

            const top = (range.start / 60) * hourHeight;
            const height = ((range.end - range.start) / 60) * hourHeight;
            bar.setCssProps({
                '--bar-color': color,
                '--bar-top': `${top}px`,
                '--bar-height': `${height}px`,
            });
        }
    }

    /**
     * 在当天列上渲染当前查看日期的执行记录卡片。
     * 卡片按「小时格子」横向切分：每格横向等分为 60 份，卡片从起始分钟对应的位置开始，
     * 宽度 = 持续分钟数；跨小时的记录拆成多段，每格一段。
     * 纵向高度固定为一行格子高度（hourHeight）。
     */
    private renderTodayEvents(col: HTMLElement, hourHeight: number) {
        const { day, weekKey, dayKey } = this.getViewDayInfo();
        // 校验：周键 + 星期几 计算出的日期键应与查看日期一致
        if (makeDayKeyFromWeek(weekKey, day) !== dayKey) return;

        // 当天全部执行记录：已执行 / 新增，统一作为执行记录卡片渲染
        const execs = this.getExecutions().filter(ex =>
            ex.day === day && ex.weekKey === weekKey,
        );
        for (const ex of execs) {
            const item = ex.inboxId
                ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                : undefined;
            const cat = item?.categoryId
                ? this.categoryData.categories.find(c => c.id === item.categoryId)
                : undefined;

            // 按小时拆段：每段落在对应的小时格子内
            for (const seg of this.splitByHour(ex.start, ex.end)) {
                const card = col.createDiv({ cls: 'event-card event-card-exec today-event-card' });
                card.setCssProps({
                    '--card-top': `${seg.hour * hourHeight}px`,
                    '--card-height': `${hourHeight}px`,
                    '--card-left': `${(seg.startMinute / 60) * 100}%`,
                    '--card-width': `${((seg.endMinute - seg.startMinute) / 60) * 100}%`,
                    '--card-color': cat?.color ?? '#888888',
                    '--card-bg': '#eeeeee88',
                });
                card.setText(item?.title ?? t('today.statusAdded'));

                // 点击执行记录卡片 → 在中心方框展示详情（再次点击取消选中）
                if (this.selectedExecId === ex.id) card.addClass('is-selected');
                card.onclick = (e) => {
                    e.stopPropagation();
                    this.toggleExecSelection(ex.id);
                };
            }
        }
    }

    /**
     * 把时间区间按整点拆分为多段（每段落在同一个小时格子内）。
     * 返回每段的：小时序号（0-23）、段内起始分钟、段内结束分钟。
     */
    private splitByHour(start: number, end: number): { hour: number; startMinute: number; endMinute: number }[] {
        const segments: { hour: number; startMinute: number; endMinute: number }[] = [];
        const from = Math.max(0, Math.min(start, end));
        const to = Math.min(24 * 60, Math.max(start, end));
        // 起止相同（如「开始任务」后立即「完成」）时，给一个最小 1 分钟的段，保证卡片可见
        if (to <= from) {
            const hour = Math.floor(from / 60);
            segments.push({ hour, startMinute: from - hour * 60, endMinute: from - hour * 60 + 1 });
            return segments;
        }

        let cursor = from;
        while (cursor < to) {
            const hour = Math.floor(cursor / 60);
            const hourEnd = Math.min((hour + 1) * 60, to);
            segments.push({
                hour,
                startMinute: cursor - hour * 60,
                endMinute: hourEnd - hour * 60,
            });
            cursor = hourEnd;
        }
        return segments;
    }

    /**
     * 渲染「习惯时间点」标记：已分配到当天、且启用了习惯时间点的任务，
     * 在时间轴对应时间点以透明化色块显示（不拦截点击）。
     */
    private renderHabitMarkers(col: HTMLElement, hourHeight: number) {
        const { dayKey } = this.getViewDayInfo();

        // 已分配到当天、且启用习惯时间点的任务
        const items = this.inboxData.items.filter(i =>
            !i.removed
            && i.habitTimeEnabled
            && typeof i.habitTime === 'number'
            && (i.assignedDayKeys ?? []).includes(dayKey),
        );
        if (items.length === 0) return;

        for (const item of items) {
            const minutes = item.habitTime as number;
            const marker = col.createDiv({ cls: 'today-habit-marker' });
            const cat = item.categoryId
                ? this.categoryData.categories.find(c => c.id === item.categoryId)
                : undefined;
            marker.setCssProps({
                '--habit-color': cat?.color ?? '#888888',
                '--habit-top': `${(minutes / 60) * hourHeight}px`,
            });
            marker.setText(item.title);
        }
    }

    /**
     * 渲染「进行中任务」色块：从开始时刻到当前时刻（随时间增长）。
     * 与执行记录卡片一致，按小时格子横向切分，纵向高度固定为一行格子高度。
     * 点击色块可选中该进行中任务，供操作区显示「完成」按钮。
     */
    private renderRunningTaskBlock(col: HTMLElement, hourHeight: number): HTMLElement[] {
        const running = this.runningTask;
        if (!running) return [];
        // 仅当进行中任务属于当前查看日期时显示
        const { dayKey } = this.getViewDayInfo();
        if (running.dayKey !== dayKey) return [];

        const item = this.inboxData.items.find(i => i.id === running.inboxId && !i.removed);
        if (!item) return [];

        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const start = Math.min(running.start, nowMinutes);
        const end = Math.max(running.start, nowMinutes);

        const cat = item.categoryId
            ? this.categoryData.categories.find(c => c.id === item.categoryId)
            : undefined;

        const blocks: HTMLElement[] = [];
        for (const seg of this.splitByHour(start, end)) {
            const block = col.createDiv({ cls: 'today-running-block' });
            block.setCssProps({
                '--running-color': cat?.color ?? '#4c8dff',
                '--running-top': `${seg.hour * hourHeight}px`,
                '--running-height': `${hourHeight}px`,
                '--running-left': `${(seg.startMinute / 60) * 100}%`,
                '--running-width': `${((seg.endMinute - seg.startMinute) / 60) * 100}%`,
            });
            block.setText(item.title);

            if (this.selectedRunningTask) block.addClass('is-selected');
            block.onclick = (e) => {
                e.stopPropagation();
                this.toggleRunningTaskSelection();
            };
            blocks.push(block);
        }
        return blocks;
    }

    /**
     * 渲染状态气泡。时间点接近（top 差值小于阈值）的卡片归为一组：
     * - 组内仅 1 个：渲染常规气泡（图标 + 文字）
     * - 组内多个：渲染合并气泡条（多个图标并排，隐藏文字），点击单个图标选中对应卡片
     */
    private renderStatusBubbles(
        col: HTMLElement,
        items: { card: HTMLElement; top: number; status: EventStatus; onSelect: () => void }[],
    ) {
        if (items.length === 0) return;

        // 按 top 升序排序后聚类（阈值 24px，约等于 36 分钟）
        const CLUSTER_THRESHOLD = 24;
        const sorted = [...items].sort((a, b) => a.top - b.top);
        const groups: typeof items[] = [];
        for (const it of sorted) {
            const last = groups[groups.length - 1];
            if (last && it.top - last[last.length - 1].top < CLUSTER_THRESHOLD) {
                last.push(it);
            } else {
                groups.push([it]);
            }
        }

        for (const group of groups) {
            if (group.length === 1) {
                // 单个：常规气泡（图标 + 文字）
                const it = group[0];
                this.renderStatusBubble(it.card, it.status, it.onSelect);
                continue;
            }

            // 多个：合并气泡条，挂在列上，垂直位置取组内平均 top
            const avgTop = group.reduce((s, it) => s + it.top, 0) / group.length;
            const bar = col.createDiv({ cls: 'event-status-bubble-group' });
            bar.setCssProps({ '--bubble-top': `${avgTop}px` });
            for (const it of group) {
                const icon = bar.createDiv({ cls: `event-status-icon-btn is-${it.status}` });
                icon.setText(EVENT_STATUS_EMOJI[it.status]);
                icon.onclick = (e) => {
                    e.stopPropagation();
                    it.onSelect();
                };
            }
        }
    }

    /** 切换计划事件选中状态（再次点击取消） */
    private toggleEventSelection(eventId: string): void {
        this.selectedEventId = this.selectedEventId === eventId ? undefined : eventId;
        this.selectedExecId = undefined;
        this.selectedRunningTask = false;
        // 与左侧任务面板选中互斥：选中时间轴事件时取消左侧选中
        this.clearInboxSelection();
        // 选中时间轴事件时自动切到「当天任务」选项卡
        if (this.selectedEventId) this.rightTab = 'dayTasks';
        void this.refresh();
    }

    /** 切换「新增」执行记录选中状态（再次点击取消） */
    private toggleExecSelection(execId: string): void {
        this.selectedExecId = this.selectedExecId === execId ? undefined : execId;
        this.selectedEventId = undefined;
        this.selectedRunningTask = false;
        // 与左侧任务面板选中互斥：选中时间轴事件时取消左侧选中
        this.clearInboxSelection();
        // 选中时间轴执行记录时自动切到「当天任务」选项卡
        if (this.selectedExecId) this.rightTab = 'dayTasks';
        void this.refresh();
    }

    /** 清除左侧任务面板的选中状态（同步 lastSelectedItemId，避免下次渲染误判为选中变化） */
    private clearInboxSelection(): void {
        if (this.inboxRepo) this.inboxRepo.setSelectedId(undefined);
        else this.inboxData.selectedId = undefined;
        this.lastSelectedItemId = undefined;
    }

    /** 取消所有选中状态（时间轴事件 / 新增执行记录 / 进行中任务 / 左侧任务），恢复显示周目标 / 日目标 */
    private clearAllSelection(): void {
        this.selectedEventId = undefined;
        this.selectedExecId = undefined;
        this.selectedRunningTask = false;
        this.clearInboxSelection();
        void this.refresh();
    }

    /** 在事件区块左侧渲染状态气泡（emoji + 文字，不使用颜色分类） */
    private renderStatusBubble(card: HTMLElement, status: EventStatus, onClick?: () => void) {
        const bubble = card.createDiv({ cls: `event-status-bubble is-${status}` });
        bubble.createSpan({ cls: 'event-status-icon', text: EVENT_STATUS_EMOJI[status] });
        bubble.createSpan({
            cls: 'event-status-label',
            text: t(EVENT_STATUS_LABEL_KEY[status] as Parameters<typeof t>[0]),
        });
        // 点击气泡等同于点击卡片（选中/取消选中）
        if (onClick) {
            bubble.addClass('is-clickable');
            bubble.onclick = (e) => {
                e.stopPropagation();
                onClick();
            };
        }
    }

    /** 清理定时器 */
    private clearTimer() {
        if (this.timer !== undefined) {
            window.clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /** 视图关闭时调用 */
    destroy() {
        this.clearTimer();
    }
}
