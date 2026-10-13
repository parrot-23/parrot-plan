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
    hexToTransparent,
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

        // 内容区（可滚动）
        const body = container.createDiv({ cls: 'check-body' });

        // 1. 计划 vs 执行对比
        this.renderPlanVsExec(body);

        // 2. 分类完成统计
        this.renderCategoryStats(body);

        // 3. 异常任务列表
        this.renderAbnormalList(body);
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

    // ===== 1. 计划 vs 执行对比 =====
    private renderPlanVsExec(body: HTMLElement) {
        const box = body.createDiv({ cls: 'check-box' });
        box.createDiv({ cls: 'check-box-title', text: t('check.planVsExecTitle') });

        const weekEvents = this.getEvents().filter(ev => ev.weekKey === this.currentWeekKey);
        const weekExecs = this.getExecutions().filter(ex => ex.weekKey === this.currentWeekKey);

        // 计划事件：排除全天事件（全天事件无具体时长，不参与时长统计）
        const timedEvents = weekEvents.filter(ev => !ev.allDay);
        const plannedCount = timedEvents.length;
        const plannedMinutes = timedEvents.reduce((s, ev) => s + Math.max(0, ev.end - ev.start), 0);

        // 已执行：存在匹配执行记录（非替换）的计划事件
        const executedEvents = timedEvents.filter(ev => getEventStatus(ev, weekExecs) === 'executed');
        const executedCount = executedEvents.length;
        const executedMinutes = executedEvents.reduce((s, ev) => s + Math.max(0, ev.end - ev.start), 0);

        // 实际执行记录总时长（含新增/替换）
        const actualMinutes = weekExecs.reduce((s, ex) => s + Math.max(0, ex.end - ex.start), 0);

        const rows = box.createDiv({ cls: 'check-stat-rows' });
        this.renderStatRow(rows, t('check.plannedCount'), `${plannedCount}`, `${formatHours(plannedMinutes)}`);
        this.renderStatRow(rows, t('check.executedCount'), `${executedCount}`, `${formatHours(executedMinutes)}`);
        this.renderStatRow(rows, t('check.actualDuration'), `${weekExecs.length}`, `${formatHours(actualMinutes)}`);

        // 完成率进度条
        const ratio = plannedCount > 0 ? executedCount / plannedCount : 0;
        const barWrap = box.createDiv({ cls: 'check-progress-wrap' });
        barWrap.createDiv({ cls: 'check-progress-label', text: t('check.completionRate') });
        const bar = barWrap.createDiv({ cls: 'check-progress-bar' });
        const fill = bar.createDiv({ cls: 'check-progress-fill' });
        fill.setCssProps({ '--progress': `${Math.round(ratio * 100)}%` });
        barWrap.createDiv({ cls: 'check-progress-value', text: `${Math.round(ratio * 100)}%` });
    }

    /** 渲染一行统计：标签 + 数量 + 时长 */
    private renderStatRow(parent: HTMLElement, label: string, count: string, duration: string) {
        const row = parent.createDiv({ cls: 'check-stat-row' });
        row.createSpan({ cls: 'check-stat-label', text: label });
        row.createSpan({ cls: 'check-stat-count', text: count });
        row.createSpan({ cls: 'check-stat-duration', text: duration });
    }

    // ===== 2. 分类完成统计 =====
    private renderCategoryStats(body: HTMLElement) {
        const box = body.createDiv({ cls: 'check-box' });
        box.createDiv({ cls: 'check-box-title', text: t('check.categoryStatsTitle') });

        const weekEvents = this.getEvents().filter(ev => ev.weekKey === this.currentWeekKey && !ev.allDay);
        const weekExecs = this.getExecutions().filter(ex => ex.weekKey === this.currentWeekKey);

        // 按分类聚合：计划数 / 已执行数
        const map = new Map<string, { planned: number; executed: number }>();
        for (const ev of weekEvents) {
            const key = ev.categoryId ?? '__none__';
            const entry = map.get(key) ?? { planned: 0, executed: 0 };
            entry.planned += 1;
            if (getEventStatus(ev, weekExecs) === 'executed') entry.executed += 1;
            map.set(key, entry);
        }

        if (map.size === 0) {
            box.createDiv({ cls: 'check-empty', text: t('check.empty') });
            return;
        }

        const list = box.createDiv({ cls: 'check-category-list' });
        for (const [key, entry] of Array.from(map.entries())) {
            const cat = key === '__none__'
                ? undefined
                : this.categoryData.categories.find(c => c.id === key);
            const color = cat?.color ?? '#888888';
            const label = cat?.label ?? t('inbox.noCategory');

            const row = list.createDiv({ cls: 'check-category-row' });
            const dot = row.createSpan({ cls: 'check-category-dot' });
            dot.setCssProps({ '--dot-color': color });
            row.createSpan({ cls: 'check-category-name', text: label });

            // 进度条
            const ratio = entry.planned > 0 ? entry.executed / entry.planned : 0;
            const bar = row.createDiv({ cls: 'check-category-bar' });
            const fill = bar.createDiv({ cls: 'check-category-fill' });
            fill.setCssProps({
                '--progress': `${Math.round(ratio * 100)}%`,
                '--fill-color': hexToTransparent(color, 0.85),
            });

            row.createSpan({
                cls: 'check-category-value',
                text: `${entry.executed}/${entry.planned}`,
            });
        }
    }

    // ===== 3. 异常任务列表 =====
    private renderAbnormalList(body: HTMLElement) {
        const box = body.createDiv({ cls: 'check-box' });
        box.createDiv({ cls: 'check-box-title', text: t('check.abnormalTitle') });

        const weekEvents = this.getEvents().filter(ev => ev.weekKey === this.currentWeekKey);
        const weekExecs = this.getExecutions().filter(ex => ex.weekKey === this.currentWeekKey);

        // 未执行：计划事件（非全天）状态为 planned
        const unexecuted = weekEvents.filter(ev => !ev.allDay && getEventStatus(ev, weekExecs) === 'planned');
        // 被替换：replaced=true 的执行记录
        const replaced = weekExecs.filter(ex => ex.replaced);

        if (unexecuted.length === 0 && replaced.length === 0) {
            box.createDiv({ cls: 'check-empty', text: t('check.noAbnormal') });
            return;
        }

        const list = box.createDiv({ cls: 'check-abnormal-list' });

        // 未执行
        for (const ev of unexecuted) {
            const row = list.createDiv({ cls: 'check-abnormal-row' });
            row.createSpan({ cls: 'check-abnormal-badge is-unexecuted', text: t('check.badgeUnexecuted') });
            row.createSpan({ cls: 'check-abnormal-title', text: ev.title });
            row.createSpan({
                cls: 'check-abnormal-meta',
                text: `${getWeekDays()[ev.day - 1]} ${formatMinutes(ev.start)}-${formatMinutes(ev.end)}`,
            });
        }

        // 被替换
        for (const ex of replaced) {
            const row = list.createDiv({ cls: 'check-abnormal-row' });
            row.createSpan({ cls: 'check-abnormal-badge is-replaced', text: t('check.badgeReplaced') });
            // 标题：优先来源任务，其次关联计划事件
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
}
