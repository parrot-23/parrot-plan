import { App, Modal, Setting, Notice } from 'obsidian';
import type { TimeBlockCategoryData } from '../week/timeblock-category-manager';
import { makeDayKeyFromWeek } from '../week/timeblock-data';
import { t, getWeekDays } from '../i18n';

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
    /** 已分配到的周键列表（如 ['2026-W40']），可分配到多个周 */
    assignedWeekKeys?: string[];
    /** 已分配到的日期列表（如 ['2026-10-02']），可分配到多天 */
    assignedDayKeys?: string[];
    /** 已从收集盒移除（不再显示，但数据保留，可查历史） */
    removed?: boolean;
}

export interface InboxData {
    items: InboxItem[];
    selectedId?: string;
    /** 已折叠的任务 id（其子任务不显示） */
    collapsedIds?: string[];
    /** 是否只看本周目标（持久化） */
    weekGoalOnly?: boolean;
    /** 是否只看当日目标（持久化） */
    dayGoalOnly?: boolean;
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

/** 判断某任务自身或其任一后代是否满足条件（用于目标筛选时保留父级链路） */
function itemOrDescendantMatches(
    inboxData: InboxData,
    item: InboxItem,
    predicate: (target: InboxItem) => boolean,
): boolean {
    if (predicate(item)) return true;
    return getChildren(inboxData, item.id).some(child =>
        itemOrDescendantMatches(inboxData, child, predicate),
    );
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
            // 「无分类」选项
            const options: { id: string; label: string; color?: string }[] = [
                { id: '', label: t('inbox.noCategory') },
                ...this.categoryData.categories.map(c => ({ id: c.id, label: c.label, color: c.color })),
            ];
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
export function renderTaskPanel(
    app: App,
    container: HTMLElement,
    inboxData: InboxData,
    categoryData: TimeBlockCategoryData,
    onAdd: (item: InboxItem) => void | Promise<void>,
    onRefresh: () => void,
    onAction?: (action: string, item: InboxItem) => void | Promise<void>,
    onUpdate?: (item?: InboxItem) => void | Promise<void>,
    /** 当前周键（提供后显示「周目标」按钮，用于只看本周任务） */
    currentWeekKey?: string,
    /** 当前日期键（提供后显示「日目标」按钮，用于只看当天任务） */
    currentDayKey?: string,
    /**
     * 日目标分组：返回任务属于「全天目标」还是「时间点目标」。
     * 提供后，日目标模式会按此自动分组显示。
     */
    getDayGoalGroup?: (item: InboxItem) => 'allday' | 'timed',
) {
    container.empty();
    container.addClass('inbox-panel');

    /** 是否只看本周目标（持久化在 inboxData 中） */
    let weekGoalOnly = inboxData.weekGoalOnly ?? false;
    /** 是否只看当日目标（持久化在 inboxData 中） */
    let dayGoalOnly = inboxData.dayGoalOnly ?? false;

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

        // 点击选中/取消（以 inboxData.selectedId 为准，避免宿主刷新后本地状态失效）
        itemEl.onclick = (e) => {
            e.stopPropagation();
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

    // ===== 渲染列表 =====
    function renderList() {
        listDiv.empty();

        // 只显示未移除的顶层条目
        let topItems = getChildren(inboxData, undefined);

        // 周目标模式：仅显示「自身」分配到当前周的任务（任意层级，平铺显示），并按星期几分组
        if (weekGoalOnly && currentWeekKey) {
            const weekKey = currentWeekKey;
            const assignedItems = getVisibleItems(inboxData).filter(i =>
                i.assignedWeekKeys?.includes(weekKey) ?? false,
            );

            if (assignedItems.length === 0) {
                listDiv.createDiv({ cls: 'inbox-empty' }).setText(t('inbox.emptyWeekGoal'));
                return;
            }

            // 按星期几分组：1=周一 ... 7=周日；未指定具体天的归入「未指定」
            const weekDays = getWeekDays();
            const dayKeys = new Map<number, string>();
            for (let d = 1; d <= 7; d++) {
                dayKeys.set(d, makeDayKeyFromWeek(weekKey, d));
            }

            const groups: { label: string; items: InboxItem[] }[] = [];
            for (let d = 1; d <= 7; d++) {
                const key = dayKeys.get(d)!;
                const items = assignedItems.filter(i => i.assignedDayKeys?.includes(key) ?? false);
                if (items.length > 0) groups.push({ label: weekDays[d - 1], items });
            }
            // 未指定具体星期的任务
            const unspecified = assignedItems.filter(i =>
                !Array.from(dayKeys.values()).some(key => i.assignedDayKeys?.includes(key) ?? false),
            );
            if (unspecified.length > 0) {
                groups.push({ label: t('inbox.groupUnspecified'), items: unspecified });
            }

            for (const group of groups) {
                listDiv.createDiv({ cls: 'inbox-group-header', text: group.label });
                for (const item of group.items) {
                    // 平铺渲染：每个任务自身独立成项，不再递归子任务
                    renderItem(item, 0, false);
                }
            }
            return;
        }

        // 日目标模式：仅显示分配到当天的任务（含子任务命中时保留父级链路）
        if (dayGoalOnly && currentDayKey) {
            const dayKey = currentDayKey;
            topItems = topItems.filter(i =>
                itemOrDescendantMatches(inboxData, i, t => t.assignedDayKeys?.includes(dayKey) ?? false),
            );
        }

        if (topItems.length === 0) {
            const emptyKey = dayGoalOnly
                ? 'inbox.emptyDayGoal'
                : weekGoalOnly
                    ? 'inbox.emptyWeekGoal'
                    : 'inbox.empty';
            listDiv.createDiv({ cls: 'inbox-empty' }).setText(t(emptyKey));
            return;
        }

        // 日目标模式 + 提供分组回调：按「全天目标 / 时间点目标」分组显示
        // 分组依据是「任务自身」是否分配到当天，而非顶层任务，因此子任务可与其父任务分属不同组
        if (dayGoalOnly && getDayGoalGroup && currentDayKey) {
            const dayKey = currentDayKey;
            // 收集所有「自身」分配到当天的任务（任意层级）
            const assignedItems = getVisibleItems(inboxData).filter(i =>
                i.assignedDayKeys?.includes(dayKey) ?? false,
            );

            const allDayItems = assignedItems.filter(i => getDayGoalGroup(i) === 'allday');
            const timedItems = assignedItems.filter(i => getDayGoalGroup(i) === 'timed');

            const renderGroup = (labelKey: 'inbox.groupAllDay' | 'inbox.groupTimed', items: InboxItem[]) => {
                if (items.length === 0) return;
                listDiv.createDiv({ cls: 'inbox-group-header', text: t(labelKey) });
                for (const item of items) {
                    // 平铺渲染：每个任务自身独立成项，不再递归子任务（避免重复与跨组）
                    renderItem(item, 0, false);
                }
            };

            renderGroup('inbox.groupAllDay', allDayItems);
            renderGroup('inbox.groupTimed', timedItems);
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
        if (!inboxData.selectedId) return;
        inboxData.selectedId = undefined;
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

    // 日目标按钮（仅提供 currentDayKey 时显示）
    if (currentDayKey) {
        const dayGoalBtn = headerActions.createEl('button', {
            cls: 'inbox-week-goal-btn',
            text: t('inbox.dayGoal'),
        });
        dayGoalBtn.toggleClass('is-active', dayGoalOnly);
        dayGoalBtn.onclick = (e) => {
            // 阻止冒泡到面板空白处，避免误取消选中
            e.stopPropagation();
            dayGoalOnly = !dayGoalOnly;
            inboxData.dayGoalOnly = dayGoalOnly;
            dayGoalBtn.toggleClass('is-active', dayGoalOnly);
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

// ===== 任务详情弹窗（查看/编辑标题、描述、分类）=====
class InboxDetailModal extends Modal {
    private title: string;
    private description: string;
    private categoryId: string;

    constructor(
        app: App,
        private item: InboxItem,
        private categoryData: TimeBlockCategoryData,
        private onSave: (updated: { title: string; description: string; categoryId?: string }) => void | Promise<void>,
    ) {
        super(app);
        this.title = item.title;
        this.description = item.description;
        this.categoryId = item.categoryId ?? '';
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
            });
            this.close();
        })();
    }

    onClose() {
        this.contentEl.empty();
    }
}
