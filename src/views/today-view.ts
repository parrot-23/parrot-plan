import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type { TimeBlockCategoryData } from '../week/timeblock-category-manager';
import type { InboxData, InboxItem } from '../shared/task-panel';
import { renderTaskPanel } from '../shared/task-panel';
import { getCurrentDayKey, getCurrentWeekKey, makeDayKeyFromWeek } from '../week/timeblock-data';
import type { EventBlock, ExecutionRecord } from '../week/week-schedule-view';
import { getWeekDays, t } from '../i18n';

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
    /** 上一次渲染时任务面板选中的任务 id（用于检测选中变化） */
    private lastSelectedItemId?: string;

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
        container.empty();
        container.addClass('today-view');

        // 任务面板选中项发生变化时，清除时间轴事件选中（两者互斥）
        if (this.inboxData.selectedId !== this.lastSelectedItemId) {
            this.lastSelectedItemId = this.inboxData.selectedId;
            this.selectedEventId = undefined;
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
            undefined,                     // 不显示「周目标」按钮
            getCurrentDayKey(),            // 当前日期键（用于「日目标」筛选）
            (item) => this.getDayGoalGroup(item), // 日目标分组：全天 / 时间点
        );

        // ===== 中间：日期方框 + 任务详情方框 + 操作按钮 =====
        const centerPanel = container.createDiv({ cls: 'today-center-panel' });
        this.renderDateBox(centerPanel);
        this.renderDetailBox(centerPanel);
        this.renderActionButtons(centerPanel);

        // ===== 右侧：当天时间轴 =====
        const timelinePanel = container.createDiv({ cls: 'today-timeline-panel' });
        this.renderTimeline(timelinePanel);
    }

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
    }

    /**
     * 判断任务属于「全天目标」还是「时间点目标」。
     * 若该任务（或其任一后代）今天存在带时间点的事件，则为「时间点目标」，否则为「全天目标」。
     */
    private getDayGoalGroup(item: InboxItem): 'allday' | 'timed' {
        const now = new Date();
        const todayDay = (now.getDay() + 6) % 7 + 1;
        const weekKey = getCurrentWeekKey();
        const events = this.getEvents();

        const hasTimedEvent = (target: InboxItem): boolean => {
            if (events.some(ev =>
                ev.inboxId === target.id && ev.weekKey === weekKey && ev.day === todayDay && !ev.allDay,
            )) {
                return true;
            }
            return this.inboxData.items.some(child =>
                child.parentId === target.id && !child.removed && hasTimedEvent(child),
            );
        };

        return hasTimedEvent(item) ? 'timed' : 'allday';
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

    /** 渲染任务详情方框（展示左侧选中任务或时间轴选中事件的详情） */
    private renderDetailBox(panel: HTMLElement) {
        const box = panel.createDiv({ cls: 'today-detail-box' });
        box.createDiv({ cls: 'today-detail-title', text: t('today.detailTitle') });

        const body = box.createDiv({ cls: 'today-detail-body' });

        // 优先展示时间轴上选中的事件；否则展示任务面板选中的任务
        const selectedEvent = this.selectedEventId
            ? this.getEvents().find(ev => ev.id === this.selectedEventId)
            : undefined;
        const selectedItem = this.inboxData.selectedId
            ? this.inboxData.items.find(i => i.id === this.inboxData.selectedId && !i.removed)
            : undefined;

        if (selectedEvent) {
            this.renderEventDetail(body, selectedEvent);
            return;
        }
        if (selectedItem) {
            this.renderItemDetail(body, selectedItem);
            return;
        }

        body.createDiv({ cls: 'today-detail-empty', text: t('today.noSelection') });
    }

    /** 渲染操作按钮（仅在选中任务时可用） */
    private renderActionButtons(panel: HTMLElement) {
        const selectedItem = this.getSelectedItem();
        const row = panel.createDiv({ cls: 'today-action-row' });

        const completeBtn = row.createEl('button', {
            cls: 'today-action-btn',
            text: t('today.complete'),
        });
        completeBtn.disabled = !selectedItem;
        completeBtn.onclick = () => {
            void this.completeSelectedTask();
        };

        const replaceBtn = row.createEl('button', {
            cls: 'today-action-btn',
            text: t('today.replace'),
        });
        replaceBtn.disabled = !selectedItem;
        replaceBtn.onclick = () => {
            void this.replaceSelectedEvent();
        };
    }

    /** 当前任务面板选中的任务（未移除） */
    private getSelectedItem(): InboxItem | undefined {
        return this.inboxData.selectedId
            ? this.inboxData.items.find(i => i.id === this.inboxData.selectedId && !i.removed)
            : undefined;
    }

    /** 完成执行计划任务：为选中任务生成一条执行记录 */
    private async completeSelectedTask(): Promise<void> {
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

    /** 替换执行其他任务：用当前选中任务替换时间轴上选中的事件 */
    private async replaceSelectedEvent(): Promise<void> {
        const item = this.getSelectedItem();
        if (!item) return;

        const ev = this.selectedEventId
            ? this.getEvents().find(e => e.id === this.selectedEventId)
            : undefined;
        if (!ev) {
            new Notice(t('today.replaceNeedEvent'));
            return;
        }

        ev.title = item.title;
        ev.categoryId = item.categoryId;
        ev.inboxId = item.id;
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
            const card = col.createDiv({ cls: 'event-card event-card-clickable' });
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

            // 点击事件卡片 → 在中心方框展示详情（再次点击取消选中）
            if (this.selectedEventId === ev.id) card.addClass('is-selected');
            card.onclick = (e) => {
                e.stopPropagation();
                this.selectedEventId = this.selectedEventId === ev.id ? undefined : ev.id;
                void this.refresh();
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
