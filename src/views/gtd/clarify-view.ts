// 梳理视图（GTD 第三步）：左中右三栏结构。
// 左：收集视图的未处理卡片；中：选择源面板（顶部按钮切换，当前仅「任务」）；右：内容编写 + 确认按钮。
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type { GtdRepo } from '../../repos/gtd-repo';
import type { InboxRepo } from '../../repos/inbox-repo';
import type { InboxData, InboxItem } from '../../datatypes/domain';
import type { PlanCategoryData } from '../../shared/plan-category-manager';
import { renderTaskPanel } from '../../shared/task-panel';
import { t } from '../../i18n';

/** 选择源面板的顶部按钮标识（当前仅「任务」） */
type SourceTab = 'tasks';

/**
 * 梳理视图：与 WorkbenchView 一致，通过 renderInto 渲染到指定容器。
 */
export class GtdClarifyView {
    private app: App;
    private gtdRepo: GtdRepo;
    private inboxData: InboxData;
    private categoryData: PlanCategoryData;
    private save: () => Promise<void>;
    /** 当前选中的收集卡片 id */
    private selectedItemId?: string;
    /** 选择源面板当前激活的按钮 */
    private activeSourceTab: SourceTab = 'tasks';
    /** 右栏是否处于「创建新任务」表单模式 */
    private creatingTask = false;
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 收集盒领域仓库（任务面板增删改走仓库方法，保证跨视图一致） */
    private inboxRepo?: InboxRepo;

    constructor(
        app: App,
        gtdRepo: GtdRepo,
        inboxData: InboxData,
        categoryData: PlanCategoryData,
        save: () => Promise<void>,
        inboxRepo?: InboxRepo,
    ) {
        this.app = app;
        this.gtdRepo = gtdRepo;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.save = save;
        this.inboxRepo = inboxRepo;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('gtd-clarify-view');

        const layout = container.createDiv({ cls: 'gtd-clarify-layout' });

        this.renderLeft(layout);
        this.renderMiddle(layout);
        this.renderRight(layout);
    }

    /** 左栏：收集视图的未处理卡片 */
    private renderLeft(layout: HTMLElement) {
        const col = layout.createDiv({ cls: 'gtd-clarify-col gtd-clarify-left' });
        col.createDiv({ cls: 'gtd-clarify-col-title', text: t('gtd.clarifyLeftTitle') });

        const list = col.createDiv({ cls: 'gtd-clarify-list' });
        const pending = this.gtdRepo.getPendingItems();
        if (pending.length === 0) {
            list.createDiv({ cls: 'gtd-clarify-empty', text: t('gtd.collectEmpty') });
            return;
        }
        for (const item of pending) {
            const card = list.createDiv({ cls: 'gtd-clarify-item' });
            if (item.id === this.selectedItemId) card.addClass('is-active');
            card.setText(item.content);
            card.onclick = () => {
                this.selectedItemId = item.id;
                if (this.container) void this.renderInto(this.container);
            };
        }
    }

    /** 中栏：选择源面板（顶部按钮切换，当前仅「任务」） */
    private renderMiddle(layout: HTMLElement) {
        const col = layout.createDiv({ cls: 'gtd-clarify-col gtd-clarify-middle' });
        col.createDiv({ cls: 'gtd-clarify-col-title', text: t('gtd.clarifyMiddleTitle') });

        // 顶部按钮行
        const tabs = col.createDiv({ cls: 'gtd-clarify-source-tabs' });
        const tabItems: { id: SourceTab; labelKey: 'gtd.organizeTasks' }[] = [
            { id: 'tasks', labelKey: 'gtd.organizeTasks' },
        ];
        for (const tab of tabItems) {
            const btn = tabs.createEl('button', {
                cls: 'gtd-clarify-source-tab',
                text: t(tab.labelKey),
                attr: { 'data-tab': tab.id },
            });
            if (tab.id === this.activeSourceTab) btn.addClass('is-active');
            btn.onclick = () => {
                if (this.activeSourceTab === tab.id) return;
                this.activeSourceTab = tab.id;
                if (this.container) void this.renderInto(this.container);
            };
        }

        // 面板内容
        const body = col.createDiv({ cls: 'gtd-clarify-source-body' });
        if (this.activeSourceTab === 'tasks') {
            this.renderTaskSource(body);
        }
    }

