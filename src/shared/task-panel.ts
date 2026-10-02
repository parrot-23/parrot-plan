import { App, Modal, Setting, Notice } from 'obsidian';
import type { TimeBlockCategoryData } from '../week/timeblock-category-manager';
import { t } from '../i18n';

/**
 * 任务面板：公共组件。
 * 多个视图（年视图、周计划、当日执行等）都会使用，
 * 本文件管理任务面板自身的全部信息与渲染逻辑。
 */

export interface InboxItem {
    id: string;
    title: string;
    description: string;
    categoryId?: string;
    createdAt: number;
    /** 父任务 id（无则为顶层任务），支持无限层级子任务 */
    parentId?: string;
    /** 已从收集盒移除（不再显示，但数据保留，可查历史） */
    removed?: boolean;
}

export interface InboxData {
    items: InboxItem[];
    selectedId?: string;
    /** 已折叠的任务 id（其子任务不显示） */
    collapsedIds?: string[];
}

export const DEFAULT_INBOX_DATA: InboxData = {
    items: [],
};

/** 子任务最大嵌套层数（顶层为第 1 层） */
export const MAX_INBOX_DEPTH = 7;

/** 计算某任务的层级（顶层为 1） */
function getItemDepth(inboxData: InboxData, item: InboxItem): number {
    let depth = 1;
    let current = item;
    while (current.parentId) {
        const parent = inboxData.items.find(i => i.id === current.parentId);
        if (!parent) break;
        depth++;
        current = parent;
    }
    return depth;
}

/** 收集盒中所有未移除的任务（扁平） */
function getVisibleItems(inboxData: InboxData): InboxItem[] {
    return inboxData.items.filter(i => !i.removed);
}

/** 获取某任务的直接子任务（未移除） */
function getChildren(inboxData: InboxData, parentId: string | undefined): InboxItem[] {
    return getVisibleItems(inboxData).filter(i => i.parentId === parentId);
}

/** 判断某任务是否有子任务 */
function hasChildren(inboxData: InboxData, id: string): boolean {
    return getVisibleItems(inboxData).some(i => i.parentId === id);
}

/** 递归收集某任务及其所有后代 id */
function collectDescendantIds(inboxData: InboxData, id: string): string[] {
    const result: string[] = [];
    const walk = (parentId: string) => {
        for (const child of getChildren(inboxData, parentId)) {
            result.push(child.id);
            walk(child.id);
        }
    };
    walk(id);
    return result;
}

// ===== 新增弹窗 =====
class InboxAddModal extends Modal {
    private title: string = '';
    private description: string = '';

    constructor(
        app: App,
        private onSubmit: (item: InboxItem) => void,
        /** 父任务标题（添加子任务时显示） */
        private parentTitle?: string,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', {
            text: this.parentTitle
                ? t('inbox.addSubTitle', { title: this.parentTitle })
                : t('inbox.addTitle'),
        });

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
export function renderTaskPanel(
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
                    // 连同所有后代一起移除
                    const ids = [item.id, ...collectDescendantIds(inboxData, item.id)];
                    for (const id of ids) {
                        const target = inboxData.items.find(i => i.id === id);
                        if (target) target.removed = true;
                    }
                    if (inboxData.selectedId && ids.includes(inboxData.selectedId)) {
                        inboxData.selectedId = undefined;
                    }
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

    // ===== 渲染单个任务（递归）=====
    function renderItem(item: InboxItem, depth: number) {
        const itemEl = listDiv.createDiv({
            cls: 'inbox-item',
            attr: { 'data-id': item.id },
        });
        itemEl.setCssProps({ '--inbox-depth': String(depth) });

        if (inboxData.selectedId === item.id) {
            itemEl.addClass('selected');
        }

        const titleRow = itemEl.createDiv({ cls: 'inbox-item-title-row' });

        // 折叠/展开箭头（有子任务时显示）
        const children = getChildren(inboxData, item.id);
        const collapsed = inboxData.collapsedIds?.includes(item.id) ?? false;
        if (children.length > 0) {
            const toggle = titleRow.createSpan({ cls: 'inbox-item-toggle' });
            toggle.setText(collapsed ? '▸' : '▾');
            toggle.onclick = (e) => {
                e.stopPropagation();
                if (!inboxData.collapsedIds) inboxData.collapsedIds = [];
                if (collapsed) {
                    inboxData.collapsedIds = inboxData.collapsedIds.filter(id => id !== item.id);
                } else {
                    inboxData.collapsedIds.push(item.id);
                }
                renderList();
            };
        } else {
            titleRow.createSpan({ cls: 'inbox-item-toggle inbox-item-toggle-empty' });
        }

        // 分类色点
        if (item.categoryId) {
            const cat = categoryData.categories.find(c => c.id === item.categoryId);
            if (cat) {
                const dot = titleRow.createSpan({ cls: 'inbox-category-dot' });
                dot.setCssProps({ '--dot-color': cat.color });
            }
        }

        titleRow.createSpan({ cls: 'inbox-item-title', text: item.title });

        if (item.description) {
            itemEl.createDiv({ cls: 'inbox-item-desc' })
                .setText(item.description);
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

        // 递归渲染子任务
        if (!collapsed) {
            for (const child of children) {
                renderItem(child, depth + 1);
            }
        }
    }

    // ===== 渲染列表 =====
    function renderList() {
        listDiv.empty();

        // 只显示未移除的顶层条目
        const topItems = getChildren(inboxData, undefined);

        if (topItems.length === 0) {
            listDiv.createDiv({ cls: 'inbox-empty' })
                .setText(t('inbox.empty'));
            return;
        }

        for (const item of topItems) {
            renderItem(item, 0);
        }
    }

    renderList();
    updateToolbar();

    // ===== 标题栏 + 添加按钮（放底部或顶部都行，这里放顶部）=====
    const header = container.createDiv({ cls: 'inbox-header' });
    header.createSpan({ text: t('inbox.title'), cls: 'inbox-title' });

    const addBtn = header.createEl('button', { cls: 'inbox-add-btn', text: '+' });
    addBtn.onclick = () => {
        // 选中某个任务时，+ 添加为其子任务
        const parent = selectedId
            ? inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;

        // 限制最大嵌套层数
        if (parent && getItemDepth(inboxData, parent) >= MAX_INBOX_DEPTH) {
            new Notice(t('inbox.maxDepth', { max: MAX_INBOX_DEPTH }));
            return;
        }

        new InboxAddModal(app, (item) => {
            if (parent) {
                item.parentId = parent.id;
                // 确保父任务展开，便于看到新子任务
                if (inboxData.collapsedIds) {
                    inboxData.collapsedIds = inboxData.collapsedIds.filter(id => id !== parent.id);
                }
            }
            inboxData.items.push(item);
            void (async () => {
                await onAdd(item);
                selectedId = null;  // 添加后清除选中
                inboxData.selectedId = undefined;
                renderList();
                updateToolbar();
                onRefresh();
            })();
        }, parent?.title).open();
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
