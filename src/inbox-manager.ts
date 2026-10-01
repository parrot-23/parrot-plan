import { App, Modal, Setting, Notice } from 'obsidian';
import type { TimeBlockCategoryData } from './timeblock-category-manager';
import { t } from './i18n';

export interface InboxItem {
    id: string;
    title: string;
    description: string;
    categoryId?: string;
    createdAt: number;
    /** 已从收集盒移除（不再显示，但数据保留，可查历史） */
    removed?: boolean;
}

export interface InboxData {
    items: InboxItem[];
    selectedId?: string; 
}

export const DEFAULT_INBOX_DATA: InboxData = {
    items: [],
};

// ===== 新增弹窗 =====
class InboxAddModal extends Modal {
    private title: string = '';
    private description: string = '';

    constructor(
        app: App,
        private onSubmit: (item: InboxItem) => void
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('inbox.addTitle') });

        new Setting(contentEl)
            .setName(t('inbox.name'))
            .addText(text => {
                text.setPlaceholder(t('inbox.namePlaceholder'))
                    .onChange(val => this.title = val);
            });

        new Setting(contentEl)
            .setName(t('inbox.desc'))
            .addTextArea(text => {
                text.setPlaceholder(t('inbox.descPlaceholder'))
                    .setValue(this.description)
                    .onChange(val => this.description = val);
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('common.add'))
                .setCta()
                .onClick(() => this.submit())
            )
            .addButton(btn => btn
                .setButtonText(t('common.cancel'))
                .onClick(() => this.close())
            );
    }

    private submit() {
        if (!this.title.trim()) {
            new Notice(t('inbox.nameRequired'));
            return;
        }

        const item: InboxItem = {
            id: `inbox_${Date.now()}`,
            title: this.title.trim(),
            description: this.description.trim(),
            createdAt: Date.now(),
        };
        this.onSubmit(item);
        this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ===== 渲染面板 =====
export function renderInboxPanel(
    app: App,
    container: HTMLElement,
    inboxData: InboxData,
    categoryData: TimeBlockCategoryData,
    onAdd: (item: InboxItem) => void | Promise<void>,
    onRefresh: () => void,
    onAction?: (action: string, item: InboxItem) => void | Promise<void>,
    onUpdate?: (item: InboxItem) => void | Promise<void>,
) {
    container.empty();
    container.addClass('inbox-panel');

    let selectedId: string | null = null;

    // ===== 列表区域（可滚动）=====
    const listDiv = container.createDiv({ cls: 'inbox-list' });

    // ===== 底部工具栏（初始隐藏）=====
    const toolbar = container.createDiv({ cls: 'inbox-toolbar' });

    const actions: { id: string; label: string; icon: string }[] = [
        { id: 'set-category', label: t('inbox.setCategory'), icon: '🏷️' },
        { id: 'delete', label: t('inbox.delete'), icon: '🗑️' },
    ];

    for (const action of actions) {
        const btn = toolbar.createEl('button', {
            cls: 'inbox-toolbar-btn',
            attr: { 'data-action': action.id },
        });
        btn.createSpan({ cls: 'inbox-toolbar-icon', text: action.icon });
        btn.createSpan({ cls: 'inbox-toolbar-label', text: action.label });
        btn.onclick = () => {
            if (!selectedId) return;
            const item = inboxData.items.find(i => i.id === selectedId);
            if (!item) return;

            if (action.id === 'set-category') {
                // 弹窗选分类
                new CategorySelectModal(app, categoryData, item.categoryId, (catId) => {
                    item.categoryId = catId || undefined;
                    void (async () => {
                        if (onUpdate) await onUpdate(item);
                        renderList();
                    })();
                }).open();
            } else if (action.id === 'delete') {
                // 从收集盒移除（不再显示，但数据保留，可查历史）
                new ConfirmDeleteInboxModal(app, item.title, async () => {
                    item.removed = true;
                    if (inboxData.selectedId === item.id) inboxData.selectedId = undefined;
                    selectedId = null;
                    if (onUpdate) await onUpdate(item);
                    renderList();
                    updateToolbar();
                    onRefresh();
                }).open();
            } else if (onAction) {
                void onAction(action.id, item);
            }
        };
    }

    // ===== 更新工具栏显示 =====
    function updateToolbar() {
        const hasSelection = !!inboxData.selectedId;
        const buttons = toolbar.querySelectorAll('.inbox-toolbar-btn');
        for (const btn of Array.from(buttons)) {
            (btn as HTMLButtonElement).disabled = !hasSelection;
            btn.toggleClass('is-disabled', !hasSelection);
        }
    }

    // ===== 渲染列表 =====
    function renderList() {
        listDiv.empty();

        // 只显示未移除的条目
        const visibleItems = inboxData.items.filter(i => !i.removed);

        if (visibleItems.length === 0) {
            listDiv.createDiv({ cls: 'inbox-empty' })
                .setText(t('inbox.empty'));
            return;
        }

        for (const item of visibleItems.slice(0, 10)) {
            const itemEl = listDiv.createDiv({
                cls: 'inbox-item',
                attr: { 'data-id': item.id },
            });

            if (inboxData.selectedId === item.id) {
                itemEl.addClass('selected');
            }

            itemEl.createDiv({ cls: 'inbox-item-title' })
                .setText(item.title);

            if (item.description) {
                itemEl.createDiv({ cls: 'inbox-item-desc' })
                    .setText(item.description);
            }

            // 显示分类色点
            if (item.categoryId) {
                const cat = categoryData.categories.find(c => c.id === item.categoryId);
                if (cat) {
                    const dot = itemEl.createSpan({ cls: 'inbox-category-dot' });
                    dot.setCssProps({ '--dot-color': cat.color });
                    const titleEl = itemEl.querySelector('.inbox-item-title') as HTMLElement;
                    if (titleEl) titleEl.prepend(dot);
                }
            }

            // 点击选中/取消
            itemEl.onclick = () => {
                if (selectedId === item.id) {
                    selectedId = null;
                    inboxData.selectedId = undefined;
                } else {
                    selectedId = item.id;
                    inboxData.selectedId = item.id;
                }
                // 重新渲染列表高亮
                renderList();
                updateToolbar();
            };
        }
    }

    renderList();
    updateToolbar();

    // ===== 标题栏 + 添加按钮（放底部或顶部都行，这里放顶部）=====
    const header = container.createDiv({ cls: 'inbox-header' });
    header.createSpan({ text: t('inbox.title'), cls: 'inbox-title' });

    const addBtn = header.createEl('button', { cls: 'inbox-add-btn', text: '+' });
    addBtn.onclick = () => {
        new InboxAddModal(app, (item) => {
            inboxData.items.unshift(item);
            void (async () => {
                await onAdd(item);
                selectedId = null;  // 添加后清除选中
                renderList();
                updateToolbar();
                onRefresh();
            })();
        }).open();
    };

    // 把 header 移到最前面（DOM 顺序：header → list → toolbar）
    container.insertBefore(header, listDiv);
}

// ===== 导出类型供外部使用 =====
export type InboxAction = 'schedule' | 'convert' | 'link-note' | 'archive';


// ===== 删除确认弹窗 =====
class ConfirmDeleteInboxModal extends Modal {
    constructor(
        app: App,
        private itemTitle: string,
        private onConfirm: () => void | Promise<void>,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('inbox.delete') });
        contentEl.createEl('p', { text: t('inbox.deleteConfirm', { title: this.itemTitle }) });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('common.delete'))
                .setWarning()
                .setCta()
                .onClick(async () => {
                    await this.onConfirm();
                    this.close();
                })
            )
            .addButton(btn => btn
                .setButtonText(t('common.cancel'))
                .onClick(() => this.close())
            );
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ===== 设置分类选择弹窗 =====
class CategorySelectModal extends Modal {
    constructor(
        app: App,
        private categories: TimeBlockCategoryData,
        private currentCategoryId: string | undefined,
        private onSelect: (categoryId: string) => void,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('inbox.selectCategory') });

        // 清除分类
        new Setting(contentEl)
            .setName(t('inbox.noCategory'))
            .addButton(btn => btn
                .setButtonText(t('common.clear'))
                .onClick(() => {
                    this.onSelect('');
                    this.close();
                })
            );

        // 每个分类
        for (const cat of this.categories.categories) {
            const setting = new Setting(contentEl).setName(cat.label);

            const dot = setting.nameEl.createSpan({ cls: 'inbox-category-dot-lg' });
            dot.setCssProps({ '--dot-color': cat.color });

            setting.addButton(btn => btn
                .setButtonText(t('common.select'))
                .onClick(() => {
                    this.onSelect(cat.id);
                    this.close();
                })
            );

            if (cat.id === this.currentCategoryId) {
                setting.settingEl.addClass('is-selected');
            }
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
