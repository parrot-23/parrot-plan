import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type { TimeBlockCategoryData } from '../week/timeblock-category-manager';
import type { InboxData, InboxItem } from '../shared/task-panel';
import { renderTaskPanel } from '../shared/task-panel';
import { getCurrentDayKey, getCurrentWeekKey, makeDayKeyFromWeek } from '../week/timeblock-data';
import type { EventBlock, ExecutionRecord } from '../week/week-schedule-view';
import { getWeekDays, t } from '../i18n';
import { EVENT_STATUS_EMOJI, EVENT_STATUS_LABEL_KEY, getEventStatus, type EventStatus } from '../shared/event-status';

/** 把分钟数格式化为 HH:MM */
function formatMinutes(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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
            {
                currentDayKey: getCurrentDayKey(),          // 用于「日目标」筛选
                getDayGoalGroup: (item) => this.getDayGoalGroup(item), // 日目标分组：全天 / 时间点
            },
        );

        // ===== 中间：日期方框 + 任务层级方框 + 任务详情方框 + 操作按钮 =====
        const centerPanel = container.createDiv({ cls: 'today-center-panel' });
        this.renderDateBox(centerPanel);
        this.renderHierarchyBox(centerPanel);
        this.renderDetailBox(centerPanel);
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

    /**
     * 判断任务属于「全天目标」还是「时间点目标」。
     * 仅依据该任务「自身」今天是否存在带时间点的事件：有则为「时间点目标」，否则为「全天目标」。
     */
    private getDayGoalGroup(item: InboxItem): 'allday' | 'timed' {
        const now = new Date();
        const todayDay = (now.getDay() + 6) % 7 + 1;
        const weekKey = getCurrentWeekKey();
        const events = this.getEvents();

        const hasTimedEvent = events.some(ev =>
            ev.inboxId === item.id && ev.weekKey === weekKey && ev.day === todayDay && !ev.allDay,
        );
        return hasTimedEvent ? 'timed' : 'allday';
    }

    /** 渲染今天的年月日方框 */
    private renderDateBox(panel: HTMLElement) {
        const now = new Date();
        const box = panel.createDiv({ cls: 'today-date-box' });
        box.createDiv({ cls: 'today-date-year', text: `${now.getFullYear()}` });
        box.createDiv({ cls: 'today-date-md' })
            .setText(`${String(now.getMonth() + 1).padStart(2, '0')} / ${String(now.getDate()).padStart(2, '0')}`);
        box.createDiv({ cls: 'today-date-weekday', text: getWeekDays()[(now.getDay() + 6) % 7] });
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

    /** 渲染操作按钮：选中左侧任务显示「执行非计划任务」；选中时间轴事件显示「执行计划 / 替换计划」 */
    private renderActionButtons(panel: HTMLElement) {
        const selectedEvent = this.getSelectedEvent();
        const selectedItem = this.getSelectedItem();
        const row = panel.createDiv({ cls: 'today-action-row' });

        // 选中「新增」执行记录：不显示任何操作按钮
        if (this.selectedExecId) return;

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
        void this.refresh();
    }

    /** 切换「新增」执行记录选中状态（再次点击取消） */
    private toggleExecSelection(execId: string): void {
        this.selectedExecId = this.selectedExecId === execId ? undefined : execId;
        this.selectedEventId = undefined;
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
