import type { App } from 'obsidian';
import { Modal, Notice, Setting, setIcon } from 'obsidian';

import type { PlanCategoryData } from '../../shared/plan-category-manager';
import type { InboxData, InboxItem, Section, ChecklistData, FileData, BasketItem, ImprovementEntry, OkrConditionItem, TaskType, TaskStatus } from '../../datatypes/domain';
import type { InboxRepo } from '../../repos/inbox-repo';
import { SECTION_TYPE_META, OKR_CONDITION_META } from '../../datatypes/domain';
import { renderTaskPanel, FilePathSuggest } from '../../shared/task-panel';
import { t } from '../../i18n';

/**
 * 任务 下的「任务计划」视图：左侧任务面板 + 右侧内容区（项目信息表单 + 已计划周数 + 板块信息）。
 * 与 PDCA 下的任务计划视图一致，但去除了泳道图。
 */
export class OkrTaskPlanView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: PlanCategoryData;
    private save: () => Promise<void>;
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 板块「+」下拉面板的「点击外部关闭」监听器（渲染前清理，避免累积） */
    private addPanelCloseHandler?: (e: MouseEvent) => void;
    /** 当前处于编辑态的板块 id（null 表示无） */
    private editingSectionId: string | null = null;
    /** 收集篮子中已多选选中的条目 id（整理到文件时使用） */
    private selectedBasketEntryIds = new Set<string>();
    /** 收集篮子多选时上次点击的条目 id（Shift 连选用） */
    private lastClickedBasketEntryId?: string;
    /** 收集盒领域仓库（任务面板增删改走仓库方法，保证跨视图一致） */
    private inboxRepo?: InboxRepo;
    /** 右侧垂直选项卡当前选中项（刷新后保持不变） */
    private rightTab: 'current' | 'overview' | 'basket' = 'current';

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: PlanCategoryData,
        save: () => Promise<void>,
        inboxRepo?: InboxRepo,
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.save = save;
        this.inboxRepo = inboxRepo;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        // 清理上一次渲染注册的下拉关闭监听器，避免累积
        if (this.addPanelCloseHandler) {
            document.removeEventListener('mousedown', this.addPanelCloseHandler);
            this.addPanelCloseHandler = undefined;
        }
        // 刷新前记录任务面板列表的滚动位置，渲染后恢复，避免选中任务时滚动条跳回顶部
        const prevListScrollTop = container
            .querySelector<HTMLElement>('.task-plan-task-panel .inbox-list')?.scrollTop ?? 0;
        container.empty();
        container.addClass('task-plan-view');

        // 左侧：任务面板
        const taskPanel = container.createDiv({ cls: 'task-plan-task-panel' });
        // 记录渲染前的选中任务 id，用于判断点击任务面板条目是否改变了选中项
        const prevSelectedId = this.inboxData.selectedId;
        renderTaskPanel(
            this.app,
            taskPanel,
            this.inboxData,
            this.categoryData,
            async () => {
                await this.save();
            },
            () => {
                // 在「任务总览」选项卡下点击任务面板条目选中任务时，自动切换到「当前任务」选项卡
                if (
                    this.rightTab === 'overview'
                    && this.inboxData.selectedId
                    && this.inboxData.selectedId !== prevSelectedId
                ) {
                    this.rightTab = 'current';
                }
                void this.refresh();
            },
            undefined,
            async () => {
                await this.save();
            },
            { enableProjectFocus: true, inboxRepo: this.inboxRepo },
        );

        // 中间：垂直选项卡（切换右侧内容区）
        const tabStrip = container.createDiv({ cls: 'task-plan-right-tabs' });
        const tabs: { id: 'current' | 'overview' | 'basket'; labelKey: 'taskPlan.tabCurrentTask' | 'taskPlan.tabOverview' | 'taskPlan.tabBasket' }[] = [
            { id: 'overview', labelKey: 'taskPlan.tabOverview' },
            { id: 'current', labelKey: 'taskPlan.tabCurrentTask' },
            { id: 'basket', labelKey: 'taskPlan.tabBasket' },
        ];
        for (const tab of tabs) {
            const tabEl = tabStrip.createDiv({ cls: 'task-plan-right-tab', text: t(tab.labelKey) });
            tabEl.toggleClass('is-active', this.rightTab === tab.id);
            tabEl.onclick = () => {
                const switched = this.rightTab !== tab.id;
                if (switched) this.rightTab = tab.id;

                // 「当前任务」/「收集篮子」的内容依赖选中任务：左侧未选中任何任务时自动选中第一个任务
                let autoSelected = false;
                if ((tab.id === 'current' || tab.id === 'basket') && !this.hasSelectedTask()) {
                    const firstTask = this.inboxData.items.find((i) => !i.removed && !i.parentId);
                    if (firstTask) {
                        if (this.inboxRepo) this.inboxRepo.setSelectedId(firstTask.id);
                        else this.inboxData.selectedId = firstTask.id;
                        autoSelected = true;
                    }
                }
                if (switched || autoSelected) void this.refresh();
            };
        }

        // 右侧：内容区（随选项卡切换）
        const contentPanel = container.createDiv({ cls: 'task-plan-content-panel' });
        if (this.rightTab === 'current') {
            // 未选中任务时该选项卡内容留空
            if (this.hasSelectedTask()) {
                this.renderInfoForm(contentPanel);

                // 收集篮子方框（当前选中任务的收集内容，供 GTD 梳理阶段放置笔记）
                const basketWrap = contentPanel.createDiv({ cls: 'okr-basket-wrap' });
                this.renderBasketBox(basketWrap);

                // 改进项方框（当前选中任务的改进条目，可勾选完成）
                const improveWrap = contentPanel.createDiv({ cls: 'okr-improve-wrap' });
                this.renderImprovementBox(improveWrap);

                // 板块信息方框（当前选中项目的板块卡片）
                this.renderSectionsArea(contentPanel);
            }
        } else if (this.rightTab === 'overview') {
            // 「任务总览」选项卡：展示所有任务条目及其 OKR 进度、成果情况
            this.renderAllTasksOverview(contentPanel);
        } else if (this.rightTab === 'basket') {
            // 「收集篮子」选项卡：左为任务名称 + 未处理数 + 收集篮子面板，右为板块信息
            this.renderBasketTab(contentPanel);
        }

        // 恢复任务面板列表的滚动位置，实现无感刷新
        if (prevListScrollTop > 0) {
            const listEl = taskPanel.querySelector<HTMLElement>('.inbox-list');
            if (listEl) listEl.scrollTop = prevListScrollTop;
        }
    }

    /** 板块方框右上角的「+」按钮：点击展开下拉面板选择板块类型 */
    private renderAddSectionButton(header: HTMLElement): void {
        const wrap = header.createDiv({ cls: 'swimlane-section-add-wrap' });
        const btn = wrap.createEl('button', { cls: 'swimlane-section-add-btn', text: '+' });

        // 下拉面板（默认隐藏）
        const panel = wrap.createDiv({ cls: 'swimlane-section-add-panel' });

        const types: { type: Section['type']; labelKey: 'section.typeChecklist' | 'section.typeFile' }[] = [
            { type: 'checklist', labelKey: 'section.typeChecklist' },
            { type: 'file', labelKey: 'section.typeFile' },
        ];
        for (const item of types) {
            const opt = panel.createDiv({ cls: 'swimlane-section-add-option', text: t(item.labelKey) });
            opt.onclick = (e) => {
                e.stopPropagation();
                panel.removeClass('is-open');
                this.openAddSectionModal(item.type);
            };
        }

        btn.onclick = (e) => {
            e.stopPropagation();
            panel.toggleClass('is-open', !panel.classList.contains('is-open'));
        };

        // 点击面板外部关闭下拉
        const closeHandler = (ev: MouseEvent) => {
            const target = ev.target as Node | null;
            if (target && wrap.contains(target)) return;
            panel.removeClass('is-open');
            document.removeEventListener('mousedown', closeHandler);
            if (this.addPanelCloseHandler === closeHandler) this.addPanelCloseHandler = undefined;
        };
        this.addPanelCloseHandler = closeHandler;
        document.addEventListener('mousedown', closeHandler);
    }

    /** 打开「添加板块」弹窗：输入板块名称，确认后添加到当前选中任务 */
    private openAddSectionModal(type: Section['type']): void {
        const selectedId = this.inboxData.selectedId;
        const item = selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;
        if (!item) {
            new Notice(t('taskPlan.noSelection'));
            return;
        }

        const modal = new Modal(this.app);
        let name = '';
        modal.onOpen = () => {
            const { contentEl } = modal;
            contentEl.empty();
            contentEl.createEl('h3', { text: t('section.add') });

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
                        void this.addSection(item, type, name.trim());
                        modal.close();
                    })
                )
                .addButton(btn => btn
                    .setButtonText(t('common.cancel'))
                    .onClick(() => modal.close())
                );
        };
        modal.open();
    }

    /** 向任务添加一个板块并保存、刷新 */
    private async addSection(item: InboxItem, type: Section['type'], name: string): Promise<void> {
        const id = `sec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const data: ChecklistData | FileData = { items: [] };
        const section: Section = { id, type, title: name || undefined, data };
        item.sections = [...(item.sections ?? []), section];
        await this.save();
        await this.refresh();
    }

    /** 板块信息区：当前选中项目的板块卡片（从左到右排列） */
    private renderSectionCards(row: HTMLElement): void {
        row.empty();

        const selectedId = this.inboxData.selectedId;
        const item = selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;
        const sections = item?.sections ?? [];

        // 编辑中的板块已不存在（切换任务 / 被删除）时，退出编辑态
        if (this.editingSectionId && !sections.some(s => s.id === this.editingSectionId)) {
            this.editingSectionId = null;
        }

        if (sections.length === 0) {
            row.createDiv({ cls: 'swimlane-sections-empty', text: t('projectPicture.sectionsEmpty') });
            return;
        }

        for (const section of sections) {
            this.renderSectionCard(row, item!, section);
        }
    }

    /** 渲染单张板块卡片：只读态或编辑态 */
    private renderSectionCard(row: HTMLElement, item: InboxItem, section: Section): void {
        if (this.editingSectionId === section.id) {
            this.renderSectionCardEdit(row, item, section);
        } else {
            this.renderSectionCardReadonly(row, item, section);
        }
    }

    /** 只读态卡片：类型标签 + 板块名 + 条目列表 + 右上角编辑按钮 */
    private renderSectionCardReadonly(row: HTMLElement, item: InboxItem, section: Section): void {
        const card = row.createDiv({ cls: 'swimlane-section-card' });

        // 卡片头部：类型标签 + 板块名 + 编辑按钮
        const head = card.createDiv({ cls: 'swimlane-section-card-head' });
        const typeEl = head.createSpan({ cls: 'swimlane-section-card-type' });
        setIcon(typeEl.createSpan({ cls: 'swimlane-section-card-type-icon' }), this.sectionTypeIcon(section.type));
        typeEl.createSpan({ text: this.sectionTypeLabel(section.type) });
        head.createSpan({
            cls: 'swimlane-section-card-name',
            text: section.title || this.sectionTypeLabel(section.type),
        });
        const editBtn = head.createEl('button', { cls: 'swimlane-section-card-edit' });
        setIcon(editBtn, 'pencil');
        editBtn.onclick = (e) => {
            e.stopPropagation();
            this.editingSectionId = section.id;
            this.renderSectionCards(row);
        };

        // 条目列表（只读）
        const itemsEl = card.createDiv({ cls: 'swimlane-section-card-items' });
        const items = (section.data as { items?: unknown[] }).items ?? [];
        if (items.length === 0) {
            itemsEl.createDiv({ cls: 'swimlane-section-card-empty', text: t('section.emptyItems') });
            return;
        }

        if (section.type === 'checklist') {
            for (const it of (section.data as ChecklistData).items) {
                this.renderSectionCardItem(itemsEl, it.done ? '☑' : '☐', it.text);
            }
        } else if (section.type === 'file') {
            for (const it of (section.data as FileData).items) {
                const itemEl = this.renderSectionCardItem(itemsEl, '📄', it.text || it.path);
                // 已多选篮子条目：文件作为整理目标（悬停提示 + 点击写入）
                if (this.isBasketSelectable() && this.selectedBasketEntryIds.size > 0 && it.path) {
                    itemEl.addClass('is-organize-target');
                    itemEl.setAttribute('title', t('basket.organizeToFile'));
                    itemEl.onclick = (e) => {
                        e.stopPropagation();
                        void this.organizeToFile(item, it.path);
                    };
                    continue;
                }
                // 点击文件条目：在新标签页打开对应 vault 文件
                if (it.path) {
                    itemEl.addClass('is-clickable');
                    itemEl.onclick = (e) => {
                        e.stopPropagation();
                        void this.app.workspace.openLinkText(it.path, '', 'tab');
                    };
                }
            }
        }
    }

    /** 将选中的收集篮子条目内容逐条追加到目标文件末尾，并从篮子移除这些条目 */
    private async organizeToFile(item: InboxItem, path: string): Promise<void> {
        const selectedIds = this.selectedBasketEntryIds;
        // 按篮子中的原始顺序取选中的条目，保证写入顺序与列表一致
        const entries = (item.basket ?? []).filter((b) => selectedIds.has(b.id));
        if (entries.length === 0) return;

        try {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!file) {
                new Notice(t('basket.organizeFileMissing'));
                return;
            }
            // 每条独立成行追加
            await this.app.vault.adapter.append(path, `\n${entries.map(e => e.text).join('\n')}\n`);
        } catch {
            new Notice(t('basket.organizeFailed'));
            return;
        }

        // 写入成功后从篮子移除这些条目
        item.basket = (item.basket ?? []).filter((b) => !selectedIds.has(b.id));
        selectedIds.clear();
        this.lastClickedBasketEntryId = undefined;
        await this.save();
        this.refreshBasketBox();
        this.refreshSectionCards();
        new Notice(t('basket.organizeDone'));
    }

    /** 编辑态卡片：右上角删除卡片 / 退出按钮，条目可编辑，底部「+」添加行 */
    private renderSectionCardEdit(row: HTMLElement, item: InboxItem, section: Section): void {
        const card = row.createDiv({ cls: 'swimlane-section-card is-editing' });

        // 卡片头部：类型标签 + 板块名 + 删除卡片 / 退出按钮
        const head = card.createDiv({ cls: 'swimlane-section-card-head' });
        const typeEl = head.createSpan({ cls: 'swimlane-section-card-type' });
        setIcon(typeEl.createSpan({ cls: 'swimlane-section-card-type-icon' }), this.sectionTypeIcon(section.type));
        typeEl.createSpan({ text: this.sectionTypeLabel(section.type) });
        head.createSpan({
            cls: 'swimlane-section-card-name',
            text: section.title || this.sectionTypeLabel(section.type),
        });
        const delBtn = head.createEl('button', { cls: 'swimlane-section-card-del', text: '🗑️' });
        delBtn.onclick = (e) => {
            e.stopPropagation();
            const title = section.title || this.sectionTypeLabel(section.type);
            new ConfirmDeleteSectionModal(this.app, title, () => {
                void this.deleteSection(item, section, row);
            }).open();
        };
        const exitBtn = head.createEl('button', { cls: 'swimlane-section-card-exit' });
        setIcon(exitBtn, 'log-out');
        exitBtn.onclick = (e) => {
            e.stopPropagation();
            this.editingSectionId = null;
            this.renderSectionCards(row);
        };

        // 条目编辑列表
        const itemsEl = card.createDiv({ cls: 'swimlane-section-card-items' });

        if (section.type === 'checklist') {
            for (const it of (section.data as ChecklistData).items) {
                const line = itemsEl.createDiv({ cls: 'swimlane-section-card-edit-row' });
                const cb = line.createEl('input', { type: 'checkbox' });
                cb.checked = it.done;
                cb.onchange = () => { it.done = cb.checked; };
                const text = line.createEl('input', { type: 'text', cls: 'swimlane-section-card-edit-text' });
                text.value = it.text;
                text.onchange = () => { it.text = text.value; };
                this.renderEditRowDelete(line, () => {
                    (section.data as ChecklistData).items = (section.data as ChecklistData).items.filter(x => x.id !== it.id);
                    this.renderSectionCards(row);
                });
            }
        } else if (section.type === 'file') {
            for (const it of (section.data as FileData).items) {
                const line = itemsEl.createDiv({ cls: 'swimlane-section-card-edit-row' });
                const pathInput = line.createEl('input', { type: 'text', cls: 'swimlane-section-card-edit-text' });
                pathInput.value = it.path;
                pathInput.placeholder = t('section.filePlaceholder');
                pathInput.onchange = () => {
                    it.path = pathInput.value;
                    // 未自定义显示名时，用文件路径作为显示名
                    if (!it.text) it.text = pathInput.value;
                };
                // 点击/输入时弹出 vault 文件下拉列表，按输入内容筛选
                new FilePathSuggest(this.app, pathInput, (path) => {
                    it.path = path;
                    // 未自定义显示名时，用文件路径作为显示名
                    if (!it.text) it.text = path;
                });
                const nameInput = line.createEl('input', { type: 'text', cls: 'swimlane-section-card-edit-text' });
                nameInput.value = it.text;
                nameInput.placeholder = t('section.fileNamePlaceholder');
                nameInput.onchange = () => { it.text = nameInput.value; };
                this.renderEditRowDelete(line, () => {
                    (section.data as FileData).items = (section.data as FileData).items.filter(x => x.id !== it.id);
                    this.renderSectionCards(row);
                });
            }
        }

        // 底部「+」占满一行：添加新条目
        const addRow = itemsEl.createEl('button', { cls: 'swimlane-section-card-add-row', text: '+' });
        addRow.onclick = (e) => {
            e.stopPropagation();
            this.addSectionItem(section);
            this.renderSectionCards(row);
        };

        // 编辑态：条目变更后保存（失焦时统一保存，避免频繁写盘）
        card.addEventListener('focusout', () => {
            void this.save();
        });
    }

    /** 编辑态行尾的删除按钮 */
    private renderEditRowDelete(line: HTMLElement, onDelete: () => void): void {
        const del = line.createEl('button', { cls: 'swimlane-section-card-edit-del', text: '✕' });
        del.onclick = (e) => {
            e.stopPropagation();
            onDelete();
        };
    }

    /** 向板块添加一个空条目 */
    private addSectionItem(section: Section): void {
        const id = `sec_item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        if (section.type === 'checklist') {
            (section.data as ChecklistData).items.push({ id, text: '', done: false });
        } else if (section.type === 'file') {
            (section.data as FileData).items.push({ id, text: '', path: '' });
        }
    }

    /** 删除板块并保存、刷新 */
    private async deleteSection(item: InboxItem, section: Section, row: HTMLElement): Promise<void> {
        item.sections = (item.sections ?? []).filter(s => s.id !== section.id);
        this.editingSectionId = null;
        await this.save();
        this.renderSectionCards(row);
    }

    /** 渲染板块卡片中的单个条目，返回条目元素 */
    private renderSectionCardItem(itemsEl: HTMLElement, mark: string, text: string, count?: string): HTMLElement {
        const itemEl = itemsEl.createDiv({ cls: 'swimlane-section-card-item' });
        itemEl.createSpan({ cls: 'swimlane-section-card-mark', text: mark });
        itemEl.createSpan({ cls: 'swimlane-section-card-text', text });
        if (count !== undefined) {
            itemEl.createSpan({ cls: 'swimlane-section-card-count', text: count });
        }
        return itemEl;
    }

    /** 板块类型显示名 */
    private sectionTypeLabel(type: Section['type']): string {
        return t(SECTION_TYPE_META[type].labelKey as Parameters<typeof t>[0]);
    }

    /** 板块类型对应的 Obsidian 原生图标名 */
    private sectionTypeIcon(type: Section['type']): string {
        return SECTION_TYPE_META[type].icon;
    }

    /**
     * 「收集篮子」选项卡内容：左右结构。
     * 左侧为当前任务的名称 + 未处理数（篮子中尚未处理的条目数）+ 收集篮子面板；
     * 右侧为板块信息，每个板块单独一行、按顺序自上而下排列。
     */
    private renderBasketTab(container: HTMLElement): void {
        const selectedId = this.inboxData.selectedId;
        const item = selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;
        if (!item) {
            container.createDiv({ cls: 'task-plan-empty-pane' });
            return;
        }

        const layout = container.createDiv({ cls: 'task-plan-basket-layout' });

        // 左：任务名称标题 + 未处理数，其下为收集篮子面板
        const left = layout.createDiv({ cls: 'task-plan-basket-left' });
        const head = left.createDiv({ cls: 'task-plan-basket-head' });
        head.createDiv({ cls: 'task-plan-basket-title', text: item.title });
        const countRow = head.createDiv({ cls: 'task-plan-basket-count' });
        setIcon(countRow.createSpan({ cls: 'task-plan-basket-count-icon' }), 'inbox');
        countRow.createSpan({
            text: t('basket.pendingCount', { count: (item.basket ?? []).length }),
        });
        this.renderBasketBox(left.createDiv({ cls: 'okr-basket-wrap' }));

        // 右：板块信息（标题行 + 各板块面板，垂直排列）
        const right = layout.createDiv({ cls: 'task-plan-basket-right' });
        this.renderSectionsArea(right);
    }

    /**
     * 渲染「板块信息」（公共组件）：标题行（右侧「+」新增板块按钮）+ 各板块面板。
     * 「当前任务」与「收集篮子」选项卡共用，保证呈现方式一致。
     * 板块信息本身无方框，仅标题行 + 各清单/文件面板（每个面板一个方框，垂直排列）。
     */
    private renderSectionsArea(container: HTMLElement): void {
        const sectionsHead = container.createDiv({ cls: 'swimlane-section-area-header task-plan-basket-sections-head' });
        sectionsHead.createDiv({ cls: 'swimlane-section-area-title', text: t('projectPicture.sectionsTitle') });
        this.renderAddSectionButton(sectionsHead);
        const sectionsBody = container.createDiv({ cls: 'swimlane-section-area-body okr-basket-sections-area' });
        this.renderSectionCards(sectionsBody);
    }

    /** 收集篮子方框：当前选中任务的收集内容（供 GTD 梳理阶段放置笔记） */
    private renderBasketBox(wrap: HTMLElement): void {
        wrap.empty();

        const selectedId = this.inboxData.selectedId;
        const item = selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;
        if (!item) return;

        const area = wrap.createDiv({ cls: 'swimlane-section-area okr-basket-area' });
        const header = area.createDiv({ cls: 'swimlane-section-area-header' });
        header.createDiv({ cls: 'swimlane-section-area-title', text: t('basket.title') });

        // 标题右侧：「收集篮子」选项卡内为多选提示文字；「当前任务」选项卡内为跳转到该选项卡的「整理」按钮
        if (this.isBasketSelectable()) {
            header.createSpan({ cls: 'okr-basket-multiselect-hint', text: t('basket.multiSelectHint') });
        } else {
            const organizeBtn = header.createEl('button', {
                cls: 'okr-basket-organize-btn',
                text: t('basket.organize'),
            });
            organizeBtn.onclick = (e) => {
                e.stopPropagation();
                // 整理在「收集篮子」选项卡中进行，此处直接跳转
                this.rightTab = 'basket';
                void this.refresh();
            };
        }

        // 添加按钮：放在标题同一行最右侧，点击弹窗输入
        const addBtn = header.createEl('button', { cls: 'okr-basket-add-btn', text: '+' });
        addBtn.onclick = (e) => {
            e.stopPropagation();
            new BasketAddModal(this.app, (text) => {
                const entry: BasketItem = {
                    id: `basket_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                    text,
                    createdAt: Date.now(),
                };
                item.basket = [...(item.basket ?? []), entry];
                void this.save().then(() => this.refreshBasketBox());
            }).open();
        };

        const body = area.createDiv({ cls: 'okr-basket-body' });

        // 已收集条目列表（只读，不可删除；「收集篮子」选项卡内可点击多选）
        const list = body.createDiv({ cls: 'okr-basket-list' });
        const entries = item.basket ?? [];
        if (entries.length === 0) {
            list.createDiv({ cls: 'swimlane-sections-empty', text: t('basket.empty') });
            return;
        }
        for (const entry of entries) {
            const row = list.createDiv({ cls: 'okr-basket-item' });
            row.createSpan({ cls: 'okr-basket-item-text', text: entry.text });
            if (!this.isBasketSelectable()) continue;

            // 「收集篮子」选项卡内可多选（交互与「梳理」视图的收集记录保持一致）
            row.addClass('is-organizable');
            if (this.selectedBasketEntryIds.has(entry.id)) row.addClass('is-active');
            row.onclick = (e) => this.handleBasketEntryClick(entry.id, entries, e);
        }
    }

    /** 收集篮子条目是否可多选：仅在「收集篮子」选项卡内（整理到文件也在此选项卡内进行） */
    private isBasketSelectable(): boolean {
        return this.rightTab === 'basket';
    }

    /**
     * 处理收集篮子条目点击（多选交互与「梳理」视图的收集记录一致）：
     * - 普通点击：单选该条目
     * - Ctrl/Cmd 点击：切换该条目的选中状态（多选）
     * - Shift 点击：从上次点击的锚点到当前条目之间连选
     */
    private handleBasketEntryClick(id: string, entries: BasketItem[], e: MouseEvent): void {
        if (e.shiftKey && this.lastClickedBasketEntryId) {
            const ids = entries.map((it) => it.id);
            const from = ids.indexOf(this.lastClickedBasketEntryId);
            const to = ids.indexOf(id);
            if (from !== -1 && to !== -1) {
                const [start, end] = from < to ? [from, to] : [to, from];
                this.selectedBasketEntryIds = new Set(ids.slice(start, end + 1));
            } else {
                this.selectedBasketEntryIds = new Set([id]);
            }
        } else if (e.ctrlKey || e.metaKey) {
            // 切换当前条目的选中状态
            if (this.selectedBasketEntryIds.has(id)) this.selectedBasketEntryIds.delete(id);
            else this.selectedBasketEntryIds.add(id);
            this.lastClickedBasketEntryId = id;
        } else {
            // 普通点击：单选
            this.selectedBasketEntryIds = new Set([id]);
            this.lastClickedBasketEntryId = id;
        }
        this.refreshBasketBox();
        this.refreshSectionCards();
    }

    /** 同步刷新收集篮子方框（增删后调用） */
    private refreshBasketBox(): void {
        const wrap = this.container?.querySelector<HTMLElement>('.okr-basket-wrap');
        if (wrap) this.renderBasketBox(wrap);
    }

    /** 改进项方框：当前选中任务的改进条目（可勾选完成） */
    private renderImprovementBox(wrap: HTMLElement): void {
        wrap.empty();

        const selectedId = this.inboxData.selectedId;
        const item = selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;
        if (!item) return;

        const area = wrap.createDiv({ cls: 'swimlane-section-area okr-improve-area' });
        const header = area.createDiv({ cls: 'swimlane-section-area-header' });
        header.createDiv({ cls: 'swimlane-section-area-title', text: t('improveBox.title') });

        // 添加按钮：放在标题同一行最右侧，点击弹窗输入
        const addBtn = header.createEl('button', { cls: 'okr-improve-add-btn', text: '+' });
        addBtn.onclick = (e) => {
            e.stopPropagation();
            new ImprovementAddModal(this.app, (text) => {
                const entry: ImprovementEntry = {
                    id: `improve_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                    text,
                    done: false,
                    createdAt: Date.now(),
                };
                item.improvements = [...(item.improvements ?? []), entry];
                void this.save().then(() => this.refreshImprovementBox());
            }).open();
        };

        const body = area.createDiv({ cls: 'okr-improve-body' });
        const list = body.createDiv({ cls: 'okr-improve-list' });
        const entries = item.improvements ?? [];
        if (entries.length === 0) {
            list.createDiv({ cls: 'swimlane-sections-empty', text: t('improveBox.empty') });
            return;
        }
        for (const entry of entries) {
            const row = list.createDiv({ cls: 'okr-improve-item' });
            if (entry.done) row.addClass('is-done');

            const cb = row.createEl('input', { type: 'checkbox', cls: 'okr-improve-checkbox' });
            cb.checked = entry.done ?? false;
            cb.onchange = () => {
                entry.done = cb.checked;
                void this.save().then(() => this.refreshImprovementBox());
            };

            row.createSpan({ cls: 'okr-improve-item-text', text: entry.text });
        }
    }

    /** 同步刷新改进项方框（增删 / 勾选后调用） */
    private refreshImprovementBox(): void {
        const wrap = this.container?.querySelector<HTMLElement>('.okr-improve-wrap');
        if (wrap) this.renderImprovementBox(wrap);
    }

    /** 同步刷新板块信息区（整理模式切换 / 选中条目变化时调用） */
    private refreshSectionCards(): void {
        const body = this.container?.querySelector<HTMLElement>('.swimlane-section-area-body');
        if (body) this.renderSectionCards(body);
    }

    /** 未选中任务时：在右侧内容区展示所有任务条目及其 OKR 进度、成果情况 */
    private renderAllTasksOverview(container: HTMLElement): void {
        const area = container.createDiv({ cls: 'task-plan-overview' });
        area.createDiv({ cls: 'task-plan-overview-title', text: t('taskPlan.overviewTitle') });

        // 按任务面板的层级顺序（顶层 → 子任务递归）收集所有未移除任务
        const ordered: { item: InboxItem; depth: number }[] = [];
        const collect = (parentId: string | undefined, depth: number) => {
            const children = this.inboxData.items.filter(i => !i.removed && i.parentId === parentId);
            for (const child of children) {
                ordered.push({ item: child, depth });
                collect(child.id, depth + 1);
            }
        };
        collect(undefined, 0);

        if (ordered.length === 0) {
            area.createDiv({ cls: 'task-plan-empty', text: t('inbox.empty') });
            return;
        }

        const list = area.createDiv({ cls: 'task-plan-overview-list' });
        for (const { item, depth } of ordered) {
            const row = list.createDiv({ cls: 'task-plan-overview-row' });
            row.style.setProperty('--overview-depth', String(depth));

            // 任务条目（标题）
            const titleRow = row.createDiv({ cls: 'task-plan-overview-item' });
            titleRow.createSpan({ cls: 'task-plan-overview-item-title', text: item.title });

            // OKR 进度 / 成果情况
            const conditions = item.okr?.conditions ?? [];
            const detail = row.createDiv({ cls: 'task-plan-overview-detail' });

            if (conditions.length === 0) {
                detail.createDiv({ cls: 'task-plan-overview-empty', text: t('taskPlan.overviewNoOkr') });
                continue;
            }

            // 累积：当前值 / 目标（与 OKR 进度方框一致，当前值暂为 0）
            const cumulativeConds = conditions.filter(c => c.type === 'cumulative');
            if (cumulativeConds.length > 0) {
                const line = detail.createDiv({ cls: 'task-plan-overview-line' });
                line.createSpan({
                    cls: 'task-plan-overview-label',
                    text: t(OKR_CONDITION_META.cumulative.labelKey as Parameters<typeof t>[0]),
                });
                const unit = t(OKR_CONDITION_META.cumulative.unitKey as Parameters<typeof t>[0]);
                const targetSum = cumulativeConds.reduce((sum, c) => sum + (c.target || 0), 0);
                line.createSpan({ cls: 'task-plan-overview-value', text: `0/${targetSum} ${unit}` });
            }

            // 成果 / 里程碑：已完成数 / 总数（按清单行统计，旧数据无清单行时按条目统计）
            const outcomeConds = conditions.filter(c => c.type === 'outcome' || c.type === 'milestone');
            if (outcomeConds.length > 0) {
                const line = detail.createDiv({ cls: 'task-plan-overview-line' });
                line.createSpan({
                    cls: 'task-plan-overview-label',
                    text: t(OKR_CONDITION_META.outcome.labelKey as Parameters<typeof t>[0]),
                });
                const rows = outcomeConds.reduce<OkrConditionItem[]>((acc, c) => acc.concat(c.items ?? []), []);
                const doneCount = rows.length > 0
                    ? rows.filter(it => it.done).length
                    : outcomeConds.filter(c => c.done).length;
                const totalCount = rows.length > 0 ? rows.length : outcomeConds.length;
                line.createSpan({
                    cls: 'task-plan-overview-value',
                    text: `${doneCount}/${totalCount}`,
                });
            }
        }
    }

    /** 当前任务面板是否选中了有效任务 */
    private hasSelectedTask(): boolean {
        const selectedId = this.inboxData.selectedId;
        return !!selectedId && this.inboxData.items.some(i => i.id === selectedId && !i.removed);
    }

    /** 渲染右侧信息表单：项目描述、分类、截止日期（跟随当前选中任务） */
    private renderInfoForm(container: HTMLElement): void {
        const selectedId = this.inboxData.selectedId;
        const item = selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;

        if (!item) {
            // 未选中任务：「当前任务」选项卡下不展示内容（总览已归并至「任务总览」选项卡）
            return;
        }

        // 两栏布局：左侧任务详情方框、右侧任务状态 / 习惯任务方框，各占页面一半
        const detailRow = container.createDiv({ cls: 'task-plan-detail-row' });

        // ===== 左方框：任务详情（标题 / 描述 / 分类）=====
        const detailBox = detailRow.createDiv({ cls: 'task-plan-detail-box' });
        detailBox.createDiv({ cls: 'task-plan-detail-title', text: t('taskPlan.detailTitle') });
        const form = detailBox.createDiv({ cls: 'task-plan-form' });

        // 标题（点击铅笔图标后内联编辑）
        const titleRow = form.createDiv({ cls: 'task-plan-title-row' });
        const titleEl = titleRow.createEl('h2', { cls: 'task-plan-title', text: item.title });
        const editTitleBtn = titleRow.createEl('button', {
            cls: 'task-plan-edit-desc-btn',
            attr: { 'aria-label': t('taskPlan.editTitle') },
        });
        setIcon(editTitleBtn, 'pencil');
        editTitleBtn.onclick = () => {
            // 已在编辑态则忽略
            if (titleRow.querySelector('.task-plan-title-edit-input')) return;
            const input = titleRow.createEl('input', {
                cls: 'task-plan-title-edit-input',
                type: 'text',
            });
            input.value = item.title;
            titleEl.hide();
            input.focus();
            // 失焦后自动保存并恢复展示
            input.onblur = () => {
                void (async () => {
                    const next = input.value.trim();
                    if (next) item.title = next;
                    await this.save();
                    await this.refresh();
                })();
            };
        };

        // 项目描述
        const descRow = form.createDiv({ cls: 'task-plan-field' });
        const descLabelRow = descRow.createDiv({ cls: 'task-plan-field-label-row' });
        descLabelRow.createDiv({ cls: 'task-plan-field-label', text: t('taskPlan.description') });
        // 铅笔图标：点击后在页面内直接显示输入框编辑描述
        const editDescBtn = descLabelRow.createEl('button', {
            cls: 'task-plan-edit-desc-btn',
            attr: { 'aria-label': t('taskPlan.editDescription') },
        });
        setIcon(editDescBtn, 'pencil');
        const descValue = descRow.createDiv({
            cls: 'task-plan-field-value',
            text: item.description || t('taskPlan.emptyValue'),
        });
        editDescBtn.onclick = () => {
            // 已在编辑态则忽略
            if (descRow.querySelector('.task-plan-desc-edit-input')) return;
            const textarea = descRow.createEl('textarea', {
                cls: 'task-plan-desc-edit-input',
            });
            textarea.value = item.description ?? '';
            descValue.hide();
            textarea.focus();
            // 失焦后自动保存并恢复展示
            textarea.onblur = () => {
                void (async () => {
                    item.description = textarea.value;
                    await this.save();
                    await this.refresh();
                })();
            };
        };

        // 分类（点击铅笔图标后内联选择）
        const category = item.categoryId
            ? this.categoryData.categories.find(c => c.id === item.categoryId)
            : undefined;
        const catRow = form.createDiv({ cls: 'task-plan-field' });
        const catLabelRow = catRow.createDiv({ cls: 'task-plan-field-label-row' });
        catLabelRow.createDiv({ cls: 'task-plan-field-label', text: t('taskPlan.category') });
        const editCatBtn = catLabelRow.createEl('button', {
            cls: 'task-plan-edit-desc-btn',
            attr: { 'aria-label': t('taskPlan.editCategory') },
        });
        setIcon(editCatBtn, 'pencil');
        const catValue = catRow.createDiv({ cls: 'task-plan-field-value' });
        if (category) {
            const dot = catValue.createSpan({ cls: 'task-plan-category-dot' });
            if (category.color) dot.setCssStyles({ backgroundColor: category.color });
            catValue.createSpan({ text: category.label });
        } else {
            catValue.setText(t('taskPlan.emptyValue'));
        }
        editCatBtn.onclick = () => {
            // 已在编辑态则忽略
            if (catRow.querySelector('.task-plan-category-select')) return;
            catValue.hide();
            const select = catRow.createEl('select', { cls: 'task-plan-category-select' });
            select.createEl('option', { text: t('inbox.noCategory'), value: '' });
            for (const c of this.categoryData.categories) {
                select.createEl('option', { text: c.label, value: c.id });
            }
            select.value = item.categoryId ?? '';
            select.focus();
            // 失焦后自动保存并恢复展示
            select.onblur = () => {
                void (async () => {
                    item.categoryId = select.value || undefined;
                    await this.save();
                    await this.refresh();
                })();
            };
        };

        // ===== 右方框：任务类型（卡片选择器）=====
        const statusBox = detailRow.createDiv({ cls: 'task-plan-detail-box' });
        statusBox.createDiv({ cls: 'task-plan-detail-title', text: t('taskPlan.typeTitle') });
        const statusBody = statusBox.createDiv({ cls: 'task-plan-status-body' });

        // 当前任务类型（旧数据无 taskType 时，按 habitTimeEnabled 兜底）
        const currentType: TaskType = item.taskType ?? (item.habitTimeEnabled ? 'habit' : 'oneTime');

        // ===== 卡片 1：一次性任务 =====
        const oneTimeCard = statusBody.createDiv({ cls: 'task-plan-type-card' });
        if (currentType === 'oneTime') oneTimeCard.addClass('is-selected');
        const oneTimeHead = oneTimeCard.createDiv({ cls: 'task-plan-type-card-head' });
        oneTimeHead.createSpan({ cls: 'task-plan-type-radio', text: currentType === 'oneTime' ? '🔘' : '⚪' });
        oneTimeHead.createSpan({ cls: 'task-plan-type-name', text: t('taskPlan.oneTimeTask') });
        oneTimeCard.createDiv({ cls: 'task-plan-type-desc', text: t('taskPlan.oneTimeTaskDesc') });

        // 一次性任务配置区（选中时展开：任务状态按钮组）
        if (currentType === 'oneTime') {
            const oneTimeBody = oneTimeCard.createDiv({ cls: 'task-plan-type-config' });
            oneTimeBody.createDiv({ cls: 'task-plan-field-label', text: t('taskPlan.statusTitle') });
            const statusGroup = oneTimeBody.createDiv({ cls: 'task-plan-status-group' });
            const statuses: { value: TaskStatus; labelKey: 'taskPlan.statusNotStarted' | 'taskPlan.statusInProgress' | 'taskPlan.statusDone' }[] = [
                { value: 'notStarted', labelKey: 'taskPlan.statusNotStarted' },
                { value: 'inProgress', labelKey: 'taskPlan.statusInProgress' },
                { value: 'done', labelKey: 'taskPlan.statusDone' },
            ];
            const currentStatus = item.status ?? 'notStarted';
            for (const st of statuses) {
                const btn = statusGroup.createEl('button', {
                    cls: 'task-plan-status-btn',
                    text: t(st.labelKey),
                });
                if (st.value === currentStatus) btn.addClass('is-active');
                btn.onclick = (e) => {
                    e.stopPropagation();
                    void (async () => {
                        item.status = st.value;
                        await this.save();
                        await this.refresh();
                    })();
                };
            }
        }

        // 点击一次性任务卡片：切换类型
        oneTimeCard.onclick = () => {
            if (currentType === 'oneTime') return;
            void (async () => {
                item.taskType = 'oneTime';
                item.habitTimeEnabled = false;
                await this.save();
                await this.refresh();
            })();
        };

        // ===== 卡片 2：习惯型任务 =====
        const habitCard = statusBody.createDiv({ cls: 'task-plan-type-card' });
        if (currentType === 'habit') habitCard.addClass('is-selected');
        const habitHead = habitCard.createDiv({ cls: 'task-plan-type-card-head' });
        habitHead.createSpan({ cls: 'task-plan-type-radio', text: currentType === 'habit' ? '🔘' : '⚪' });
        habitHead.createSpan({ cls: 'task-plan-type-name', text: t('taskPlan.habitTypeTask') });
        habitCard.createDiv({ cls: 'task-plan-type-desc', text: t('taskPlan.habitTypeTaskDesc') });

        // 习惯型任务配置区（选中时展开：习惯时间点 + 预估时长）
        if (currentType === 'habit') {
            const habitBody = habitCard.createDiv({ cls: 'task-plan-type-config' });

            // 习惯时间点与预估执行时长并排
            const habitRow = habitBody.createDiv({ cls: 'task-plan-habit-row' });

            // ===== 习惯时间点（小时下拉 + 分钟下拉，选择后自动保存）=====
            const habitTimeCol = habitRow.createDiv({ cls: 'task-plan-habit-col' });
            habitTimeCol.createDiv({ cls: 'task-plan-field-label', text: t('taskPlan.habitTimePoint') });
            const habitGroup = habitTimeCol.createDiv({ cls: 'task-plan-habit-group' });

            // 未设置时默认 09:00
            const habitMinutes = item.habitTime ?? 9 * 60;
            const habitHour = Math.floor(habitMinutes / 60);
            const habitMinute = habitMinutes % 60;

            const hourSelect = habitGroup.createEl('select', { cls: 'task-plan-habit-select' });
            for (let h = 0; h < 24; h++) {
                hourSelect.createEl('option', { text: `${String(h).padStart(2, '0')}`, value: `${h}` });
            }
            hourSelect.value = `${habitHour}`;

            habitGroup.createSpan({ cls: 'task-plan-habit-sep', text: ':' });

            const minuteSelect = habitGroup.createEl('select', { cls: 'task-plan-habit-select' });
            for (let m = 0; m < 60; m += 5) {
                minuteSelect.createEl('option', { text: `${String(m).padStart(2, '0')}`, value: `${m}` });
            }
            minuteSelect.value = `${habitMinute}`;

            const applyHabit = () => {
                void (async () => {
                    item.habitTime = Number(hourSelect.value) * 60 + Number(minuteSelect.value);
                    await this.save();
                    await this.refresh();
                })();
            };
            hourSelect.onchange = applyHabit;
            minuteSelect.onchange = applyHabit;

            // ===== 预估执行时长（手动输入：小时 + 分钟，失焦后自动保存）=====
            const estCol = habitRow.createDiv({ cls: 'task-plan-habit-col' });
            estCol.createDiv({ cls: 'task-plan-field-label', text: t('weekPanel.estimatedLabel') });
            const estGroup = estCol.createDiv({ cls: 'task-plan-habit-input-group' });

            // 未设置时默认 0 小时 0 分钟
            const estMinutes = typeof item.estimatedMinutes === 'number' && item.estimatedMinutes >= 0
                ? item.estimatedMinutes
                : 0;
            const estHour = Math.floor(estMinutes / 60);
            const estMinute = estMinutes % 60;

            const estHourInput = estGroup.createEl('input', {
                cls: 'task-plan-habit-input',
                type: 'number',
                attr: { min: '0', step: '1' },
            });
            estHourInput.value = String(estHour);
            estGroup.createSpan({ cls: 'task-plan-habit-unit', text: t('weekPanel.hourUnit') });

            const estMinuteInput = estGroup.createEl('input', {
                cls: 'task-plan-habit-input',
                type: 'number',
                attr: { min: '0', step: '5' },
            });
            estMinuteInput.value = String(estMinute);
            estGroup.createSpan({ cls: 'task-plan-habit-unit', text: t('weekPanel.minuteUnit') });

            const applyEst = () => {
                void (async () => {
                    const hour = Math.max(0, Math.floor(Number(estHourInput.value)) || 0);
                    const minute = Math.max(0, Math.floor(Number(estMinuteInput.value)) || 0);
                    item.estimatedMinutes = hour * 60 + minute;
                    await this.save();
                    await this.refresh();
                })();
            };
            estHourInput.onchange = applyEst;
            estMinuteInput.onchange = applyEst;
        }

        // 点击习惯型任务卡片：切换类型
        habitCard.onclick = () => {
            if (currentType === 'habit') return;
            void (async () => {
                item.taskType = 'habit';
                item.habitTimeEnabled = true;
                await this.save();
                await this.refresh();
            })();
        };
    }

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
    }
}

