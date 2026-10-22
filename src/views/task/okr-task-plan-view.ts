import type { App } from 'obsidian';
import { AbstractInputSuggest, Modal, Notice, Setting, TFolder, setIcon } from 'obsidian';

import type { PlanCategoryData } from '../../shared/plan-category-manager';
import type { InboxData, InboxItem, Section, ChecklistData, FileData, BasketItem, ImprovementEntry, OkrCondition, OkrConditionItem, OkrConditionType, OkrPeriod, OkrRecordCard, OkrRecordFieldType, ExecutionRecord, TaskType, TaskStatus } from '../../datatypes/domain';
import type { InboxRepo } from '../../repos/inbox-repo';
import { SECTION_TYPE_META, OKR_CONDITION_META, OKR_GROUP_META, OKR_PERIOD_META, OKR_RECORD_FIELD_META, executionDuration } from '../../datatypes/domain';
import { renderTaskPanel, FilePathSuggest } from '../../shared/task-panel';
import { TaskSearchModal } from '../../shared/task-search-modal';
import { makePeriodKey } from '../../datatypes/card';
import type { CardInstance } from '../../datatypes/card';
import type { CardTemplate } from '../../datatypes/form';
import { RecordRepo } from '../../repos/record-repo';
import { makeDayKeyFromWeek } from '../../shared/plan-data';
import { renderCardContent } from '../../cardmake/card-component';
import { createDataProvider } from '../../cardmake/engine/provider';
import { t } from '../../i18n';

