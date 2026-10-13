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
import { t } from '../../i18n';

/** 改进建议的严重程度（决定徽章颜色） */
type SuggestionLevel = 'good' | 'warn' | 'bad';

/** 单条改进建议 */
interface Suggestion {
    level: SuggestionLevel;
    /** 建议标题（i18n 已求值） */
    title: string;
    /** 建议详情（i18n 已求值） */
    detail: string;
}

/**
 * 改进视图（PDCA 的 Act）：按周基于「检查」数据自动生成改进建议。
 * 单列纵向布局：周导航 → 改进建议列表。
 * 与 CheckView 一样，通过 renderInto 渲染到指定容器。
 */
export class ImproveView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: TimeBlockCategoryData;
    /** 获取全部计划事件 */
    private getEvents: () => EventBlock[];
    /** 获取全部执行记录 */
    private getExecutions: () => ExecutionRecord[];
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 当前改进的周键 */
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
        container.addClass('improve-view');

        // 顶部：周导航
        this.renderWeekNav(container);

        // 内容区（可滚动）
        const body = container.createDiv({ cls: 'improve-body' });

        // 改进建议列表
        this.renderSuggestions(body);
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

    // ===== 改进建议 =====
    private renderSuggestions(body: HTMLElement) {
        const box = body.createDiv({ cls: 'improve-box' });
        box.createDiv({ cls: 'improve-box-title', text: t('improve.suggestionsTitle') });

        const suggestions = this.buildSuggestions();

        if (suggestions.length === 0) {
            box.createDiv({ cls: 'improve-empty', text: t('improve.noSuggestion') });
            return;
        }

        const list = box.createDiv({ cls: 'improve-list' });
        for (const s of suggestions) {
            const row = list.createDiv({ cls: 'improve-item' });
            row.createSpan({ cls: `improve-badge is-${s.level}`, text: t(`improve.level.${s.level}`) });
            const textWrap = row.createDiv({ cls: 'improve-item-text' });
            textWrap.createDiv({ cls: 'improve-item-title', text: s.title });
            textWrap.createDiv({ cls: 'improve-item-detail', text: s.detail });
        }
    }

    /**
     * 基于当前周的计划/执行数据生成改进建议。
     * 规则（按优先级）：
     * 1. 本周无计划 → 提示先制定周计划
     * 2. 完成率过低 → 建议减少计划量或聚焦重点
     * 3. 存在未执行 → 建议复盘未执行原因
     * 4. 存在被替换 → 建议调整计划与实际匹配度
     * 5. 分类失衡 → 建议均衡各分类
     * 6. 完成率良好 → 正向反馈
     */
    private buildSuggestions(): Suggestion[] {
        const weekEvents = this.getEvents().filter(ev => ev.weekKey === this.currentWeekKey);
        const weekExecs = this.getExecutions().filter(ex => ex.weekKey === this.currentWeekKey);

        const timedEvents = weekEvents.filter(ev => !ev.allDay);
        const plannedCount = timedEvents.length;

        // 本周无计划
        if (plannedCount === 0) {
            return [{
                level: 'warn',
                title: t('improve.noPlanTitle'),
                detail: t('improve.noPlanDetail'),
            }];
        }

        const executedCount = timedEvents.filter(ev => getEventStatus(ev, weekExecs) === 'executed').length;
        const unexecutedCount = plannedCount - executedCount;
        const replacedCount = weekExecs.filter(ex => ex.replaced).length;
        const ratio = plannedCount > 0 ? executedCount / plannedCount : 0;

        const suggestions: Suggestion[] = [];

        // 完成率过低
        if (ratio < 0.5) {
            suggestions.push({
                level: 'bad',
                title: t('improve.lowRateTitle'),
                detail: t('improve.lowRateDetail', {
                    rate: Math.round(ratio * 100),
                    planned: plannedCount,
                    executed: executedCount,
                }),
            });
        }

        // 存在未执行
        if (unexecutedCount > 0) {
            suggestions.push({
                level: 'warn',
                title: t('improve.unexecutedTitle'),
                detail: t('improve.unexecutedDetail', { count: unexecutedCount }),
            });
        }

        // 存在被替换
        if (replacedCount > 0) {
            suggestions.push({
                level: 'warn',
                title: t('improve.replacedTitle'),
                detail: t('improve.replacedDetail', { count: replacedCount }),
            });
        }

        // 分类失衡：某分类计划占比过高（> 60%）
        const catCount = new Map<string, number>();
        for (const ev of timedEvents) {
            const key = ev.categoryId ?? '__none__';
            catCount.set(key, (catCount.get(key) ?? 0) + 1);
        }
        let dominantKey: string | undefined;
        let dominantCount = 0;
        for (const [key, count] of Array.from(catCount.entries())) {
            if (count > dominantCount) {
                dominantCount = count;
                dominantKey = key;
            }
        }
        if (dominantKey && dominantCount / plannedCount > 0.6 && catCount.size > 1) {
            const cat = dominantKey === '__none__'
                ? undefined
                : this.categoryData.categories.find(c => c.id === dominantKey);
            const label = cat?.label ?? t('inbox.noCategory');
            suggestions.push({
                level: 'warn',
                title: t('improve.imbalanceTitle'),
                detail: t('improve.imbalanceDetail', {
                    label,
                    percent: Math.round((dominantCount / plannedCount) * 100),
                }),
            });
        }

        // 完成率良好（无其他问题时给正向反馈）
        if (suggestions.length === 0 && ratio >= 0.8) {
            suggestions.push({
                level: 'good',
                title: t('improve.goodTitle'),
                detail: t('improve.goodDetail', { rate: Math.round(ratio * 100) }),
            });
        }

        // 兜底：有数据但未触发任何规则
        if (suggestions.length === 0) {
            suggestions.push({
                level: 'good',
                title: t('improve.stableTitle'),
                detail: t('improve.stableDetail', {
                    planned: plannedCount,
                    executed: executedCount,
                }),
            });
        }

        return suggestions;
    }
}
