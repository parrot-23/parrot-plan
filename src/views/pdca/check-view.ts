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

        const body = container.createDiv({ cls: 'check-body' });

        // 上方：按七天逐日展示执行情况（每天一个区块，内部左中右）
        this.renderDailySection(body);

        // 下方：周统计（两行，每行左中右结构）
        this.renderWeekStats(body);
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

        // 本周计划（按分类，排除全天事件）
        const currPlannedMap = this.aggregateByCategory(
            this.getEvents()
                .filter(ev => ev.weekKey === this.currentWeekKey && !ev.allDay)
                .map(ev => ({ categoryId: ev.categoryId, minutes: Math.max(0, ev.end - ev.start) })),
        );

        // 本周执行（按分类，分类取来源任务）
        const currActualMap = this.aggregateByCategory(
            this.getExecutions()
                .filter(ex => ex.weekKey === this.currentWeekKey)
                .map(ex => {
                    const item = ex.inboxId
                        ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                        : undefined;
                    return { categoryId: item?.categoryId, minutes: Math.max(0, ex.end - ex.start) };
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
                    return { categoryId: item?.categoryId, minutes: Math.max(0, ex.end - ex.start) };
                }),
        );

        // 第一行：本周计划 + 本周执行 + 差异（执行 - 计划）
        const row1 = section.createDiv({ cls: 'check-daily-block' });
        row1.createDiv({ cls: 'check-daily-block-title', text: t('check.weekRow1Title') });
        const cols1 = row1.createDiv({ cls: 'check-daily-cols' });
        this.renderDailyColumn(cols1, t('check.dailyPlanned'), currPlannedMap);
        this.renderDailyColumn(cols1, t('check.dailyActual'), currActualMap);
        this.renderDailyColumn(cols1, t('check.dailyDiff'), this.diffMap(currActualMap, currPlannedMap), true);

        // 第二行：上周执行 + 本周执行 + 差异（本周 - 上周）
        const row2 = section.createDiv({ cls: 'check-daily-block' });
        row2.createDiv({ cls: 'check-daily-block-title', text: t('check.weekRow2Title') });
        const cols2 = row2.createDiv({ cls: 'check-daily-cols' });
        this.renderDailyColumn(cols2, t('check.prevWeekActual'), prevActualMap);
        this.renderDailyColumn(cols2, t('check.dailyActual'), currActualMap);
        this.renderDailyColumn(cols2, t('check.dailyDiff'), this.diffMap(currActualMap, prevActualMap), true);
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

    // ===== 下方：按七天逐日展示执行情况 =====
    /** 按天展示：每天一个区块，内部左（计划分类时长）/ 中（实际分类时长）/ 右（差异） */
    private renderDailySection(body: HTMLElement) {
        const section = body.createDiv({ cls: 'check-daily-section' });
        section.createDiv({ cls: 'check-daily-section-title', text: t('check.dailyTitle') });

        const weekEvents = this.getEvents().filter(ev => ev.weekKey === this.currentWeekKey);
        const weekExecs = this.getExecutions().filter(ex => ex.weekKey === this.currentWeekKey);
        const weekDays = getWeekDays();

        for (let day = 1; day <= 7; day++) {
            const block = section.createDiv({ cls: 'check-daily-block' });
            block.createDiv({ cls: 'check-daily-block-title', text: weekDays[day - 1] });

            const cols = block.createDiv({ cls: 'check-daily-cols' });

            // 左：当天计划时长（按分类，排除全天事件）
            const plannedEntries = weekEvents
                .filter(ev => ev.day === day && !ev.allDay)
                .map(ev => ({ categoryId: ev.categoryId, minutes: Math.max(0, ev.end - ev.start) }));
            const plannedMap = this.aggregateByCategory(plannedEntries);

            // 中：当天实际执行时长（按分类，分类取来源任务）
            const actualEntries = weekExecs
                .filter(ex => ex.day === day)
                .map(ex => {
                    const item = ex.inboxId
                        ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                        : undefined;
                    return { categoryId: item?.categoryId, minutes: Math.max(0, ex.end - ex.start) };
                });
            const actualMap = this.aggregateByCategory(actualEntries);

            // 右：差异（实际 - 计划），按分类
            const diffMap = new Map<string, number>();
            for (const [key, minutes] of Array.from(plannedMap.entries())) {
                diffMap.set(key, (diffMap.get(key) ?? 0) - minutes);
            }
            for (const [key, minutes] of Array.from(actualMap.entries())) {
                diffMap.set(key, (diffMap.get(key) ?? 0) + minutes);
            }

            this.renderDailyColumn(cols, t('check.dailyPlanned'), plannedMap);
            this.renderDailyColumn(cols, t('check.dailyActual'), actualMap);
            this.renderDailyColumn(cols, t('check.dailyDiff'), diffMap, true);
        }
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

    /** 渲染逐日区块中的一列（计划 / 实际 / 差异） */
    private renderDailyColumn(
        cols: HTMLElement,
        title: string,
        map: Map<string, number>,
        showSign = false,
    ) {
        const col = cols.createDiv({ cls: 'check-daily-col' });
        col.createDiv({ cls: 'check-daily-col-title', text: title });

        if (map.size === 0) {
            col.createDiv({ cls: 'check-daily-empty', text: t('check.dailyEmpty') });
            return;
        }

        const list = col.createDiv({ cls: 'check-daily-list' });
        for (const [key, minutes] of Array.from(map.entries())) {
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
            if (showSign) {
                const sign = minutes > 0 ? '+' : minutes < 0 ? '-' : '';
                valueEl.setText(`${sign}${formatHours(Math.abs(minutes))}`);
                valueEl.toggleClass('is-over', minutes > 0);
                valueEl.toggleClass('is-under', minutes < 0);
            } else {
                valueEl.setText(formatHours(minutes));
            }
        }
    }
}
