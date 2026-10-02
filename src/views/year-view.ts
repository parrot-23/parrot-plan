import type { App } from 'obsidian';

import type { TimeBlockCategoryData } from '../week/timeblock-category-manager';
import type { InboxData } from '../shared/task-panel';
import { renderTaskPanel } from '../shared/task-panel';
import { renderYearWeekGrid } from '../shared/year-week-grid';

/**
 * 年视图：左侧任务面板 + 右侧周历面板（1-52 周）。
 * 与 WeekScheduleView 一样，通过 renderInto 渲染到指定容器。
 */
export class YearView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: TimeBlockCategoryData;
    private save: () => Promise<void>;
    private refresh: () => Promise<void>;

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: TimeBlockCategoryData,
        save: () => Promise<void>,
        refresh: () => Promise<void>,
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.save = save;
        this.refresh = refresh;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        container.empty();
        container.addClass('year-view');

        // 左侧：任务面板
        const taskPanel = container.createDiv({ cls: 'year-task-panel' });
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

        // 右侧：周历面板
        const calendarPanel = container.createDiv({ cls: 'year-calendar-panel' });
        renderYearWeekGrid(calendarPanel, {
            onWeekClick: (week) => {
                // 占位：后续可跳转到对应周
            },
        });
    }
}
