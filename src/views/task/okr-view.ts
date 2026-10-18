// OKR 视图：左侧任务面板（与任务计划视图一致）+ 右侧 OKR 方框。
// 右侧按「拆解型 / 周期型」两类展示当前选中任务的 OKR 条目卡片。
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type { PlanCategoryData } from '../../shared/plan-category-manager';
import type { InboxData, InboxItem, OkrCondition, OkrConditionItem, OkrConditionType, OkrPeriod, ExecutionRecord } from '../../datatypes/domain';
import { OKR_CONDITION_META, OKR_GROUP_META, OKR_PERIOD_META } from '../../datatypes/domain';
import type { InboxRepo } from '../../repos/inbox-repo';
import { renderTaskPanel } from '../../shared/task-panel';
import { makePeriodKey } from '../../datatypes/card';
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

/** 按类型生成清单行的默认内容（里程碑1 / 成果1） */
function makeItem(type: OkrConditionType, index: number): OkrConditionItem {
    return {
        id: makeItemId(),
        text: `${t(OKR_CONDITION_META[type].labelKey as Parameters<typeof t>[0])}${index}`,
        done: false,
    };
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

        // 右侧：统计信息方框（顶部）+ OKR 方框
        const contentPanel = container.createDiv({ cls: 'task-plan-content-panel' });

        // 统计信息方框（当前选中任务的执行时长分布）
        const statsWrap = contentPanel.createDiv({ cls: 'okr-stats-wrap' });
        this.renderStatsBox(statsWrap);

        this.renderOkrBox(contentPanel);

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
     * 新增条目后重新渲染。
     * 注意：不能走 renderInto（它会清空并重建左侧任务面板），
     * 否则任务面板的点击事件会丢失，导致「+」下拉里的条目点击无反应。
     * 这里只重绘右侧统计方框 + OKR 方框。
     */
    private async refresh(): Promise<void> {
        const panel = this.container?.querySelector<HTMLElement>('.task-plan-content-panel');
        if (!panel) return;
        panel.empty();
        const statsWrap = panel.createDiv({ cls: 'okr-stats-wrap' });
        this.renderStatsBox(statsWrap);
        this.renderOkrBox(panel);
    }

    /** OKR 方框：标题栏（含「+」下拉）+ 条目卡片列表 */
    private renderOkrBox(panel: HTMLElement): void {
        const area = panel.createDiv({ cls: 'swimlane-section-area okr-area' });
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

        for (const cond of conditions) {
            this.renderEntryCard(body, item, cond);
        }
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
        if (cond.type === 'milestone' || cond.type === 'outcome') {
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
        bar.createDiv({ cls: 'okr-progress-fill' }).style.width = '0%';
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

        // 绑定子任务（当前任务的直接子任务）
        row.createSpan({ cls: 'okr-entry-dim-label', text: t('okr.subtask') });
        const sel = row.createEl('select', { cls: 'okr-entry-select' });
        sel.createEl('option', { text: t('okr.subtaskNone'), value: '' });
        const children = this.inboxData.items.filter(i => i.parentId === item.id && !i.removed);
        for (const child of children) {
            const opt = sel.createEl('option', { text: child.title, value: child.id });
            if (cond.subtaskId === child.id) opt.selected = true;
        }
        sel.onchange = () => {
            cond.subtaskId = sel.value || undefined;
            void this.save();
        };
    }
}