/** 生成 OKR 条目 id */
function makeOkrId(): string {
    return `okr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 生成 OKR 清单行 id */
function makeConditionItemId(): string {
    return `okr_item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 规范化目录：去掉首尾斜杠与空白 */
function normalizeFolder(folder: string): string {
    return folder.trim().replace(/^\/+|\/+$/g, '');
}

/**
 * 按命名规则渲染文件名：支持 {{date}}（yyyy-MM-dd）、{{time}}（HHmm）、{{datetime}} 占位符，
 * 自动清理非法字符并补全 .md 后缀。规则为空或渲染结果为空时返回空字符串。
 */
function buildFileName(pattern: string, now = new Date()): string {
    if (!pattern.trim()) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
    const name = pattern
        .replace(/\{\{datetime\}\}/gi, `${date} ${time}`)
        .replace(/\{\{date\}\}/gi, date)
        .replace(/\{\{time\}\}/gi, time)
        .replace(/[\\/:*?"<>|]/g, '-')
        .trim();
    if (!name) return '';
    return /\.md$/i.test(name) ? name : `${name}.md`;
}

/** 按类型生成新 OKR 条目的默认字段 */
function makeCondition(type: OkrConditionType, index: number): OkrCondition {
    const cond: OkrCondition = {
        id: makeOkrId(),
        type,
        target: 0,
        title: `${t(OKR_CONDITION_META[type].labelKey as Parameters<typeof t>[0])}${index}`,
    };
    if (type === 'milestone' || type === 'outcome') {
        // 里程碑 / 成果：一个条目表示一整个清单，默认带一行
        cond.items = [makeConditionItem(type, 1)];
    }
    if (type === 'cumulative') cond.unit = t('okr.unitMinute');
    if (type === 'frequency') cond.period = 'week';
    if (type === 'range') {
        cond.period = 'day';
        cond.min = 0;
        cond.max = 0;
        cond.unit = '';
    }
    return cond;
}

/** 按类型生成 OKR 清单行的默认内容（里程碑1 / 成果1） */
function makeConditionItem(type: OkrConditionType, index: number): OkrConditionItem {
    return {
        id: makeConditionItemId(),
        text: `${t(OKR_CONDITION_META[type].labelKey as Parameters<typeof t>[0])}${index}`,
        done: false,
    };
}

/** 截止日期（YYYY-MM-DD）距今天的天数：正数表示未来，负数表示已过期 */
function daysUntil(dueDate: string): number {
    const [y, m, d] = dueDate.split('-').map(Number);
    const due = new Date(y, (m ?? 1) - 1, d ?? 1);
    const today = new Date();
    due.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    return Math.round((due.getTime() - today.getTime()) / 86400000);
}

/** 生成记录卡片（自定义表单设计，默认带一行字段） */
function makeRecordCard(): OkrRecordCard {
    return {
        id: `okr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        fields: [{ id: `okr_item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, type: 'text', name: '' }],
    };
}

/** 生成记录卡字段 id */
function makeRecordFieldId(): string {
    return `okr_item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

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
    /** 记录数据仓库（记录卡填写结果读写入口） */
    private recordRepo: RecordRepo;
    /** 执行记录访问器（用于统计当前任务的执行时长） */
    private getExecutions: () => ExecutionRecord[];
    /** 右侧垂直选项卡当前选中项（刷新后保持不变） */
    private rightTab: 'current' | 'overview' | 'basket' | 'execution' | 'okr' = 'current';
    /** 处于编辑模式的记录卡片对应的卡片 id（本次会话内保留，可来回切换） */
    private recordEditIds = new Set<string>();
    /** 处于编辑模式的里程碑卡片对应的任务 id（本次会话内保留，可来回切换） */
    private milestoneEditIds = new Set<string>();

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: PlanCategoryData,
        save: () => Promise<void>,
        inboxRepo?: InboxRepo,
        getExecutions?: () => ExecutionRecord[],
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.save = save;
        this.inboxRepo = inboxRepo;
        this.recordRepo = new RecordRepo(app);
        this.getExecutions = getExecutions ?? (() => []);
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
                // 在「执行情况」选项卡下点击任务面板条目选中任务时，自动切换到「当前任务」选项卡
                if (
                    this.rightTab === 'execution'
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
        const tabs: { id: 'current' | 'overview' | 'basket' | 'execution' | 'okr'; labelKey: 'taskPlan.tabCurrentTask' | 'taskPlan.tabOverview' | 'taskPlan.tabBasket' | 'taskPlan.tabExecution' | 'taskPlan.tabOkr' }[] = [
            { id: 'overview', labelKey: 'taskPlan.tabOverview' },
            { id: 'current', labelKey: 'taskPlan.tabCurrentTask' },
            { id: 'basket', labelKey: 'taskPlan.tabBasket' },
            { id: 'execution', labelKey: 'taskPlan.tabExecution' },
            { id: 'okr', labelKey: 'taskPlan.tabOkr' },
        ];
        for (const tab of tabs) {
            const tabEl = tabStrip.createDiv({ cls: 'task-plan-right-tab' });
            // OKR 逐字母竖排（O / K / R 各占一行），不改变选项卡宽度
            if (tab.id === 'okr') {
                tabEl.addClass('is-stacked-chars');
                for (const ch of t(tab.labelKey)) tabEl.createSpan({ text: ch });
            } else {
                tabEl.setText(t(tab.labelKey));
            }
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
                await this.renderInfoForm(contentPanel);

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
            // 「任务关注」选项卡：添加关注任务 + 关注任务方框列表
            this.renderFocusTab(contentPanel);
        } else if (this.rightTab === 'basket') {
            // 「收集篮子」选项卡：左为任务名称 + 未处理数 + 收集篮子面板，右为板块信息
            this.renderBasketTab(contentPanel);
        } else if (this.rightTab === 'execution') {
            // 「执行情况」选项卡：展示所有任务条目及执行时长、OKR 进度、成果情况
            this.renderAllTasksOverview(contentPanel);
        } else if (this.rightTab === 'okr') {
            // 「OKR」选项卡：OKR 进度方框（拆解型 / 周期型条目卡片）
            this.renderOkrBox(contentPanel);
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
        // 文件面板：编辑态标题行提供配置按钮（目录 + 命名规则）
        if (section.type === 'file') {
            const cfgBtn = head.createEl('button', { cls: 'swimlane-section-card-settings' });
            setIcon(cfgBtn, 'settings');
            cfgBtn.setAttribute('aria-label', t('section.fileConfigTitle'));
            cfgBtn.setAttribute('title', t('section.fileConfigTitle'));
            cfgBtn.onclick = (ev) => {
                ev.stopPropagation();
                new FileSectionConfigModal(this.app, section.data as FileData, () => {
                    void this.save();
                    this.renderSectionCards(row);
                }).open();
            };
        }
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
                const nameInput = line.createEl('input', { type: 'text', cls: 'swimlane-section-card-edit-text' });
                pathInput.value = it.path;
                pathInput.placeholder = t('section.filePlaceholder');
                nameInput.value = it.text;
                nameInput.placeholder = t('section.fileNamePlaceholder');
                // 未自定义显示名时，用文件名（不带路径）作为显示名
                const syncName = (path: string) => {
                    if (!it.text) {
                        it.text = path.split('/').pop() ?? path;
                        nameInput.value = it.text;
                    }
                };
                pathInput.onchange = () => {
                    it.path = pathInput.value;
                    syncName(pathInput.value);
                };
                // 点击/输入时弹出 vault 文件下拉列表，按输入内容筛选
                new FilePathSuggest(this.app, pathInput, (path) => {
                    it.path = path;
                    syncName(path);
                });
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
            this.addSectionItem(section, row);
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

    /** 向板块添加一个空条目（文件板块已配置目录与命名规则时，自动创建文件并加入条目） */
    private addSectionItem(section: Section, row: HTMLElement): void {
        const id = `sec_item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        if (section.type === 'checklist') {
            (section.data as ChecklistData).items.push({ id, text: '', done: false });
        } else if (section.type === 'file') {
            const data = section.data as FileData;
            const folder = normalizeFolder(data.folder ?? '');
            const fileName = buildFileName(data.namePattern ?? '');
            // 未配置目录或命名规则：退回手动填写路径
            if (!folder || !fileName) {
                data.items.push({ id, text: '', path: '' });
            } else {
                void this.createFileItem(data, id, folder, fileName, row);
                return;
            }
        }
        this.renderSectionCards(row);
    }

    /** 在配置目录下创建文件并写入条目，成功后刷新板块卡片 */
    private async createFileItem(
        data: FileData,
        id: string,
        folder: string,
        fileName: string,
        row: HTMLElement,
    ): Promise<void> {
        let path = `${folder}/${fileName}`;
        const exists = (p: string) => this.app.vault.getAbstractFileByPath(p) !== null;
        // 同名文件已存在时追加序号，避免覆盖已有笔记
        if (exists(path)) {
            const base = fileName.replace(/\.md$/i, '');
            let index = 2;
            while (exists(`${folder}/${base}-${index}.md`)) index += 1;
            path = `${folder}/${base}-${index}.md`;
        }
        try {
            await this.ensureFolder(folder);
            await this.app.vault.create(path, '');
        } catch (err) {
            console.error(err);
            new Notice(t('section.fileCreateFailed', { path }));
            // 创建失败时退回手动填写路径，保证新增行不丢失
            data.items.push({ id, text: '', path: '' });
            this.renderSectionCards(row);
            return;
        }
        data.items.push({ id, text: path.split('/').pop() ?? path, path });
        await this.save();
        this.renderSectionCards(row);
    }

    /** 按层级创建目录（目录已存在时跳过） */
    private async ensureFolder(folder: string): Promise<void> {
        let current = '';
        for (const part of folder.split('/').filter(Boolean)) {
            current = current ? `${current}/${part}` : part;
            if (!this.app.vault.getAbstractFileByPath(current)) {
                await this.app.vault.createFolder(current);
            }
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

    /** OKR 进度：标题栏（含「+」下拉）+ 条目卡片列表（不再使用外框） */
    private renderOkrBox(panel: HTMLElement): void {
        panel.empty();
        const area = panel.createDiv({ cls: 'okr-area' });
        const header = area.createDiv({ cls: 'swimlane-section-area-header' });
        header.createDiv({ cls: 'swimlane-section-area-title', text: t('okr.progressTitle') });
        this.renderOkrAddButton(header);

        const body = area.createDiv({ cls: 'okr-entry-list' });
        const item = this.getSelectedItem();
        if (!item) {
            body.createDiv({ cls: 'swimlane-sections-empty', text: t('okr.noSelection') });
            return;
        }

        const conditions = item.okr?.conditions ?? [];
        if (conditions.length === 0) {
            body.createDiv({ cls: 'swimlane-sections-empty', text: t('okr.emptyList') });
            return;
        }

        // 里程碑：合并渲染为一个「里程碑」列表卡片（标题 + 行末「+」+ 多个条目）
        let milestoneRendered = false;
        for (const cond of conditions) {
            if (cond.type === 'milestone') {
                if (!milestoneRendered) {
                    milestoneRendered = true;
                    this.renderMilestoneList(body, item, conditions.filter(c => c.type === 'milestone'));
                }
                continue;
            }
            this.renderEntryCard(body, item, cond);
        }
    }

    /** OKR 标题栏右上角「+」按钮：点击展开下拉面板（按大类分组列出条目类型） */
    private renderOkrAddButton(header: HTMLElement): void {
        const wrap = header.createDiv({ cls: 'swimlane-section-add-wrap' });
        const btn = wrap.createEl('button', { cls: 'swimlane-section-add-btn', text: '+' });
        const panel = wrap.createDiv({ cls: 'swimlane-section-add-panel okr-add-panel' });

        for (const group of Object.values(OKR_GROUP_META)) {
            panel.createDiv({
                cls: 'okr-add-group-title',
                text: t(group.labelKey as Parameters<typeof t>[0]),
            });
            for (const type of group.types) {
                const opt = panel.createDiv({
                    cls: 'swimlane-section-add-option',
                    text: t(OKR_CONDITION_META[type].labelKey as Parameters<typeof t>[0]),
                });
                opt.onclick = (e) => {
                    e.stopPropagation();
                    panel.removeClass('is-open');
                    void this.addEntry(type);
                };
            }
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

    /** 新增一条 OKR 条目并刷新 */
    private async addEntry(type: OkrConditionType): Promise<void> {
        const item = this.getSelectedItem();
        if (!item) {
            new Notice(t('okr.noSelection'));
            return;
        }
        if (!item.okr) item.okr = { conditions: [] };
        const sameTypeCount = item.okr.conditions.filter(c => c.type === type).length;
        item.okr.conditions.push(makeCondition(type, sameTypeCount + 1));
        await this.save();
        await this.refresh();
    }

    /** 删除一条 OKR 条目并刷新 */
    private async deleteEntry(item: InboxItem, condId: string): Promise<void> {
        if (!item.okr) return;
        item.okr.conditions = item.okr.conditions.filter(c => c.id !== condId);
        await this.save();
        await this.refresh();
    }

    /** 渲染单条 OKR 条目卡片 */
    private renderEntryCard(container: HTMLElement, item: InboxItem, cond: OkrCondition): void {
        const card = container.createDiv({ cls: `okr-entry-card okr-entry-${cond.type}` });

        // 卡片头部：类型标签 + 名称输入 + 删除按钮
        const head = card.createDiv({ cls: 'okr-entry-head' });
        head.createSpan({
            cls: 'okr-entry-type',
            text: t(OKR_CONDITION_META[cond.type].labelKey as Parameters<typeof t>[0]),
        });
        const titleInput = head.createEl('input', {
            type: 'text',
            cls: 'okr-entry-title',
            attr: { placeholder: t('okr.entryTitlePlaceholder') },
        });
        titleInput.value = cond.title ?? '';
        titleInput.onchange = () => {
            cond.title = titleInput.value.trim();
            void this.save();
        };
        const delBtn = head.createEl('button', { cls: 'okr-entry-del', text: '✕' });
        delBtn.onclick = (e) => {
            e.stopPropagation();
            void this.deleteEntry(item, cond.id);
        };

        // 卡片主体：按类型渲染
        const body = card.createDiv({ cls: 'okr-entry-body' });
        if (cond.type === 'outcome') {
            this.renderChecklistBody(body, cond);
        } else if (cond.type === 'cumulative') {
            this.renderCumulativeBody(body, cond);
        } else if (cond.type === 'frequency') {
            this.renderFrequencyBody(body, cond);
        } else {
            this.renderRangeBody(body, cond);
        }

        // 维度信息：期望时间点 + 绑定子任务
        this.renderDimensions(card, item, cond);
    }

    /**
     * 里程碑列表卡片：卡片即一个里程碑列表，分「正常模式」与「编辑模式」。
     * - 正常模式（默认）：每个条目是一个方块信息（奖杯图标 / 名称 / x 天后（具体日期） / 关联任务），
     *   固定宽度、从左到右排列并自动换行；卡片右上角为编辑图标。
     * - 编辑模式：沿用原有显示方式（右上角「+」号 + 下方逐条可编辑的条目）。
     * 右上角编辑图标可来回切换两种模式，状态在本次会话内保留。
     */
    private renderMilestoneList(container: HTMLElement, item: InboxItem, conds: OkrCondition[]): void {
        const card = container.createDiv({ cls: 'okr-entry-card okr-entry-milestone' });
        const editing = this.milestoneEditIds.has(item.id);

        // 标题行：标题 + 右侧按钮（编辑模式：「+」在编辑图标左侧；「+」的自动外边距由编辑图标承担）
        const head = card.createDiv({ cls: 'okr-entry-head' });
        head.createSpan({ cls: 'okr-entry-type', text: t('okr.typeMilestone') });

        if (editing) {
            const addBtn = head.createEl('button', { cls: 'okr-milestone-add-btn', text: '+' });
            addBtn.onclick = (e) => {
                e.stopPropagation();
                void this.addEntry('milestone');
            };
        }

        const editBtn = head.createEl('button', {
            cls: `okr-milestone-edit-btn${editing ? ' is-active' : ''}`,
            attr: { title: t('okr.toggleMilestoneEdit') },
        });
        setIcon(editBtn, 'pencil');
        editBtn.onclick = (e) => {
            e.stopPropagation();
            if (editing) this.milestoneEditIds.delete(item.id);
            else this.milestoneEditIds.add(item.id);
            this.refresh();
        };

        if (editing) {
            // 条目列表（逐条可编辑）
            const list = card.createDiv({ cls: 'okr-milestone-list' });
            for (const cond of conds) {
                this.renderMilestoneItem(list, item, cond);
            }
            return;
        }

        // 正常模式：方块信息横向排列、自动换行
        const grid = card.createDiv({ cls: 'okr-milestone-grid' });
        for (const cond of conds) {
            this.renderMilestoneTile(grid, item, cond);
        }
    }

    /**
     * 里程碑条目（正常模式）：方块信息，内容从上到下依次为
     * 奖杯图标 / 名称 / x 天后（具体日期） / 关联任务（只读标签）。
     */
    private renderMilestoneTile(container: HTMLElement, item: InboxItem, cond: OkrCondition): HTMLElement {
        const tile = container.createDiv({ cls: 'okr-milestone-tile' });

        tile.createDiv({ cls: 'okr-milestone-tile-icon', text: '🏆' });

        tile.createDiv({ cls: 'okr-milestone-tile-name', text: cond.title ?? '' });

        if (cond.dueDate) {
            const diffDays = daysUntil(cond.dueDate);
            tile.createDiv({
                cls: 'okr-milestone-tile-deadline',
                text: diffDays >= 0
                    ? t('okr.deadlineDaysWithDate', { days: diffDays, date: cond.dueDate })
                    : t('okr.deadlineOverdueWithDate', { days: Math.abs(diffDays), date: cond.dueDate }),
            });
        } else {
            tile.createDiv({ cls: 'okr-milestone-tile-deadline', text: t('okr.deadlineUnset') });
        }

        // 关联任务：只读标签（增删需进入编辑模式）
        const children = this.inboxData.items.filter(i => i.parentId === item.id && !i.removed);
        const linkedIds = cond.subtaskIds ?? [];
        const linked = linkedIds
            .map(id => children.find(c => c.id === id))
            .filter((c): c is InboxItem => !!c);
        if (linked.length > 0) {
            const tasks = tile.createDiv({ cls: 'okr-milestone-tile-tasks' });
            for (const child of linked) {
                const chip = tasks.createSpan({ cls: 'okr-milestone-linked-task' });
                // 标签前显示该任务当前状态图标（与左侧任务面板的图标规则一致）
                const isHabit = child.taskType === 'habit' || child.habitTimeEnabled === true;
                const status = child.status ?? 'notStarted';
                const statusMeta: Record<string, { icon: string }> = {
                    notStarted: { icon: 'circle-dot-dashed' },
                    inProgress: { icon: 'zap' },
                    done: { icon: 'check' },
                    paused: { icon: 'circle-pause' },
                };
                const meta = isHabit ? { icon: 'rotate-cw-square' } : (statusMeta[status] ?? statusMeta.notStarted);
                const statusEl = chip.createSpan({ cls: `inbox-item-status is-${isHabit ? 'habit' : status}` });
                const iconEl = statusEl.createSpan({ cls: 'inbox-item-status-icon' });
                setIcon(iconEl, meta.icon);

                chip.createSpan({ text: child.title });
            }
        }
        return tile;
    }

    /**
     * 里程碑条目：奖杯位于条目最前、纵向占两行高度；
     * 其右侧为纵向两行——第一行「条目名称 + 删除」；第二行「截止时间 + 关联任务」。
     * 「关联任务」按钮点击弹出公共的任务搜索弹窗，输入关键词查找并选择子任务。
     */
    private renderMilestoneItem(container: HTMLElement, item: InboxItem, cond: OkrCondition): void {
        const entry = container.createDiv({ cls: 'okr-milestone-item' });

        // 奖杯置于条目最前，占两行高度
        const body = entry.createDiv({ cls: 'okr-milestone-body' });
        const icon = body.createSpan({ cls: 'okr-milestone-icon' });
        setIcon(icon, 'trophy');

        // 奖杯右侧的两行内容
        const content = body.createDiv({ cls: 'okr-milestone-content' });

        // 第一行：条目名称 + 删除
        const head = content.createDiv({ cls: 'okr-entry-head' });

        const titleInput = head.createEl('input', {
            type: 'text',
            cls: 'okr-entry-title',
            attr: { placeholder: t('okr.entryTitlePlaceholder') },
        });
        titleInput.value = cond.title ?? '';
        titleInput.onchange = () => {
            cond.title = titleInput.value.trim();
            void this.save();
        };

        const delBtn = head.createEl('button', { cls: 'okr-entry-del', text: '✕' });
        delBtn.onclick = (e) => {
            e.stopPropagation();
            void this.deleteEntry(item, cond.id);
        };

        // 第二行：截止时间 + 关联任务（与第一行之间不设分割线）
        const row = content.createDiv({ cls: 'okr-entry-row' });

        // 截止时间文案：已设置时显示为「截止时间：x 天后」（已过期显示为已逾期 x 天）
        const formatDeadline = (dueDate?: string): string => {
            if (!dueDate) return t('okr.deadline');
            const diffDays = daysUntil(dueDate);
            return diffDays >= 0
                ? t('okr.deadlineDays', { days: diffDays })
                : t('okr.deadlineOverdue', { days: Math.abs(diffDays) });
        };

        const dateLabel = row.createSpan({ cls: 'okr-entry-dim-label', text: formatDeadline(cond.dueDate) });
        const date = row.createEl('input', { type: 'date', cls: 'okr-entry-date' });
        date.value = cond.dueDate ?? '';
        date.onchange = () => {
            cond.dueDate = date.value || undefined;
            dateLabel.setText(formatDeadline(cond.dueDate));
            void this.save();
        };

        // 关联任务：可关联多个子任务，已关联的任务依次显示在「关联任务」按钮右侧
        const children = this.inboxData.items.filter(i => i.parentId === item.id && !i.removed);
        const linkedIds = cond.subtaskIds ?? [];

        const linkBtn = row.createEl('button', {
            cls: 'okr-milestone-link-btn',
            text: t('okr.linkTask'),
        });
        linkBtn.onclick = (e) => {
            e.stopPropagation();
            new TaskSearchModal(
                this.app,
                children.map(c => ({ id: c.id, title: c.title })),
                {
                    title: t('okr.linkTask'),
                    placeholder: t('okr.linkTaskSearchPlaceholder'),
                    empty: t('okr.linkTaskSearchEmpty'),
                },
                (id) => {
                    if (!cond.subtaskIds) cond.subtaskIds = [...linkedIds];
                    if (!cond.subtaskIds.includes(id)) cond.subtaskIds.push(id);
                    void this.save().then(() => this.refresh());
                },
            ).open();
        };

        // 已关联的任务（显示在「关联任务」按钮之后；标签末尾「✕」可取消该关联）
        for (const linkedId of linkedIds) {
            const child = children.find(c => c.id === linkedId);
            if (!child) continue;
            const chip = row.createSpan({ cls: 'okr-milestone-linked-task' });
            chip.createSpan({ text: child.title });
            const removeBtn = chip.createSpan({ cls: 'okr-milestone-linked-task-del', text: '✕' });
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                const rest = linkedIds.filter(id => id !== linkedId);
                cond.subtaskIds = rest.length > 0 ? rest : undefined;
                void this.save().then(() => this.refresh());
            };
        }
    }

    /**
     * 里程碑 / 成果：卡片表示一整个清单，可添加多行（里程碑1、里程碑2…）。
     * 每行可勾选完成、编辑文本、删除；卡片底部显示完成进度。
     */
    private renderChecklistBody(body: HTMLElement, cond: OkrCondition): void {
        if (!cond.items) cond.items = [];
        const items = cond.items;

        const list = body.createDiv({ cls: 'okr-entry-checklist' });
        if (items.length === 0) {
            list.createDiv({ cls: 'okr-entry-checklist-empty', text: t('okr.checklistEmpty') });
        }
        for (const row of items) {
            const rowEl = list.createDiv({ cls: 'okr-entry-checklist-row' });

            const cb = rowEl.createEl('input', { type: 'checkbox', cls: 'okr-progress-checkbox' });
            cb.checked = row.done;
            cb.onchange = () => {
                row.done = cb.checked;
                void this.save();
                void this.refresh();
            };

            const input = rowEl.createEl('input', {
                type: 'text',
                cls: 'okr-entry-text',
                attr: { placeholder: t('okr.checklistItemPlaceholder') },
            });
            input.value = row.text;
            input.onchange = () => {
                row.text = input.value.trim();
                void this.save();
            };

            const delBtn = rowEl.createEl('button', { cls: 'okr-entry-del', text: '✕' });
            delBtn.onclick = (e) => {
                e.stopPropagation();
                cond.items = (cond.items ?? []).filter(it => it.id !== row.id);
                void this.save();
                void this.refresh();
            };
        }

        // 底部：完成进度 + 添加一行
        const foot = body.createDiv({ cls: 'okr-entry-row' });
        const doneCount = items.filter(it => it.done).length;
        foot.createSpan({
            cls: 'okr-progress-value',
            text: t('okr.checklistProgress', { done: String(doneCount), total: String(items.length) }),
        });
        const addBtn = foot.createEl('button', { cls: 'okr-record-btn', text: t('okr.checklistAdd') });
        addBtn.onclick = (e) => {
            e.stopPropagation();
            if (!cond.items) cond.items = [];
            cond.items.push(makeConditionItem(cond.type, cond.items.length + 1));
            void this.save();
            void this.refresh();
        };
    }

    /** 累积：目标值 + 单位 + 进度条 */
    private renderCumulativeBody(body: HTMLElement, cond: OkrCondition): void {
        const row = body.createDiv({ cls: 'okr-entry-row' });
        row.createSpan({ cls: 'okr-entry-label', text: t('okr.progressTarget') });

        const target = row.createEl('input', {
            type: 'number',
            cls: 'okr-entry-number',
            attr: { placeholder: t('okr.targetPlaceholder') },
        });
        target.value = String(cond.target || 0);
        target.onchange = () => {
            const v = Number(target.value);
            cond.target = Number.isFinite(v) ? v : 0;
            void this.save();
            void this.refresh();
        };

        const unit = row.createEl('input', {
            type: 'text',
            cls: 'okr-entry-unit-input',
            attr: { placeholder: t('okr.unitPlaceholder') },
        });
        unit.value = cond.unit ?? '';
        unit.onchange = () => {
            cond.unit = unit.value.trim();
            void this.save();
        };

        // 进度条（当前值暂为 0，后续可由执行记录推算）
        const barRow = body.createDiv({ cls: 'okr-entry-row' });
        const bar = barRow.createDiv({ cls: 'okr-progress-bar' });
        bar.createDiv({ cls: 'okr-progress-fill' }).setCssProps({ width: '0%' });
        barRow.createSpan({
            cls: 'okr-progress-value',
            text: `0 / ${cond.target || 0} ${cond.unit ?? ''}`.trim(),
        });
    }

    /** 频次：周期 + 目标次数 + 本周期打卡 */
    private renderFrequencyBody(body: HTMLElement, cond: OkrCondition): void {
        this.renderPeriodRow(body, cond);

        const row = body.createDiv({ cls: 'okr-entry-row' });
        row.createSpan({ cls: 'okr-entry-label', text: t('okr.progressTarget') });
        const target = row.createEl('input', {
            type: 'number',
            cls: 'okr-entry-number',
            attr: { placeholder: t('okr.targetPlaceholder') },
        });
        target.value = String(cond.target || 0);
        target.onchange = () => {
            const v = Number(target.value);
            cond.target = Number.isFinite(v) ? v : 0;
            void this.save();
            void this.refresh();
        };
        row.createSpan({ cls: 'okr-entry-unit', text: t('okr.unitTimes') });

        this.renderRecordRow(body, cond);
    }

    /** 区间：周期 + 下限 / 上限 + 单位 + 本周期打卡 */
    private renderRangeBody(body: HTMLElement, cond: OkrCondition): void {
        this.renderPeriodRow(body, cond);

        const row = body.createDiv({ cls: 'okr-entry-row' });
        row.createSpan({ cls: 'okr-entry-label', text: t('okr.progressTarget') });

        const min = row.createEl('input', {
            type: 'number',
            cls: 'okr-entry-number',
            attr: { placeholder: t('okr.minPlaceholder') },
        });
        min.value = String(cond.min ?? 0);
        min.onchange = () => {
            const v = Number(min.value);
            cond.min = Number.isFinite(v) ? v : 0;
            void this.save();
            void this.refresh();
        };

        row.createSpan({ cls: 'okr-entry-unit', text: '–' });

        const max = row.createEl('input', {
            type: 'number',
            cls: 'okr-entry-number',
            attr: { placeholder: t('okr.maxPlaceholder') },
        });
        max.value = String(cond.max ?? 0);
        max.onchange = () => {
            const v = Number(max.value);
            cond.max = Number.isFinite(v) ? v : 0;
            void this.save();
            void this.refresh();
        };

        const unit = row.createEl('input', {
            type: 'text',
            cls: 'okr-entry-unit-input',
            attr: { placeholder: t('okr.unitPlaceholder') },
        });
        unit.value = cond.unit ?? '';
        unit.onchange = () => {
            cond.unit = unit.value.trim();
            void this.save();
        };

        this.renderRecordRow(body, cond);
    }

    /** 周期选择行（周期型条目共用） */
    private renderPeriodRow(body: HTMLElement, cond: OkrCondition): void {
        const row = body.createDiv({ cls: 'okr-entry-row' });
        row.createSpan({ cls: 'okr-entry-label', text: t('okr.recordCurrent') });
        const sel = row.createEl('select', { cls: 'okr-entry-select' });
        for (const period of Object.keys(OKR_PERIOD_META) as OkrPeriod[]) {
            const opt = sel.createEl('option', {
                text: t(OKR_PERIOD_META[period].labelKey as Parameters<typeof t>[0]),
                value: period,
            });
            if ((cond.period ?? 'week') === period) opt.selected = true;
        }
        sel.onchange = () => {
            cond.period = sel.value as OkrPeriod;
            void this.save();
            void this.refresh();
        };
    }

    /** 本周期打卡行：显示当前周期记录 + 打卡按钮 */
    private renderRecordRow(body: HTMLElement, cond: OkrCondition): void {
        const period = cond.period ?? 'week';
        const periodKey = makePeriodKey(period);
        const records = cond.records ?? [];
        const current = records.find(r => r.periodKey === periodKey);

        const row = body.createDiv({ cls: 'okr-entry-row' });
        row.createSpan({ cls: 'okr-entry-label', text: t('okr.recordCurrent') });

        // 当前周期记录值
        if (cond.type === 'frequency') {
            const value = current?.value ?? 0;
            const target = cond.target || 0;
            row.createSpan({
                cls: 'okr-progress-value',
                text: t('okr.recordCount', {
                    value: String(value),
                    target: String(target),
                    unit: t('okr.unitTimes'),
                }),
            });
            row.createSpan({
                cls: `okr-record-state ${value >= target && target > 0 ? 'is-hit' : 'is-miss'}`,
                text: value >= target && target > 0 ? t('okr.recordHit') : t('okr.recordMiss'),
            });
        } else {
            const min = cond.min ?? 0;
            const max = cond.max ?? 0;
            const unit = cond.unit ?? '';
            if (current) {
                const hit = current.value >= min && current.value <= max;
                row.createSpan({
                    cls: 'okr-progress-value',
                    text: t('okr.recordRange', { value: String(current.value), min: String(min), max: String(max), unit }),
                });
                row.createSpan({
                    cls: `okr-record-state ${hit ? 'is-hit' : 'is-miss'}`,
                    text: hit ? t('okr.recordHit') : t('okr.recordMiss'),
                });
            } else {
                row.createSpan({
                    cls: 'okr-progress-value',
                    text: t('okr.recordRangeEmpty', { min: String(min), max: String(max), unit }),
                });
            }
        }

        // 打卡输入 + 按钮
        const input = row.createEl('input', {
            type: 'number',
            cls: 'okr-entry-number',
            attr: { placeholder: t('okr.recordValuePlaceholder') },
        });
        if (current) input.value = String(current.value);
        const btn = row.createEl('button', { cls: 'okr-record-btn', text: t('okr.recordAdd') });
        btn.onclick = (e) => {
            e.stopPropagation();
            const v = Number(input.value);
            if (!Number.isFinite(v)) return;
            if (!cond.records) cond.records = [];
            const existing = cond.records.find(r => r.periodKey === periodKey);
            if (existing) {
                existing.value = v;
            } else {
                cond.records.push({ periodKey, value: v });
            }
            void this.save();
            void this.refresh();
        };
    }

    /** 维度信息：期望时间点 + 绑定子任务 */
    private renderDimensions(card: HTMLElement, item: InboxItem, cond: OkrCondition): void {
        const row = card.createDiv({ cls: 'okr-entry-dimensions' });

        // 期望时间点
        row.createSpan({ cls: 'okr-entry-dim-label', text: t('okr.dueDate') });
        const date = row.createEl('input', { type: 'date', cls: 'okr-entry-date' });
        date.value = cond.dueDate ?? '';
        date.onchange = () => {
            cond.dueDate = date.value || undefined;
            void this.save();
        };

        // 绑定子任务：可关联多个子任务（当前任务的直接子任务）
        row.createSpan({ cls: 'okr-entry-dim-label', text: t('okr.subtask') });
        const linkedIds = cond.subtaskIds ?? [];
        const children = this.inboxData.items.filter(i => i.parentId === item.id && !i.removed);

        const linkBtn = row.createEl('button', { cls: 'okr-milestone-link-btn', text: t('okr.linkTask') });
        linkBtn.onclick = (e) => {
            e.stopPropagation();
            new TaskSearchModal(
                this.app,
                children.map(c => ({ id: c.id, title: c.title })),
                {
                    title: t('okr.linkTask'),
                    placeholder: t('okr.linkTaskSearchPlaceholder'),
                    empty: t('okr.linkTaskSearchEmpty'),
                },
                (id) => {
                    if (!cond.subtaskIds) cond.subtaskIds = [...linkedIds];
                    if (!cond.subtaskIds.includes(id)) cond.subtaskIds.push(id);
                    void this.save().then(() => this.refresh());
                },
            ).open();
        };

        // 已关联子任务标签（标签末尾「✕」可取消关联）
        for (const linkedId of linkedIds) {
            const child = children.find(c => c.id === linkedId);
            if (!child) continue;
            const chip = row.createSpan({ cls: 'okr-milestone-linked-task' });
            chip.createSpan({ text: child.title });
            const removeBtn = chip.createSpan({ cls: 'okr-milestone-linked-task-del', text: '✕' });
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                const rest = linkedIds.filter(id => id !== linkedId);
                cond.subtaskIds = rest.length > 0 ? rest : undefined;
                void this.save().then(() => this.refresh());
            };
        }
    }

    /**
     * 未选中任务时：在右侧内容区展示所有任务条目及其 OKR 进度、成果情况
     */
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

        // 按任务聚合执行时长（分钟），用于每行的执行时长卡片
        const minutesByTask = new Map<string, number>();
        for (const ex of this.getExecutions()) {
            if (!ex.inboxId) continue;
            const minutes = executionDuration(ex);
            minutesByTask.set(ex.inboxId, (minutesByTask.get(ex.inboxId) ?? 0) + minutes);
        }

        // 任务自身 + 所有子孙的执行时长
        const childrenByParent = new Map<string, InboxItem[]>();
        for (const it of this.inboxData.items) {
            if (it.removed || !it.parentId) continue;
            const arr = childrenByParent.get(it.parentId) ?? [];
            arr.push(it);
            childrenByParent.set(it.parentId, arr);
        }
        const subtreeMinutes = (taskId: string): number => {
            let total = minutesByTask.get(taskId) ?? 0;
            for (const child of childrenByParent.get(taskId) ?? []) {
                total += subtreeMinutes(child.id);
            }
            return total;
        };

        const list = area.createDiv({ cls: 'task-plan-overview-list' });
        for (const { item, depth } of ordered) {
            // 每行：任务条目卡片 + 总执行时长卡片（两者样式一致，横向排列）
            const rowWrap = list.createDiv({ cls: 'task-plan-overview-row-wrap' });

            const row = rowWrap.createDiv({ cls: 'task-plan-overview-row' });
            row.style.setProperty('--overview-depth', String(depth));

            // 任务条目（标题）
            const titleRow = row.createDiv({ cls: 'task-plan-overview-item' });
            titleRow.createSpan({ cls: 'task-plan-overview-item-title', text: item.title });

            // OKR 进度 / 成果情况
            const conditions = item.okr?.conditions ?? [];
            const detail = row.createDiv({ cls: 'task-plan-overview-detail' });

            if (conditions.length === 0) {
                detail.createDiv({ cls: 'task-plan-overview-empty', text: t('taskPlan.overviewNoOkr') });
            } else {
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

            // 执行时长卡片（样式与任务条目卡片一致）：总执行时长（含子任务）、任务执行时长（自身）各为独立卡片
            const formatDuration = (minutes: number): string => {
                const total = Math.max(0, Math.round(minutes));
                return t('taskPlan.durationHourMinute', { hours: Math.floor(total / 60), minutes: total % 60 });
            };

            const totalCard = rowWrap.createDiv({ cls: 'task-plan-overview-row task-plan-overview-duration' });
            totalCard.createDiv({ cls: 'task-plan-overview-item-title', text: t('taskPlan.statsTotalDuration') });
            totalCard.createDiv({ cls: 'task-plan-overview-value', text: formatDuration(subtreeMinutes(item.id)) });

            const selfCard = rowWrap.createDiv({ cls: 'task-plan-overview-row task-plan-overview-duration' });
            selfCard.createDiv({ cls: 'task-plan-overview-item-title', text: t('taskPlan.statsSelfDuration') });
            selfCard.createDiv({ cls: 'task-plan-overview-value', text: formatDuration(minutesByTask.get(item.id) ?? 0) });
        }
    }

    /**
     * 「任务关注」选项卡：右上角「添加任务关注」按钮 + 关注任务方框列表。
     * 点击添加按钮时需先在左侧选中任务，选中的任务会生成一个关注方框，
     * 用于查看该任务的里程碑目标与直接子任务的进度、活跃程度。
     */
    private renderFocusTab(container: HTMLElement): void {
        const area = container.createDiv({ cls: 'task-plan-focus' });

        const header = area.createDiv({ cls: 'task-plan-focus-header' });
        const addBtn = header.createEl('button', { cls: 'task-plan-focus-add-btn', text: t('taskPlan.addFocus') });
        addBtn.addEventListener('click', () => { void this.addFocusTask(); });

        const list = area.createDiv({ cls: 'task-plan-focus-list' });
        const focusIds = this.inboxData.focusTaskIds ?? [];
        if (focusIds.length === 0) {
            list.createDiv({ cls: 'task-plan-focus-empty', text: t('taskPlan.focusEmpty') });
            return;
        }
        for (const id of focusIds) {
            const item = this.inboxData.items.find(i => i.id === id && !i.removed);
            if (!item) continue;
            this.renderFocusBox(list, item);
        }
    }

    /** 将当前选中任务加入关注列表 */
    private async addFocusTask(): Promise<void> {
        const item = this.inboxData.items.find(i => i.id === this.inboxData.selectedId && !i.removed);
        if (!item) {
            new Notice(t('taskPlan.noSelection'));
            return;
        }
        const focusIds = this.inboxData.focusTaskIds ?? [];
        if (focusIds.includes(item.id)) {
            new Notice(t('taskPlan.focusAlready'));
            return;
        }
        this.inboxData.focusTaskIds = [...focusIds, item.id];
        await this.save();
        await this.refresh();
    }

    /** 从关注列表移除任务 */
    private async removeFocusTask(id: string): Promise<void> {
        this.inboxData.focusTaskIds = (this.inboxData.focusTaskIds ?? []).filter(x => x !== id);
        await this.save();
        await this.refresh();
    }

    /** 渲染单个关注任务方框：标题 + 里程碑目标 + 最近执行时间 + 直接子任务进度列表 */
    private renderFocusBox(container: HTMLElement, item: InboxItem): void {
        const box = container.createDiv({ cls: 'task-plan-focus-box' });

        // 头部：任务名称 + 里程碑目标 + 最近执行时间（右上角取消关注按钮）
        const head = box.createDiv({ cls: 'task-plan-focus-head' });
        const headMain = head.createDiv({ cls: 'task-plan-focus-head-main' });
        headMain.createDiv({ cls: 'task-plan-focus-title', text: item.title });

        const latestDay = this.latestExecutionDayKeyForSubtree(item.id);
        headMain.createDiv({
            cls: 'task-plan-focus-latest',
            text: `${t('taskPlan.focusLatest')}：${latestDay ? this.relativeDayText(latestDay) : t('taskPlan.emptyValue')}`,
        });

        const removeBtn = head.createEl('button', { cls: 'task-plan-focus-remove-btn', text: '✕' });
        removeBtn.setAttribute('title', t('taskPlan.focusRemove'));
        removeBtn.addEventListener('click', () => { void this.removeFocusTask(item.id); });

        // 里程碑目标：复用 OKR 选项卡里程碑卡片的样式（卡片 + 类型标签 + 方块方格）
        const milestones = (item.okr?.conditions ?? []).filter(c => c.type === 'milestone');
        if (milestones.length > 0) {
            const msCard = box.createDiv({ cls: 'okr-entry-card okr-entry-milestone task-plan-focus-milestone-card' });
            const msHead = msCard.createDiv({ cls: 'okr-entry-head' });
            msHead.createSpan({ cls: 'okr-entry-type', text: t('okr.typeMilestone') });

            const msGrid = msCard.createDiv({ cls: 'okr-milestone-grid' });
            for (const cond of milestones) {
                // 复用 OKR 选项卡的里程碑方块渲染（奖杯 / 名称 / 截止日期 / 关联任务标签）
                this.renderMilestoneTile(msGrid, item, cond);
            }
        }

        // 子任务区：直接子任务，每行 = 名称 + 含后代总时长 + 最新进度
        const childrenByParent = new Map<string, InboxItem[]>();
        for (const it of this.inboxData.items) {
            if (it.removed || !it.parentId) continue;
            const arr = childrenByParent.get(it.parentId) ?? [];
            arr.push(it);
            childrenByParent.set(it.parentId, arr);
        }

        const minutesByTask = new Map<string, number>();
        for (const ex of this.getExecutions()) {
            if (!ex.inboxId) continue;
            minutesByTask.set(ex.inboxId, (minutesByTask.get(ex.inboxId) ?? 0) + executionDuration(ex));
        }
        const subtreeMinutes = (taskId: string): number => {
            let total = minutesByTask.get(taskId) ?? 0;
            for (const child of childrenByParent.get(taskId) ?? []) total += subtreeMinutes(child.id);
            return total;
        };
        const formatDuration = (minutes: number): string => {
            const total = Math.max(0, Math.round(minutes));
            const hours = Math.floor(total / 60);
            const mins = total % 60;
            return hours > 0
                ? t('taskPlan.durationHourMinute', { hours, minutes: mins })
                : t('taskPlan.durationMinute', { minutes: mins });
        };

        const subtasks = childrenByParent.get(item.id) ?? [];
        const body = box.createDiv({ cls: 'task-plan-focus-body' });
        body.createDiv({ cls: 'task-plan-focus-section-title', text: t('taskPlan.focusProgressTitle') });
        if (subtasks.length === 0) {
            body.createDiv({ cls: 'task-plan-focus-no-subtask', text: t('taskPlan.focusNoSubtask') });
        }
        for (const sub of subtasks) {
            const subStatus = sub.status ?? 'notStarted';
            // 已完成 / 无未完成后代时右侧为空，左侧保持一半宽度
            const target = subStatus === 'done'
                ? undefined
                : this.nearestIncompleteDescendant(sub.id, childrenByParent);
            const row = body.createDiv({ cls: `task-plan-focus-subtask${target ? '' : ' is-solo'}` });

            // 左侧：该子任务自身（名称 + 时长 + 状态）
            const left = row.createDiv({ cls: 'task-plan-focus-subtask-side is-left' });
            left.createDiv({ cls: 'task-plan-focus-subtask-name', text: sub.title });
            left.createDiv({ cls: 'task-plan-focus-subtask-duration', text: formatDuration(subtreeMinutes(sub.id)) });
            left.createDiv({ cls: `task-plan-focus-subtask-status is-${subStatus}`, text: this.taskStatusLabel(subStatus) });

            if (!target) continue;

            // 右侧：后代任务中遍历上最近的一条未完成任务
            const targetStatus = target.status ?? 'notStarted';
            const right = row.createDiv({ cls: 'task-plan-focus-subtask-side is-right' });
            right.createDiv({ cls: 'task-plan-focus-subtask-descendant-label', text: t('taskPlan.focusDescendantTask') });
            right.createDiv({ cls: 'task-plan-focus-subtask-name', text: target.title });
            right.createDiv({ cls: 'task-plan-focus-subtask-duration', text: formatDuration(subtreeMinutes(target.id)) });
            right.createDiv({ cls: `task-plan-focus-subtask-status is-${targetStatus}`, text: this.taskStatusLabel(targetStatus) });
        }

        // 项目活跃度：按周聚合该任务整棵子树的执行时长（最近 8 周）柱状图
        const activity = box.createDiv({ cls: 'task-plan-focus-activity' });
        activity.createDiv({ cls: 'task-plan-focus-section-title', text: t('taskPlan.focusActivityTitle') });
        const chartWrap = activity.createDiv({ cls: 'task-plan-focus-chart' });
        this.renderActivityChart(chartWrap, item.id);
    }

    /** 渲染项目活跃度柱状图：通过卡片机制按周聚合整棵子树的执行时长，动态周数填满关注方框宽度 */
    private renderActivityChart(container: HTMLElement, rootId: string): void {
        // 收集整棵子树的 id 集合
        const ids = new Set<string>([rootId]);
        const collect = (id: string) => {
            for (const it of this.inboxData.items) {
                if (!it.removed && it.parentId === id) {
                    ids.add(it.id);
                    collect(it.id);
                }
            }
        };
        collect(rootId);

        // 数据提供者：执行记录缩小到当前任务子树范围，其余数据源透传
        const provider = createDataProvider(
            () => [],
            () => this.getExecutions().filter(ex => ex.inboxId && ids.has(ex.inboxId)),
            () => this.inboxData.items,
            () => this.categoryData.categories,
        );

        // 按容器可用宽度动态计算周数（柱宽=间隔，每格约 32px），并据此渲染
        const render = (width: number) => {
            // 与 renderBarChart 的坐标轴边距保持一致：左侧刻度区 34、右侧 8
            const plotWidth = Math.max(32, width - 34 - 8);
            // 柱宽与间隔相等且均加倍，每格（柱+间隔）约 64px，保证 14px 周号标签不重叠
            const windowWeeks = Math.max(1, Math.min(104, Math.floor(plotWidth / 64) + 1));

            const template: CardTemplate = {
                id: 'focus-activity-chart',
                name: t('taskPlan.focusActivityTitle'),
                mode: 'chart',
                renderer: 'stats',
                source: {
                    dataSource: 'executions',
                    aggregation: 'by-week',
                    chart: 'bar',
                    params: {
                        metric: 'duration',
                        windowWeeks,
                        shortLabel: true,
                        showAxes: true,
                        yUnit: 'hours',
                        width,
                        stackedByTask: true,
                    },
                },
            };
            const instance: CardInstance = {
                id: `focus_activity_${rootId}`,
                templateId: 'focus-activity-chart',
                mode: 'chart',
            };

            renderCardContent(container, instance, template, {
                app: this.app,
                save: this.save,
                refresh: () => { void this.refresh(); },
                provider,
            });
        };

        // 容器刚创建时 clientWidth 为 0，等待一帧布局完成后再测量，失败则回退默认宽度
        if (container.clientWidth > 0) {
            render(container.clientWidth);
        } else {
            requestAnimationFrame(() => render(container.clientWidth || 360));
        }
    }

    /** 任务状态文案：已完成 / 进行中 / 暂停 / 未完成 */
    private taskStatusLabel(status: TaskStatus): string {
        if (status === 'done') return t('taskPlan.statusDone');
        if (status === 'inProgress') return t('taskPlan.statusInProgress');
        if (status === 'paused') return t('taskPlan.statusPaused');
        return t('taskPlan.focusStatusUndone');
    }

    /** 后代任务中遍历上（逐层）最近的一条未完成任务（用于右侧进度） */
    private nearestIncompleteDescendant(taskId: string, childrenByParent: Map<string, InboxItem[]>): InboxItem | undefined {
        const queue: InboxItem[] = [...(childrenByParent.get(taskId) ?? [])];
        let head = 0;
        while (head < queue.length) {
            const cur = queue[head++];
            if ((cur.status ?? 'notStarted') !== 'done') return cur;
            queue.push(...(childrenByParent.get(cur.id) ?? []));
        }
        return undefined;
    }

    /** 某任务整棵子树最近一次执行记录的日期键（用于「最近执行」） */
    private latestExecutionDayKeyForSubtree(rootId: string): string | undefined {
        const ids = new Set<string>([rootId]);
        const collect = (id: string) => {
            for (const it of this.inboxData.items) {
                if (!it.removed && it.parentId === id) {
                    ids.add(it.id);
                    collect(it.id);
                }
            }
        };
        collect(rootId);

        let latest: string | undefined;
        for (const ex of this.getExecutions()) {
            if (!ex.inboxId || !ids.has(ex.inboxId) || !ex.weekKey) continue;
            const dayKey = makeDayKeyFromWeek(ex.weekKey, ex.day);
            if (!latest || dayKey > latest) latest = dayKey;
        }
        return latest;
    }

    /** 日期键转为相对时间文案：今天 / 昨天 / X 天前 */
    private relativeDayText(dayKey: string): string {
        const [y, m, d] = dayKey.split('-').map(Number);
        const date = new Date(y, (m ?? 1) - 1, d ?? 1);
        const today = new Date();
        date.setHours(0, 0, 0, 0);
        today.setHours(0, 0, 0, 0);
        const diff = Math.round((today.getTime() - date.getTime()) / 86400000);
        if (diff <= 0) return t('today.todayBadge');
        if (diff === 1) return t('today.yesterdayBadge');
        return t('today.daysAgoBadge', { days: String(diff) });
    }

    /** 当前任务面板是否选中了有效任务 */
    private hasSelectedTask(): boolean {
        const selectedId = this.inboxData.selectedId;
        return !!selectedId && this.inboxData.items.some(i => i.id === selectedId && !i.removed);
    }

    /** 渲染右侧信息表单：项目描述、分类、截止日期（跟随当前选中任务） */
    private async renderInfoForm(container: HTMLElement): Promise<void> {
        const selectedId = this.inboxData.selectedId;
        const item = selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;

        if (!item) {
            // 未选中任务：「当前任务」选项卡下不展示内容（总览已归并至「执行情况」选项卡）
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
            const statuses: { value: TaskStatus; labelKey: 'taskPlan.statusNotStarted' | 'taskPlan.statusInProgress' | 'taskPlan.statusDone' | 'taskPlan.statusPaused' }[] = [
                { value: 'notStarted', labelKey: 'taskPlan.statusNotStarted' },
                { value: 'inProgress', labelKey: 'taskPlan.statusInProgress' },
                { value: 'paused', labelKey: 'taskPlan.statusPaused' },
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

        // 记录方框（任务详情方框下方）
        await this.renderRecordBox(container);
    }

    /** 记录卡片：独立方框，标题「记录」+ 右上角编辑按钮（切换字段编辑） */
    private async renderRecordBox(panel: HTMLElement): Promise<void> {
        const area = panel.createDiv({ cls: 'swimlane-section-area okr-record-area' });
        const header = area.createDiv({ cls: 'swimlane-section-area-header' });
        header.createDiv({ cls: 'swimlane-section-area-title', text: t('okr.recordCardTitle') });

        const editBtn = header.createEl('button', {
            cls: 'okr-record-edit-btn',
            attr: { title: t('okr.toggleRecordEdit') },
        });
        setIcon(editBtn, 'pencil');

        const body = area.createDiv({ cls: 'okr-entry-list' });
        const item = this.getSelectedItem();
        if (!item) {
            editBtn.disabled = true;
            body.createDiv({ cls: 'swimlane-sections-empty', text: t('okr.noSelection') });
            return;
        }

        // 记录方框即一张记录卡：无则自动初始化一张默认空卡片
        if (!item.records || item.records.length === 0) {
            item.records = [makeRecordCard()];
        }
        const recordCard = item.records[0];
        const editing = this.recordEditIds.has(recordCard.id);

        editBtn.toggleClass('is-active', editing);
        editBtn.onclick = (e) => {
            e.stopPropagation();
            if (editing) this.recordEditIds.delete(recordCard.id);
            else this.recordEditIds.add(recordCard.id);
            void this.refresh();
        };

        await this.renderRecordCard(body, recordCard, item);
    }

    /**
     * 记录卡片内容：正常模式以表格展示当前任务的填写记录（日期 + 各字段值）；
     * 编辑模式显示表单（字段类型 + 名称 + 删除）。
     * 右上角编辑图标改由记录方框标题栏统一承载，此方法只渲染卡片主体，不再包裹卡片外框。
     */
    private async renderRecordCard(container: HTMLElement, recordCard: OkrRecordCard, item: InboxItem): Promise<void> {
        const editing = this.recordEditIds.has(recordCard.id);

        if (!editing) {
            // 正常模式：使用说明 + 记录总数
            container.createDiv({ cls: 'okr-record-hint', text: t('okr.recordCardHint') });
            const entries = await this.recordRepo.listByInbox(item.id);
            container.createDiv({ cls: 'okr-record-total', text: t('okr.recordTotal', { count: entries.length }) });
            return;
        }

        // 编辑模式：顶部「+」新增字段 + 表单设计，每行 = 字段类型 + 字段名称 + 删除
        const addBtn = container.createEl('button', { cls: 'okr-record-add-btn', text: '+' });
        addBtn.onclick = (e) => {
            e.stopPropagation();
            recordCard.fields.push({ id: makeRecordFieldId(), type: 'text', name: '' });
            void this.save().then(() => this.refresh());
        };

        const form = container.createDiv({ cls: 'okr-record-form' });
        for (const field of recordCard.fields) {
            const row = form.createDiv({ cls: 'okr-record-field-row' });

            const typeSelect = row.createEl('select', { cls: 'okr-record-field-type' });
            for (const fieldType of Object.keys(OKR_RECORD_FIELD_META) as OkrRecordFieldType[]) {
                const opt = typeSelect.createEl('option', {
                    text: t(OKR_RECORD_FIELD_META[fieldType].labelKey as Parameters<typeof t>[0]),
                    value: fieldType,
                });
                if (fieldType === field.type) opt.selected = true;
            }
            typeSelect.onchange = () => {
                field.type = typeSelect.value as OkrRecordFieldType;
                void this.save();
            };

            const nameInput = row.createEl('input', {
                type: 'text',
                cls: 'okr-record-field-name',
                attr: { placeholder: t('okr.recordFieldNamePlaceholder') },
            });
            nameInput.value = field.name;
            nameInput.onchange = () => {
                field.name = nameInput.value.trim();
                void this.save();
            };

            const delBtn = row.createEl('button', { cls: 'okr-entry-del', text: '✕' });
            delBtn.onclick = (e) => {
                e.stopPropagation();
                recordCard.fields = recordCard.fields.filter(f => f.id !== field.id);
                void this.save().then(() => this.refresh());
            };
        }
    }

    /** 当前选中任务（未选中或已移除时返回 undefined） */
    private getSelectedItem(): InboxItem | undefined {
        const selectedId = this.inboxData.selectedId;
        return selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;
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

// ===== 文件面板配置弹窗 =====
/** 文件面板配置：设置自动生成文件的目录与命名规则 */
class FileSectionConfigModal extends Modal {
    private folder: string;
    private pattern: string;

    constructor(
        app: App,
        private data: FileData,
        private onSave: () => void,
    ) {
        super(app);
        this.folder = data.folder ?? '';
        this.pattern = data.namePattern ?? '';
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('section.fileConfigTitle') });

        // 实时预览：目录 + 渲染后的文件名
        const preview = contentEl.createDiv({ cls: 'file-section-config-preview' });
        const updatePreview = () => {
            const folder = normalizeFolder(this.folder);
            const name = buildFileName(this.pattern);
            preview.setText(folder && name
                ? t('section.filePreview', { path: `${folder}/${name}` })
                : t('section.filePreviewEmpty'));
        };

        new Setting(contentEl)
            .setName(t('section.fileFolderLabel'))
            .setDesc(t('section.fileFolderDesc'))
            .addText(text => {
                text.setPlaceholder(t('section.fileFolderPlaceholder'))
                    .setValue(this.folder)
                    .onChange((value) => {
                        this.folder = value;
                        updatePreview();
                    });
                // 目录下拉建议
                new FolderPathSuggest(this.app, text.inputEl, (path) => {
                    this.folder = path;
                    updatePreview();
                });
                // 弹窗打开时避免自动聚焦到目录输入框，防止下拉框自动弹出
                window.setTimeout(() => text.inputEl.blur(), 0);
            });

        new Setting(contentEl)
            .setName(t('section.fileNameRuleLabel'))
            .setDesc(t('section.fileNameRuleDesc'))
            .addText(text => text
                .setPlaceholder(t('section.fileNameRulePlaceholder'))
                .setValue(this.pattern)
                .onChange((value) => {
                    this.pattern = value;
                    updatePreview();
                })
            );

        updatePreview();

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('common.confirm'))
                .setCta()
                .onClick(() => {
                    const folder = normalizeFolder(this.folder);
                    // 目录非空时必须为 vault 中已存在的目录，强制约束为目录
                    if (folder) {
                        const existing = this.app.vault.getAbstractFileByPath(folder);
                        if (!(existing instanceof TFolder)) {
                            new Notice(t('section.fileFolderInvalid'));
                            return;
                        }
                    }
                    this.data.folder = folder || undefined;
                    this.data.namePattern = this.pattern.trim() || undefined;
                    this.onSave();
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

/** vault 目录下拉建议 */
class FolderPathSuggest extends AbstractInputSuggest<TFolder> {
    constructor(
        app: App,
        private suggestInputEl: HTMLInputElement,
        private onPick: (path: string) => void,
    ) {
        super(app, suggestInputEl);
    }

    protected getSuggestions(query: string): TFolder[] {
        const lower = query.toLowerCase();
        return this.app.vault.getAllLoadedFiles()
            .filter((f): f is TFolder => f instanceof TFolder && f.path.toLowerCase().includes(lower))
            .slice(0, 50);
    }

    renderSuggestion(folder: TFolder, el: HTMLElement): void {
        el.setText(folder.path || '/');
    }

    selectSuggestion(folder: TFolder): void {
        this.suggestInputEl.value = folder.path;
        this.onPick(folder.path);
        this.close();
    }
}
