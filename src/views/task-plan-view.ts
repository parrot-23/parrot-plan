import type { App } from 'obsidian';

import type { TimeBlockCategoryData } from './week-view/timeblock-category-manager';
import type { InboxData, InboxItem } from '../datatypes/domain';
import { renderTaskPanel } from '../shared/task-panel';
import { renderSwimlane } from '../shared/swimlane';
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

        // 泳道图（仅显示计划，不显示执行）
        const board = contentPanel.createDiv({ cls: 'task-plan-board' });
        renderSwimlane(board, {
            tasks: this.collectVisibleTasks(),
            categoryData: this.categoryData,
            selectedId: this.inboxData.selectedId,
            currentYear: this.currentYear,
            onYearChange: (year) => {
                this.currentYear = year;
                void this.refresh();
            },
            showExec: false,
        });
    }

    /**
     * 按任务面板的显示顺序收集可见任务（深度优先，跳过已折叠任务的子任务）。
     * 与 task-panel 的 renderList / renderItem 顺序保持一致。
     */
    private collectVisibleTasks(): InboxItem[] {
        const result: InboxItem[] = [];
        const collapsed = this.inboxData.collapsedIds ?? [];

        const walk = (parentId: string | undefined) => {
            const children = this.inboxData.items.filter(
                i => !i.removed && i.parentId === parentId,
            );
            for (const child of children) {
                result.push(child);
                if (!collapsed.includes(child.id)) walk(child.id);
            }
        };
        walk(undefined);
        return result;
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
