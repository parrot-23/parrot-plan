import { App, Modal, Setting, Notice, AbstractInputSuggest, TFile, setIcon } from 'obsidian';
import type { TimeBlockCategoryData } from '../views/week-view/timeblock-category-manager';
import { t } from '../i18n';
import type { InboxItem, InboxData, Section, SectionType, ChecklistData, StepsData, HabitData, FileData, EventBlock } from '../datatypes/domain';
import { DEFAULT_INBOX_DATA, SECTION_TYPE_META } from '../datatypes/domain';

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

/** 板块类型显示名（统一入口，避免各处三元判断遗漏新类型） */
function sectionTypeLabel(type: SectionType): string {
    if (type === 'checklist') return t('section.typeChecklist');
    if (type === 'steps') return t('section.typeSteps');
    if (type === 'habit') return t('section.typeHabit');
    return t('section.typeFile');
}

/** 分钟数 → 时长文本（如 90 → "1.5h"，60 → "1h"，30 → "30m"） */
function formatDuration(minutes: number): string {
    if (minutes <= 0) return '0m';
    if (minutes < 60) return `${minutes}m`;
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

// ===== 新增浮动面板（紧贴任务面板右侧，非模态，可同时操作其他笔记）=====
class InboxAddPanel {
    private title: string = '';
    private description: string = '';
    private categoryId: string = '';
    private panelEl: HTMLElement;
    private closeHandler?: (e: MouseEvent) => void;

    constructor(
        private app: App,
        /** 挂载父容器（任务面板根节点），面板作为其子节点，随视图一起销毁 */
        private mountParent: HTMLElement,
        /** 锚点元素（「+」按钮），面板紧贴其所在任务面板右侧 */
        private anchor: HTMLElement,
        private onSubmit: (item: InboxItem) => void,
        /** 分类数据（用于新建时直接选择分类） */
        private categoryData: TimeBlockCategoryData,
        /** 父任务标题（添加子任务时显示） */
        private parentTitle?: string,
    ) {
        // 默认选中第一个分类（未分类）
        this.categoryId = categoryData.categories[0]?.id ?? '';
        // 挂到任务面板容器内（而非 body），随视图一起销毁；用绝对定位紧贴其右侧
        this.panelEl = mountParent.createDiv({ cls: 'inbox-add-panel' });
        // 阻止点击面板内部时冒泡到任务面板容器，避免触发「点击空白处取消选中」导致面板被重渲染移除
        this.panelEl.onclick = (e) => e.stopPropagation();
    }

    open() {
        this.render();
        // 等布局完成后再定位，确保尺寸真实
        this.position();
        window.requestAnimationFrame(() => this.position());
        // 点击面板外部关闭（延迟绑定，避免本次点击立即触发关闭）
        // 用 mousedown 判断，且检查事件目标是否在面板内，避免点击面板内部时误关闭
        this.closeHandler = (e: MouseEvent) => {
            const target = e.target as Node | null;
            if (target && this.panelEl.contains(target)) return;
            this.close();
        };
        window.setTimeout(() => {
            if (this.closeHandler) document.addEventListener('mousedown', this.closeHandler);
        }, 0);
    }

    /** 定位：相对任务面板容器绝对定位，紧贴其右边缘，垂直对齐「+」按钮 */
    private position() {
        const parentRect = this.mountParent.getBoundingClientRect();
        const anchorRect = this.anchor.getBoundingClientRect();
        // 相对父容器：left = 父容器宽度（紧贴右边缘），top = 按钮相对父容器顶部的偏移
        const left = this.mountParent.clientWidth;
        const top = anchorRect.top - parentRect.top;
        this.panelEl.setCssProps({
            '--panel-left': `${left}px`,
            '--panel-top': `${top}px`,
        });
    }

    private render() {
        const contentEl = this.panelEl;
        contentEl.empty();
        contentEl.createEl('h3', {
            cls: 'inbox-add-panel-title',
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

    close() {
        if (this.closeHandler) {
            document.removeEventListener('mousedown', this.closeHandler);
            this.closeHandler = undefined;
        }
        this.panelEl.remove();
    }
}

// ===== 渲染面板 =====
export interface TaskPanelOptions {
    /** 当前周键（提供后显示「周目标」按钮，用于只看本周任务） */
    currentWeekKey?: string;
    /** 是否启用「按项目排布」按钮（仅年视图使用） */
    enableProjectFocus?: boolean;
    /** 当前周的计划事件（用于周目标卡片统计已分配时长/次数） */
    events?: EventBlock[];
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
    const { currentWeekKey, enableProjectFocus, events } = options;
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
                // 通知宿主视图刷新（如泳道图需根据展开/折叠后的子任务重绘）
                onRefresh();
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

        // 展示板块摘要（只读，编辑在详情弹窗中）：仅显示类型图标，不显示名称
        if (item.sections && item.sections.length > 0) {
            const sectionsEl = itemEl.createDiv({ cls: 'inbox-item-sections' });
            for (const section of item.sections) {
                const chip = sectionsEl.createSpan({ cls: 'inbox-section-chip' });
                setIcon(chip, SECTION_TYPE_META[section.type].icon);
            }
        }

        // 长按进入拖动模式：按住约 300ms 未移动则开始拖动
        let longPressTimer: number | undefined;
        let longPressStart: { x: number; y: number } | undefined;
        let suppressClick = false;

        const cancelLongPress = () => {
            if (longPressTimer !== undefined) {
                window.clearTimeout(longPressTimer);
                longPressTimer = undefined;
            }
            longPressStart = undefined;
        };

        itemEl.onmousedown = (e) => {
            // 仅左键；忽略折叠箭头等交互元素
            if (e.button !== 0) return;
            if ((e.target as HTMLElement).closest('.inbox-item-toggle')) return;
            longPressStart = { x: e.clientX, y: e.clientY };
            longPressTimer = window.setTimeout(() => {
                longPressTimer = undefined;
                suppressClick = true;
                startDrag(item, itemEl, () => { suppressClick = false; });
            }, 300);
        };

        itemEl.onmousemove = (e) => {
            // 长按期间移动超过阈值则取消长按（视为普通点击/选择）
            if (!longPressStart) return;
            if (Math.abs(e.clientX - longPressStart.x) > 5 || Math.abs(e.clientY - longPressStart.y) > 5) {
                cancelLongPress();
            }
        };

        itemEl.onmouseup = () => cancelLongPress();
        itemEl.onmouseleave = () => cancelLongPress();

        // 点击选中/取消（以 inboxData.selectedId 为准，避免宿主刷新后本地状态失效）
        itemEl.onclick = (e) => {
            e.stopPropagation();
            // 长按拖动结束后抑制本次点击，避免误选中
            if (suppressClick) {
                suppressClick = false;
                return;
            }
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

    // ===== 渲染周目标卡片（周目标模式下替代任务层级列表）=====
    function renderWeekGoalCard(cardList: HTMLElement, item: InboxItem) {
        const card = cardList.createDiv({ cls: 'week-goal-card' });

        // 选中态高亮（与任务项一致，供点击日历分配计划事件使用）
        if (inboxData.selectedId === item.id) {
            card.addClass('selected');
        }

        // 分类色点（有分类时显示）
        if (item.categoryId) {
            const cat = categoryData.categories.find(c => c.id === item.categoryId);
            if (cat) {
                const dot = card.createSpan({ cls: 'inbox-category-dot' });
                dot.setCssProps({ '--dot-color': cat.color });
            }
        }

        // 任务名称
        card.createDiv({ cls: 'week-goal-card-title', text: item.title });

        // 右上角：拥有的板块类型图标（与任务面板条目中的板块图标样式一致）
        if (item.sections && item.sections.length > 0) {
            const iconsEl = card.createDiv({ cls: 'week-goal-card-section-icons' });
            for (const section of item.sections) {
                const chip = iconsEl.createSpan({ cls: 'inbox-section-chip' });
                setIcon(chip, SECTION_TYPE_META[section.type].icon);
            }
        }

        // 统计本周已分配的计划事件：时长（分钟累加）与次数
        let totalMinutes = 0;
        let count = 0;
        if (events && currentWeekKey) {
            for (const ev of events) {
                if (ev.inboxId === item.id && ev.weekKey === currentWeekKey) {
                    totalMinutes += Math.max(0, ev.end - ev.start);
                    count += 1;
                }
            }
        }

        // 最后一行：已分配：时长 3h 次数 x3（数值高亮）
        const meta = card.createDiv({ cls: 'week-goal-card-meta' });
        meta.createSpan({ cls: 'week-goal-card-assigned-label', text: t('inbox.weekGoalAssigned') });

        const durationEl = meta.createSpan({ cls: 'week-goal-card-duration' });
        durationEl.createSpan({ text: t('inbox.weekGoalDurationLabel') });
        durationEl.createSpan({ cls: 'week-goal-card-value', text: formatDuration(totalMinutes) });

        const countEl = meta.createSpan({ cls: 'week-goal-card-count' });
        countEl.createSpan({ text: t('inbox.weekGoalCountLabel') });
        countEl.createSpan({ cls: 'week-goal-card-value', text: `x${count}` });

        // 点击选中/取消（与任务项一致：设置 selectedId，供点击日历分配计划事件）
        card.onclick = (e) => {
            e.stopPropagation();
            inboxData.selectedSectionId = undefined;
            inboxData.selectedSectionItemId = undefined;
            if (inboxData.selectedId === item.id) {
                inboxData.selectedId = undefined;
            } else {
                inboxData.selectedId = item.id;
            }
            renderList();
            updateToolbar();
            onRefresh();
        };
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

            const typeLabel = sectionTypeLabel(section.type);
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
                const data: HabitData = section.data;
                for (const it of data.items) {
                    const count = it.checkedDays?.length ?? 0;
                    renderSectionEntry(item, section.id, depth + 1, it.id, '🔁', it.text, String(count));
                }
            } else if (section.type === 'file') {
                for (const it of (section.data as FileData).items) {
                    renderSectionEntry(item, section.id, depth + 1, it.id, '📄', it.text || it.path);
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

        // 周目标模式（优先级最高）：隐藏原有任务层级，改为渲染「周目标卡片列表」
        // （卡片代表分配到当前周的任务，内容为任务名称 + 时长 / 次数占位）
        if (weekGoalOnly && currentWeekKey) {
            const weekKey = currentWeekKey;
            const assignedItems = getVisibleItems(inboxData).filter(i =>
                i.assignedWeekKeys?.includes(weekKey) ?? false,
            );

            if (assignedItems.length === 0) {
                listDiv.createDiv({ cls: 'inbox-empty' }).setText(t('inbox.emptyWeekGoal'));
                return;
            }

            listDiv.createDiv({ cls: 'inbox-group-header', text: t('inbox.weekGoal') });
            const cardList = listDiv.createDiv({ cls: 'week-goal-card-list' });
            for (const item of assignedItems) {
                renderWeekGoalCard(cardList, item);
            }
            return;
        }

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

    // ===== 拖动排序 / 调整层级 =====
    /** 每层缩进像素（与 CSS 中 --inbox-depth 的 16px 保持一致） */
    const DEPTH_INDENT = 16;

    /**
     * 开始拖动某任务：长按任务项后，跟随鼠标显示插入指示线，
     * 松手时根据落点重排 inboxData.items 并更新 parentId。
     * onEnd 在拖动结束时回调（用于重置长按抑制标记）。
     */
    function startDrag(item: InboxItem, itemEl: HTMLElement, onEnd?: () => void) {
        // 被拖动任务及其所有后代（拖动时整体移动，且不能拖入自身后代）
        const movingIds = new Set<string>([item.id, ...collectDescendantIds(inboxData, item.id)]);

        // 当前可见的任务项（按 DOM 顺序），排除被拖动项及其后代
        const targets = Array.from(listDiv.querySelectorAll<HTMLElement>('.inbox-item'))
            .filter(el => {
                const id = el.getAttribute('data-id');
                return id && !movingIds.has(id);
            });

        itemEl.addClass('is-dragging');

        // 插入指示线
        const indicator = listDiv.createDiv({ cls: 'inbox-drag-indicator' });

        // 计算落点：返回 { beforeId, parentId, depth }
        const computeDrop = (clientX: number, clientY: number) => {
            if (targets.length === 0) {
                return { beforeId: undefined as string | undefined, parentId: undefined as string | undefined, depth: 0 };
            }
            // 找到鼠标 Y 最接近的目标项
            let refEl: HTMLElement | undefined;
            let placeAfter = false;
            for (const el of targets) {
                const rect = el.getBoundingClientRect();
                if (clientY < rect.top) {
                    refEl = el;
                    placeAfter = false;
                    break;
                }
                if (clientY <= rect.bottom) {
                    refEl = el;
                    placeAfter = clientY > rect.top + rect.height / 2;
                    break;
                }
            }
            if (!refEl) {
                refEl = targets[targets.length - 1];
                placeAfter = true;
            }

            const refId = refEl.getAttribute('data-id')!;

            // 层级：根据鼠标 X 相对目标项左边缘的偏移（每 16px 一层）
            const refRect = refEl.getBoundingClientRect();
            const offset = clientX - refRect.left;
            let depth = Math.round(offset / DEPTH_INDENT);
            depth = Math.max(0, Math.min(depth, MAX_INBOX_DEPTH - 1));

            // 落点父级：目标项深度为 depth 时，父级是深度 depth-1 的最近前驱
            let parentId: string | undefined;
            if (depth > 0) {
                // 在目标项之前找深度为 depth-1 的项作为父级
                const refIndex = targets.indexOf(refEl);
                for (let i = refIndex; i >= 0; i--) {
                    const candId = targets[i].getAttribute('data-id')!;
                    const candItem = inboxData.items.find(x => x.id === candId)!;
                    const candDepth = getItemDepth(inboxData, candItem) - 1;
                    if (candDepth === depth - 1) {
                        parentId = candId;
                        break;
                    }
                }
                // 找不到合适父级则退回顶层
                if (!parentId) depth = 0;
            }

            return { beforeId: refId, placeAfter, parentId, depth };
        };

        // 指示线定位
        const updateIndicator = (clientX: number, clientY: number) => {
            const drop = computeDrop(clientX, clientY);
            const refEl = targets.find(el => el.getAttribute('data-id') === drop.beforeId);
            if (!refEl) {
                indicator.removeClass('is-visible');
                return;
            }
            const rect = refEl.getBoundingClientRect();
            const listRect = listDiv.getBoundingClientRect();
            const top = (drop.placeAfter ? rect.bottom : rect.top) - listRect.top + listDiv.scrollTop;
            indicator.addClass('is-visible');
            indicator.setCssProps({
                '--indicator-top': `${top}px`,
                '--indicator-left': `${drop.depth * DEPTH_INDENT}px`,
            });
        };

        const onMove = (ev: MouseEvent) => {
            updateIndicator(ev.clientX, ev.clientY);
        };

        const onUp = (ev: MouseEvent) => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            indicator.remove();
            itemEl.removeClass('is-dragging');

            const drop = computeDrop(ev.clientX, ev.clientY);
            applyDrop(item, drop);
            onEnd?.();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    /** 应用落点：更新 parentId 并重排 items 数组，然后保存刷新 */
    function applyDrop(
        item: InboxItem,
        drop: { beforeId?: string; placeAfter?: boolean; parentId?: string; depth: number },
    ) {
        // 更新层级
        item.parentId = drop.parentId;

        // 重排数组：把 item 及其后代整体移动到目标位置
        const movingIds = new Set<string>([item.id, ...collectDescendantIds(inboxData, item.id)]);
        const moving = inboxData.items.filter(i => movingIds.has(i.id));
        const rest = inboxData.items.filter(i => !movingIds.has(i.id));

        if (!drop.beforeId) {
            // 放到末尾
            inboxData.items = [...rest, ...moving];
        } else {
            const refIndex = rest.findIndex(i => i.id === drop.beforeId);
            const insertAt = refIndex < 0
                ? rest.length
                : (drop.placeAfter ? refIndex + 1 : refIndex);
            inboxData.items = [
                ...rest.slice(0, insertAt),
                ...moving,
                ...rest.slice(insertAt),
            ];
        }

        renderList();
        updateToolbar();
        void (async () => {
            if (onUpdate) await onUpdate(item);
            onRefresh();
        })();
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

        new InboxAddPanel(app, container, addBtn, (item) => {
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

// ===== 文件路径自动补全（文件板块使用）=====
/** 输入框的文件路径建议：从 vault 全部文件中模糊匹配 */
export class FilePathSuggest extends AbstractInputSuggest<TFile> {
    constructor(
        app: App,
        private inputEl: HTMLInputElement,
        private onPick: (path: string) => void,
    ) {
        super(app, inputEl);
    }

    protected getSuggestions(query: string): TFile[] {
        const lower = query.toLowerCase();
        return this.app.vault.getFiles()
            .filter(f => f.path.toLowerCase().includes(lower))
            .slice(0, 50);
    }

    renderSuggestion(file: TFile, el: HTMLElement): void {
        el.setText(file.path);
    }

    selectSuggestion(file: TFile): void {
        this.inputEl.value = file.path;
        this.onPick(file.path);
        this.close();
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
            data: JSON.parse(JSON.stringify(s.data)) as Section['data'],
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
            const data: HabitData = section.data;
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
        } else if (section.type === 'file') {
            const data = section.data as FileData;
            for (const item of data.items) {
                const row = itemsEl.createDiv({ cls: 'section-item-row' });
                // 文件路径输入框（带 vault 文件自动补全）
                const pathInput = row.createEl('input', { type: 'text', cls: 'section-item-text section-file-path' });
                pathInput.value = item.path;
                pathInput.placeholder = t('section.filePlaceholder');
                new FilePathSuggest(this.app, pathInput, (path) => {
                    item.path = path;
                    // 未自定义显示名时，用文件名作为显示名
                    if (!item.text) item.text = path;
                });
                pathInput.onchange = () => { item.path = pathInput.value; };
                // 显示名输入框（可选）
                const nameInput = row.createEl('input', { type: 'text', cls: 'section-item-text section-file-name' });
                nameInput.value = item.text;
                nameInput.placeholder = t('section.fileNamePlaceholder');
                nameInput.onchange = () => { item.text = nameInput.value; };
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
            const data: HabitData = section.data;
            data.items.push({ id, text: '' });
        } else if (section.type === 'file') {
            (section.data as FileData).items.push({ id, text: '', path: '' });
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
                    drop.addOption('file', t('section.typeFile'));
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
                        const data: ChecklistData | StepsData | HabitData | FileData =
                            type === 'checklist' ? { items: [] }
                            : type === 'steps' ? { items: [] }
                            : type === 'habit' ? { items: [] }
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
        return sectionTypeLabel(type);
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
