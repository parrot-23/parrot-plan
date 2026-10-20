// OKR 视图：左侧任务面板（与任务计划视图一致）+ 右侧 OKR 方框。
// 右侧按「拆解型 / 周期型」两类展示当前选中任务的 OKR 条目卡片。
import type { App } from 'obsidian';
import { Notice, setIcon } from 'obsidian';

import type { PlanCategoryData } from '../../shared/plan-category-manager';
import type { InboxData, InboxItem, OkrCondition, OkrConditionItem, OkrConditionType, OkrPeriod, OkrRecordCard, OkrRecordFieldType, ExecutionRecord } from '../../datatypes/domain';
import { OKR_CONDITION_META, OKR_GROUP_META, OKR_PERIOD_META, OKR_RECORD_FIELD_META } from '../../datatypes/domain';
import type { InboxRepo } from '../../repos/inbox-repo';
import { renderTaskPanel } from '../../shared/task-panel';
import { TaskSearchModal } from '../../shared/task-search-modal';
import { makePeriodKey } from '../../datatypes/card';
import { getRecordStore } from '../../db/record-store';
import { t } from '../../i18n';

/** 生成条目 id */
function makeOkrId(): string {
    return `okr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 生成清单行 id */
function makeItemId(): string {
    return `okr_item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 按类型生成新条目的默认字段 */
function makeCondition(type: OkrConditionType, index: number): OkrCondition {
    const cond: OkrCondition = {
        id: makeOkrId(),
        type,
        target: 0,
        title: `${t(OKR_CONDITION_META[type].labelKey as Parameters<typeof t>[0])}${index}`,
    };
    if (type === 'milestone' || type === 'outcome') {
        // 里程碑 / 成果：一个条目表示一整个清单，默认带一行
        cond.items = [makeItem(type, 1)];
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

/** 生成记录卡片（自定义表单设计，默认带一行字段） */
function makeRecordCard(): OkrRecordCard {
    return {
        id: makeOkrId(),
        fields: [{ id: makeItemId(), type: 'text', name: '' }],
    };
}

/** 按类型生成清单行的默认内容（里程碑1 / 成果1） */
function makeItem(type: OkrConditionType, index: number): OkrConditionItem {
    return {
        id: makeItemId(),
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

/**
 * OKR 视图：与 WorkbenchView 一致，通过 renderInto 渲染到指定容器。
 * 左侧复用任务面板，右侧为当前选中任务的 OKR 条目卡片。
 */

export class OkrView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: PlanCategoryData;
    private save: () => Promise<void>;
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 收集盒领域仓库（任务面板增删改走仓库方法，保证跨视图一致） */
    private inboxRepo?: InboxRepo;
    /** 「+」下拉面板的「点击外部关闭」监听器（渲染前清理，避免累积） */
    private addPanelCloseHandler?: (e: MouseEvent) => void;
    /** 执行记录访问器（用于统计当前任务的执行时长） */
    private getExecutions: () => ExecutionRecord[];
    /** 处于编辑模式的里程碑卡片对应的任务 id（本次会话内保留，可来回切换） */
    private milestoneEditIds = new Set<string>();
    /** 处于编辑模式的记录卡片对应的条目 id（本次会话内保留，可来回切换） */
    private recordEditIds = new Set<string>();
    /** 右侧垂直选项卡：计划执行 / OKR 进度（默认 OKR 进度） */
    private rightTab: 'plan' | 'okrProgress' = 'okrProgress';

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

        // 左侧：任务面板（与任务计划视图一致）
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
                // 任务面板选中变化：只重绘右侧 OKR 方框，避免重建左侧面板
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
        const tabs: { id: 'plan' | 'okrProgress'; labelKey: 'okr.tabPlanExecution' | 'okr.tabOkrProgress' }[] = [
            { id: 'plan', labelKey: 'okr.tabPlanExecution' },
            { id: 'okrProgress', labelKey: 'okr.tabOkrProgress' },
        ];
        for (const tab of tabs) {
            const tabEl = tabStrip.createDiv({ cls: 'task-plan-right-tab', text: t(tab.labelKey) });
            tabEl.toggleClass('is-active', this.rightTab === tab.id);
            tabEl.onclick = () => {
                if (this.rightTab === tab.id) return;
                this.rightTab = tab.id;
                void this.refreshRight();
            };
        }

        // 右侧：内容区（随选项卡切换）
        const contentPanel = container.createDiv({ cls: 'task-plan-content-panel' });
        await this.renderRightContent(contentPanel);

        // 恢复任务面板列表的滚动位置，实现无感刷新
        if (prevListScrollTop > 0) {
            const listEl = taskPanel.querySelector<HTMLElement>('.inbox-list');
            if (listEl) listEl.scrollTop = prevListScrollTop;
        }
    }

    /** 当前选中任务（未选中或已移除时返回 undefined） */
    private getSelectedItem(): InboxItem | undefined {
        const selectedId = this.inboxData.selectedId;
        return selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;
    }

    /**
     * 统计信息方框：一行从左到右依次为
     * 任务树总时长（含所有子孙）→ 当前任务自身时长 → 各直接子任务总时长（含其所有子孙）。
     * 每项为「方块 + 方块下方任务名」，方块内显示时长。
     * 数据来源为执行记录（按 inboxId 聚合），无选中任务时不渲染。
     */
    private renderStatsBox(wrap: HTMLElement): void {
        wrap.empty();

        const item = this.getSelectedItem();
        if (!item) return;

        // 按任务聚合执行时长（分钟）
        const minutesByTask = new Map<string, number>();
        for (const ex of this.getExecutions()) {
            if (!ex.inboxId) continue;
            const minutes = Math.max(0, (ex.end ?? ex.start) - ex.start);
            minutesByTask.set(ex.inboxId, (minutesByTask.get(ex.inboxId) ?? 0) + minutes);
        }

        // 任务自身 + 所有子孙的执行时长
        const subtreeMinutes = (taskId: string): number => {
            let total = minutesByTask.get(taskId) ?? 0;
            for (const child of this.inboxData.items) {
                if (child.removed || child.parentId !== taskId) continue;
                total += subtreeMinutes(child.id);
            }
            return total;
        };

        const area = wrap.createDiv({ cls: 'swimlane-section-area task-plan-stats-area' });
        const header = area.createDiv({ cls: 'swimlane-section-area-header' });
        header.createDiv({ cls: 'swimlane-section-area-title', text: t('taskPlan.statsTitle') });

        const body = area.createDiv({ cls: 'task-plan-stats-body' });

        // 1. 当前任务树总时长（含所有子孙）
        this.renderStatsBlock(body, subtreeMinutes(item.id), t('taskPlan.statsTreeDuration'));

        // 2. 当前任务节点自身时长
        this.renderStatsBlock(body, minutesByTask.get(item.id) ?? 0, item.title);

        // 3. 每个直接子任务的总时长（含其所有子孙）
        const children = this.inboxData.items.filter(i => !i.removed && i.parentId === item.id);
        for (const child of children) {
            this.renderStatsBlock(body, subtreeMinutes(child.id), child.title);
        }
    }

    /** 统计方块：方块内为时长，方块下方为任务名 */
    private renderStatsBlock(row: HTMLElement, minutes: number, label: string): void {
        const block = row.createDiv({ cls: 'task-plan-stats-block' });
        const box = block.createDiv({ cls: 'task-plan-stats-box' });
        const total = Math.max(0, Math.round(minutes));
        box.createSpan({ cls: 'task-plan-stats-value', text: String(Math.floor(total / 60)) });
        box.createSpan({ cls: 'task-plan-stats-unit', text: 'h' });
        box.createSpan({ cls: 'task-plan-stats-value', text: String(total % 60) });
        box.createSpan({ cls: 'task-plan-stats-unit', text: 'm' });
        block.createDiv({ cls: 'task-plan-stats-name', text: label });
    }

    /**
     * 重绘右侧内容区（不重建左侧任务面板，避免任务面板的点击事件丢失）。
     */
    private async refresh(): Promise<void> {
        const panel = this.container?.querySelector<HTMLElement>('.task-plan-content-panel');
        if (!panel) return;
        await this.renderRightContent(panel);
    }

    /** 切换右侧选项卡后重绘内容区，并刷新选项卡高亮 */
    private async refreshRight(): Promise<void> {
        this.container?.querySelectorAll('.task-plan-right-tab').forEach((el, i) => {
            const ids: ('plan' | 'okrProgress')[] = ['plan', 'okrProgress'];
            el.toggleClass('is-active', ids[i] === this.rightTab);
        });
        const panel = this.container?.querySelector<HTMLElement>('.task-plan-content-panel');
        if (!panel) return;
        await this.renderRightContent(panel);
    }

    /** 按当前选项卡渲染右侧内容区 */
    private async renderRightContent(panel: HTMLElement): Promise<void> {
        panel.empty();
        // 「计划执行」选项卡：暂无内容
        if (this.rightTab === 'plan') return;

        // 「OKR 进度」选项卡：统计信息方框 + 记录方框 + OKR 方框
        const statsWrap = panel.createDiv({ cls: 'okr-stats-wrap' });
        this.renderStatsBox(statsWrap);
        await this.renderRecordBox(panel);
        this.renderOkrBox(panel);
    }

    /** OKR 进度：标题栏（含「+」下拉）+ 条目卡片列表（不再使用外框） */
    private renderOkrBox(panel: HTMLElement): void {
        const area = panel.createDiv({ cls: 'okr-area' });
        const header = area.createDiv({ cls: 'swimlane-section-area-header' });
        header.createDiv({ cls: 'swimlane-section-area-title', text: t('okr.progressTitle') });
        this.renderAddButton(header);

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

    /** 记录卡片：独立方框，标题「记录」+ 右上角编辑按钮（切换字段编辑） */
    private async renderRecordBox(panel: HTMLElement): Promise<void> {
        const area = panel.createDiv({ cls: 'swimlane-section-area okr-record-area' });
        const header = area.createDiv({ cls: 'swimlane-section-area-header' });
        header.createDiv({ cls: 'swimlane-section-area-title', text: t('okr.typeRecord') });

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
            this.refresh();
        };

        await this.renderRecordCard(body, recordCard, item);
    }

    /** 标题栏右上角「+」按钮：点击展开下拉面板（按大类分组列出条目类型） */
    private renderAddButton(header: HTMLElement): void {
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
    private renderMilestoneTile(container: HTMLElement, item: InboxItem, cond: OkrCondition): void {
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
                };
                const meta = isHabit ? { icon: 'rotate-cw-square' } : (statusMeta[status] ?? statusMeta.notStarted);
                const statusEl = chip.createSpan({ cls: `inbox-item-status is-${isHabit ? 'habit' : status}` });
                const iconEl = statusEl.createSpan({ cls: 'inbox-item-status-icon' });
                setIcon(iconEl, meta.icon);

                chip.createSpan({ text: child.title });
            }
        }
    }

    /**
     * 记录卡片内容：正常模式以表格展示当前任务的填写记录（日期 + 各字段值）；
     * 编辑模式显示表单（字段类型 + 名称 + 删除）。
     * 右上角编辑图标改由记录方框标题栏统一承载，此方法只渲染卡片主体，不再包裹卡片外框。
     */
    private async renderRecordCard(container: HTMLElement, recordCard: OkrRecordCard, item: InboxItem): Promise<void> {
        const editing = this.recordEditIds.has(recordCard.id);

        if (!editing) {
            // 正常模式：仅显示记录总数
            const entries = await getRecordStore(this.app).listEntriesByInbox(item.id);
            container.createDiv({ cls: 'okr-record-total', text: t('okr.recordTotal', { count: entries.length }) });
            return;
        }

        // 编辑模式：顶部「+」新增字段 + 表单设计，每行 = 字段类型 + 字段名称 + 删除
        const addBtn = container.createEl('button', { cls: 'okr-record-add-btn', text: '+' });
        addBtn.onclick = (e) => {
            e.stopPropagation();
            recordCard.fields.push({ id: makeItemId(), type: 'text', name: '' });
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
            cond.items.push(makeItem(cond.type, cond.items.length + 1));
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
}
