// 梳理视图（GTD 第三步）：左中右三栏结构。
// 左：收集视图的未处理卡片；中：选择源面板（顶部按钮切换，当前仅「任务」）；右：内容编写 + 确认按钮。
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type { GtdRepo } from '../../repos/gtd-repo';
import type { InboxData } from '../../datatypes/domain';
import type { TimeBlockCategoryData } from '../../shared/timeblock-category-manager';
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
    private categoryData: TimeBlockCategoryData;
    private save: () => Promise<void>;
    /** 当前选中的收集卡片 id */
    private selectedItemId?: string;
    /** 选择源面板当前激活的按钮 */
    private activeSourceTab: SourceTab = 'tasks';
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;

    constructor(
        app: App,
        gtdRepo: GtdRepo,
        inboxData: InboxData,
        categoryData: TimeBlockCategoryData,
        save: () => Promise<void>,
    ) {
        this.app = app;
        this.gtdRepo = gtdRepo;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.save = save;
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
            { hideAddButton: true, hideToolbar: true },
        );
    }

    /** 右栏：整理说明 + 确认按钮 */
    private renderRight(layout: HTMLElement) {
        const col = layout.createDiv({ cls: 'gtd-clarify-col gtd-clarify-right' });
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

        // 确认按钮（居中）
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
    }
}
