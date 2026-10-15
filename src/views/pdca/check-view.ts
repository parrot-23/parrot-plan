import type { App } from 'obsidian';

import type { TimeBlockCategoryData } from '../../shared/timeblock-category-manager';
import type { InboxData, EventBlock, ExecutionRecord } from '../../datatypes/domain';
import { getEventStatus } from '../../datatypes/domain';
import {
    getCurrentWeekKey,
    makeWeekKey,
    parseWeekKey,
    shiftWeekKey,
    getWeeksInYear,
} from '../../shared/timeblock-data';
import { t, getWeekDays } from '../../i18n';

/** 把分钟数格式化为小时（如 1.5h） */
function formatHours(minutes: number): string {
    const hours = minutes / 60;
    return `${Number(hours.toFixed(1))}h`;
}

/** 把分钟数格式化为 HH:MM */
function formatMinutes(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 检查视图（PDCA 的 Check）：按周统计计划与执行的对比情况。
 * 单列纵向布局：周导航 → 计划 vs 执行对比 → 分类完成统计 → 异常任务列表。
 * 与 YearView / TaskPlanView 一样，通过 renderInto 渲染到指定容器。
 */
export class CheckView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: TimeBlockCategoryData;
    /** 获取全部计划事件 */
    private getEvents: () => EventBlock[];
    /** 获取全部执行记录 */
    private getExecutions: () => ExecutionRecord[];
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 当前检查的周键 */
    private currentWeekKey: string = getCurrentWeekKey();

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: TimeBlockCategoryData,
        getEvents: () => EventBlock[],
        getExecutions: () => ExecutionRecord[],
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.getEvents = getEvents;
        this.getExecutions = getExecutions;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('check-view');

        // 顶部：周导航
        this.renderWeekNav(container);

        // 内容区：三列（左：计划汇总 / 中：执行汇总 / 右：差异项）
        const body = container.createDiv({ cls: 'check-body' });
        const columns = body.createDiv({ cls: 'check-columns' });

        // 左块：本周计划汇总统计
        this.renderPlanSummary(columns.createDiv({ cls: 'check-col' }));

        // 中块：本周执行汇总统计
        this.renderExecSummary(columns.createDiv({ cls: 'check-col' }));

        // 右块：差异项（第一行：本周分配 vs 执行；第二行：上周 vs 本周）
        this.renderDiffColumn(columns.createDiv({ cls: 'check-col' }));
    }

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
    }

    // ===== 周导航 =====
    private renderWeekNav(container: HTMLElement) {
        const nav = container.createDiv({ cls: 'check-week-nav' });
        const { year, week } = parseWeekKey(this.currentWeekKey);

        // 年份下拉（当前年 ±5）
        const yearSelect = nav.createEl('select', { cls: 'check-week-nav-select' });
        const nowYear = new Date().getFullYear();
        for (let y = nowYear - 5; y <= nowYear + 5; y++) {
            yearSelect.createEl('option', { text: `${y}`, value: `${y}` });
        }
        yearSelect.value = `${year}`;

        // 周号下拉（按该年实际周数）
        const weekSelect = nav.createEl('select', { cls: 'check-week-nav-select' });
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
        const prevBtn = nav.createEl('button', { text: '‹', cls: 'check-week-nav-arrow-btn' });
        prevBtn.onclick = () => {
            this.currentWeekKey = shiftWeekKey(this.currentWeekKey, -1);
            void this.refresh();
        };

        const nextBtn = nav.createEl('button', { text: '›', cls: 'check-week-nav-arrow-btn' });
        nextBtn.onclick = () => {
            this.currentWeekKey = shiftWeekKey(this.currentWeekKey, 1);
            void this.refresh();
        };

        // 「本周」按钮
        const thisWeekBtn = nav.createEl('button', {
            text: t('weekNav.thisWeek'),
            cls: 'check-week-nav-today-btn',
        });
        thisWeekBtn.toggleClass('is-active', this.currentWeekKey === getCurrentWeekKey());
        thisWeekBtn.onclick = () => {
            this.currentWeekKey = getCurrentWeekKey();
            void this.refresh();
        };
    }

    // ===== 左块：本周计划汇总统计 =====
    private renderPlanSummary(col: HTMLElement) {
        const box = col.createDiv({ cls: 'check-box' });
        box.createDiv({ cls: 'check-box-title', text: t('check.planSummaryTitle') });

        const weekEvents = this.getEvents().filter(ev => ev.weekKey === this.currentWeekKey);
        const timedEvents = weekEvents.filter(ev => !ev.allDay);
        const plannedCount = timedEvents.length;
        const plannedMinutes = timedEvents.reduce((s, ev) => s + Math.max(0, ev.end - ev.start), 0);

        const rows = box.createDiv({ cls: 'check-stat-rows' });
        this.renderStatRow(rows, t('check.plannedCount'), `${plannedCount}`, formatHours(plannedMinutes));

        // 按分类汇总计划时长
        this.renderCategoryBreakdown(box, timedEvents.map(ev => ({
            categoryId: ev.categoryId,
            minutes: Math.max(0, ev.end - ev.start),
        })));
    }

    // ===== 中块：本周执行汇总统计 =====
    private renderExecSummary(col: HTMLElement) {
        const box = col.createDiv({ cls: 'check-box' });
        box.createDiv({ cls: 'check-box-title', text: t('check.execSummaryTitle') });

        const weekExecs = this.getExecutions().filter(ex => ex.weekKey === this.currentWeekKey);
        const actualMinutes = weekExecs.reduce((s, ex) => s + Math.max(0, ex.end - ex.start), 0);

        const rows = box.createDiv({ cls: 'check-stat-rows' });
        this.renderStatRow(rows, t('check.actualDuration'), `${weekExecs.length}`, formatHours(actualMinutes));

        // 按分类汇总执行时长（分类取来源任务）
        this.renderCategoryBreakdown(box, weekExecs.map(ex => {
            const item = ex.inboxId
                ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                : undefined;
            return { categoryId: item?.categoryId, minutes: Math.max(0, ex.end - ex.start) };
        }));
    }

    /** 按分类汇总时长（计划 / 执行共用） */
    private renderCategoryBreakdown(
        box: HTMLElement,
        entries: { categoryId?: string; minutes: number }[],
    ) {
        const map = new Map<string, number>();
        for (const e of entries) {
            const key = e.categoryId ?? '__none__';
            map.set(key, (map.get(key) ?? 0) + e.minutes);
        }
        if (map.size === 0) return;

        const list = box.createDiv({ cls: 'check-category-list' });
        for (const [key, minutes] of Array.from(map.entries())) {
            const cat = key === '__none__'
                ? undefined
                : this.categoryData.categories.find(c => c.id === key);
            const color = cat?.color ?? '#888888';
            const label = cat?.label ?? t('inbox.noCategory');

            const row = list.createDiv({ cls: 'check-category-row' });
            const dot = row.createSpan({ cls: 'check-category-dot' });
            dot.setCssProps({ '--dot-color': color });
            row.createSpan({ cls: 'check-category-name', text: label });
            row.createSpan({ cls: 'check-category-value', text: formatHours(minutes) });
        }
    }

    // ===== 右块：差异项（两行）=====
    private renderDiffColumn(col: HTMLElement) {
        // 第一行：本周分配 vs 执行
        this.renderWeekDiffBox(col);

        // 第二行：上周 vs 本周
        this.renderPrevWeekDiffBox(col);
    }

    /** 第一行：本周「分配 vs 执行」的差距 */
    private renderWeekDiffBox(col: HTMLElement) {
        const box = col.createDiv({ cls: 'check-box' });
        box.createDiv({ cls: 'check-box-title', text: t('check.weekDiffTitle') });

        const weekEvents = this.getEvents().filter(ev => ev.weekKey === this.currentWeekKey);
        const weekExecs = this.getExecutions().filter(ex => ex.weekKey === this.currentWeekKey);

        const timedEvents = weekEvents.filter(ev => !ev.allDay);
        const plannedCount = timedEvents.length;
        const executedEvents = timedEvents.filter(ev => getEventStatus(ev, weekExecs) === 'executed');
        const executedCount = executedEvents.length;

        const rows = box.createDiv({ cls: 'check-stat-rows' });
        this.renderStatRow(rows, t('check.diffPlanned'), `${plannedCount}`, '');
        this.renderStatRow(rows, t('check.diffExecuted'), `${executedCount}`, '');
        this.renderStatRow(
            rows,
            t('check.diffUnexecuted'),
            `${Math.max(0, plannedCount - executedCount)}`,
            '',
        );

        // 完成率进度条
        const ratio = plannedCount > 0 ? executedCount / plannedCount : 0;
        const barWrap = box.createDiv({ cls: 'check-progress-wrap' });
        barWrap.createDiv({ cls: 'check-progress-label', text: t('check.completionRate') });
        const bar = barWrap.createDiv({ cls: 'check-progress-bar' });
        const fill = bar.createDiv({ cls: 'check-progress-fill' });
        fill.setCssProps({ '--progress': `${Math.round(ratio * 100)}%` });
        barWrap.createDiv({ cls: 'check-progress-value', text: `${Math.round(ratio * 100)}%` });

        // 差异明细：未执行 / 被替换
        const unexecuted = timedEvents.filter(ev => getEventStatus(ev, weekExecs) === 'planned');
        const replaced = weekExecs.filter(ex => ex.replaced);
        if (unexecuted.length === 0 && replaced.length === 0) {
            box.createDiv({ cls: 'check-empty', text: t('check.noAbnormal') });
            return;
        }
        const list = box.createDiv({ cls: 'check-abnormal-list' });
        for (const ev of unexecuted) {
            const row = list.createDiv({ cls: 'check-abnormal-row' });
            row.createSpan({ cls: 'check-abnormal-badge is-unexecuted', text: t('check.badgeUnexecuted') });
            row.createSpan({ cls: 'check-abnormal-title', text: ev.title });
            row.createSpan({
                cls: 'check-abnormal-meta',
                text: `${getWeekDays()[ev.day - 1]} ${formatMinutes(ev.start)}-${formatMinutes(ev.end)}`,
            });
        }
        for (const ex of replaced) {
            const row = list.createDiv({ cls: 'check-abnormal-row' });
            row.createSpan({ cls: 'check-abnormal-badge is-replaced', text: t('check.badgeReplaced') });
            const item = ex.inboxId
                ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                : undefined;
            const planned = ex.eventId ? this.getEvents().find(e => e.id === ex.eventId) : undefined;
            const title = item?.title ?? planned?.title ?? t('check.unknownTask');
            row.createSpan({ cls: 'check-abnormal-title', text: title });
            row.createSpan({
                cls: 'check-abnormal-meta',
                text: `${getWeekDays()[ex.day - 1]} ${formatMinutes(ex.start)}-${formatMinutes(ex.end)}`,
            });
        }
    }

    /** 第二行：上周 vs 本周 的对比差异 */
    private renderPrevWeekDiffBox(col: HTMLElement) {
        const box = col.createDiv({ cls: 'check-box' });
        box.createDiv({ cls: 'check-box-title', text: t('check.prevWeekDiffTitle') });

        const prevWeekKey = shiftWeekKey(this.currentWeekKey, -1);

        const stat = (weekKey: string) => {
            const events = this.getEvents().filter(ev => ev.weekKey === weekKey && !ev.allDay);
            const execs = this.getExecutions().filter(ex => ex.weekKey === weekKey);
            const plannedMinutes = events.reduce((s, ev) => s + Math.max(0, ev.end - ev.start), 0);
            const actualMinutes = execs.reduce((s, ex) => s + Math.max(0, ex.end - ex.start), 0);
            const executedCount = events.filter(ev => getEventStatus(ev, execs) === 'executed').length;
            return { plannedCount: events.length, plannedMinutes, execCount: execs.length, actualMinutes, executedCount };
        };

        const prev = stat(prevWeekKey);
        const curr = stat(this.currentWeekKey);

        const rows = box.createDiv({ cls: 'check-stat-rows' });
        // 表头：上周 / 本周
        const head = rows.createDiv({ cls: 'check-diff-head' });
        head.createSpan({ cls: 'check-diff-head-label', text: '' });
        head.createSpan({ cls: 'check-diff-head-col', text: t('check.prevWeek') });
        head.createSpan({ cls: 'check-diff-head-col', text: t('check.currWeek') });

        this.renderDiffRow(rows, t('check.plannedCount'), `${prev.plannedCount}`, `${curr.plannedCount}`);
        this.renderDiffRow(rows, t('check.plannedDuration'), formatHours(prev.plannedMinutes), formatHours(curr.plannedMinutes));
        this.renderDiffRow(rows, t('check.executedCount'), `${prev.executedCount}`, `${curr.executedCount}`);
        this.renderDiffRow(rows, t('check.actualDuration'), formatHours(prev.actualMinutes), formatHours(curr.actualMinutes));
    }

    /** 渲染一行对比：标签 + 上周值 + 本周值 */
    private renderDiffRow(parent: HTMLElement, label: string, prev: string, curr: string) {
        const row = parent.createDiv({ cls: 'check-diff-row' });
        row.createSpan({ cls: 'check-diff-label', text: label });
        row.createSpan({ cls: 'check-diff-prev', text: prev });
        row.createSpan({ cls: 'check-diff-curr', text: curr });
    }

    /** 渲染一行统计：标签 + 数量 + 时长 */
    private renderStatRow(parent: HTMLElement, label: string, count: string, duration: string) {
        const row = parent.createDiv({ cls: 'check-stat-row' });
        row.createSpan({ cls: 'check-stat-label', text: label });
        row.createSpan({ cls: 'check-stat-count', text: count });
        row.createSpan({ cls: 'check-stat-duration', text: duration });
    }
}