    /** 选择源面板内容：任务面板 */
    private renderTaskSource(container: HTMLElement) {
        renderTaskPanel(
            this.app,
            container,
            this.inboxData,
            this.categoryData,
            async () => {
                await this.save();
            },
            () => {
                if (this.container) void this.renderInto(this.container);
            },
            undefined,
            async () => {
                await this.save();
            },
            // 梳理视图的选择源面板：隐藏「+」按钮与底部工具栏
            { hideAddButton: true, hideToolbar: true, inboxRepo: this.inboxRepo },
        );
    }

    /** 右栏：整理说明 + 确认按钮（或「创建新任务」表单） */
    private renderRight(layout: HTMLElement) {
        const col = layout.createDiv({ cls: 'gtd-clarify-col gtd-clarify-right' });

        // 创建新任务表单模式
        if (this.creatingTask) {
            this.renderCreateTaskForm(col);
            return;
        }

        col.createDiv({ cls: 'gtd-clarify-col-title', text: t('gtd.clarifyRightTitle') });

        const selectedTask = this.inboxData.selectedId
            ? this.inboxData.items.find((it) => it.id === this.inboxData.selectedId && !it.removed)
            : undefined;
        const selectedItem = this.selectedItemId
            ? this.gtdRepo.data.items.find((it) => it.id === this.selectedItemId)
            : undefined;

        // 整理说明行：信息将放入 xxx 任务的收集篮子中
        const organizeRow = col.createDiv({ cls: 'gtd-clarify-organize-row' });
        organizeRow.createSpan({ cls: 'gtd-clarify-organize-label', text: t('gtd.clarifyOrganizeLabel') });
        organizeRow.createSpan({
            cls: 'gtd-clarify-organize-text',
            text: selectedTask
                ? t('gtd.clarifyOrganizeTarget', { name: selectedTask.title })
                : t('gtd.clarifyOrganizeNoTarget'),
        });

        // 待整理内容预览（来自左栏选中的收集记录）
        const preview = col.createDiv({ cls: 'gtd-clarify-preview' });
        preview.createDiv({ cls: 'gtd-clarify-preview-label', text: t('gtd.clarifyPreviewLabel') });
        preview.createDiv({
            cls: 'gtd-clarify-preview-text',
            text: selectedItem ? selectedItem.content : t('gtd.clarifyPreviewEmpty'),
        });

        // 底部按钮：确认 + 创建为新任务
        const footer = col.createDiv({ cls: 'gtd-clarify-footer' });
        const confirmBtn = footer.createEl('button', {
            cls: 'gtd-clarify-confirm-btn',
            text: t('gtd.clarifyConfirm'),
        });
        confirmBtn.onclick = () => {
            if (!selectedItem || !selectedTask) return;

            // 将收集记录内容放入选中任务的收集篮子，并标记为已处理
            this.gtdRepo.clarify(selectedItem.id, selectedTask);

            this.selectedItemId = undefined;
            new Notice(t('gtd.clarifyResult', {
                content: selectedItem.content,
                name: selectedTask.title,
            }));
            void this.save().then(() => {
                if (this.container) void this.renderInto(this.container);
            });
        };

        // 创建为新任务：切换到创建表单
        const createBtn = footer.createEl('button', {
            cls: 'gtd-clarify-create-btn',
            text: t('gtd.clarifyCreateTask'),
        });
        createBtn.onclick = () => {
            if (!selectedItem) return;
            this.creatingTask = true;
            if (this.container) void this.renderInto(this.container);
        };
    }

