import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type { TimeBlockCategoryData } from './week-view/timeblock-category-manager';
import type { InboxData, InboxItem } from '../datatypes/domain';
import { renderTaskPanel } from '../shared/task-panel';
import { getCurrentDayKey, getCurrentWeekKey, makeDayKeyFromWeek } from './week-view/timeblock-data';
import type { EventBlock, ExecutionRecord } from '../datatypes/domain';
import { getWeekDays, t } from '../i18n';
import { EVENT_STATUS_EMOJI, EVENT_STATUS_LABEL_KEY, getEventStatus, type EventStatus } from '../datatypes/domain';

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

/**
 * 当日执行视图：左侧任务面板 + 中间执行区 + 右侧当天时间轴。
 * 通过 renderInto 渲染到指定容器（与 WeekScheduleView / YearView 一致）。
 */
export class TodayView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: TimeBlockCategoryData;
    private save: () => Promise<void>;
    /** 获取全部事件（用于在时间轴上展示今天的计划事件） */
    private getEvents: () => EventBlock[];
    /** 获取全部执行记录（用于「完成执行计划任务」写入） */
    private getExecutions: () => ExecutionRecord[];
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
    /** 是否处于「替换计划」模式 */
    private replaceMode = false;
    /** 替换模式下锁定的目标事件 id */
    private replaceTargetEventId?: string;
    /** 是否处于「新增非计划事件」模式（点击时间轴触发） */
    private addUnplannedMode = false;
    /** 新增非计划事件的起始分钟（由点击时间轴的位置换算） */
    private addUnplannedStart = 0;
    /** 新增非计划事件的时长（分钟，默认 30，可由用户填写） */
    private addUnplannedDuration = 30;
    /** 当前正在执行的事件 id（点击「进入执行」后设置，用于顶部执行卡片） */
    private executingEventId?: string;

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: TimeBlockCategoryData,
        save: () => Promise<void>,
        getEvents: () => EventBlock[],
        getExecutions: () => ExecutionRecord[],
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.save = save;
        this.getEvents = getEvents;
        this.getExecutions = getExecutions;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        this.clearTimer();
        // 保存时间轴滚动位置，重建 DOM 后恢复，避免刷新时滚动条重置
        const prevScrollTop = container
            .querySelector('.today-timeline-panel')?.scrollTop ?? 0;
        container.empty();
        container.addClass('today-view');

        // 任务面板选中项发生变化时，清除时间轴事件选中（两者互斥）
        if (this.inboxData.selectedId !== this.lastSelectedItemId) {
            this.lastSelectedItemId = this.inboxData.selectedId;
            this.selectedEventId = undefined;
            this.selectedExecId = undefined;
        }

        // ===== 左侧：任务面板 =====
        const taskPanel = container.createDiv({ cls: 'today-task-panel' });
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

        // ===== 中间：日期方框 + 任务层级方框 + 任务详情方框 + 操作按钮 =====
        const centerPanel = container.createDiv({ cls: 'today-center-panel' });
        this.renderDateBox(centerPanel);
        this.renderHierarchyBox(centerPanel);
        // 新增非计划事件模式：在任务详情方框的位置展示「执行非计划事件方框」
        if (this.addUnplannedMode) {
            this.renderAddUnplannedBox(centerPanel);
        } else if (this.hasSelection()) {
            // 未选中任何任务/事件时，在任务详情方框的位置展示「周目标方框」
            this.renderDetailBox(centerPanel);
        } else {
            this.renderWeekGoalBox(centerPanel);
        }
        // 替换模式下，在任务详情下方展示「替换任务详情方框」
        if (this.replaceMode) this.renderReplaceBox(centerPanel);
        this.renderActionButtons(centerPanel);

        // ===== 右侧：当天时间轴 =====
        const timelinePanel = container.createDiv({ cls: 'today-timeline-panel' });
        this.renderTimeline(timelinePanel);
        // 恢复时间轴滚动位置
        timelinePanel.scrollTop = prevScrollTop;
    }

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
    }

    /** 渲染今天的年月日方框 + 右侧日目标完成情况 */
    private renderDateBox(panel: HTMLElement) {
        const now = new Date();
        const box = panel.createDiv({ cls: 'today-date-box' });

        // 左侧：日期（点击日期区域 → 取消所有选中，恢复显示周目标 / 日目标）
        const dateSide = box.createDiv({ cls: 'today-date-side' });
        dateSide.createDiv({ cls: 'today-date-year', text: `${now.getFullYear()}` });
        dateSide.createDiv({ cls: 'today-date-md' })
            .setText(`${String(now.getMonth() + 1).padStart(2, '0')} / ${String(now.getDate()).padStart(2, '0')}`);
        dateSide.createDiv({ cls: 'today-date-weekday', text: getWeekDays()[(now.getDay() + 6) % 7] });
        dateSide.addClass('is-clickable');
        dateSide.onclick = () => {
            this.clearAllSelection();
        };

        // 中间：正在执行的任务卡片（斜向条纹背景，突出进行中）
        this.renderExecutingCard(box);

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

        // 右上：计划中 / 已执行 / 替换
        const breakdownTotal = stats.planned + stats.executed + stats.changed;
        this.renderStatCard(smallCol, {
            label: t('today.statBreakdownLabel'),
            values: [
                { text: String(stats.planned), cls: 'is-planned' },
                { text: String(stats.executed), cls: 'is-executed' },
                { text: String(stats.changed), cls: 'is-changed' },
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
        card.createDiv({
            cls: 'today-executing-time',
            text: ev.allDay
                ? t('today.allDay')
                : `${formatMinutes(ev.start)} - ${formatMinutes(ev.end)}`,
        });

        // 点击卡片 → 选中该事件，同步更新任务层级 / 任务详情 / 操作按钮
        card.addClass('is-clickable');
        if (this.selectedEventId === ev.id) card.addClass('is-selected');
        card.onclick = () => {
            this.toggleEventSelection(ev.id);
        };
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

    /** 统计今天的日目标完成情况（含全天事件） */
    private computeDayStats(): {
        total: number;
        planned: number;
        executed: number;
        changed: number;
        added: number;
    } {
        const now = new Date();
        const todayDay = (now.getDay() + 6) % 7 + 1;
        const weekKey = getCurrentWeekKey();
        const executions = this.getExecutions();

        // 今天的计划事件（含全天）
        const events = this.getEvents().filter(ev =>
            ev.day === todayDay && ev.weekKey === weekKey,
        );

        let planned = 0;
        let executed = 0;
        let changed = 0;
        for (const ev of events) {
            const status = getEventStatus(ev, executions);
            if (status === 'changed') changed++;
            else if (status === 'executed') executed++;
            else planned++;
        }

        // 非计划执行记录（新增）
        const plannedEventIds = new Set(events.map(ev => ev.id));
        const added = executions.filter(ex =>
            ex.day === todayDay
            && ex.weekKey === weekKey
            && !(ex.eventId && plannedEventIds.has(ex.eventId)),
        ).length;

        return { total: events.length, planned, executed, changed, added };
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

    /** 是否存在选中项（时间轴事件 / 新增执行记录 / 任务面板任务） */
    private hasSelection(): boolean {
        if (this.selectedEventId) return true;
        if (this.selectedExecId) return true;
        return !!this.getSelectedItem();
    }

    /** 渲染任务详情方框（展示左侧选中任务或时间轴选中事件的详情） */
    private renderDetailBox(panel: HTMLElement) {
        const box = panel.createDiv({ cls: 'today-detail-box' });
        box.createDiv({ cls: 'today-detail-title', text: t('today.detailTitle') });

        const body = box.createDiv({ cls: 'today-detail-body' });

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

        if (selectedEvent) {
            this.renderEventDetail(body, selectedEvent);
            return;
        }
        if (selectedExec) {
            this.renderExecDetail(body, selectedExec);
            return;
        }
        if (selectedItem) {
            this.renderItemDetail(body, selectedItem);
            return;
        }

        body.createDiv({ cls: 'today-detail-empty', text: t('today.noSelection') });
    }

    /**
     * 渲染「执行非计划事件方框」（点击时间轴触发，占据任务详情方框的位置）。
     * 顶部为等待选择任务的提示框，下方为事件时间区间（起始时间由点击位置换算，时长可填写）。
     */
    private renderAddUnplannedBox(panel: HTMLElement) {
        const box = panel.createDiv({ cls: 'today-detail-box today-addunplanned-box' });
        box.createDiv({ cls: 'today-detail-title', text: t('today.addUnplannedTitle') });

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

        // 时间区间：起始时间（只读，由点击位置换算）+ 时长（可填写）
        const start = this.addUnplannedStart;
        const end = start + this.addUnplannedDuration;

        const rangeRow = body.createDiv({ cls: 'today-addunplanned-row' });
        rangeRow.createSpan({ cls: 'today-detail-label', text: `${t('today.timeRange')}:` });
        rangeRow.createSpan({
            cls: 'today-addunplanned-range',
            text: `${formatMinutes(start)} - ${formatMinutes(end)}`,
        });

        const durationRow = body.createDiv({ cls: 'today-addunplanned-row' });
        durationRow.createSpan({ cls: 'today-detail-label', text: `${t('today.addUnplannedDuration')}:` });
        const durationInput = durationRow.createEl('input', {
            cls: 'today-addunplanned-input',
            type: 'number',
        });
        durationInput.value = String(this.addUnplannedDuration);
        durationInput.min = '5';
        durationInput.step = '5';
        durationInput.onchange = () => {
            const v = Number(durationInput.value);
            if (Number.isFinite(v) && v > 0) {
                this.addUnplannedDuration = Math.round(v);
                void this.refresh();
            }
        };
        durationRow.createSpan({ cls: 'today-detail-label', text: t('today.addUnplannedMinutes') });
    }

    /**
     * 渲染周目标方框（未选中任何任务/事件时，占据任务详情方框的位置）。
     * 中间用竖线分成左右两栏：左侧「周目标」清单，右侧「日目标」清单，两栏样式一致。
     */
    private renderWeekGoalBox(panel: HTMLElement) {
        const box = panel.createDiv({ cls: 'today-detail-box today-weekgoal-box' });

        const body = box.createDiv({ cls: 'today-detail-body today-weekgoal-body' });

        // 左侧：周目标
        const weekCol = body.createDiv({ cls: 'today-weekgoal-col' });
        weekCol.createDiv({ cls: 'today-weekgoal-col-title', text: t('today.weekGoalTitle') });
        this.renderGoalList(
            weekCol,
            this.getEvents().filter(ev => ev.weekKey === getCurrentWeekKey()),
            t('today.weekGoalEmpty'),
        );

        // 右侧：日目标（今天）
        const now = new Date();
        const todayDay = (now.getDay() + 6) % 7 + 1;
        const weekKey = getCurrentWeekKey();
        const dayCol = body.createDiv({ cls: 'today-weekgoal-col' });
        dayCol.createDiv({ cls: 'today-weekgoal-col-title', text: t('today.dayGoalTitle') });
        this.renderGoalList(
            dayCol,
            this.getEvents().filter(ev => ev.weekKey === weekKey && ev.day === todayDay),
            t('today.dayGoalEmpty'),
        );
    }

    /**
     * 渲染一组计划事件清单：相同标题累计显示为 x N，行末尾显示总时长与小进度条，
     * 底部显示「共计时长 / 已执行时长」进度条。周目标与日目标共用，保证样式一致。
     */
    private renderGoalList(container: HTMLElement, events: EventBlock[], emptyText: string) {
        if (events.length === 0) {
            container.createDiv({ cls: 'today-detail-empty', text: emptyText });
            return;
        }

        const executions = this.getExecutions();

        // 按标题聚合：相同事件累计次数，并分别累计总时长与已执行时长
        const groups = new Map<string, { title: string; count: number; total: number; executed: number }>();
        let totalMinutes = 0;
        let executedMinutes = 0;
        for (const ev of events) {
            const duration = Math.max(0, ev.end - ev.start);
            const isExecuted = getEventStatus(ev, executions) === 'executed';
            totalMinutes += duration;
            if (isExecuted) executedMinutes += duration;

            const key = ev.title;
            const group = groups.get(key) ?? { title: ev.title, count: 0, total: 0, executed: 0 };
            group.count += 1;
            group.total += duration;
            if (isExecuted) group.executed += duration;
            groups.set(key, group);
        }

        // 事件清单
        const list = container.createDiv({ cls: 'today-weekgoal-list' });
        for (const group of Array.from(groups.values())) {
            const row = list.createDiv({ cls: 'today-weekgoal-item' });
            row.createSpan({ cls: 'today-weekgoal-name', text: group.title });
            if (group.count > 1) {
                row.createSpan({
                    cls: 'today-weekgoal-count',
                    text: t('today.weekGoalCount', { count: group.count }),
                });
            }
            // 弹性占位：把时长与进度条推到行末尾
            row.createDiv({ cls: 'today-weekgoal-spacer' });
            row.createSpan({ cls: 'today-weekgoal-duration', text: formatHours(group.total) });

            // 行末尾的小进度条：可视化该事件已执行时长 / 总时长
            const bar = row.createDiv({ cls: 'today-stat-bar today-weekgoal-bar' });
            const fill = bar.createDiv({ cls: 'today-stat-bar-fill is-executed' });
            const ratio = group.total > 0 ? group.executed / group.total : 0;
            fill.setCssProps({ '--stat-fill': `${Math.max(0, Math.min(1, ratio)) * 100}%` });
        }

        // 共计时长 / 已执行时长 进度条
        const stats = container.createDiv({ cls: 'today-weekgoal-stats' });
        const labelRow = stats.createDiv({ cls: 'today-weekgoal-stats-label' });
        labelRow.createSpan({ text: t('today.weekGoalDuration') });
        labelRow.createSpan({
            cls: 'today-weekgoal-stats-value',
            text: `${formatHours(executedMinutes)} / ${formatHours(totalMinutes)}`,
        });
        const bar = stats.createDiv({ cls: 'today-stat-bar' });
        const fill = bar.createDiv({ cls: 'today-stat-bar-fill is-executed' });
        const ratio = totalMinutes > 0 ? executedMinutes / totalMinutes : 0;
        fill.setCssProps({ '--stat-fill': `${Math.max(0, Math.min(1, ratio)) * 100}%` });
    }

    /** 渲染操作按钮：选中左侧任务显示「执行非计划任务」；选中时间轴事件显示「执行计划 / 替换计划」 */
    private renderActionButtons(panel: HTMLElement) {
        const selectedEvent = this.getSelectedEvent();
        const selectedItem = this.getSelectedItem();
        const row = panel.createDiv({ cls: 'today-action-row' });

        // 选中「新增」执行记录：不显示任何操作按钮
        if (this.selectedExecId) return;

        // 新增非计划事件模式：确认新增 / 取消
        if (this.addUnplannedMode) {
            const confirmBtn = row.createEl('button', {
                cls: 'today-action-btn mod-cta',
                text: t('today.addUnplannedConfirm'),
            });
            // 必须先在左侧选中任务，才能确认新增
            confirmBtn.disabled = !selectedItem;
            confirmBtn.onclick = () => {
                void this.confirmAddUnplanned();
            };

            const cancelBtn = row.createEl('button', {
                cls: 'today-action-btn',
                text: t('today.addUnplannedCancel'),
            });
            cancelBtn.onclick = () => {
                this.cancelAddUnplanned();
            };
            return;
        }

        // 替换模式：确认替换 / 取消替换
        if (this.replaceMode) {
            const confirmBtn = row.createEl('button', {
                cls: 'today-action-btn mod-cta',
                text: t('today.replaceConfirm'),
            });
            // 必须先在左侧选中任务，才能确认替换
            confirmBtn.disabled = !selectedItem;
            confirmBtn.onclick = () => {
                void this.confirmReplace();
            };

            const cancelBtn = row.createEl('button', {
                cls: 'today-action-btn',
                text: t('today.replaceCancel'),
            });
            cancelBtn.onclick = () => {
                this.cancelReplace();
            };
            return;
        }

        // 选中时间轴事件：仅「计划」状态显示「执行计划 / 替换计划」按钮
        if (selectedEvent) {
            const isExecuting = this.executingEventId === selectedEvent.id;

            // 正在执行：显示「完成执行 / 取消执行」
            if (isExecuting) {
                const finishBtn = row.createEl('button', {
                    cls: 'today-action-btn mod-cta',
                    text: t('today.finishExec'),
                });
                finishBtn.onclick = () => {
                    void this.finishExecuting();
                };

                const cancelBtn = row.createEl('button', {
                    cls: 'today-action-btn',
                    text: t('today.cancelExec'),
                });
                cancelBtn.onclick = () => {
                    this.cancelExecuting();
                };
                return;
            }

            const status = getEventStatus(selectedEvent, this.getExecutions());
            if (status === 'planned') {
                const execBtn = row.createEl('button', {
                    cls: 'today-action-btn',
                    text: t('today.execPlanned'),
                });
                execBtn.onclick = () => {
                    void this.executePlannedEvent();
                };

                const replaceBtn = row.createEl('button', {
                    cls: 'today-action-btn',
                    text: t('today.replacePlanned'),
                });
                replaceBtn.onclick = () => {
                    this.startReplace();
                };
            }

            // 进入执行：切换当前任务的「正在执行」状态
            const enterBtn = row.createEl('button', {
                cls: 'today-action-btn',
                text: t('today.enterExec'),
            });
            enterBtn.onclick = () => {
                this.toggleExecuting(selectedEvent.id);
            };
            return;
        }

        // 选中左侧任务：执行非计划任务
        const unplannedBtn = row.createEl('button', {
            cls: 'today-action-btn',
            text: t('today.execUnplanned'),
        });
        unplannedBtn.disabled = !selectedItem;
        unplannedBtn.onclick = () => {
            void this.executeUnplannedTask();
        };
    }

    /** 渲染「替换任务详情方框」：左侧原计划事件，中间转换符号，右侧替换成的任务 */
    private renderReplaceBox(panel: HTMLElement) {
        const box = panel.createDiv({ cls: 'today-replace-box' });
        box.createDiv({ cls: 'today-replace-title', text: t('today.replaceBoxTitle') });

        const body = box.createDiv({ cls: 'today-replace-body' });

        // 左侧：原计划事件
        const sourceEl = body.createDiv({ cls: 'today-replace-side' });
        sourceEl.createDiv({ cls: 'today-replace-label', text: t('today.replaceBoxSource') });
        const sourceEvent = this.replaceTargetEventId
            ? this.getEvents().find(e => e.id === this.replaceTargetEventId)
            : undefined;
        sourceEl.createDiv({
            cls: 'today-replace-name',
            text: sourceEvent?.title ?? t('today.replaceBoxSourceEmpty'),
        });

        // 中间：转换符号
        body.createDiv({ cls: 'today-replace-arrow', text: '→' });

        // 右侧：替换成的任务
        const targetEl = body.createDiv({ cls: 'today-replace-side' });
        targetEl.createDiv({ cls: 'today-replace-label', text: t('today.replaceBoxTarget') });
        const item = this.getSelectedItem();
        if (item) {
            targetEl.createDiv({ cls: 'today-replace-name', text: item.title });
        } else {
            targetEl.createDiv({ cls: 'today-replace-empty', text: t('today.replaceBoxHint') });
        }
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

    /** 执行非计划任务：为选中任务生成一条执行记录 */
    private async executeUnplannedTask(): Promise<void> {
        const item = this.getSelectedItem();
        if (!item) return;

        const now = new Date();
        const todayDay = (now.getDay() + 6) % 7 + 1;
        const weekKey = getCurrentWeekKey();
        const totalMinutes = now.getHours() * 60 + now.getMinutes();

        this.getExecutions().push({
            id: `exec_${Date.now()}`,
            inboxId: item.id,
            day: todayDay,
            start: totalMinutes,
            end: totalMinutes,
            weekKey,
        });
        await this.save();
        new Notice(t('today.completeDone', { title: item.title }));
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
        void this.refresh();
    }

    /** 取消「新增非计划事件」 */
    private cancelAddUnplanned(): void {
        this.addUnplannedMode = false;
        void this.refresh();
    }

    /** 确认新增非计划事件：用左侧选中任务生成一条执行记录 */
    private async confirmAddUnplanned(): Promise<void> {
        const item = this.getSelectedItem();
        if (!item) return;

        const now = new Date();
        const todayDay = (now.getDay() + 6) % 7 + 1;
        const weekKey = getCurrentWeekKey();
        const start = this.addUnplannedStart;
        const end = Math.min(24 * 60, start + this.addUnplannedDuration);

        this.getExecutions().push({
            id: `exec_${Date.now()}`,
            inboxId: item.id,
            day: todayDay,
            start,
            end,
            weekKey,
        });
        this.addUnplannedMode = false;
        await this.save();
        new Notice(t('today.completeDone', { title: item.title }));
        await this.refresh();
    }

    /** 执行计划：为时间轴上选中的事件生成一条执行记录 */
    private async executePlannedEvent(): Promise<void> {
        const ev = this.getSelectedEvent();
        if (!ev) return;

        const now = new Date();
        const todayDay = (now.getDay() + 6) % 7 + 1;
        const weekKey = getCurrentWeekKey();

        this.getExecutions().push({
            id: `exec_${Date.now()}`,
            eventId: ev.id,
            inboxId: ev.inboxId,
            day: todayDay,
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
        void this.refresh();
    }

    /** 完成执行：为正在执行的事件写入执行记录，并清除「正在执行」状态 */
    private async finishExecuting(): Promise<void> {
        const ev = this.getSelectedEvent();
        if (!ev) return;

        const now = new Date();
        const todayDay = (now.getDay() + 6) % 7 + 1;
        const weekKey = getCurrentWeekKey();

        this.getExecutions().push({
            id: `exec_${Date.now()}`,
            eventId: ev.id,
            inboxId: ev.inboxId,
            day: todayDay,
            start: ev.start,
            end: ev.end,
            weekKey,
        });
        this.executingEventId = undefined;
        await this.save();
        new Notice(t('today.completeDone', { title: ev.title }));
        await this.refresh();
    }

    /** 取消执行：清除「正在执行」状态，不写入执行记录 */
    private cancelExecuting(): void {
        this.executingEventId = undefined;
        void this.refresh();
    }

    /** 进入替换模式：锁定当前选中的时间轴事件，等待用户在左侧选择任务 */
    private startReplace(): void {
        const ev = this.getSelectedEvent();
        if (!ev) {
            new Notice(t('today.replaceNeedEvent'));
            return;
        }
        this.replaceTargetEventId = ev.id;
        this.replaceMode = true;
        void this.refresh();
    }

    /** 取消替换：退出替换模式 */
    private cancelReplace(): void {
        this.replaceMode = false;
        this.replaceTargetEventId = undefined;
        void this.refresh();
    }

    /** 确认替换：用左侧选中的任务替换锁定的目标事件 */
    private async confirmReplace(): Promise<void> {
        const item = this.getSelectedItem();
        if (!item) return;

        const ev = this.replaceTargetEventId
            ? this.getEvents().find(e => e.id === this.replaceTargetEventId)
            : undefined;
        if (!ev) {
            this.cancelReplace();
            return;
        }

        // 记录被替换前的原任务，用于标记「变更计划」状态
        if (ev.inboxId && ev.inboxId !== item.id) {
            ev.replacedFromInboxId = ev.inboxId;
        }
        ev.title = item.title;
        ev.categoryId = item.categoryId;
        ev.inboxId = item.id;

        this.replaceMode = false;
        this.replaceTargetEventId = undefined;
        await this.save();
        new Notice(t('today.replaceDone', { title: item.title }));
        await this.refresh();
    }

    /** 展示收集盒任务详情 */
    private renderItemDetail(body: HTMLElement, item: InboxItem) {
        body.createDiv({ cls: 'today-detail-name', text: item.title });
        body.createDiv({ cls: 'today-detail-desc' })
            .setText(item.description || t('today.noDescription'));

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
        body.createDiv({ cls: 'today-detail-name', text: ev.title });

        const row = body.createDiv({ cls: 'today-detail-row' });
        row.createSpan({ cls: 'today-detail-label', text: `${t('today.timeRange')}:` });
        row.createSpan({
            text: ev.allDay
                ? t('today.allDay')
                : `${formatMinutes(ev.start)} - ${formatMinutes(ev.end)}`,
        });

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
        body.createDiv({ cls: 'today-detail-name', text: item?.title ?? t('today.statusAdded') });

        const row = body.createDiv({ cls: 'today-detail-row' });
        row.createSpan({ cls: 'today-detail-label', text: `${t('today.timeRange')}:` });
        row.createSpan({ text: `${formatMinutes(ex.start)} - ${formatMinutes(ex.end)}` });

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

    /** 渲染当天时间轴（时间刻度 + 今天的计划事件 + 当前时刻红线） */
    private renderTimeline(panel: HTMLElement) {
        const timeline = panel.createDiv({ cls: 'today-timeline' });

        // 时间刻度（每 2 小时一格）
        const timeCol = timeline.createDiv({ cls: 'today-time-column' });
        for (let h = 0; h < 24; h += 2) {
            timeCol.createDiv({ cls: 'time-cell two-hour' })
                .setText(`${h.toString().padStart(2, '0')}:00`);
        }

        // 点击左侧时间刻度列 → 新增非计划事件（起始时间按点击位置换算，吸附到 5 分钟）
        timeCol.onclick = (e) => {
            const rect = timeCol.getBoundingClientRect();
            const offsetY = e.clientY - rect.top;
            // 每 80px = 2 小时（120 分钟），即 1px = 1.5 分钟
            const rawMinutes = (offsetY / 80) * 120;
            const snapped = Math.max(0, Math.min(24 * 60 - 5, Math.round(rawMinutes / 5) * 5));
            this.startAddUnplanned(snapped);
        };

        // 当天列
        const col = timeline.createDiv({ cls: 'today-day-column' });
        for (let h = 0; h < 24; h += 2) {
            col.createDiv({ cls: 'hour-cell two-hour' });
        }

        // 今天的计划事件（按当前周键 + 今天星期几筛选）
        this.renderTodayEvents(col);

        // 当前时刻红线
        const line = col.createDiv({ cls: 'current-time-line' });
        const updateLine = () => {
            const now = new Date();
            const totalMinutes = now.getHours() * 60 + now.getMinutes();
            line.setCssProps({ '--line-top': `${(totalMinutes / 120) * 80}px` });
        };
        updateLine();
        // 每分钟更新一次
        this.timer = window.setInterval(updateLine, 60 * 1000);
    }

    /** 在当天列上渲染今天的计划事件（与周计划视图的定位比例一致：80px / 2 小时） */
    private renderTodayEvents(col: HTMLElement) {
        const now = new Date();
        // 今天对应的星期几（1 = 周一 ... 7 = 周日）
        const todayDay = (now.getDay() + 6) % 7 + 1;
        const weekKey = getCurrentWeekKey();
        // 校验：当前周键 + 今天星期几 计算出的日期键应与今天一致
        const todayKey = getCurrentDayKey();
        if (makeDayKeyFromWeek(weekKey, todayDay) !== todayKey) return;

        const events = this.getEvents().filter(ev =>
            ev.day === todayDay && ev.weekKey === weekKey && !ev.allDay,
        );

        for (const ev of events) {
            const card = col.createDiv({ cls: 'event-card event-card-clickable today-event-card' });
            card.setCssProps({
                '--card-top': `${(ev.start / 120) * 80}px`,
                '--card-height': `${((ev.end - ev.start) / 120) * 80}px`,
            });
            const cat = ev.categoryId
                ? this.categoryData.categories.find(c => c.id === ev.categoryId)
                : undefined;
            card.setCssProps({
                '--card-color': cat?.color ?? '#888888',
                '--card-bg': '#eeeeee88',
            });
            card.setText(ev.title);

            // 左侧状态气泡（点击气泡等同于点击卡片）
            this.renderStatusBubble(card, getEventStatus(ev, this.getExecutions()), () => {
                this.toggleEventSelection(ev.id);
            });

            // 点击事件卡片 → 在中心方框展示详情（再次点击取消选中）
            if (this.selectedEventId === ev.id) card.addClass('is-selected');
            card.onclick = (e) => {
                e.stopPropagation();
                this.toggleEventSelection(ev.id);
            };
        }

        // 非计划执行记录：作为独立区块渲染，状态为「新增执行」
        const plannedEventIds = new Set(events.map(ev => ev.id));
        const unplannedExecs = this.getExecutions().filter(ex =>
            ex.day === todayDay
            && ex.weekKey === weekKey
            && !(ex.eventId && plannedEventIds.has(ex.eventId)),
        );
        for (const ex of unplannedExecs) {
            const card = col.createDiv({ cls: 'event-card event-card-exec today-event-card' });
            card.setCssProps({
                '--card-top': `${(ex.start / 120) * 80}px`,
                // 新增执行卡片固定高度 40px
                '--card-height': '40px',
            });
            const item = ex.inboxId
                ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                : undefined;
            const cat = item?.categoryId
                ? this.categoryData.categories.find(c => c.id === item.categoryId)
                : undefined;
            card.setCssProps({
                '--card-color': cat?.color ?? '#888888',
                '--card-bg': '#eeeeee88',
            });
            card.setText(item?.title ?? t('today.statusAdded'));

            this.renderStatusBubble(card, 'added', () => {
                this.toggleExecSelection(ex.id);
            });

            // 点击「新增」卡片 → 在中心方框展示详情（再次点击取消选中）
            if (this.selectedExecId === ex.id) card.addClass('is-selected');
            card.onclick = (e) => {
                e.stopPropagation();
                this.toggleExecSelection(ex.id);
            };
        }
    }

    /** 切换计划事件选中状态（再次点击取消） */
    private toggleEventSelection(eventId: string): void {
        this.selectedEventId = this.selectedEventId === eventId ? undefined : eventId;
        this.selectedExecId = undefined;
        // 与左侧任务面板选中互斥：选中时间轴事件时取消左侧选中
        this.clearInboxSelection();
        void this.refresh();
    }

    /** 切换「新增」执行记录选中状态（再次点击取消） */
    private toggleExecSelection(execId: string): void {
        this.selectedExecId = this.selectedExecId === execId ? undefined : execId;
        this.selectedEventId = undefined;
        // 与左侧任务面板选中互斥：选中时间轴事件时取消左侧选中
        this.clearInboxSelection();
        void this.refresh();
    }

    /** 清除左侧任务面板的选中状态（同步 lastSelectedItemId，避免下次渲染误判为选中变化） */
    private clearInboxSelection(): void {
        this.inboxData.selectedId = undefined;
        this.lastSelectedItemId = undefined;
    }

    /** 取消所有选中状态（时间轴事件 / 新增执行记录 / 左侧任务），恢复显示周目标 / 日目标 */
    private clearAllSelection(): void {
        this.selectedEventId = undefined;
        this.selectedExecId = undefined;
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
