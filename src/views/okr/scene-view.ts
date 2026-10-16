// 剧本场景视图：初始页展示「进入剧本场景」按钮，点击后切换到今天的任务清单。
import type { App } from 'obsidian';

import type { PlanCategoryData } from '../../shared/plan-category-manager';
import type { EventBlock } from '../../datatypes/domain';
import { getISOWeek, makeWeekKey } from '../../shared/plan-data';
import { t } from '../../i18n';

/**
 * 剧本场景视图：与 WorkbenchView 一致，通过 renderInto 渲染到指定容器。
 * 两种状态：初始页（按钮 + 说明）/ 任务清单页（今天的计划事件）。
 */
export class SceneView {
    private app: App;
    private categoryData: PlanCategoryData;
    /** 获取全部计划事件 */
    private getEvents: () => EventBlock[];
    /** 是否已进入剧本场景（任务清单页） */
    private entered = false;
    /** 当前渲染容器（用于状态切换时自刷新） */
    private container?: HTMLElement;

    constructor(
        app: App,
        categoryData: PlanCategoryData,
        getEvents: () => EventBlock[],
    ) {
        this.app = app;
        this.categoryData = categoryData;
        this.getEvents = getEvents;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('scene-view');

        if (!this.entered) {
            this.renderEntry(container);
        } else {
            this.renderTaskList(container);
        }
    }

    /** 初始页：进入按钮 + 说明 */
    private renderEntry(container: HTMLElement) {
        const entry = container.createDiv({ cls: 'scene-entry' });
        entry.createDiv({ cls: 'scene-entry-title', text: t('scene.entryTitle') });
        entry.createDiv({ cls: 'scene-entry-desc', text: t('scene.entryDesc') });

        const btn = entry.createEl('button', {
            cls: 'scene-enter-btn',
            text: t('scene.enter'),
        });
        btn.onclick = () => {
            this.entered = true;
            if (this.container) void this.renderInto(this.container);
        };
    }

    /** 任务清单页：今天的计划事件 */
    private renderTaskList(container: HTMLElement) {
        const header = container.createDiv({ cls: 'scene-header' });
        const backBtn = header.createEl('button', {
            cls: 'scene-back-btn',
            text: t('scene.back'),
        });
        backBtn.onclick = () => {
            this.entered = false;
            if (this.container) void this.renderInto(this.container);
        };
        header.createDiv({ cls: 'scene-title', text: t('scene.todayTasks') });

        const list = container.createDiv({ cls: 'scene-task-list' });

        // 今天的计划事件（统一为全天事件）
        const now = new Date();
        const day = (now.getDay() + 6) % 7 + 1;
        const weekKey = makeWeekKey(now.getFullYear(), getISOWeek(now));
        const dayEvents = this.getEvents()
            .filter(ev => ev.day === day && ev.weekKey === weekKey);

        if (dayEvents.length === 0) {
            list.createDiv({ cls: 'scene-task-empty', text: t('scene.empty') });
            return;
        }

        for (const ev of dayEvents) {
            const cat = ev.categoryId
                ? this.categoryData.categories.find(c => c.id === ev.categoryId)
                : undefined;

            const row = list.createDiv({ cls: 'scene-task-item' });
            row.setCssProps({ '--chip-color': cat?.color ?? '#888888' });
            row.createSpan({ cls: 'scene-task-name', text: ev.title });

            row.createSpan({ cls: 'scene-task-time', text: t('allday.label') });
        }
    }
}
