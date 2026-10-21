import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type { PlanCategoryData } from '../../shared/plan-category-manager';
import type { InboxData, EventBlock, ExecutionRecord, ImprovementItem, ImprovementEntry } from '../../datatypes/domain';
import { getEventStatus } from '../../datatypes/domain';
import type { PdcaRepo } from '../../repos/pdca-repo';
import type { InboxRepo } from '../../repos/inbox-repo';
import {
    getCurrentWeekKey,
    makeWeekKey,
    parseWeekKey,
    shiftWeekKey,
    getWeeksInYear,
} from '../../shared/plan-data';
import { t, getWeekDays } from '../../i18n';

/** 把分钟数格式化为小时（如 1.5h） */
function formatHours(minutes: number): string {
    const hours = minutes / 60;
    return `${Number(hours.toFixed(1))}h`;
}

/**
 * 改进视图（PDCA 的 Act）：左右结构。
 * 左侧：本周计划执行差异点 + 7 天每天执行情况。
 * 右侧：可填写的改进项列表（按周键持久化）。
 * 与 CheckView 一样，通过 renderInto 渲染到指定容器。
 */
export class ImproveView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: PlanCategoryData;
    /** 获取全部计划事件 */
    private getEvents: () => EventBlock[];
    /** 获取全部执行记录 */
    private getExecutions: () => ExecutionRecord[];
    /** PDCA 领域仓库（改进项增删） */
    private pdcaRepo: PdcaRepo;
    /** 保存回调 */
    private save: () => Promise<void>;
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 当前改进的周键 */
    private currentWeekKey: string = getCurrentWeekKey();
    /**
     * 临时改进条目：点击左侧任务行后生成，尚未输入内容前不落库。
     * 切换任务行时丢弃旧的、换成新任务的；输入内容并归档后才写入对应任务的改进项。
     */
    private pendingImprovement?: { taskId: string; taskTitle: string; text: string };
    /** 收集盒领域仓库（任务改进项写入走仓库方法，保证跨视图一致） */
    private inboxRepo?: InboxRepo;

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: PlanCategoryData,
        getEvents: () => EventBlock[],
        getExecutions: () => ExecutionRecord[],
        pdcaRepo: PdcaRepo,
        save: () => Promise<void>,
        inboxRepo?: InboxRepo,
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.getEvents = getEvents;
        this.getExecutions = getExecutions;
        this.pdcaRepo = pdcaRepo;
        this.save = save;
        this.inboxRepo = inboxRepo;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('improve-view');

        // 整页重渲染（如切换周）时丢弃未填写的临时条目
        this.pendingImprovement = undefined;

        // 顶部：周导航
        this.renderWeekNav(container);

        // 内容区：左右结构
        const body = container.createDiv({ cls: 'improve-body' });
        const columns = body.createDiv({ cls: 'improve-columns' });

        // 左：本周计划执行情况 + 本周任务执行情况
        const left = columns.createDiv({ cls: 'improve-col improve-col-left' });
        this.renderWeekPlanStats(left);
        this.renderWeekTaskStats(left);

        // 右：可填写的改进项列表
        const right = columns.createDiv({ cls: 'improve-col improve-col-right' });
        this.renderImprovementList(right);
    }

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
    }

    // ===== 周导航 =====
    private renderWeekNav(container: HTMLElement) {
        const nav = container.createDiv({ cls: 'improve-week-nav' });
        const { year, week } = parseWeekKey(this.currentWeekKey);

        // 年份下拉（当前年 ±5）
        const yearSelect = nav.createEl('select', { cls: 'improve-week-nav-select' });
        const nowYear = new Date().getFullYear();
        for (let y = nowYear - 5; y <= nowYear + 5; y++) {
            yearSelect.createEl('option', { text: `${y}`, value: `${y}` });
        }
        yearSelect.value = `${year}`;

        // 周号下拉（按该年实际周数）
        const weekSelect = nav.createEl('select', { cls: 'improve-week-nav-select' });
        const weeksInYear = getWeeksInYear(year);
        for (let w = 1; w <= weeksInYear; w++) {
            weekSelect.createEl('option', { text: `${t('weekNav.week')} ${w}`, value: `${w}` });
        }
        weekSelect.value = `${week}`;

        const apply = () => {
            this.currentWeekKey = makeWeekKey(Number(yearSelect.value), Number(weekSelect.value));
            void this.refresh();
        };
        yearSelect.onchange = apply;
        weekSelect.onchange = apply;

        // 上一周 / 下一周
        const prevBtn = nav.createEl('button', { text: '‹', cls: 'improve-week-nav-arrow-btn' });
        prevBtn.onclick = () => {
            this.currentWeekKey = shiftWeekKey(this.currentWeekKey, -1);
            void this.refresh();
        };

        const nextBtn = nav.createEl('button', { text: '›', cls: 'improve-week-nav-arrow-btn' });
        nextBtn.onclick = () => {
            this.currentWeekKey = shiftWeekKey(this.currentWeekKey, 1);
            void this.refresh();
        };

        // 「本周」按钮
        const thisWeekBtn = nav.createEl('button', {
            text: t('weekNav.thisWeek'),
            cls: 'improve-week-nav-today-btn',
        });
        thisWeekBtn.toggleClass('is-active', this.currentWeekKey === getCurrentWeekKey());
        thisWeekBtn.onclick = () => {
            this.currentWeekKey = getCurrentWeekKey();
            void this.refresh();
        };
    }

    // ===== 左块 1：这周计划执行情况（周一~周日小方块，展示计划 vs 执行的差异） =====
    private renderWeekPlanStats(col: HTMLElement) {
        const box = col.createDiv({ cls: 'improve-box' });
        box.createDiv({ cls: 'improve-box-title', text: t('improve.weekPlanTitle') });

        const weekEvents = this.getEvents().filter(ev => ev.weekKey === this.currentWeekKey);
        const weekExecs = this.getExecutions().filter(ex => ex.weekKey === this.currentWeekKey);
        const days = getWeekDays();

        const grid = box.createDiv({ cls: 'improve-week-grid' });
        for (let day = 1; day <= 7; day++) {
            const cell = grid.createDiv({ cls: 'improve-week-cell' });
            cell.createDiv({ cls: 'improve-week-cell-title', text: days[day - 1] });

            // 事件差异：当天计划事件数 vs 已执行事件数（已完成 / 计划总数）
            // 计划事件现为全天事件（含习惯时间点），故不再按 allDay 过滤
            const dayEvents = weekEvents.filter(ev => ev.day === day);
            const executedCount = dayEvents.filter(ev => getEventStatus(ev, weekExecs) === 'executed').length;
            const eventRow = cell.createDiv({ cls: 'improve-week-cell-row' });
            eventRow.createSpan({ cls: 'improve-week-cell-label', text: t('improve.weekCellEvent') });
            eventRow.createSpan({
                cls: 'improve-week-cell-value',
                text: `${executedCount} / ${dayEvents.length}`,
            });
        }
    }

    // ===== 左块 2：这周任务执行情况（本周计划中出现的任务，含本周新增 OKR 进度） =====
    private renderWeekTaskStats(col: HTMLElement) {
        const box = col.createDiv({ cls: 'improve-box improve-week-task-box' });
        box.createDiv({ cls: 'improve-box-title', text: t('improve.weekTaskTitle') });

        const weekEvents = this.getEvents().filter(ev => ev.weekKey === this.currentWeekKey);
        const weekExecs = this.getExecutions().filter(ex => ex.weekKey === this.currentWeekKey);

        // 本周计划中出现的任务（按来源 inboxId 去重，保持首次出现顺序）
        const taskIds: string[] = [];
        for (const ev of weekEvents) {
            if (ev.inboxId && !taskIds.includes(ev.inboxId)) taskIds.push(ev.inboxId);
        }
        const tasks = taskIds
            .map(id => this.inboxData.items.find(i => i.id === id && !i.removed))
            .filter((i): i is NonNullable<typeof i> => !!i);

        if (tasks.length === 0) {
            box.createDiv({ cls: 'improve-empty', text: t('improve.weekTaskEmpty') });
            return;
        }

        const list = box.createDiv({ cls: 'improve-week-task-list' });
        for (const item of tasks) {
            const row = list.createDiv({ cls: 'improve-week-task-row' });

            // 点击任务行：在右侧改进项列表临时生成一条待填写条目（未输入前不落库）
            row.addClass('is-clickable');
            // 激活态：该行正是当前临时条目对应的任务
            if (this.pendingImprovement?.taskId === item.id) row.addClass('is-active');
            row.onclick = () => this.selectTaskForImprovement(item.id, item.title);

            // 本周计划（次数 + 预估时长合计）与执行（次数 + 执行时长合计）
            const planEvents = weekEvents.filter(ev => ev.inboxId === item.id);
            const planCount = planEvents.length;
            const planMinutes = planEvents.reduce(
                (s, ev) => s + (typeof ev.estimatedMinutes === 'number' ? Math.max(0, ev.estimatedMinutes) : 0),
                0,
            );
            const execs = weekExecs.filter(ex => ex.inboxId === item.id);
            const execCount = execs.length;
            const execMinutes = execs.reduce((s, ex) => s + Math.max(0, ex.end - ex.start), 0);

            // 第一行：分类色点 + 任务名 + 完成程度 %
            const line1 = row.createDiv({ cls: 'improve-week-task-line1' });
            const cat = item.categoryId
                ? this.categoryData.categories.find(c => c.id === item.categoryId)
                : undefined;
            const dot = line1.createSpan({ cls: 'improve-week-task-dot' });
            dot.setCssProps({ '--dot-color': cat?.color ?? '#888888' });
            line1.createSpan({ cls: 'improve-week-task-name', text: item.title });

            const pct = this.computeWeekTaskCompletion(planCount, planMinutes, execCount, execMinutes);
            if (pct !== null) {
                line1.createSpan({ cls: 'improve-week-task-completion', text: `${pct}%` });
            }

            // 第二行：计划（次数、时长） · 执行（次数、时长） · 偏差（是否次数少了/时长不足）
            const line2 = row.createDiv({ cls: 'improve-week-task-line2' });
            this.renderWeekTaskSegment(line2, t('improve.weekTaskPlan'), [
                t('improve.weekTaskTimes', { count: String(planCount) }),
                formatHours(planMinutes),
            ]);
            this.renderWeekTaskSegment(line2, t('improve.weekTaskExec'), [
                t('improve.weekTaskTimes', { count: String(execCount) }),
                formatHours(execMinutes),
            ]);
            this.renderWeekTaskBias(line2, planCount, planMinutes, execCount, execMinutes);
        }
    }

    /**
     * 计算任务本周完成程度（百分比，四舍五入到整数，截断至 0–100）。
     * 有预估时长则按时长完成率，无预估时长则按次数完成率；完全无计划返回 null。
     */
    private computeWeekTaskCompletion(
        planCount: number,
        planMinutes: number,
        execCount: number,
        execMinutes: number,
    ): number | null {
        if (planMinutes > 0) {
            const pct = Math.round((execMinutes / planMinutes) * 100);
            return Math.max(0, Math.min(100, pct));
        }
        if (planCount > 0) {
            const pct = Math.round((execCount / planCount) * 100);
            return Math.max(0, Math.min(100, pct));
        }
        return null;
    }

    /** 渲染第二行的一组「标签 + 值」片段 */
    private renderWeekTaskSegment(container: HTMLElement, label: string, values: string[]): void {
        const seg = container.createDiv({ cls: 'improve-week-task-seg' });
        seg.createSpan({ cls: 'improve-week-task-seg-label', text: label });
        for (const value of values) {
            seg.createSpan({ cls: 'improve-week-task-chip', text: value });
        }
    }

    /**
     * 渲染第二行的偏差片段：次数、时长各显示一个偏差值。
     * 次数：正常 / 次数少 N；时长：无预估时长 / 正常 / 时长少 N。
     */
    private renderWeekTaskBias(
        container: HTMLElement,
        planCount: number,
        planMinutes: number,
        execCount: number,
        execMinutes: number,
    ): void {
        const seg = container.createDiv({ cls: 'improve-week-task-seg improve-week-task-bias' });
        seg.createSpan({ cls: 'improve-week-task-seg-label', text: t('improve.weekTaskBias') });

        // 次数偏差
        const lessCount = planCount - execCount;
        if (lessCount > 0) {
            seg.createSpan({
                cls: 'improve-week-task-chip is-bad',
                text: t('improve.weekTaskLessCount', { count: String(lessCount) }),
            });
        } else {
            seg.createSpan({ cls: 'improve-week-task-chip is-ok', text: t('improve.weekTaskBiasCountOk') });
        }

        // 时长偏差：无预估时长时单独提示，不参与「正常/不足」判定
        if (planMinutes <= 0) {
            seg.createSpan({ cls: 'improve-week-task-chip', text: t('improve.weekTaskNoEstimate') });
        } else {
            const lessMinutes = planMinutes - execMinutes;
            if (lessMinutes > 0) {
                seg.createSpan({
                    cls: 'improve-week-task-chip is-bad',
                    text: t('improve.weekTaskLessDuration', { duration: formatHours(lessMinutes) }),
                });
            } else {
                seg.createSpan({ cls: 'improve-week-task-chip is-ok', text: t('improve.weekTaskBiasDurationOk') });
            }
        }
    }

    // ===== 右块：可填写的改进项列表 =====
    private renderImprovementList(col: HTMLElement) {
        const box = col.createDiv({ cls: 'improve-box' });
        const titleRow = box.createDiv({ cls: 'improve-box-title-row' });
        titleRow.createDiv({ cls: 'improve-box-title', text: t('improve.listTitle') });
        const addBtn = titleRow.createEl('button', { cls: 'improve-add-btn', text: '+' });
        addBtn.onclick = () => void this.addImprovementItem();

        const list = box.createDiv({ cls: 'improve-input-list' });

        // 临时条目（点击左侧任务行后生成）：显示在列表最上方
        if (this.pendingImprovement) {
            this.renderPendingImprovementRow(list);
        }

        const items = this.getWeekItems();
        if (items.length === 0 && !this.pendingImprovement) {
            list.createDiv({ cls: 'improve-empty', text: t('improve.listEmpty') });
        }
        for (const item of items) {
            const row = list.createDiv({ cls: 'improve-input-row' });
            const input = row.createEl('input', {
                cls: 'improve-input',
                type: 'text',
                value: item.text,
            });
            input.placeholder = t('improve.inputPlaceholder');
            input.onchange = () => {
                this.pdcaRepo.updateImprovement(this.currentWeekKey, item.id, input.value);
                void this.save();
            };
            const delBtn = row.createEl('button', { cls: 'improve-input-del', text: '×' });
            delBtn.onclick = () => void this.removeImprovementItem(item.id);
        }
    }

    /**
     * 渲染临时改进条目：任务名方框 + 输入框 + 归档按钮 + 删除按钮。
     * 未输入内容时该条目不落库；点击归档才写入对应任务的改进项。
     */
    private renderPendingImprovementRow(list: HTMLElement): void {
        const pending = this.pendingImprovement;
        if (!pending) return;

        const row = list.createDiv({ cls: 'improve-input-row improve-pending-row' });

        // 任务名方框（前缀分类色点）
        const taskBox = row.createSpan({ cls: 'improve-pending-task' });
        const task = this.inboxData.items.find(i => i.id === pending.taskId && !i.removed);
        const cat = task?.categoryId
            ? this.categoryData.categories.find(c => c.id === task.categoryId)
            : undefined;
        const dot = taskBox.createSpan({ cls: 'improve-pending-task-dot' });
        dot.setCssProps({ '--dot-color': cat?.color ?? '#888888' });
        taskBox.createSpan({ cls: 'improve-pending-task-name', text: pending.taskTitle });

        // 输入框
        const input = row.createEl('input', {
            cls: 'improve-input',
            type: 'text',
            value: pending.text,
        });
        input.placeholder = t('improve.inputPlaceholder');
        input.oninput = () => {
            if (this.pendingImprovement) this.pendingImprovement.text = input.value;
        };

        // 归档按钮：把内容写入对应任务的改进项
        const archiveBtn = row.createEl('button', {
            cls: 'improve-pending-archive',
            text: t('improve.archive'),
        });
        archiveBtn.onclick = () => void this.archivePendingImprovement();

        // 删除按钮：直接丢弃临时条目
        const delBtn = row.createEl('button', { cls: 'improve-input-del', text: '×' });
        delBtn.onclick = () => {
            this.pendingImprovement = undefined;
            this.refreshImprovementList();
        };
    }

    /** 点击左侧任务行：设置/替换临时改进条目（丢弃旧的未填写条目） */
    private selectTaskForImprovement(taskId: string, taskTitle: string): void {
        this.pendingImprovement = { taskId, taskTitle, text: '' };
        this.refreshImprovementList();
    }

    /** 归档临时条目：把内容写入对应任务的改进项并保存 */
    private async archivePendingImprovement(): Promise<void> {
        const pending = this.pendingImprovement;
        if (!pending) return;
        const text = pending.text.trim();
        if (!text) {
            new Notice(t('improve.archiveEmpty'));
            return;
        }
        const task = this.inboxData.items.find(i => i.id === pending.taskId && !i.removed);
        if (!task) {
            new Notice(t('improve.archiveEmpty'));
            return;
        }
        const entry: ImprovementEntry = {
            id: `improve_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            text,
            done: false,
            createdAt: Date.now(),
        };
        const nextImprovements = [...(task.improvements ?? []), entry];
        if (this.inboxRepo) {
            this.inboxRepo.updateItem(task.id, { improvements: nextImprovements });
        } else {
            task.improvements = nextImprovements;
        }
        await this.save();
        new Notice(t('improve.archiveDone', { title: pending.taskTitle }));
        this.pendingImprovement = undefined;
        this.refreshImprovementList();
    }

    /** 仅刷新右侧改进项列表（不整页刷新，避免丢失输入焦点） */
    private refreshImprovementList(): void {
        const col = this.container?.querySelector<HTMLElement>('.improve-col-right');
        if (col) {
            col.empty();
            this.renderImprovementList(col);
        }
        // 同步刷新左侧任务块，更新任务行的激活态
        this.refreshWeekTaskStats();
    }

    /** 仅刷新左侧「这周任务执行情况」块（更新任务行激活态） */
    private refreshWeekTaskStats(): void {
        const box = this.container?.querySelector<HTMLElement>('.improve-week-task-box');
        if (!box) return;
        const parent = box.parentElement;
        if (!parent) return;
        box.remove();
        this.renderWeekTaskStats(parent);
    }

    /** 取当前周的改进项列表（不存在则初始化） */
    private getWeekItems(): ImprovementItem[] {
        return this.pdcaRepo.getWeekImprovements(this.currentWeekKey);
    }

    /** 新增一条改进项 */
    private async addImprovementItem() {
        this.pdcaRepo.addImprovement(this.currentWeekKey, '');
        await this.save();
        await this.refresh();
    }

    /** 删除一条改进项 */
    private async removeImprovementItem(id: string) {
        this.pdcaRepo.removeImprovement(this.currentWeekKey, id);
        await this.save();
        await this.refresh();
    }
}
