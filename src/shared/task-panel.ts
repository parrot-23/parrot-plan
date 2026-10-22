import { App, Modal, Setting, Notice, AbstractInputSuggest, TFile, setIcon } from 'obsidian';
import type { PlanCategoryData } from './plan-category-manager';
import { t } from '../i18n';
import type { InboxItem, InboxData } from '../datatypes/domain';
import { SECTION_TYPE_META } from '../datatypes/domain';
import type { InboxRepo } from '../repos/inbox-repo';

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
        private categoryData: PlanCategoryData,
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
    /** 是否启用「按项目排布」按钮（仅年视图使用） */
    enableProjectFocus?: boolean;
    /** 是否隐藏右上角「+」添加按钮（默认显示） */
    hideAddButton?: boolean;
    /** 是否隐藏底部工具栏（默认显示） */
    hideToolbar?: boolean;
    /** 收集盒领域仓库（提供后，任务增删改/折叠/选中均走仓库方法，保证跨视图一致） */
    inboxRepo?: InboxRepo;
}

export function renderTaskPanel(
    app: App,
    container: HTMLElement,
    inboxData: InboxData,
    categoryData: PlanCategoryData,
    onAdd: (item: InboxItem) => void | Promise<void>,
    onRefresh: () => void,
    onAction?: (action: string, item: InboxItem) => void | Promise<void>,
    onUpdate?: (item?: InboxItem) => void | Promise<void>,
    options: TaskPanelOptions = {},
) {
    const { enableProjectFocus, hideAddButton, hideToolbar, inboxRepo } = options;
    container.empty();
    container.addClass('inbox-panel');

    // ===== 列表区域（可滚动）=====
    const listDiv = container.createDiv({ cls: 'inbox-list' });

    // ===== 底部工具栏（初始隐藏）=====
    const toolbar = container.createDiv({ cls: 'inbox-toolbar' });
    // 需要隐藏时加标记类，由 CSS 强制隐藏（不影响 updateToolbar 的显隐逻辑）
    if (hideToolbar) toolbar.addClass('is-hidden');

    const actions: { id: string; label: string; icon: string }[] = [
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

            if (action.id === 'delete') {
                // 从收集盒移除（不再显示，但数据保留，可查历史）
                new ConfirmDeleteInboxModal(app, item.title, async () => {
                    // 连同所有后代一起移除
                    const ids = [item.id, ...collectDescendantIds(inboxData, item.id)];
                    if (inboxRepo) {
                        inboxRepo.removeItems(ids);
                        if (inboxData.selectedId && ids.includes(inboxData.selectedId)) {
                            inboxRepo.setSelectedId(undefined);
                        }
                    } else {
                        for (const id of ids) {
                            const target = inboxData.items.find(i => i.id === id);
                            if (target) target.removed = true;
                        }
                        if (inboxData.selectedId && ids.includes(inboxData.selectedId)) {
                            inboxData.selectedId = undefined;
                        }
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
                if (inboxRepo) {
                    inboxRepo.toggleCollapse(item.id);
                } else {
                    if (!inboxData.collapsedIds) inboxData.collapsedIds = [];
                    if (collapsed) {
                        inboxData.collapsedIds = inboxData.collapsedIds.filter(id => id !== item.id);
                    } else {
                        inboxData.collapsedIds.push(item.id);
                    }
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

        titleRow.createSpan({ cls: 'inbox-item-title', text: item.title, title: item.title });

        // 行末状态标记：使用 Obsidian 内置 Lucide 图标
        // 习惯型任务优先显示 rotate-cw-square，否则按任务状态显示对应图标
        const isHabit = item.taskType === 'habit' || item.habitTimeEnabled === true;
        const status = item.status ?? 'notStarted';
        const statusMeta: Record<string, { icon: string }> = {
            notStarted: { icon: 'circle-dot-dashed' },
            inProgress: { icon: 'zap' },
            done: { icon: 'check' },
            paused: { icon: 'circle-pause' },
        };
        const meta = isHabit ? { icon: 'rotate-cw-square' } : (statusMeta[status] ?? statusMeta.notStarted);
        const statusEl = titleRow.createSpan({ cls: `inbox-item-status is-${isHabit ? 'habit' : status}` });
        const iconEl = statusEl.createSpan({ cls: 'inbox-item-status-icon' });
        setIcon(iconEl, meta.icon);

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
                startDrag(item, itemEl, e.clientX, e.clientY, (moved) => {
                    if (moved) {
                        suppressClick = false;
                    } else {
                        // 长按未移动：抑制紧随其后的 click，稍后复位
                        window.setTimeout(() => { suppressClick = false; }, 0);
                    }
                });
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
            const nextSelected = inboxData.selectedId === item.id ? undefined : item.id;
            if (inboxRepo) {
                inboxRepo.setSelectedId(nextSelected);
            } else {
                inboxData.selectedId = nextSelected;
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
        // 记录当前滚动位置，重渲染后恢复，避免选中任务时滚动条跳回顶部
        const prevScrollTop = listDiv.scrollTop;
        listDiv.empty();

        try {
            // 只显示未移除的顶层条目
            let topItems = getChildren(inboxData, undefined);

            // 项目聚焦模式：仅显示聚焦任务及其所有子任务（以聚焦任务为根递归展示）
            const focusId = inboxData.projectFocusId;
            if (focusId) {
                const focusItem = inboxData.items.find(i => i.id === focusId && !i.removed);
                if (!focusItem) {
                    // 聚焦任务已不存在（被删除等），自动退出聚焦
                    if (inboxRepo) {
                        inboxRepo.setProjectFocusId(undefined);
                    } else {
                        inboxData.projectFocusId = undefined;
                    }
                } else {
                    listDiv.createDiv({ cls: 'inbox-group-header', text: t('inbox.projectFocus') });
                    // 渲染聚焦任务本身（不递归子任务），再渲染子任务
                    renderItem(focusItem, 0, false);
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
                listDiv.createDiv({ cls: 'inbox-empty' }).setText(t('inbox.empty'));
                return;
            }

            for (const item of topItems) {
                renderItem(item, 0);
            }
        } finally {
            // 恢复滚动位置（内容变短时浏览器会自动收敛到有效范围）
            listDiv.scrollTop = prevScrollTop;
        }
    }

    // ===== 拖动排序 / 调整层级 =====
    /** 每层缩进像素（与 CSS 中 --inbox-depth 的 16px 保持一致） */
    const DEPTH_INDENT = 16;

    /**
     * 开始拖动某任务：长按任务项后，跟随鼠标显示插入指示线，
     * 松手时根据落点重排 inboxData.items 并更新 parentId。
     * onEnd 在拖动结束时回调（入参表示本次是否发生了实际位移）。
     */
    function startDrag(
        item: InboxItem,
        itemEl: HTMLElement,
        startX: number,
        startY: number,
        onEnd?: (moved: boolean) => void,
    ) {
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

        // 记录本次拖动是否发生实际位移（超过阈值才视为真正拖动）
        let hasMoved = false;

        const onMove = (ev: MouseEvent) => {
            if (!hasMoved && (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5)) {
                hasMoved = true;
            }
            updateIndicator(ev.clientX, ev.clientY);
        };

        const onUp = (ev: MouseEvent) => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            indicator.remove();
            itemEl.removeClass('is-dragging');

            // 仅在实际拖动后才应用落点；原地长按松手视为取消
            if (hasMoved) {
                const drop = computeDrop(ev.clientX, ev.clientY);
                applyDrop(item, drop);
            }
            onEnd?.(hasMoved);
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
        if (inboxRepo) {
            inboxRepo.setParent(item.id, drop.parentId);
        } else {
            item.parentId = drop.parentId;
        }

        // 重排数组：把 item 及其后代整体移动到目标位置
        const movingIds = new Set<string>([item.id, ...collectDescendantIds(inboxData, item.id)]);
        const moving = inboxData.items.filter(i => movingIds.has(i.id));
        const rest = inboxData.items.filter(i => !movingIds.has(i.id));

        let next: InboxItem[];
        if (!drop.beforeId) {
            // 放到末尾
            next = [...rest, ...moving];
        } else {
            const refIndex = rest.findIndex(i => i.id === drop.beforeId);
            const insertAt = refIndex < 0
                ? rest.length
                : (drop.placeAfter ? refIndex + 1 : refIndex);
            next = [
                ...rest.slice(0, insertAt),
                ...moving,
                ...rest.slice(insertAt),
            ];
        }
        // 原地替换数组内容，保持 items 数组引用不变（子视图持有同一引用）
        if (inboxRepo) {
            inboxRepo.reorderItems(next);
        } else {
            inboxData.items.splice(0, inboxData.items.length, ...next);
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
        if (inboxRepo) {
            inboxRepo.setSelectedId(undefined);
        } else {
            inboxData.selectedId = undefined;
        }
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
                if (inboxRepo) {
                    inboxRepo.setProjectFocusId(undefined);
                } else {
                    inboxData.projectFocusId = undefined;
                }
            } else {
                // 未聚焦：需先选中一个任务，聚焦到该任务
                if (!inboxData.selectedId) {
                    new Notice(t('inbox.projectFocusNeedSelect'));
                    return;
                }
                if (inboxRepo) {
                    inboxRepo.setProjectFocusId(inboxData.selectedId);
                } else {
                    inboxData.projectFocusId = inboxData.selectedId;
                }
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
    if (hideAddButton) addBtn.addClass('is-hidden');
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
                if (inboxRepo) {
                    inboxRepo.expand(parent.id);
                } else if (inboxData.collapsedIds) {
                    inboxData.collapsedIds = inboxData.collapsedIds.filter(id => id !== parent.id);
                }
            }
            if (inboxRepo) {
                inboxRepo.addItem(item);
            } else {
                inboxData.items.push(item);
            }
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

