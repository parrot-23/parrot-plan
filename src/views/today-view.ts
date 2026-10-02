import type { App } from 'obsidian';

import type { TimeBlockCategoryData } from '../week/timeblock-category-manager';
import type { InboxData } from '../shared/task-panel';
import { renderTaskPanel } from '../shared/task-panel';
import { getCurrentDayKey, getCurrentWeekKey, makeDayKeyFromWeek } from '../week/timeblock-data';
import type { EventBlock } from '../week/week-schedule-view';
import { t } from '../i18n';

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
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 红线定时器 */
    private timer?: number;

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: TimeBlockCategoryData,
        save: () => Promise<void>,
        getEvents: () => EventBlock[],
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.save = save;
        this.getEvents = getEvents;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        this.clearTimer();
        container.empty();
        container.addClass('today-view');

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
        );

        // ===== 中间：执行区（空面板 + 开始执行按钮）=====
        const execPanel = container.createDiv({ cls: 'today-exec-panel' });
        const startBtn = execPanel.createEl('button', {
            text: t('today.start'),
            cls: 'today-start-btn',
        });
        startBtn.onclick = () => {
            // 占位：后续实现执行逻辑
        };

        // ===== 右侧：当天时间轴 =====
        const timelinePanel = container.createDiv({ cls: 'today-timeline-panel' });
        this.renderTimeline(timelinePanel);
    }

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
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
            const card = col.createDiv({ cls: 'event-card' });
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
