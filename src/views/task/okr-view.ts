// OKR 视图：左侧任务面板（与任务计划视图一致）+ 右侧 OKR 方框。
// 右侧按「拆解型 / 周期型」两类展示当前选中任务的 OKR 条目卡片。
import type { App } from 'obsidian';

import type { PlanCategoryData } from '../../shared/plan-category-manager';
import type { InboxData, InboxItem, OkrCondition, OkrConditionType, OkrPeriod } from '../../datatypes/domain';
import { OKR_CONDITION_META, OKR_GROUP_META, OKR_PERIOD_META } from '../../datatypes/domain';
import type { InboxRepo } from '../../repos/inbox-repo';
import { renderTaskPanel } from '../../shared/task-panel';
import { makePeriodKey } from '../../datatypes/card';
import { t } from '../../i18n';

/** 生成条目 id */
function makeOkrId(): string {
    return `okr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 按类型生成新条目的默认字段 */
function makeCondition(type: OkrConditionType, index: number): OkrCondition {
    const cond: OkrCondition = {
        id: makeOkrId(),
        type,
        target: 0,
        title: `${t(OKR_CONDITION_META[type].labelKey as Parameters<typeof t>[0])}${index}`,
    };
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
                void this.refresh();
            },
            undefined,
            async () => {
                await this.save();
            },
            { enableProjectFocus: true, inboxRepo: this.inboxRepo },
        );

        // 右侧：OKR 方框
        const contentPanel = container.createDiv({ cls: 'task-plan-content-panel' });
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
        if (!item) return;
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
        if (cond.type === 'milestone') {
            this.renderMilestoneBody(body, cond);
        } else if (cond.type === 'outcome') {
            this.renderOutcomeBody(body, cond);
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

    /** 里程碑：状态进度（0–100%） */
    private renderMilestoneBody(body: HTMLElement, cond: OkrCondition): void {
        const row = body.createDiv({ cls: 'okr-entry-row' });
        row.createSpan({ cls: 'okr-entry-label', text: t('okr.progressCurrent') });

        const target = Math.max(0, Math.min(100, cond.target || 0));
        const bar = row.createDiv({ cls: 'okr-progress-bar' });
        bar.createDiv({ cls: 'okr-progress-fill' }).style.width = `${target}%`;

        const input = row.createEl('input', {
            type: 'number',
            cls: 'okr-entry-number',
            attr: { min: '0', max: '100' },
        });
        input.value = String(target);
        input.onchange = () => {
            const v = Number(input.value);
            cond.target = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
            void this.save();
            void this.refresh();
        };
        row.createSpan({ cls: 'okr-entry-unit', text: '%' });
    }

    /** 成果：交付物文本 + 完成勾选 */
    private renderOutcomeBody(body: HTMLElement, cond: OkrCondition): void {
        const row = body.createDiv({ cls: 'okr-entry-row' });
        const cb = row.createEl('input', { type: 'checkbox', cls: 'okr-progress-checkbox' });
        cb.checked = cond.done ?? false;
        cb.onchange = () => {
            cond.done = cb.checked;
            void this.save();
        };
        const input = row.createEl('input', {
            type: 'text',
            cls: 'okr-entry-text',
            attr: { placeholder: t('okr.outcomePlaceholder') },
        });
        input.value = cond.text ?? '';
        input.onchange = () => {
            cond.text = input.value;
            void this.save();
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

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
    }
}
