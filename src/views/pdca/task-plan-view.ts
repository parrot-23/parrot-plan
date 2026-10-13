import type { App } from 'obsidian';
import { Modal, Notice, Setting, setIcon } from 'obsidian';

import type { TimeBlockCategoryData } from './week-view/timeblock-category-manager';
import type { InboxData, InboxItem, Section, ChecklistData, StepsData, HabitData, FileData } from '../datatypes/domain';
import { SECTION_TYPE_META } from '../datatypes/domain';
import { renderTaskPanel, FilePathSuggest } from '../shared/task-panel';
import { renderSwimlane } from '../shared/swimlane';
import { makeWeekKey, parseWeekKey } from './week-view/timeblock-data';
import { t } from '../i18n';

/**
 * 任务计划视图：左侧任务面板 + 右侧内容区（项目信息表单 + 泳道图）。
 * 与 YearView 一样，通过 renderInto 渲染到指定容器。
 */
export class TaskPlanView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: TimeBlockCategoryData;
    private save: () => Promise<void>;
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 泳道图当前显示的年份 */
    private currentYear: number = new Date().getFullYear();
    /** 刷新前泳道图的横向滚动位置（渲染后恢复，避免位置跳动） */
    private savedScrollLeft: number | null = null;
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
        // 刷新前记录泳道图的横向滚动位置，渲染后恢复，避免位置跳动
        const prevBoard = container.querySelector('.task-plan-board');
        if (prevBoard) {
            this.savedScrollLeft = prevBoard.scrollLeft;
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

        // 右侧：内容区（当前选中任务的信息表单 + 泳道图）
        const contentPanel = container.createDiv({ cls: 'task-plan-content-panel' });
        this.renderInfoForm(contentPanel);

        // 泳道图（仅显示计划，不显示执行；只显示当前选中任务及其子任务）
        const board = contentPanel.createDiv({ cls: 'task-plan-board' });
        const { tasks, depthMap, inheritedMap } = this.collectSelectedSubtree();
        renderSwimlane(board, {
            tasks,
            categoryData: this.categoryData,
            selectedId: this.inboxData.selectedId,
            currentYear: this.currentYear,
            onYearChange: (year) => {
                this.currentYear = year;
                void this.refresh();
            },
            showExec: false,
            getDepth: (task) => depthMap.get(task.id) ?? 0,
            getDescendantWeeks: (task) => inheritedMap.get(task.id) ?? [],
            onWeekClick: (task, week) => {
                void this.toggleWeekAssignment(task, week);
            },
        });

        // 恢复刷新前的横向滚动位置，实现无感刷新
        if (this.savedScrollLeft !== null) {
            const left = this.savedScrollLeft;
            this.savedScrollLeft = null;
            window.setTimeout(() => {
                board.scrollLeft = left;
            }, 0);
        }

        // 泳道图与下方区域之间的分隔线
        contentPanel.createDiv({ cls: 'task-plan-divider' });

        // 泳道图下方：已计划周数（每个周数为一张小卡片，随任务面板选中任务切换）
        this.renderPlannedWeeks(contentPanel);

        // 泳道图下方：板块信息方框（当前选中项目的板块卡片）
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

    /**
     * 点击泳道图某周格子：将该行任务分配到该周（再次点击同一周则取消）。
     */
    private async toggleWeekAssignment(task: InboxItem, week: number): Promise<void> {
        const item = this.inboxData.items.find(i => i.id === task.id && !i.removed);
        if (!item) return;

        const weekKey = makeWeekKey(this.currentYear, week);
        const keys = item.assignedWeekKeys ?? [];
        if (keys.includes(weekKey)) {
            item.assignedWeekKeys = keys.filter(k => k !== weekKey);
            await this.save();
            new Notice(t('year.unassigned', { title: item.title, week: weekKey }));
        } else {
            item.assignedWeekKeys = [...keys, weekKey];
            await this.save();
            new Notice(t('year.assigned', { title: item.title, week: weekKey }));
        }
        await this.refresh();
    }

    /**
     * 泳道图（及其上方项目信息）的根任务 id：
     * 「按项目排布」激活时锁定在顶层任务（projectFocusId），否则跟随当前选中任务。
     */
    private getSwimlaneRootId(): string | undefined {
        return this.inboxData.projectFocusId ?? this.inboxData.selectedId;
    }

    /**
     * 收集泳道图根任务及其所有子任务（深度优先，跳过已折叠任务的子任务）。
     * 返回任务列表、每个任务的层级深度（根任务为 0），
     * 以及每个任务的所有子孙节点的计划周号（当前年份，用于渲染条纹格子）。
     * 无根任务时返回空列表。
     */
    private collectSelectedSubtree(): {
        tasks: InboxItem[];
        depthMap: Map<string, number>;
        inheritedMap: Map<string, number[]>;
    } {
        const tasks: InboxItem[] = [];
        const depthMap = new Map<string, number>();
        const inheritedMap = new Map<string, number[]>();
        const selectedId = this.getSwimlaneRootId();
        if (!selectedId) return { tasks, depthMap, inheritedMap };
        const root = this.inboxData.items.find(i => i.id === selectedId && !i.removed);
        if (!root) return { tasks, depthMap, inheritedMap };

        const collapsed = this.inboxData.collapsedIds ?? [];

        // 提取任务在当前年份的计划周号
        const weeksOf = (item: InboxItem): number[] => {
            const result: number[] = [];
            for (const key of item.assignedWeekKeys ?? []) {
                const parsed = parseWeekKey(key);
                if (parsed.year === this.currentYear) result.push(parsed.week);
            }
            return result;
        };

        // 递归收集：返回该节点及其所有子孙的计划周号集合
        // visible 表示该节点是否作为泳道行显示（折叠的子孙不显示，但仍需汇总其计划周）
        const walk = (item: InboxItem, depth: number, visible: boolean): Set<number> => {
            if (visible) {
                tasks.push(item);
                depthMap.set(item.id, depth);
            }

            const descendantWeeks = new Set<number>();
            const children = this.inboxData.items.filter(
                i => !i.removed && i.parentId === item.id,
            );
            // 折叠时子孙不显示为泳道行，但仍要汇总其计划周（父级条纹格子）
            const childrenVisible = visible && !collapsed.includes(item.id);
            for (const child of children) {
                // 子节点自身计划周 + 其子孙的计划周
                for (const w of weeksOf(child)) descendantWeeks.add(w);
                for (const w of Array.from(walk(child, depth + 1, childrenVisible))) {
                    descendantWeeks.add(w);
                }
            }
            // 该行条纹格子 = 所有子孙的计划周（不含自身）
            inheritedMap.set(item.id, Array.from(descendantWeeks));
            return descendantWeeks;
        };
        walk(root, 0, true);
        return { tasks, depthMap, inheritedMap };
    }

    /** 渲染右侧信息表单：项目描述、分类（跟随泳道图根任务） */
    private renderInfoForm(container: HTMLElement): void {
        const rootId = this.getSwimlaneRootId();
        const item = rootId
            ? this.inboxData.items.find(i => i.id === rootId && !i.removed)
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

    /** 渲染「已计划周数」区域（位于泳道图下方，每个周数为一张小卡片） */
    private renderPlannedWeeks(container: HTMLElement): void {
        const selectedId = this.inboxData.selectedId;
        const item = selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;
        if (!item) return;

        const area = container.createDiv({ cls: 'task-plan-weeks-area' });
        area.createDiv({ cls: 'task-plan-weeks-title', text: t('taskPlan.plannedWeeks') });

        const weekKeys = item.assignedWeekKeys ?? [];
        const list = area.createDiv({ cls: 'task-plan-weeks-list' });
        if (weekKeys.length === 0) {
            list.createDiv({ cls: 'task-plan-weeks-empty', text: t('taskPlan.emptyValue') });
            return;
        }
        for (const key of weekKeys) {
            const card = list.createDiv({ cls: 'task-plan-week-card' });
            card.createDiv({ cls: 'task-plan-week-card-title', text: key });
            // 白底黑边的框（内容占位）
            card.createDiv({ cls: 'task-plan-week-card-box' });
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
