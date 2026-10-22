import type { App } from 'obsidian';

import type { PlanCategoryData } from '../../shared/plan-category-manager';
import type { InboxData, EventBlock, ExecutionRecord } from '../../datatypes/domain';
import { executionDuration, executionEndMinutes } from '../../datatypes/domain';
import type { DailyRange } from '../../shared/plan-data';
import {
    getCurrentWeekKey,
    getCurrentDayKey,
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
    private categoryData: PlanCategoryData;
    /** 获取全部计划事件 */
    private getEvents: () => EventBlock[];
    /** 获取全部执行记录 */
    private getExecutions: () => ExecutionRecord[];
    /** 获取当前激活的时间计划方案的日区间配置（计划时长的来源） */
    private getPlanSchemeDays: () => DailyRange[];
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 当前检查的周键 */
    private currentWeekKey: string = getCurrentWeekKey();
    /** 视图模式：详细 / 统计（两者互斥，默认详细） */
    private viewMode: 'detail' | 'stats' = 'detail';

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: PlanCategoryData,
        getEvents: () => EventBlock[],
        getExecutions: () => ExecutionRecord[],
        getPlanSchemeDays: () => DailyRange[],
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.getEvents = getEvents;
        this.getExecutions = getExecutions;
        this.getPlanSchemeDays = getPlanSchemeDays;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('check-view');

        // 顶部：周导航
        this.renderWeekNav(container);

        const body = container.createDiv({ cls: 'check-body' });

        // 详细模式：文字形式的执行详细情况
        if (this.viewMode === 'detail') {
            this.renderDetailSection(body);
            return;
        }

        // 统计模式：今日执行情况 + 每日执行情况 + 周统计
        // 最顶部：今日执行情况（计划 / 实际 / 差异，含事件数量与时长）
        this.renderTodaySection(body);

        // 上方：按七天逐日展示执行情况（每天一个区块，内部左中右）
        this.renderDailySection(body);

        // 下方：周统计（两行，每行左中右结构）
        this.renderWeekStats(body);
    }

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
    }

    // ===== 详细模式：文字形式的执行详细情况 =====
    /**
     * 按天列出本周所有执行记录的文字详情：
     * 每天一个区块，逐条显示「时间 · 任务名 · 分类 · 时长」。
     */
    private renderDetailSection(body: HTMLElement) {
        // 计划分布图 + 执行分布图（左右并排，固定大小）
        const chartsRow = body.createDiv({ cls: 'check-charts-row' });

        // 计划分布图（周一到周日，每列展示当天时间计划方案的时间区块分布）
        this.renderPlanChart(chartsRow);

        // 执行分布图（周一到周日，每列展示当天实际执行记录）
        this.renderExecChart(chartsRow);

        const section = body.createDiv({ cls: 'check-daily-section' });
        section.createDiv({ cls: 'check-daily-section-title', text: t('check.detailTitle') });

        const weekExecs = this.getExecutions().filter(ex => ex.weekKey === this.currentWeekKey);
        if (weekExecs.length === 0) {
            section.createDiv({ cls: 'check-daily-empty', text: t('check.detailEmpty') });
            return;
        }

        const weekDays = getWeekDays();
        for (let day = 1; day <= 7; day++) {
            const dayExecs = weekExecs
                .filter(ex => ex.day === day)
                .sort((a, b) => a.start - b.start);

            const block = section.createDiv({ cls: 'check-daily-block' });
            block.createDiv({ cls: 'check-daily-block-title', text: weekDays[day - 1] });

            if (dayExecs.length === 0) {
                block.createDiv({ cls: 'check-daily-empty', text: t('check.detailDayEmpty') });
                continue;
            }

            const list = block.createDiv({ cls: 'check-detail-list' });
            for (const ex of dayExecs) {
                const item = ex.inboxId
                    ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                    : undefined;
                const planned = ex.eventId ? this.getEvents().find(e => e.id === ex.eventId) : undefined;
                const title = item?.title ?? planned?.title ?? t('check.unknownTask');
                const cat = item?.categoryId
                    ? this.categoryData.categories.find(c => c.id === item.categoryId)
                    : undefined;

                const row = list.createDiv({ cls: 'check-detail-row' });

                // 时间
                row.createSpan({
                    cls: 'check-detail-time',
                    text: `${formatMinutes(ex.start)} - ${formatMinutes(ex.end)}${ex.endDayOffset ? ` ${t('today.crossDay')}` : ''}`,
                });

                // 分类色点
                const dot = row.createSpan({ cls: 'check-category-dot' });
                dot.setCssProps({ '--dot-color': cat?.color ?? '#888888' });

                // 任务名
                row.createSpan({ cls: 'check-detail-name', text: title });

                // 分类名
                row.createSpan({
                    cls: 'check-detail-category',
                    text: cat?.label ?? t('inbox.noCategory'),
                });

                // 时长
                row.createSpan({
                    cls: 'check-detail-duration',
                    text: t('check.detailDuration', { duration: formatHours(executionDuration(ex)) }),
                });
            }
        }
    }

    // ===== 详细模式：计划 / 执行分布图 =====
    /**
     * 计划分布图：横坐标为周一到周日，每列纵向按 24 小时展示当天
     * 时间计划方案的时间区块（按分类颜色填充），类似柱状图。
     */
    private renderPlanChart(body: HTMLElement) {
        // 每天的时间区块：来自时间计划方案
        const blocksByDay = new Map<number, { start: number; end: number; categoryId?: string }[]>();
        for (let day = 1; day <= 7; day++) {
            const dayData = this.getPlanSchemeDays().find(d => d.day === day);
            blocksByDay.set(day, (dayData?.ranges ?? []).map(r => ({
                start: r.start,
                end: r.end,
                categoryId: r.sort,
            })));
        }
        this.renderDistributionChart(body, t('check.detailPlanChartTitle'), blocksByDay);
    }

    /**
     * 执行分布图：横坐标为周一到周日，每列纵向按 24 小时展示当天
     * 实际执行记录（按来源任务分类颜色填充），绘制逻辑与计划分布图一致。
     */
    private renderExecChart(body: HTMLElement) {
        const weekExecs = this.getExecutions().filter(ex => ex.weekKey === this.currentWeekKey);
        const blocksByDay = new Map<number, { start: number; end: number; categoryId?: string }[]>();
        for (let day = 1; day <= 7; day++) {
            blocksByDay.set(day, weekExecs
                .filter(ex => ex.day === day)
                .map(ex => {
                    const item = ex.inboxId
                        ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                        : undefined;
                    return { start: ex.start, end: Math.min(24 * 60, executionEndMinutes(ex)), categoryId: item?.categoryId };
                }));
        }
        this.renderDistributionChart(body, t('check.detailExecChartTitle'), blocksByDay);
    }

    /**
     * 渲染分布图（计划 / 执行共用）：
     * 横坐标为周一到周日，每列纵向按 24 小时展示时间区块（按分类颜色填充）。
     */
    private renderDistributionChart(
        body: HTMLElement,
        title: string,
        blocksByDay: Map<number, { start: number; end: number; categoryId?: string }[]>,
    ) {
        const section = body.createDiv({ cls: 'check-daily-section' });
        section.createDiv({ cls: 'check-daily-section-title', text: title });

        const chart = section.createDiv({ cls: 'check-plan-chart' });

        // 左侧时间刻度（每 2 小时一格，共 12 格）
        const axis = chart.createDiv({ cls: 'check-plan-chart-axis' });
        for (let h = 0; h < 24; h += 2) {
            axis.createDiv({ cls: 'check-plan-chart-axis-cell' })
                .setText(`${String(h).padStart(2, '0')}:00`);
        }

        // 7 列（周一到周日）
        const cols = chart.createDiv({ cls: 'check-plan-chart-cols' });
        const weekDays = getWeekDays();
        for (let day = 1; day <= 7; day++) {
            const col = cols.createDiv({ cls: 'check-plan-chart-col' });

            // 列标题（星期）
            col.createDiv({ cls: 'check-plan-chart-col-title', text: weekDays[day - 1] });

            // 列主体：24 小时背景 + 时间区块
            const track = col.createDiv({ cls: 'check-plan-chart-track' });
            for (const range of blocksByDay.get(day) ?? []) {
                const cat = range.categoryId
                    ? this.categoryData.categories.find(c => c.id === range.categoryId)
                    : undefined;
                const block = track.createDiv({ cls: 'check-plan-chart-block' });
                block.setCssProps({
                    '--block-color': cat?.color ?? '#888888',
                    '--block-top': `${(range.start / 1440) * 100}%`,
                    '--block-height': `${(Math.max(0, range.end - range.start) / 1440) * 100}%`,
                });
                block.setAttribute('title', `${cat?.label ?? t('inbox.noCategory')} ${formatMinutes(range.start)}-${formatMinutes(range.end)}`);
            }
        }
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

        // 详细 / 统计按钮（互斥：同一时刻只有一个处于激活态）
        const detailBtn = nav.createEl('button', {
            text: t('check.detailBtn'),
            cls: 'check-week-nav-mode-btn',
        });
        detailBtn.toggleClass('is-active', this.viewMode === 'detail');
        detailBtn.onclick = () => {
            if (this.viewMode === 'detail') return;
            this.viewMode = 'detail';
            void this.refresh();
        };

        const statsBtn = nav.createEl('button', {
            text: t('check.statsBtn'),
            cls: 'check-week-nav-mode-btn',
        });
        statsBtn.toggleClass('is-active', this.viewMode === 'stats');
        statsBtn.onclick = () => {
            if (this.viewMode === 'stats') return;
            this.viewMode = 'stats';
            void this.refresh();
        };
    }

    // ===== 下方：周统计（两行，每行左中右结构）=====
    /**
     * 周统计：
     * 第一行：本周计划 + 本周执行 + 差异；
     * 第二行：上周执行 + 本周执行 + 差异。
     */
    private renderWeekStats(body: HTMLElement) {
        const section = body.createDiv({ cls: 'check-daily-section' });
        section.createDiv({ cls: 'check-daily-section-title', text: t('check.weekStatsTitle') });

        const prevWeekKey = shiftWeekKey(this.currentWeekKey, -1);

        // 本周计划（来自时间计划方案，按分类汇总七天区间时长）
        const plannedEntries: { categoryId?: string; minutes: number }[] = [];
        for (const dayData of this.getPlanSchemeDays()) {
            for (const r of dayData.ranges ?? []) {
                plannedEntries.push({ categoryId: r.sort, minutes: Math.max(0, r.end - r.start) });
            }
        }
        const currPlannedMap = this.aggregateByCategory(plannedEntries);

        // 本周执行（按分类，分类取来源任务）
        const currActualMap = this.aggregateByCategory(
            this.getExecutions()
                .filter(ex => ex.weekKey === this.currentWeekKey)
                .map(ex => {
                    const item = ex.inboxId
                        ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                        : undefined;
                    return { categoryId: item?.categoryId, minutes: executionDuration(ex) };
                }),
        );

        // 上周执行（按分类）
        const prevActualMap = this.aggregateByCategory(
            this.getExecutions()
                .filter(ex => ex.weekKey === prevWeekKey)
                .map(ex => {
                    const item = ex.inboxId
                        ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                        : undefined;
                    return { categoryId: item?.categoryId, minutes: executionDuration(ex) };
                }),
        );

        // 第一行：本周计划 + 本周执行 + 差异（执行 - 计划）
        const row1 = section.createDiv({ cls: 'check-daily-block' });
        row1.createDiv({ cls: 'check-daily-block-title', text: t('check.weekRow1Title') });
        const cols1 = row1.createDiv({ cls: 'check-daily-cols' });
        this.renderExecVsActualColumn(cols1, currPlannedMap, currActualMap);
        this.renderDiffColumn(cols1, this.diffMap(currActualMap, currPlannedMap));

        // 第二行：上周执行 + 本周执行 + 差异（本周 - 上周）
        const row2 = section.createDiv({ cls: 'check-daily-block' });
        row2.createDiv({ cls: 'check-daily-block-title', text: t('check.weekRow2Title') });
        const cols2 = row2.createDiv({ cls: 'check-daily-cols' });
        this.renderExecVsActualColumn(cols2, prevActualMap, currActualMap);
        this.renderDiffColumn(cols2, this.diffMap(currActualMap, prevActualMap));
    }

    /** 计算差异映射：a - b（按分类） */
    private diffMap(a: Map<string, number>, b: Map<string, number>): Map<string, number> {
        const diff = new Map<string, number>();
        for (const [key, minutes] of Array.from(a.entries())) {
            diff.set(key, (diff.get(key) ?? 0) + minutes);
        }
        for (const [key, minutes] of Array.from(b.entries())) {
            diff.set(key, (diff.get(key) ?? 0) - minutes);
        }
        return diff;
    }

    // ===== 最顶部：今日执行情况 =====
    /**
     * 今日执行情况：以「今天」为对象，按分类展示计划 / 实际 / 差异，
     * 每行同时显示事件数量与时长。
     */
    private renderTodaySection(body: HTMLElement) {
        const section = body.createDiv({ cls: 'check-daily-section' });
        section.createDiv({ cls: 'check-daily-section-title', text: t('check.todayTitle') });

        const todayKey = getCurrentDayKey();
        // 今天对应的星期几（1=周一 ... 7=周日）
        const todayDay = ((new Date().getDay() + 6) % 7) + 1;

        // 计划：今天的计划方案区间，按分类统计数量与时长
        const plannedMap = this.aggregateCountDuration(
            (this.getPlanSchemeDays().find(d => d.day === todayDay)?.ranges ?? [])
                .map(r => ({ categoryId: r.sort, minutes: Math.max(0, r.end - r.start) })),
        );

        // 实际：今天的执行记录，按分类统计数量与时长
        const actualMap = this.aggregateCountDuration(
            this.getExecutions()
                .filter(ex => ex.day === todayDay && ex.weekKey === getCurrentWeekKey())
                .map(ex => {
                    const item = ex.inboxId
                        ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                        : undefined;
                    return { categoryId: item?.categoryId, minutes: executionDuration(ex) };
                }),
        );

        const block = section.createDiv({ cls: 'check-daily-block' });
        block.createDiv({ cls: 'check-daily-block-title', text: todayKey });
        const cols = block.createDiv({ cls: 'check-daily-cols' });
        // 执行 vs 实际（计划 / 实际时长，方块进度条）
        this.renderExecVsActualColumn(
            cols,
            this.countDurationToMinutes(plannedMap),
            this.countDurationToMinutes(actualMap),
        );
        // 差异点（实际 - 计划）
        this.renderDiffColumn(cols, this.diffCountDurationToMinutes(actualMap, plannedMap));
    }

    /** 将「数量 + 时长」映射转为「分类 → 分钟」映射 */
    private countDurationToMinutes(
        map: Map<string, { count: number; minutes: number }>,
    ): Map<string, number> {
        const result = new Map<string, number>();
        map.forEach((v, k) => result.set(k, v.minutes));
        return result;
    }

    /** 计算「数量 + 时长」映射的差异（a - b），返回「分类 → 分钟」 */
    private diffCountDurationToMinutes(
        a: Map<string, { count: number; minutes: number }>,
        b: Map<string, { count: number; minutes: number }>,
    ): Map<string, number> {
        const diff = new Map<string, number>();
        a.forEach((v, k) => diff.set(k, (diff.get(k) ?? 0) + v.minutes));
        b.forEach((v, k) => diff.set(k, (diff.get(k) ?? 0) - v.minutes));
        return diff;
    }

    /** 按分类聚合「数量 + 时长」 */
    private aggregateCountDuration(
        entries: { categoryId?: string; minutes: number }[],
    ): Map<string, { count: number; minutes: number }> {
        const map = new Map<string, { count: number; minutes: number }>();
        for (const e of entries) {
            const key = e.categoryId ?? '__none__';
            const cur = map.get(key) ?? { count: 0, minutes: 0 };
            cur.count += 1;
            cur.minutes += e.minutes;
            map.set(key, cur);
        }
        return map;
    }

    // ===== 下方：按七天逐日展示执行情况 =====
    /** 按天展示：每天一个区块，内部左（执行 vs 实际）/ 右（差异点） */
    private renderDailySection(body: HTMLElement) {
        const section = body.createDiv({ cls: 'check-daily-section' });
        section.createDiv({ cls: 'check-daily-section-title', text: t('check.dailyTitle') });

        const weekExecs = this.getExecutions().filter(ex => ex.weekKey === this.currentWeekKey);
        const weekDays = getWeekDays();

        for (let day = 1; day <= 7; day++) {
            const block = section.createDiv({ cls: 'check-daily-block' });
            block.createDiv({ cls: 'check-daily-block-title', text: weekDays[day - 1] });

            const cols = block.createDiv({ cls: 'check-daily-cols' });

            // 左：当天计划时长（来自时间计划方案，按分类）
            const plannedMap = this.plannedMapForDay(day);

            // 中：当天实际执行时长（按分类，分类取来源任务）
            const actualEntries = weekExecs
                .filter(ex => ex.day === day)
                .map(ex => {
                    const item = ex.inboxId
                        ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                        : undefined;
                    return { categoryId: item?.categoryId, minutes: executionDuration(ex) };
                });
            const actualMap = this.aggregateByCategory(actualEntries);

            // 右：差异（实际 - 计划），按分类
            const diffMap = this.diffMap(actualMap, plannedMap);

            // 执行 vs 实际（计划 / 实际时长，方块进度条）
            this.renderExecVsActualColumn(cols, plannedMap, actualMap);
            // 差异点
            this.renderDiffColumn(cols, diffMap);
        }
    }

    /** 某天的计划时长（来自时间计划方案，按分类聚合区间分钟数） */
    private plannedMapForDay(day: number): Map<string, number> {
        const dayData = this.getPlanSchemeDays().find(d => d.day === day);
        const ranges = dayData?.ranges ?? [];
        return this.aggregateByCategory(
            ranges.map(r => ({ categoryId: r.sort, minutes: Math.max(0, r.end - r.start) })),
        );
    }

    /** 按分类聚合时长（返回 分类键 → 分钟） */
    private aggregateByCategory(entries: { categoryId?: string; minutes: number }[]): Map<string, number> {
        const map = new Map<string, number>();
        for (const e of entries) {
            const key = e.categoryId ?? '__none__';
            map.set(key, (map.get(key) ?? 0) + e.minutes);
        }
        return map;
    }

    // ===== 统计模式：两列布局（执行 vs 实际 / 差异点）=====
    /**
     * 渲染「执行 vs 实际」列：每个分类一行，显示分类名 + 计划/实际时长文字，
     * 下方两条方块进度条（每满 1 小时一个方块）：
     * - 第一条：仅边框（计划时长）
     * - 第二条：实心分类色（实际时长）
     */
    private renderExecVsActualColumn(
        cols: HTMLElement,
        plannedMap: Map<string, number>,
        actualMap: Map<string, number>,
    ) {
        const col = cols.createDiv({ cls: 'check-daily-col' });
        col.createDiv({ cls: 'check-daily-col-title', text: t('check.execVsActual') });

        // 合并出现过的分类（计划 + 实际），按分类列表顺序稳定输出
        const keys = new Set<string>();
        plannedMap.forEach((_v, k) => keys.add(k));
        actualMap.forEach((_v, k) => keys.add(k));
        if (keys.size === 0) {
            col.createDiv({ cls: 'check-daily-empty', text: t('check.dailyEmpty') });
            return;
        }

        const ordered = this.categoryData.categories.filter(c => keys.has(c.id));
        if (keys.has('__none__')) {
            ordered.push({ id: '__none__', label: t('inbox.noCategory'), color: '#888888' });
        }

        const list = col.createDiv({ cls: 'check-daily-list' });
        for (const cat of ordered) {
            const planned = plannedMap.get(cat.id) ?? 0;
            const actual = actualMap.get(cat.id) ?? 0;
            const color = cat.color ?? '#888888';

            const row = list.createDiv({ cls: 'check-exec-row' });

            // 第一行：分类名 + 计划/实际时长文字
            const head = row.createDiv({ cls: 'check-exec-head' });
            const dot = head.createSpan({ cls: 'check-category-dot' });
            dot.setCssProps({ '--dot-color': color });
            head.createSpan({ cls: 'check-daily-name', text: cat.label });
            head.createSpan({
                cls: 'check-exec-values',
                text: `${t('check.dailyPlanned')} ${formatHours(planned)} / ${t('check.dailyActual')} ${formatHours(actual)}`,
            });

            // 第一条：计划（仅边框方块）
            this.renderDurationBlocks(row, planned, color, true);
            // 第二条：实际执行（实心分类色方块）
            this.renderDurationBlocks(row, actual, color, false);
        }
    }

    /**
     * 渲染方块进度条：每满 1 小时一个方块，不足 1 小时的余数用部分填充的方块。
     * outline 为 true 时仅显示边框（计划），否则实心填充（实际）。
     */
    private renderDurationBlocks(container: HTMLElement, minutes: number, color: string, outline: boolean) {
        const blocks = container.createDiv({ cls: 'check-exec-blocks' });
        if (minutes <= 0) {
            blocks.createDiv({ cls: 'check-exec-blocks-empty', text: t('check.dailyEmpty') });
            return;
        }
        const fullHours = Math.floor(minutes / 60);
        const remainder = minutes % 60;
        const blockCount = fullHours + (remainder > 0 ? 1 : 0);
        for (let i = 0; i < blockCount; i++) {
            const block = blocks.createDiv({ cls: 'check-exec-block' });
            block.setCssProps({ '--block-color': color });
            if (outline) block.addClass('is-outline');
            // 最后一个方块为不足 1 小时的余数时，按比例填充
            const isPartial = remainder > 0 && i === blockCount - 1;
            const fillPercent = isPartial ? Math.round((remainder / 60) * 100) : 100;
            const fill = block.createDiv({ cls: 'check-exec-block-fill' });
            fill.setCssProps({ '--fill-width': `${fillPercent}%` });
        }
    }

    /** 渲染「差异点」列：按分类显示差异时长（实际 - 计划），带正负号与颜色区分 */
    private renderDiffColumn(cols: HTMLElement, diffMap: Map<string, number>) {
        const col = cols.createDiv({ cls: 'check-daily-col' });
        col.createDiv({ cls: 'check-daily-col-title', text: t('check.diffPoints') });

        if (diffMap.size === 0) {
            col.createDiv({ cls: 'check-daily-empty', text: t('check.dailyEmpty') });
            return;
        }

        const list = col.createDiv({ cls: 'check-daily-list' });
        for (const [key, minutes] of Array.from(diffMap.entries())) {
            const cat = key === '__none__'
                ? undefined
                : this.categoryData.categories.find(c => c.id === key);
            const color = cat?.color ?? '#888888';
            const label = cat?.label ?? t('inbox.noCategory');

            const row = list.createDiv({ cls: 'check-daily-row' });
            const dot = row.createSpan({ cls: 'check-category-dot' });
            dot.setCssProps({ '--dot-color': color });
            row.createSpan({ cls: 'check-daily-name', text: label });
            const valueEl = row.createSpan({ cls: 'check-daily-value' });
            const sign = minutes > 0 ? '+' : minutes < 0 ? '-' : '';
            valueEl.setText(`${sign}${formatHours(Math.abs(minutes))}`);
            valueEl.toggleClass('is-over', minutes > 0);
            valueEl.toggleClass('is-under', minutes < 0);
        }
    }
}