    /** 右栏：创建新任务表单（标题 + 描述 + 分类 + 确认/取消） */
    private renderCreateTaskForm(col: HTMLElement) {
        const selectedTask = this.inboxData.selectedId
            ? this.inboxData.items.find((it) => it.id === this.inboxData.selectedId && !it.removed)
            : undefined;
        const selectedItem = this.selectedItemId
            ? this.gtdRepo.data.items.find((it) => it.id === this.selectedItemId)
            : undefined;

        // 标题：有选中任务时显示为「创建新任务（xx 的子任务）」
        col.createDiv({
            cls: 'gtd-clarify-col-title',
            text: selectedTask
                ? t('gtd.clarifyCreateSubTitle', { name: selectedTask.title })
                : t('gtd.clarifyCreateTitle'),
        });

        const form = col.createDiv({ cls: 'gtd-clarify-create-form' });

        // 标题输入框
        form.createDiv({ cls: 'gtd-clarify-create-label', text: t('gtd.clarifyCreateNameLabel') });
        const nameInput = form.createEl('input', {
            cls: 'gtd-clarify-create-input',
            type: 'text',
            attr: { placeholder: t('gtd.clarifyCreateNamePlaceholder') },
        });

        // 描述：预填收集记录内容（可编辑）
        form.createDiv({ cls: 'gtd-clarify-create-label', text: t('gtd.clarifyCreateDescLabel') });
        const descInput = form.createEl('textarea', { cls: 'gtd-clarify-create-textarea' });
        descInput.value = selectedItem ? selectedItem.content : '';

        // 分类下拉
        form.createDiv({ cls: 'gtd-clarify-create-label', text: t('gtd.clarifyCreateCategoryLabel') });
        const catSelect = form.createEl('select', { cls: 'gtd-clarify-create-select' });
        for (const cat of this.categoryData.categories) {
            catSelect.createEl('option', { text: cat.label, value: cat.id });
        }

        // 底部按钮：确认 + 取消
        const footer = col.createDiv({ cls: 'gtd-clarify-footer' });
        const confirmBtn = footer.createEl('button', {
            cls: 'gtd-clarify-confirm-btn',
            text: t('gtd.clarifyCreateConfirm'),
        });
        confirmBtn.onclick = () => {
            const title = nameInput.value.trim();
            if (!title) {
                new Notice(t('gtd.clarifyCreateNameRequired'));
                return;
            }
            if (!selectedItem) return;

            // 创建新任务（有选中任务时作为其子任务）
            const item: InboxItem = {
                id: `inbox_${Date.now()}`,
                title,
                description: descInput.value.trim(),
                categoryId: catSelect.value || undefined,
                createdAt: Date.now(),
            };
            if (selectedTask) {
                item.parentId = selectedTask.id;
                // 确保父任务展开，便于看到新子任务
                if (this.inboxRepo) {
                    this.inboxRepo.expand(selectedTask.id);
                } else if (this.inboxData.collapsedIds) {
                    this.inboxData.collapsedIds = this.inboxData.collapsedIds.filter(id => id !== selectedTask.id);
                }
            }
            if (this.inboxRepo) {
                this.inboxRepo.addItem(item);
            } else {
                this.inboxData.items.push(item);
            }

            // 标记收集记录为已处理
            selectedItem.status = 'processed';

            this.creatingTask = false;
            this.selectedItemId = undefined;
            new Notice(t('gtd.clarifyCreateResult', { name: title }));
            void this.save().then(() => {
                if (this.container) void this.renderInto(this.container);
            });
        };

        const cancelBtn = footer.createEl('button', {
            cls: 'gtd-clarify-cancel-btn',
            text: t('gtd.clarifyCreateCancel'),
        });
        cancelBtn.onclick = () => {
            this.creatingTask = false;
            if (this.container) void this.renderInto(this.container);
        };
    }
}
