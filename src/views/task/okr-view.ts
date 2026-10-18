// OKR 视图：左侧任务面板（与任务计划视图一致）+ 右侧 OKR 方框。
// 右侧只展示当前选中任务的 OKR 条件（进度展示 + 编辑态切换）。
import type { App } from 'obsidian';

import type { PlanCategoryData } from '../../shared/plan-category-manager';
import type { InboxData, InboxItem, OkrConditionType } from '../../datatypes/domain';
import { OKR_CONDITION_META } from '../../datatypes/domain';
import type { InboxRepo } from '../../repos/inbox-repo';
import { renderTaskPanel } from '../../shared/task-panel';
import { t } from '../../i18n';

/**
 * OKR 视图：与 WorkbenchView 一致，通过 renderInto 渲染到指定容器。
 * 左侧复用任务面板，右侧为当前选中任务的 OKR 方框。
 */
export class OkrView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: PlanCategoryData;
    private save: () => Promise<void>;
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** OKR 方框是否处于编辑态（true 显示可编辑条目，false 显示进度） */
    private okrEditMode = false;
    /** 上次渲染时选中的任务 id（用于切换任务时退出 OKR 编辑态） */
    private lastOkrSelectedId?: string;
    /** 收集盒领域仓库（任务面板增删改走仓库方法，保证跨视图一致） */
    private inboxRepo?: InboxRepo;

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
        // 切换选中任务时退出编辑态，避免编辑态残留到另一个任务
        if (this.lastOkrSelectedId !== this.inboxData.selectedId) {
            this.okrEditMode = false;
            this.lastOkrSelectedId = this.inboxData.selectedId;
        }
        const okrWrap = contentPanel.createDiv({ cls: 'okr-wrap' });
        this.renderOkrBox(okrWrap);

        // 恢复任务面板列表的滚动位置，实现无感刷新
        if (prevListScrollTop > 0) {
            const listEl = taskPanel.querySelector<HTMLElement>('.inbox-list');
            if (listEl) listEl.scrollTop = prevListScrollTop;
        }
    }

    /**
     * OKR 方框：
     * - 默认展示进度内容，右上角为「编辑」按钮；
     * - 点击「编辑」进入编辑态，展示可编辑条目，右上角为「退出」按钮。
     */
    private renderOkrBox(wrap: HTMLElement): void {
        wrap.empty();

        const selectedId = this.inboxData.selectedId;
        const item = selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;
        if (!item) return;

        const area = wrap.createDiv({ cls: 'swimlane-section-area okr-area' });
        const header = area.createDiv({ cls: 'swimlane-section-area-header' });
        header.createDiv({ cls: 'swimlane-section-area-title', text: t('okr.progressTitle') });

        if (this.okrEditMode) {
            // 编辑态：右上角「退出」按钮 + 「添加条件」按钮
            const actions = header.createDiv({ cls: 'okr-header-actions' });
            const addBtn = actions.createEl('button', { cls: 'okr-add-btn', text: t('okr.addCondition') });
            addBtn.onclick = (e) => {
                e.stopPropagation();
                void this.addOkrCondition(item, wrap);
            };
            const exitBtn = actions.createEl('button', { cls: 'okr-edit-btn', text: t('okr.exitEdit') });
            exitBtn.onclick = (e) => {
                e.stopPropagation();
                this.okrEditMode = false;
                this.renderOkrBox(wrap);
            };
            this.renderOkrEditBody(area, item, wrap);
        } else {
            // 展示态：右上角「编辑」按钮
            const editBtn = header.createEl('button', { cls: 'okr-edit-btn', text: t('okr.edit') });
            editBtn.onclick = (e) => {
                e.stopPropagation();
                this.okrEditMode = true;
                this.renderOkrBox(wrap);
            };
            this.renderOkrProgressBody(area, item);
        }
    }

    /** OKR 编辑态内容：可编辑的条件条目列表 */
    private renderOkrEditBody(area: HTMLElement, item: InboxItem, wrap: HTMLElement): void {
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

            if (cond.type === 'outcome') {
                // 成果：文本输入框（非数字）
                const textInput = row.createEl('input', {
                    type: 'text',
                    cls: 'okr-target-input okr-outcome-input',
                    attr: { placeholder: t('okr.outcomePlaceholder') },
                });
                textInput.value = cond.text ?? '';
                textInput.onchange = () => {
                    cond.text = textInput.value;
                    void this.save();
                };
            } else {
                // 时长：数字目标值 + 单位
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
            }

            // 删除按钮（放在行末尾）
            const del = row.createEl('button', { cls: 'okr-del-btn', text: '✕' });
            del.onclick = (e) => {
                e.stopPropagation();
                void this.deleteOkrCondition(item, cond.id, wrap);
            };
        }
    }

    /** OKR 展示态内容：条件完成进度（当前值 / 目标值） */
    private renderOkrProgressBody(area: HTMLElement, item: InboxItem): void {
        const body = area.createDiv({ cls: 'okr-progress-body' });
        const conditions = item.okr?.conditions ?? [];
        if (conditions.length === 0) {
            body.createDiv({ cls: 'swimlane-sections-empty', text: t('okr.progressEmpty') });
            return;
        }

        for (const cond of conditions) {
            const row = body.createDiv({ cls: 'okr-progress-row' });

            // 条件类型标签
            row.createSpan({
                cls: 'okr-progress-label',
                text: t(OKR_CONDITION_META[cond.type].labelKey as Parameters<typeof t>[0]),
            });

            if (cond.type === 'outcome') {
                // 成果：勾选框形式展示（勾选状态持久化到 cond.done）
                const cb = row.createEl('input', { type: 'checkbox', cls: 'okr-progress-checkbox' });
                cb.checked = cond.done ?? false;
                cb.onchange = () => {
                    cond.done = cb.checked;
                    void this.save();
                };
                row.createSpan({ cls: 'okr-progress-outcome-text', text: cond.text ?? '' });
                continue;
            }

            // 时长：进度条（宽度为页面的一半）
            const bar = row.createDiv({ cls: 'okr-progress-bar is-half' });
            const fill = bar.createDiv({ cls: 'okr-progress-fill' });
            const percent = cond.target > 0 ? Math.min(100, Math.round((0 / cond.target) * 100)) : 0;
            fill.style.width = `${percent}%`;

            // 数值：当前 / 目标
            const unit = t(OKR_CONDITION_META[cond.type].unitKey as Parameters<typeof t>[0]);
            row.createSpan({
                cls: 'okr-progress-value',
                text: `0 / ${cond.target} ${unit}`,
            });

            // 百分比
            row.createSpan({
                cls: 'okr-progress-percent',
                text: t('okr.progressPercent', { percent: String(percent) }),
            });
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

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
    }
}
