import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type { TimeBlockCategoryData } from './week-view/timeblock-category-manager';
import type { InboxData, InboxItem } from '../datatypes/domain';
import { renderTaskPanel } from '../shared/task-panel';
import { renderSwimlane } from '../shared/swimlane';
import { makeWeekKey, parseWeekKey } from './week-view/timeblock-data';
import { t } from '../i18n';

/**
 * 任务计划视图：左侧任务面板 + 右侧内容区（项目信息表单 + 泳道图）。
 * 与 YearView 一样，通过 renderInto 渲染到指定容器。
 */
export class TaskPlanView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: TimeBlockCategoryData;
    private save: () => Promise<void>;
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 泳道图当前显示的年份 */
    private currentYear: number = new Date().getFullYear();

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
        container.empty();
        container.addClass('task-plan-view');

        // 左侧：任务面板
        const taskPanel = container.createDiv({ cls: 'task-plan-task-panel' });
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
            { enableProjectFocus: true },
        );

        // 右侧：内容区（当前选中任务的信息表单 + 泳道图）
        const contentPanel = container.createDiv({ cls: 'task-plan-content-panel' });
        this.renderInfoForm(contentPanel);

        // 泳道图（仅显示计划，不显示执行；只显示当前选中任务及其子任务）
        const board = contentPanel.createDiv({ cls: 'task-plan-board' });
        const { tasks, depthMap, inheritedMap } = this.collectSelectedSubtree();
        renderSwimlane(board, {
            tasks,
            categoryData: this.categoryData,
            selectedId: this.inboxData.selectedId,
            currentYear: this.currentYear,
            onYearChange: (year) => {
                this.currentYear = year;
                void this.refresh();
            },
            showExec: false,
            getDepth: (task) => depthMap.get(task.id) ?? 0,
            getDescendantWeeks: (task) => inheritedMap.get(task.id) ?? [],
            onWeekClick: (task, week) => {
                void this.toggleWeekAssignment(task, week);
            },
        });
    }

    /**
     * 点击泳道图某周格子：将该行任务分配到该周（再次点击同一周则取消）。
     */
    private async toggleWeekAssignment(task: InboxItem, week: number): Promise<void> {
        const item = this.inboxData.items.find(i => i.id === task.id && !i.removed);
        if (!item) return;

        const weekKey = makeWeekKey(this.currentYear, week);
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

    /**
     * 收集当前选中任务及其所有子任务（深度优先，跳过已折叠任务的子任务）。
     * 返回任务列表、每个任务的层级深度（选中任务为 0），
     * 以及每个任务的所有子孙节点的计划周号（当前年份，用于渲染条纹格子）。
     * 未选中任务时返回空列表。
     */
    private collectSelectedSubtree(): {
        tasks: InboxItem[];
        depthMap: Map<string, number>;
        inheritedMap: Map<string, number[]>;
    } {
        const tasks: InboxItem[] = [];
        const depthMap = new Map<string, number>();
        const inheritedMap = new Map<string, number[]>();
        const selectedId = this.inboxData.selectedId;
        if (!selectedId) return { tasks, depthMap, inheritedMap };
        const root = this.inboxData.items.find(i => i.id === selectedId && !i.removed);
        if (!root) return { tasks, depthMap, inheritedMap };

        const collapsed = this.inboxData.collapsedIds ?? [];

        // 提取任务在当前年份的计划周号
        const weeksOf = (item: InboxItem): number[] => {
            const result: number[] = [];
            for (const key of item.assignedWeekKeys ?? []) {
                const parsed = parseWeekKey(key);
                if (parsed.year === this.currentYear) result.push(parsed.week);
            }
            return result;
        };

        // 递归收集：返回该节点及其所有子孙的计划周号集合
        const walk = (item: InboxItem, depth: number): Set<number> => {
            tasks.push(item);
            depthMap.set(item.id, depth);

            const descendantWeeks = new Set<number>();
            if (!collapsed.includes(item.id)) {
                const children = this.inboxData.items.filter(
                    i => !i.removed && i.parentId === item.id,
                );
                for (const child of children) {
                    // 子节点自身计划周 + 其子孙的计划周
                    for (const w of weeksOf(child)) descendantWeeks.add(w);
                    for (const w of Array.from(walk(child, depth + 1))) descendantWeeks.add(w);
                }
            }
            // 该行条纹格子 = 所有子孙的计划周（不含自身）
            inheritedMap.set(item.id, Array.from(descendantWeeks));
            return descendantWeeks;
        };
        walk(root, 0);
        return { tasks, depthMap, inheritedMap };
    }

    /** 渲染右侧信息表单：项目描述、分类、已计划周数 */
    private renderInfoForm(container: HTMLElement): void {
        const selectedId = this.inboxData.selectedId;
        const item = selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;

        if (!item) {
            container.createDiv({
                cls: 'task-plan-empty',
                text: t('taskPlan.noSelection'),
            });
            return;
        }

        const form = container.createDiv({ cls: 'task-plan-form' });

        // 标题
        form.createEl('h2', { cls: 'task-plan-title', text: item.title });

        // 项目描述
        const descRow = form.createDiv({ cls: 'task-plan-field' });
        descRow.createDiv({ cls: 'task-plan-field-label', text: t('taskPlan.description') });
        descRow.createDiv({
            cls: 'task-plan-field-value',
            text: item.description || t('taskPlan.emptyValue'),
        });

        // 分类
        const category = item.categoryId
            ? this.categoryData.categories.find(c => c.id === item.categoryId)
            : undefined;
        const catRow = form.createDiv({ cls: 'task-plan-field' });
        catRow.createDiv({ cls: 'task-plan-field-label', text: t('taskPlan.category') });
        const catValue = catRow.createDiv({ cls: 'task-plan-field-value' });
        if (category) {
            const dot = catValue.createSpan({ cls: 'task-plan-category-dot' });
            if (category.color) dot.style.backgroundColor = category.color;
            catValue.createSpan({ text: category.label });
        } else {
            catValue.setText(t('taskPlan.emptyValue'));
        }

        // 已计划周数：列出所有已分配到的周键
        const weekKeys = item.assignedWeekKeys ?? [];
        const weekRow = form.createDiv({ cls: 'task-plan-field' });
        weekRow.createDiv({ cls: 'task-plan-field-label', text: t('taskPlan.plannedWeeks') });
        const weekValue = weekRow.createDiv({ cls: 'task-plan-field-value' });
        if (weekKeys.length === 0) {
            weekValue.setText(t('taskPlan.emptyValue'));
        } else {
            for (const key of weekKeys) {
                weekValue.createSpan({ cls: 'task-plan-week-tag', text: key });
            }
        }
    }

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
    }
}
