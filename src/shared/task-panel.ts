import { App, Modal, Setting, Notice } from 'obsidian';
import type { TimeBlockCategoryData } from '../views/week-view/timeblock-category-manager';
import { t } from '../i18n';
import type { InboxItem, InboxData, Section, SectionType, ChecklistData, StepsData, HabitData } from '../datatypes/domain';
import { DEFAULT_INBOX_DATA } from '../datatypes/domain';

/**
 * 任务面板：公共组件。
 * 多个视图（年视图、周计划、当日执行等）都会使用，
 * 本文件管理任务面板自身的全部信息与渲染逻辑。
 */

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
    private categoryId: string = '';

    constructor(
        app: App,
        private onSubmit: (item: InboxItem) => void,
        /** 分类数据（用于新建时直接选择分类） */
        private categoryData: TimeBlockCategoryData,
        /** 父任务标题（添加子任务时显示） */
        private parentTitle?: string,
    ) {
        super(app);
        // 默认选中第一个分类（未分类）
        this.categoryId = categoryData.categories[0]?.id ?? '';
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

        // 分类：全部列出，点击选中（颜色小方块 + 文字）
        const catSetting = new Setting(contentEl).setName(t('inbox.category'));
        const catList = catSetting.controlEl.createDiv({ cls: 'inbox-cat-picker' });

        const renderCatChips = () => {
            catList.empty();
            const options: { id: string; label: string; color?: string }[] =
                this.categoryData.categories.map(c => ({ id: c.id, label: c.label, color: c.color }));
            for (const opt of options) {
                const chip = catList.createDiv({ cls: 'inbox-cat-chip' });
                if (this.categoryId === opt.id) chip.addClass('is-selected');
                const square = chip.createSpan({ cls: 'inbox-cat-square' });
                square.setCssProps({ '--dot-color': opt.color ?? 'transparent' });
                if (!opt.color) square.addClass('is-none');
                chip.createSpan({ cls: 'inbox-cat-label', text: opt.label });
                chip.onclick = () => {
                    this.categoryId = opt.id;
                    renderCatChips();
                };
            }
        };
        renderCatChips();

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
            categoryId: this.categoryId || undefined,
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
export interface TaskPanelOptions {
    /** 当前周键（提供后显示「周目标」按钮，用于只看本周任务） */
    currentWeekKey?: string;
    /** 是否启用「按项目排布」按钮（仅年视图使用） */
    enableProjectFocus?: boolean;
}

export function renderTaskPanel(
    app: App,
    container: HTMLElement,
    inboxData: InboxData,
    categoryData: TimeBlockCategoryData,
    onAdd: (item: InboxItem) => void | Promise<void>,
    onRefresh: () => void,
    onAction?: (action: string, item: InboxItem) => void | Promise<void>,
    onUpdate?: (item?: InboxItem) => void | Promise<void>,
    options: TaskPanelOptions = {},
) {
    const { currentWeekKey, enableProjectFocus } = options;
    container.empty();
    container.addClass('inbox-panel');

    /** 是否只看本周目标（持久化在 inboxData 中） */
    let weekGoalOnly = inboxData.weekGoalOnly ?? false;

    // ===== 列表区域（可滚动）=====
    const listDiv = container.createDiv({ cls: 'inbox-list' });

    // ===== 底部工具栏（初始隐藏）=====
    const toolbar = container.createDiv({ cls: 'inbox-toolbar' });

    const actions: { id: string; label: string; icon: string }[] = [
        { id: 'detail', label: t('inbox.detail'), icon: '📄' },
        { id: 'delete', label: t('inbox.delete'), icon: '🗑️' },
    ];

    for (const action of actions) {
        const btn = toolbar.createEl('button', {
            cls: 'inbox-toolbar-btn',
            attr: { 'data-action': action.id },
        });
        btn.createSpan({ cls: 'inbox-toolbar-icon', text: action.icon });
        btn.createSpan({ cls: 'inbox-toolbar-label', text: action.label });
        btn.onclick = (e) => {
            // 阻止冒泡到面板空白处，避免打开弹窗时取消选中
            e.stopPropagation();
            if (!inboxData.selectedId) return;
            const item = inboxData.items.find(i => i.id === inboxData.selectedId);
            if (!item) return;

            if (action.id === 'detail') {
                // 查看/编辑任务详情
                new InboxDetailModal(app, item, categoryData, async (updated) => {
                    item.title = updated.title;
                    item.description = updated.description;
                    item.categoryId = updated.categoryId;
                    item.sections = updated.sections;
                    if (onUpdate) await onUpdate(item);
                    renderList();
                    onRefresh();
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
    function renderItem(item: InboxItem, depth: number, recurse = true) {
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

        // 展示板块摘要（只读，编辑在详情弹窗中）
        if (item.sections && item.sections.length > 0) {
            const sectionsEl = itemEl.createDiv({ cls: 'inbox-item-sections' });
            for (const section of item.sections) {
                const chip = sectionsEl.createSpan({ cls: 'inbox-section-chip' });
                const typeLabel = section.type === 'checklist'
                    ? t('section.typeChecklist')
                    : section.type === 'steps'
                        ? t('section.typeSteps')
                        : t('section.typeHabit');
                chip.setText(`${typeLabel}${section.title ? '·' + section.title : ''}`);
            }
        }

        // 点击选中/取消（以 inboxData.selectedId 为准，避免宿主刷新后本地状态失效）
        itemEl.onclick = (e) => {
            e.stopPropagation();
            // 点击任务项时清除板块选中状态
            inboxData.selectedSectionId = undefined;
            inboxData.selectedSectionItemId = undefined;
            if (inboxData.selectedId === item.id) {
                inboxData.selectedId = undefined;
            } else {
                inboxData.selectedId = item.id;
            }
            // 重新渲染列表高亮
            renderList();
            updateToolbar();
            // 通知宿主视图刷新（如泳道图需根据选中任务重绘）
            onRefresh();
        };

        // 递归渲染子任务
        if (recurse && !collapsed) {
            for (const child of children) {
                renderItem(child, depth + 1);
            }
        }
    }

    // ===== 渲染板块为只读子目录（仅项目聚焦模式使用）=====
    function renderSectionsAsSubdir(item: InboxItem, depth: number) {
        if (!item.sections || item.sections.length === 0) return;

        for (const section of item.sections) {
            const el = listDiv.createDiv({ cls: 'inbox-item inbox-section-subdir' });
            el.setCssProps({ '--inbox-depth': String(depth) });

            // 选中态：选中该板块（且未选中具体条目）时高亮
            const sectionSelected = inboxData.selectedSectionId === section.id
                && !inboxData.selectedSectionItemId;
            if (sectionSelected) el.addClass('selected');

            const titleRow = el.createDiv({ cls: 'inbox-item-title-row' });

            // 折叠/展开箭头（复用 collapsedIds，板块 id 前缀为 sec_，不与任务 id 冲突）
            const collapsed = inboxData.collapsedIds?.includes(section.id) ?? false;
            const toggle = titleRow.createSpan({ cls: 'inbox-item-toggle' });
            toggle.setText(collapsed ? '▸' : '▾');
            toggle.onclick = (e) => {
                e.stopPropagation();
                if (!inboxData.collapsedIds) inboxData.collapsedIds = [];
                if (collapsed) {
                    inboxData.collapsedIds = inboxData.collapsedIds.filter(id => id !== section.id);
                } else {
                    inboxData.collapsedIds.push(section.id);
                }
                renderList();
            };

            const typeLabel = section.type === 'checklist'
                ? t('section.typeChecklist')
                : section.type === 'steps'
                    ? t('section.typeSteps')
                    : t('section.typeHabit');
            titleRow.createSpan({ cls: 'inbox-section-subdir-type', text: typeLabel });
            titleRow.createSpan({ cls: 'inbox-item-title', text: section.title || typeLabel });

            // 点击板块名：选中该板块，同时选中所属项目
            el.onclick = (e) => {
                e.stopPropagation();
                selectSection(item, section.id);
            };

            if (collapsed) continue;

            // 条目列表：像子任务一样逐条渲染（只读）
            const items = (section.data as { items?: unknown[] }).items ?? [];
            if (items.length === 0) {
                const emptyEl = listDiv.createDiv({ cls: 'inbox-item inbox-section-subdir' });
                emptyEl.setCssProps({ '--inbox-depth': String(depth + 1) });
                const emptyRow = emptyEl.createDiv({ cls: 'inbox-item-title-row' });
                emptyRow.createSpan({ cls: 'inbox-item-toggle inbox-item-toggle-empty' });
                emptyRow.createSpan({ cls: 'inbox-section-subdir-empty', text: t('section.emptyItems') });
                continue;
            }

            if (section.type === 'checklist') {
                for (const it of (section.data as ChecklistData).items) {
                    renderSectionEntry(item, section.id, depth + 1, it.id, it.done ? '☑' : '☐', it.text);
                }
            } else if (section.type === 'steps') {
                for (const it of (section.data as StepsData).items) {
                    const mark = it.status === 'done' ? '✅' : it.status === 'doing' ? '🔄' : '⬜';
                    renderSectionEntry(item, section.id, depth + 1, it.id, mark, it.text);
                }
            } else if (section.type === 'habit') {
                for (const it of (section.data as HabitData).items) {
                    const count = it.checkedDays?.length ?? 0;
                    renderSectionEntry(item, section.id, depth + 1, it.id, '🔁', it.text, String(count));
                }
            }
        }
    }

    /** 选中板块：selectedId 指向所属项目，同时记录板块 */
    function selectSection(item: InboxItem, sectionId: string) {
        inboxData.selectedId = item.id;
        inboxData.selectedSectionId = sectionId;
        inboxData.selectedSectionItemId = undefined;
        renderList();
        updateToolbar();
        onRefresh();
    }

    /** 选中板块条目：同时选中所属板块与项目 */
    function selectSectionEntry(item: InboxItem, sectionId: string, entryId: string) {
        inboxData.selectedId = item.id;
        inboxData.selectedSectionId = sectionId;
        inboxData.selectedSectionItemId = entryId;
        renderList();
        updateToolbar();
        onRefresh();
    }

    /** 渲染板块下的单个条目（像子任务一样：inbox-item 结构 + 缩进） */
    function renderSectionEntry(
        item: InboxItem,
        sectionId: string,
        depth: number,
        entryId: string,
        mark: string,
        text: string,
        count?: string,
    ) {
        const el = listDiv.createDiv({ cls: 'inbox-item inbox-section-subdir' });
        el.setCssProps({ '--inbox-depth': String(depth) });

        // 选中态：选中该条目时高亮
        if (inboxData.selectedSectionItemId === entryId) el.addClass('selected');

        const titleRow = el.createDiv({ cls: 'inbox-item-title-row' });
        titleRow.createSpan({ cls: 'inbox-item-toggle inbox-item-toggle-empty' });
        titleRow.createSpan({ cls: 'inbox-section-subdir-mark', text: mark });
        titleRow.createSpan({ cls: 'inbox-item-title', text });
        if (count !== undefined) {
            titleRow.createSpan({ cls: 'inbox-section-subdir-count', text: count });
        }

        // 点击条目：选中该条目，同时选中所属板块与项目
        el.onclick = (e) => {
            e.stopPropagation();
            selectSectionEntry(item, sectionId, entryId);
        };
    }

    // ===== 渲染列表 =====
    function renderList() {
        listDiv.empty();

        // 只显示未移除的顶层条目
        let topItems = getChildren(inboxData, undefined);

        // 项目聚焦模式：仅显示聚焦任务及其所有子任务（以聚焦任务为根递归展示）
        const focusId = inboxData.projectFocusId;
        if (focusId) {
            const focusItem = inboxData.items.find(i => i.id === focusId && !i.removed);
            if (!focusItem) {
                // 聚焦任务已不存在（被删除等），自动退出聚焦
                inboxData.projectFocusId = undefined;
            } else {
                listDiv.createDiv({ cls: 'inbox-group-header', text: t('inbox.projectFocus') });
                // 先渲染聚焦任务本身（不递归子任务），再渲染板块，最后渲染子任务，
                // 保证板块位于子任务之上
                renderItem(focusItem, 0, false);
                renderSectionsAsSubdir(focusItem, 1);
                const collapsed = inboxData.collapsedIds?.includes(focusItem.id) ?? false;
                if (!collapsed) {
                    for (const child of getChildren(inboxData, focusItem.id)) {
                        renderItem(child, 1);
                    }
                }
                return;
            }
        }

        // 周目标模式：仅显示「自身」分配到当前周的任务（任意层级，平铺显示），统一归入「周目标」分组
        if (weekGoalOnly && currentWeekKey) {
            const weekKey = currentWeekKey;
            const assignedItems = getVisibleItems(inboxData).filter(i =>
                i.assignedWeekKeys?.includes(weekKey) ?? false,
            );

            if (assignedItems.length === 0) {
                listDiv.createDiv({ cls: 'inbox-empty' }).setText(t('inbox.emptyWeekGoal'));
                return;
            }

            // 单一分组：列出本周所有目标，不再按星期几分组
            listDiv.createDiv({ cls: 'inbox-group-header', text: t('inbox.weekGoal') });
            for (const item of assignedItems) {
                // 平铺渲染：每个任务自身独立成项，不再递归子任务
                renderItem(item, 0, false);
            }
            return;
        }

        if (topItems.length === 0) {
            const emptyKey = weekGoalOnly
                ? 'inbox.emptyWeekGoal'
                : 'inbox.empty';
            listDiv.createDiv({ cls: 'inbox-empty' }).setText(t(emptyKey));
            return;
        }

        for (const item of topItems) {
            renderItem(item, 0);
        }
    }

    renderList();
    updateToolbar();

    // 点击面板空白处取消选中（任务项自身已 stopPropagation）
    container.onclick = () => {
        if (!inboxData.selectedId && !inboxData.selectedSectionId) return;
        inboxData.selectedId = undefined;
        inboxData.selectedSectionId = undefined;
        inboxData.selectedSectionItemId = undefined;
        renderList();
        updateToolbar();
        onRefresh();
    };

    // ===== 标题栏 + 添加按钮（放底部或顶部都行，这里放顶部）=====
    const header = container.createDiv({ cls: 'inbox-header' });
    header.createSpan({ text: t('inbox.title'), cls: 'inbox-title' });

    const headerActions = header.createDiv({ cls: 'inbox-header-actions' });

    // 周目标按钮（仅提供 currentWeekKey 时显示）
    if (currentWeekKey) {
        const weekGoalBtn = headerActions.createEl('button', {
            cls: 'inbox-week-goal-btn',
            text: t('inbox.weekGoal'),
        });
        weekGoalBtn.toggleClass('is-active', weekGoalOnly);
        weekGoalBtn.onclick = (e) => {
            // 阻止冒泡到面板空白处，避免误取消选中
            e.stopPropagation();
            weekGoalOnly = !weekGoalOnly;
            inboxData.weekGoalOnly = weekGoalOnly;
            weekGoalBtn.toggleClass('is-active', weekGoalOnly);
            renderList();
            // 持久化状态
            void (async () => {
                if (onUpdate) await onUpdate();
                onRefresh();
            })();
        };
    }

    // 「按项目排布」按钮（仅年视图启用）：聚焦到选中任务，专门排布其所有子任务
    if (enableProjectFocus) {
        const projectFocusBtn = headerActions.createEl('button', {
            cls: 'inbox-week-goal-btn',
            text: t('inbox.projectFocusBtn'),
        });
        projectFocusBtn.toggleClass('is-active', !!inboxData.projectFocusId);
        projectFocusBtn.onclick = (e) => {
            // 阻止冒泡到面板空白处，避免误取消选中
            e.stopPropagation();
            // 已聚焦：再次点击退出聚焦
            if (inboxData.projectFocusId) {
                inboxData.projectFocusId = undefined;
            } else {
                // 未聚焦：需先选中一个任务，聚焦到该任务
                if (!inboxData.selectedId) {
                    new Notice(t('inbox.projectFocusNeedSelect'));
                    return;
                }
                inboxData.projectFocusId = inboxData.selectedId;
            }
            projectFocusBtn.toggleClass('is-active', !!inboxData.projectFocusId);
            renderList();
            // 持久化状态
            void (async () => {
                if (onUpdate) await onUpdate();
                onRefresh();
            })();
        };
    }

    const addBtn = headerActions.createEl('button', { cls: 'inbox-add-btn', text: '+' });
    addBtn.onclick = (e) => {
        // 阻止冒泡到面板空白处，避免打开弹窗时取消选中
        e.stopPropagation();
        // 选中某个任务时，+ 添加为其子任务
        const parent = inboxData.selectedId
            ? inboxData.items.find(i => i.id === inboxData.selectedId && !i.removed)
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
                // 保持原有选中状态（添加子任务后父任务仍保持选中）
                renderList();
                updateToolbar();
                onRefresh();
            })();
        }, categoryData, parent?.title).open();
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
                .setDestructive()
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

// ===== 任务详情弹窗（查看/编辑标题、描述、分类、板块）=====
class InboxDetailModal extends Modal {
    private title: string;
    private description: string;
    private categoryId: string;
    /** 板块的本地副本（编辑期间操作，保存时写回） */
    private sections: Section[];

    constructor(
        app: App,
        private item: InboxItem,
        private categoryData: TimeBlockCategoryData,
        private onSave: (updated: { title: string; description: string; categoryId?: string; sections?: Section[] }) => void | Promise<void>,
    ) {
        super(app);
        this.title = item.title;
        this.description = item.description;
        this.categoryId = item.categoryId ?? '';
        // 深拷贝板块，避免编辑时直接改动原数据（取消时不生效）
        this.sections = (item.sections ?? []).map(s => ({
            ...s,
            data: JSON.parse(JSON.stringify(s.data)),
        }));
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('inbox.detail') });

        new Setting(contentEl)
            .setName(t('inbox.name'))
            .addText(text => {
                text.setPlaceholder(t('inbox.namePlaceholder'))
                    .setValue(this.title)
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
            .setName(t('inbox.category'))
            .addDropdown(drop => {
                drop.addOption('', t('inbox.noCategory'));
                for (const cat of this.categoryData.categories) {
                    drop.addOption(cat.id, cat.label);
                }
                drop.setValue(this.categoryId)
                    .onChange(val => this.categoryId = val);
            });

        // ===== 板块编辑区 =====
        const sectionHeader = contentEl.createDiv({ cls: 'section-header' });
        sectionHeader.createSpan({ text: t('section.title'), cls: 'section-title' });
        const addSectionBtn = sectionHeader.createEl('button', {
            cls: 'section-add-btn',
            text: t('section.add'),
        });
        addSectionBtn.onclick = () => this.openAddSectionModal();

        const sectionList = contentEl.createDiv({ cls: 'section-list' });
        this.renderSections(sectionList);

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('common.save'))
                .setCta()
                .onClick(() => this.submit())
            )
            .addButton(btn => btn
                .setButtonText(t('common.cancel'))
                .onClick(() => this.close())
            );
    }

    /** 渲染板块列表（编辑态） */
    private renderSections(container: HTMLElement) {
        container.empty();
        if (this.sections.length === 0) {
            container.createDiv({ cls: 'section-empty', text: t('section.empty') });
            return;
        }
        for (const section of this.sections) {
            const el = container.createDiv({ cls: 'section-item' });
            const head = el.createDiv({ cls: 'section-item-head' });
            const typeLabel = this.sectionTypeLabel(section.type);
            head.createSpan({ cls: 'section-item-type', text: typeLabel });
            head.createSpan({ cls: 'section-item-name', text: section.title || typeLabel });

            const delBtn = head.createEl('button', { cls: 'section-item-del', text: '🗑️' });
            delBtn.onclick = () => {
                this.sections = this.sections.filter(s => s.id !== section.id);
                this.renderSections(container);
            };

            // 各类型条目编辑
            this.renderSectionItems(el, section, container);
        }
    }

    /** 渲染某板块的条目编辑区 */
    private renderSectionItems(el: HTMLElement, section: Section, container: HTMLElement) {
        const itemsEl = el.createDiv({ cls: 'section-items' });

        if (section.type === 'checklist') {
            const data = section.data as ChecklistData;
            for (const item of data.items) {
                const row = itemsEl.createDiv({ cls: 'section-item-row' });
                const cb = row.createEl('input', { type: 'checkbox' });
                cb.checked = item.done;
                cb.onchange = () => { item.done = cb.checked; };
                const text = row.createEl('input', { type: 'text', cls: 'section-item-text' });
                text.value = item.text;
                text.onchange = () => { item.text = text.value; };
                const del = row.createEl('button', { cls: 'section-item-del', text: '✕' });
                del.onclick = () => {
                    data.items = data.items.filter(i => i.id !== item.id);
                    this.renderSections(container);
                };
            }
        } else if (section.type === 'steps') {
            const data = section.data as StepsData;
            for (const item of data.items) {
                const row = itemsEl.createDiv({ cls: 'section-item-row' });
                const sel = row.createEl('select', { cls: 'section-step-status' });
                const statuses: Array<{ v: 'todo' | 'doing' | 'done'; label: string }> = [
                    { v: 'todo', label: t('section.stepTodo') },
                    { v: 'doing', label: t('section.stepDoing') },
                    { v: 'done', label: t('section.stepDone') },
                ];
                for (const s of statuses) {
                    const opt = sel.createEl('option', { text: s.label, value: s.v });
                    if (item.status === s.v) opt.selected = true;
                }
                sel.onchange = () => { item.status = sel.value as 'todo' | 'doing' | 'done'; };
                const text = row.createEl('input', { type: 'text', cls: 'section-item-text' });
                text.value = item.text;
                text.onchange = () => { item.text = text.value; };
                const del = row.createEl('button', { cls: 'section-item-del', text: '✕' });
                del.onclick = () => {
                    data.items = data.items.filter(i => i.id !== item.id);
                    this.renderSections(container);
                };
            }
        } else if (section.type === 'habit') {
            const data = section.data as HabitData;
            for (const item of data.items) {
                const row = itemsEl.createDiv({ cls: 'section-item-row' });
                const text = row.createEl('input', { type: 'text', cls: 'section-item-text' });
                text.value = item.text;
                text.onchange = () => { item.text = text.value; };
                const del = row.createEl('button', { cls: 'section-item-del', text: '✕' });
                del.onclick = () => {
                    data.items = data.items.filter(i => i.id !== item.id);
                    this.renderSections(container);
                };
            }
        }

        // 添加条目按钮
        const addBtn = itemsEl.createEl('button', { cls: 'section-add-item-btn', text: t('section.addItem') });
        addBtn.onclick = () => {
            this.addItemToSection(section);
            this.renderSections(container);
        };
    }

    /** 向板块添加一个空条目 */
    private addItemToSection(section: Section) {
        const id = `sec_item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        if (section.type === 'checklist') {
            (section.data as ChecklistData).items.push({ id, text: '', done: false });
        } else if (section.type === 'steps') {
            (section.data as StepsData).items.push({ id, text: '', status: 'todo' });
        } else if (section.type === 'habit') {
            (section.data as HabitData).items.push({ id, text: '' });
        }
    }

    /** 打开「添加板块」弹窗 */
    private openAddSectionModal() {
        const modal = new Modal(this.app);
        let type: SectionType = 'checklist';
        let name = '';
        modal.onOpen = () => {
            const { contentEl } = modal;
            contentEl.empty();
            contentEl.createEl('h3', { text: t('section.add') });

            new Setting(contentEl)
                .setName(t('section.type'))
                .addDropdown(drop => {
                    drop.addOption('checklist', t('section.typeChecklist'));
                    drop.addOption('steps', t('section.typeSteps'));
                    drop.addOption('habit', t('section.typeHabit'));
                    drop.setValue('checklist')
                        .onChange(val => type = val as SectionType);
                });

            new Setting(contentEl)
                .setName(t('section.name'))
                .addText(text => {
                    text.setPlaceholder(t('section.namePlaceholder'))
                        .onChange(val => name = val);
                });

            new Setting(contentEl)
                .addButton(btn => btn
                    .setButtonText(t('common.add'))
                    .setCta()
                    .onClick(() => {
                        const id = `sec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                        const data: ChecklistData | StepsData | HabitData =
                            type === 'checklist' ? { items: [] }
                            : type === 'steps' ? { items: [] }
                            : { items: [] };
                        this.sections.push({ id, type, title: name.trim() || undefined, data });
                        modal.close();
                        // 重新渲染板块列表
                        const list = this.contentEl.querySelector('.section-list');
                        if (list) this.renderSections(list as HTMLElement);
                    })
                )
                .addButton(btn => btn
                    .setButtonText(t('common.cancel'))
                    .onClick(() => modal.close())
                );
        };
        modal.open();
    }

    private sectionTypeLabel(type: SectionType): string {
        if (type === 'checklist') return t('section.typeChecklist');
        if (type === 'steps') return t('section.typeSteps');
        return t('section.typeHabit');
    }

    private submit() {
        if (!this.title.trim()) {
            new Notice(t('inbox.nameRequired'));
            return;
        }
        void (async () => {
            await this.onSave({
                title: this.title.trim(),
                description: this.description.trim(),
                categoryId: this.categoryId || undefined,
                sections: this.sections,
            });
            this.close();
        })();
    }

    onClose() {
        this.contentEl.empty();
    }
}
