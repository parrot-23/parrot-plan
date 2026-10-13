import type { App } from 'obsidian';
import { Modal, Notice, Setting, setIcon } from 'obsidian';

import type { TimeBlockCategoryData } from '../../shared/timeblock-category-manager';
import type { InboxData, InboxItem, Section, ChecklistData, StepsData, HabitData, FileData, OkrConditionType } from '../../datatypes/domain';
import { SECTION_TYPE_META, OKR_CONDITION_META } from '../../datatypes/domain';
import { renderTaskPanel, FilePathSuggest } from '../../shared/task-panel';
import { t } from '../../i18n';

/**
 * 任务OKR 下的「任务计划」视图：左侧任务面板 + 右侧内容区（项目信息表单 + 已计划周数 + 板块信息）。
 * 与 PDCA 下的任务计划视图一致，但去除了泳道图。
 */
export class OkrTaskPlanView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: TimeBlockCategoryData;
    private save: () => Promise<void>;
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 板块「+」下拉面板的「点击外部关闭」监听器（渲染前清理，避免累积） */
    private addPanelCloseHandler?: (e: MouseEvent) => void;
    /** 当前处于编辑态的板块 id（null 表示无） */
    private editingSectionId: string | null = null;

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
        // 清理上一次渲染注册的下拉关闭监听器，避免累积
        if (this.addPanelCloseHandler) {
            document.removeEventListener('mousedown', this.addPanelCloseHandler);
            this.addPanelCloseHandler = undefined;
        }
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

        // 右侧：内容区（当前选中任务的信息表单 + OKR 信息 + 板块信息）
        const contentPanel = container.createDiv({ cls: 'task-plan-content-panel' });
        this.renderInfoForm(contentPanel);

        // OKR 信息方框（当前选中任务的 OKR 条件）
        const okrWrap = contentPanel.createDiv({ cls: 'okr-wrap' });
        this.renderOkrBox(okrWrap);

        // 板块信息方框（当前选中项目的板块卡片）
        const sectionsArea = contentPanel.createDiv({ cls: 'swimlane-section-area' });
        const sectionsHeader = sectionsArea.createDiv({ cls: 'swimlane-section-area-header' });
        sectionsHeader.createDiv({ cls: 'swimlane-section-area-title', text: t('projectPicture.sectionsTitle') });
        this.renderAddSectionButton(sectionsHeader);
        const sectionsBody = sectionsArea.createDiv({ cls: 'swimlane-section-area-body' });
        this.renderSectionCards(sectionsBody);
    }

    /** 板块方框右上角的「+」按钮：点击展开下拉面板选择板块类型 */
    private renderAddSectionButton(header: HTMLElement): void {
        const wrap = header.createDiv({ cls: 'swimlane-section-add-wrap' });
        const btn = wrap.createEl('button', { cls: 'swimlane-section-add-btn', text: '+' });

        // 下拉面板（默认隐藏）
        const panel = wrap.createDiv({ cls: 'swimlane-section-add-panel' });

        const types: { type: Section['type']; labelKey: 'section.typeChecklist' | 'section.typeSteps' | 'section.typeHabit' | 'section.typeFile' }[] = [
            { type: 'checklist', labelKey: 'section.typeChecklist' },
            { type: 'steps', labelKey: 'section.typeSteps' },
            { type: 'habit', labelKey: 'section.typeHabit' },
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
        const data: ChecklistData | StepsData | HabitData | FileData = { items: [] };
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
        } else if (section.type === 'steps') {
            for (const it of (section.data as StepsData).items) {
                const mark = it.status === 'done' ? '✅' : it.status === 'doing' ? '🔄' : '⬜';
                this.renderSectionCardItem(itemsEl, mark, it.text);
            }
        } else if (section.type === 'habit') {
            const data: HabitData = section.data;
            for (const it of data.items) {
                const count = it.checkedDays?.length ?? 0;
                this.renderSectionCardItem(itemsEl, '🔁', it.text, String(count));
            }
        } else if (section.type === 'file') {
            for (const it of (section.data as FileData).items) {
                const itemEl = this.renderSectionCardItem(itemsEl, '📄', it.text || it.path);
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
        } else if (section.type === 'steps') {
            for (const it of (section.data as StepsData).items) {
                const line = itemsEl.createDiv({ cls: 'swimlane-section-card-edit-row' });
                const sel = line.createEl('select', { cls: 'swimlane-section-card-edit-status' });
                const statuses: Array<{ v: 'todo' | 'doing' | 'done'; label: string }> = [
                    { v: 'todo', label: t('section.stepTodo') },
                    { v: 'doing', label: t('section.stepDoing') },
                    { v: 'done', label: t('section.stepDone') },
                ];
                for (const s of statuses) {
                    const opt = sel.createEl('option', { text: s.label, value: s.v });
                    if (it.status === s.v) opt.selected = true;
                }
                sel.onchange = () => { it.status = sel.value as 'todo' | 'doing' | 'done'; };
                const text = line.createEl('input', { type: 'text', cls: 'swimlane-section-card-edit-text' });
                text.value = it.text;
                text.onchange = () => { it.text = text.value; };
                this.renderEditRowDelete(line, () => {
                    (section.data as StepsData).items = (section.data as StepsData).items.filter(x => x.id !== it.id);
                    this.renderSectionCards(row);
                });
            }
        } else if (section.type === 'habit') {
            const data: HabitData = section.data;
            for (const it of data.items) {
                const line = itemsEl.createDiv({ cls: 'swimlane-section-card-edit-row' });
                const text = line.createEl('input', { type: 'text', cls: 'swimlane-section-card-edit-text' });
                text.value = it.text;
                text.onchange = () => { it.text = text.value; };
                this.renderEditRowDelete(line, () => {
                    data.items = data.items.filter(x => x.id !== it.id);
                    this.renderSectionCards(row);
                });
            }
        } else if (section.type === 'file') {
            for (const it of (section.data as FileData).items) {
                const line = itemsEl.createDiv({ cls: 'swimlane-section-card-edit-row' });
                const pathInput = line.createEl('input', { type: 'text', cls: 'swimlane-section-card-edit-text' });
                pathInput.value = it.path;
                pathInput.placeholder = t('section.filePlaceholder');
                pathInput.onchange = () => { it.path = pathInput.value; };
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
        } else if (section.type === 'steps') {
            (section.data as StepsData).items.push({ id, text: '', status: 'todo' });
        } else if (section.type === 'habit') {
            const data: HabitData = section.data;
            data.items.push({ id, text: '' });
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

    /** OKR 信息方框：当前选中任务的 OKR 条件列表（每行：条件类型 + 目标值） */
    private renderOkrBox(wrap: HTMLElement): void {
        wrap.empty();

        const selectedId = this.inboxData.selectedId;
        const item = selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;
        if (!item) return;

        const area = wrap.createDiv({ cls: 'swimlane-section-area okr-area' });
        const header = area.createDiv({ cls: 'swimlane-section-area-header' });
        header.createDiv({ cls: 'swimlane-section-area-title', text: t('okr.title') });
        const addBtn = header.createEl('button', { cls: 'okr-add-btn', text: t('okr.addCondition') });
        addBtn.onclick = (e) => {
            e.stopPropagation();
            void this.addOkrCondition(item, wrap);
        };

        const body = area.createDiv({ cls: 'okr-body' });
        const conditions = item.okr?.conditions ?? [];
        if (conditions.length === 0) {
            body.createDiv({ cls: 'swimlane-sections-empty', text: t('okr.empty') });
            return;
        }

        for (const cond of conditions) {
            const row = body.createDiv({ cls: 'okr-row' });

            // 条件类型下拉
            const sel = row.createEl('select', { cls: 'okr-type-select' });
            for (const type of Object.keys(OKR_CONDITION_META) as OkrConditionType[]) {
                const opt = sel.createEl('option', {
                    text: t(OKR_CONDITION_META[type].labelKey as Parameters<typeof t>[0]),
                    value: type,
                });
                if (cond.type === type) opt.selected = true;
            }
            sel.onchange = () => {
                cond.type = sel.value as OkrConditionType;
                void this.save();
                this.renderOkrBox(wrap);
            };

            // 目标值输入
            const target = row.createEl('input', {
                type: 'number',
                cls: 'okr-target-input',
                attr: { placeholder: t('okr.targetPlaceholder') },
            });
            target.value = String(cond.target);
            target.onchange = () => {
                const v = Number(target.value);
                cond.target = Number.isFinite(v) ? v : 0;
                void this.save();
            };

            // 单位
            row.createSpan({
                cls: 'okr-unit',
                text: t(OKR_CONDITION_META[cond.type].unitKey as Parameters<typeof t>[0]),
            });

            // 删除按钮
            const del = row.createEl('button', { cls: 'okr-del-btn', text: '✕' });
            del.onclick = (e) => {
                e.stopPropagation();
                void this.deleteOkrCondition(item, cond.id, wrap);
            };
        }
    }

    /** 添加一条 OKR 条件并保存、刷新 */
    private async addOkrCondition(item: InboxItem, wrap: HTMLElement): Promise<void> {
        const id = `okr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        if (!item.okr) item.okr = { conditions: [] };
        item.okr.conditions.push({ id, type: 'duration', target: 0 });
        await this.save();
        this.renderOkrBox(wrap);
    }

    /** 删除一条 OKR 条件并保存、刷新 */
    private async deleteOkrCondition(item: InboxItem, condId: string, wrap: HTMLElement): Promise<void> {
        if (!item.okr) return;
        item.okr.conditions = item.okr.conditions.filter(c => c.id !== condId);
        await this.save();
        this.renderOkrBox(wrap);
    }

    /** 渲染右侧信息表单：项目描述、分类（跟随当前选中任务） */
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
    }

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
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
