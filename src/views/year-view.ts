import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type { TimeBlockCategoryData } from './week-view/timeblock-category-manager';
import type { InboxData } from '../datatypes/domain';
import { renderTaskPanel } from '../shared/task-panel';
import { renderYearWeekGrid } from '../shared/year-week-grid';
import { makeWeekKey } from './week-view/timeblock-data';
import { t } from '../i18n';

/**
 * 年视图：左侧任务面板 + 右侧周历面板（1-52 周）。
 * 与 WeekScheduleView 一样，通过 renderInto 渲染到指定容器。
 */
export class YearView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: TimeBlockCategoryData;
    private save: () => Promise<void>;
    /** 未选中任务时点击周格子 → 跳转到该周的周计划 */
    private onJumpToWeek?: (weekKey: string) => void;
    /** 获取已制定周计划的周键列表（与周计划视图联动） */
    private getPlannedWeeks?: () => string[];
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: TimeBlockCategoryData,
        save: () => Promise<void>,
        onJumpToWeek?: (weekKey: string) => void,
        getPlannedWeeks?: () => string[],
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.save = save;
        this.onJumpToWeek = onJumpToWeek;
        this.getPlannedWeeks = getPlannedWeeks;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
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
            { enableProjectFocus: true },  // 启用「按项目排布」按钮
        );

        // 右侧：周历面板
        const calendarPanel = container.createDiv({ cls: 'year-calendar-panel' });
        renderYearWeekGrid(calendarPanel, {
            assignedTasks: this.buildAssignedTasks(),
            plannedWeeks: this.getPlannedWeeks?.() ?? [],
            selectedTaskId: this.inboxData.selectedId,
            onWeekClick: (week, year) => {
                void this.onWeekClick(week, year);
            },
        });
    }

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
    }

    /** 汇总各周已分配的任务（周键 → 任务列表，含任务 id 与分类颜色） */
    private buildAssignedTasks(): Record<string, { id: string; title: string; color?: string }[]> {
        const map: Record<string, { id: string; title: string; color?: string }[]> = {};

        // 项目聚焦：仅显示聚焦任务及其所有子任务，隐藏其余任务
        const focusId = this.inboxData.projectFocusId;
        let visibleIds: Set<string> | undefined;
        if (focusId) {
            const focusItem = this.inboxData.items.find(i => i.id === focusId && !i.removed);
            if (focusItem) {
                visibleIds = new Set<string>([focusId]);
                const walk = (parentId: string) => {
                    for (const child of this.inboxData.items) {
                        if (child.removed || child.parentId !== parentId) continue;
                        visibleIds!.add(child.id);
                        walk(child.id);
                    }
                };
                walk(focusId);
            }
        }

        for (const item of this.inboxData.items) {
            if (item.removed || !item.assignedWeekKeys) continue;
            if (visibleIds && !visibleIds.has(item.id)) continue;
            const color = item.categoryId
                ? this.categoryData.categories.find(c => c.id === item.categoryId)?.color
                : undefined;
            for (const weekKey of item.assignedWeekKeys) {
                (map[weekKey] ??= []).push({ id: item.id, title: item.title, color });
            }
        }
        return map;
    }

    /**
     * 点击周格子：
     * - 已选中任务 → 将任务分配到该周（可分配到多个周，再次点击同一周则取消）
     * - 未选中任务 → 跳转到该周的周计划
     */
    private async onWeekClick(week: number, year: number): Promise<void> {
        const weekKey = makeWeekKey(year, week);
        const selectedId = this.inboxData.selectedId;
        const item = selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;

        if (!item) {
            // 未选中任务：跳转到对应周的周计划
            this.onJumpToWeek?.(weekKey);
            return;
        }

        // 已选中任务：分配到该周（再次点击同一周则取消分配）
        const keys = item.assignedWeekKeys ?? [];
        if (keys.includes(weekKey)) {
            item.assignedWeekKeys = keys.filter(k => k !== weekKey);
            await this.save();
            new Notice(t('year.unassigned', { title: item.title, week: weekKey }));
        } else {
            item.assignedWeekKeys = [...keys, weekKey];
            await this.save();
            new Notice(t('year.assigned', { title: item.title, week: weekKey }));
        }
        await this.refresh();
    }
}
