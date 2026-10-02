import type { App } from 'obsidian';

import type { TimeBlockCategoryData } from '../week/timeblock-category-manager';
import type { InboxData } from '../shared/task-panel';
import { renderTaskPanel } from '../shared/task-panel';
import { getCurrentDayKey } from '../week/timeblock-data';
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
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 红线定时器 */
    private timer?: number;

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: TimeBlockCategoryData,
        save: () => Promise<void>,
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.save = save;
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

    /** 渲染当天时间轴（时间刻度 + 当前时刻红线） */
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