// ===== 收集篮子添加弹窗 =====
class BasketAddModal extends Modal {
    constructor(
        app: App,
        private onSubmit: (text: string) => void,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('basket.title') });

        let value = '';
        new Setting(contentEl)
            .setName(t('basket.addPlaceholder'))
            .addText(text => {
                text.setPlaceholder(t('basket.addPlaceholder'));
                text.onChange(v => { value = v; });
                text.inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        this.submit(value);
                    }
                });
                window.setTimeout(() => text.inputEl.focus(), 0);
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('basket.add'))
                .setCta()
                .onClick(() => this.submit(value))
            )
            .addButton(btn => btn
                .setButtonText(t('common.cancel'))
                .onClick(() => this.close())
            );
    }

    private submit(value: string) {
        const text = value.trim();
        if (!text) return;
        this.onSubmit(text);
        this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ===== 改进项添加弹窗 =====
class ImprovementAddModal extends Modal {
    constructor(
        app: App,
        private onSubmit: (text: string) => void,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('improveBox.title') });

        let value = '';
        new Setting(contentEl)
            .setName(t('improveBox.addPlaceholder'))
            .addText(text => {
                text.setPlaceholder(t('improveBox.addPlaceholder'));
                text.onChange(v => { value = v; });
                text.inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        this.submit(value);
                    }
                });
                window.setTimeout(() => text.inputEl.focus(), 0);
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('improveBox.add'))
                .setCta()
                .onClick(() => this.submit(value))
            )
            .addButton(btn => btn
                .setButtonText(t('common.cancel'))
                .onClick(() => this.close())
            );
    }

    private submit(value: string) {
        const text = value.trim();
        if (!text) return;
        this.onSubmit(text);
        this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ===== 删除板块确认弹窗 =====
class ConfirmDeleteSectionModal extends Modal {
    constructor(
        app: App,
        private sectionTitle: string,
        private onConfirm: () => void | Promise<void>,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('common.delete') });
        contentEl.createEl('p', { text: t('section.deleteConfirm', { title: this.sectionTitle }) });

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
