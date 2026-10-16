import type { App } from 'obsidian';

import type { PlanCategoryData } from '../../shared/plan-category-manager';
import type { InboxData, EventBlock, ExecutionRecord, ImprovementItem } from '../../datatypes/domain';
import { getEventStatus } from '../../datatypes/domain';
import type { PdcaRepo } from '../../repos/pdca-repo';
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

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: PlanCategoryData,
        getEvents: () => EventBlock[],
        getExecutions: () => ExecutionRecord[],
        pdcaRepo: PdcaRepo,
        save: () => Promise<void>,
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.getEvents = getEvents;
        this.getExecutions = getExecutions;
        this.pdcaRepo = pdcaRepo;
        this.save = save;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('improve-view');

        // 顶部：周导航
        this.renderWeekNav(container);

        // 内容区：左右结构
        const body = container.createDiv({ cls: 'improve-body' });
        const columns = body.createDiv({ cls: 'improve-columns' });

        // 左：差异点 + 7 天执行情况
        const left = columns.createDiv({ cls: 'improve-col improve-col-left' });
        this.renderDiffPoints(left);
        this.renderDailyStats(left);

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

    // ===== 左块 1：本周计划执行差异点 =====
    private renderDiffPoints(col: HTMLElement) {
        const box = col.createDiv({ cls: 'improve-box' });
        box.createDiv({ cls: 'improve-box-title', text: t('improve.diffPointsTitle') });

        const weekEvents = this.getEvents().filter(ev => ev.weekKey === this.currentWeekKey);
        const weekExecs = this.getExecutions().filter(ex => ex.weekKey === this.currentWeekKey);
        const timedEvents = weekEvents.filter(ev => !ev.allDay);

        // 未执行：计划事件状态为 planned
        const unexecuted = timedEvents.filter(ev => getEventStatus(ev, weekExecs) === 'planned');
        // 被替换：replaced=true 的执行记录
        const replaced = weekExecs.filter(ex => ex.replaced);

        if (unexecuted.length === 0 && replaced.length === 0) {
            box.createDiv({ cls: 'improve-empty', text: t('improve.noDiff') });
            return;
        }

        const list = box.createDiv({ cls: 'improve-diff-list' });
        for (const ev of unexecuted) {
            const row = list.createDiv({ cls: 'improve-diff-row' });
            row.createSpan({ cls: 'improve-diff-badge is-unexecuted', text: t('improve.badgeUnexecuted') });
            row.createSpan({ cls: 'improve-diff-title', text: ev.title });
            row.createSpan({
                cls: 'improve-diff-meta',
                text: `${getWeekDays()[ev.day - 1]} ${this.formatMinutes(ev.start)}-${this.formatMinutes(ev.end)}`,
            });
        }
        for (const ex of replaced) {
            const row = list.createDiv({ cls: 'improve-diff-row' });
            row.createSpan({ cls: 'improve-diff-badge is-replaced', text: t('improve.badgeReplaced') });
            const item = ex.inboxId
                ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                : undefined;
            const planned = ex.eventId ? this.getEvents().find(e => e.id === ex.eventId) : undefined;
            const title = item?.title ?? planned?.title ?? t('improve.unknownTask');
            row.createSpan({ cls: 'improve-diff-title', text: title });
            row.createSpan({
                cls: 'improve-diff-meta',
                text: `${getWeekDays()[ex.day - 1]} ${this.formatMinutes(ex.start)}-${this.formatMinutes(ex.end)}`,
            });
        }
    }

    // ===== 左块 2：7 天每天执行情况 =====
    private renderDailyStats(col: HTMLElement) {
        const box = col.createDiv({ cls: 'improve-box' });
        box.createDiv({ cls: 'improve-box-title', text: t('improve.dailyStatsTitle') });

        const weekEvents = this.getEvents().filter(ev => ev.weekKey === this.currentWeekKey);
        const weekExecs = this.getExecutions().filter(ex => ex.weekKey === this.currentWeekKey);
        const days = getWeekDays();

        const list = box.createDiv({ cls: 'improve-daily-list' });
        for (let day = 1; day <= 7; day++) {
            const dayBox = list.createDiv({ cls: 'improve-daily-day' });
            dayBox.createDiv({ cls: 'improve-daily-day-title', text: days[day - 1] });

            // 计划：按分类汇总时长
            const dayEvents = weekEvents.filter(ev => ev.day === day && !ev.allDay);
            const plannedByCat = new Map<string, number>();
            for (const ev of dayEvents) {
                const key = ev.categoryId ?? '__none__';
                plannedByCat.set(key, (plannedByCat.get(key) ?? 0) + Math.max(0, ev.end - ev.start));
            }
            this.renderDailyCatRow(dayBox, t('improve.dailyPlanned'), plannedByCat);

            // 实际：按分类汇总时长（分类取来源任务）
            const dayExecs = weekExecs.filter(ex => ex.day === day);
            const actualByCat = new Map<string, number>();
            for (const ex of dayExecs) {
                const item = ex.inboxId
                    ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
                    : undefined;
                const key = item?.categoryId ?? '__none__';
                actualByCat.set(key, (actualByCat.get(key) ?? 0) + Math.max(0, ex.end - ex.start));
            }
            this.renderDailyCatRow(dayBox, t('improve.dailyActual'), actualByCat);

            // 当天计划事件完成情况
            const executedCount = dayEvents.filter(ev => getEventStatus(ev, weekExecs) === 'executed').length;
            const completion = dayBox.createDiv({ cls: 'improve-daily-completion' });
            completion.createSpan({ cls: 'improve-daily-completion-label', text: t('improve.dailyCompletion') });
            completion.createSpan({
                cls: 'improve-daily-completion-value',
                text: `${executedCount}/${dayEvents.length}`,
            });
        }
    }

    /** 渲染一天内某口径（计划/实际）的分类时长行 */
    private renderDailyCatRow(parent: HTMLElement, label: string, byCat: Map<string, number>) {
        const row = parent.createDiv({ cls: 'improve-daily-cat-row' });
        row.createSpan({ cls: 'improve-daily-cat-label', text: label });
        const chips = row.createDiv({ cls: 'improve-daily-cat-chips' });
        if (byCat.size === 0) {
            chips.createSpan({ cls: 'improve-daily-cat-empty', text: '—' });
            return;
        }
        for (const [key, minutes] of Array.from(byCat.entries())) {
            const cat = key === '__none__'
                ? undefined
                : this.categoryData.categories.find(c => c.id === key);
            const color = cat?.color ?? '#888888';
            const name = cat?.label ?? t('inbox.noCategory');
            const chip = chips.createSpan({ cls: 'improve-daily-cat-chip' });
            const dot = chip.createSpan({ cls: 'improve-daily-cat-dot' });
            dot.setCssProps({ '--dot-color': color });
            chip.createSpan({ text: `${name} ${formatHours(minutes)}` });
        }
    }

    // ===== 右块：可填写的改进项列表 =====
    private renderImprovementList(col: HTMLElement) {
        const box = col.createDiv({ cls: 'improve-box' });
        const titleRow = box.createDiv({ cls: 'improve-box-title-row' });
        titleRow.createDiv({ cls: 'improve-box-title', text: t('improve.listTitle') });
        const addBtn = titleRow.createEl('button', { cls: 'improve-add-btn', text: '+' });
        addBtn.onclick = () => void this.addImprovementItem();

        const items = this.getWeekItems();
        const list = box.createDiv({ cls: 'improve-input-list' });
        if (items.length === 0) {
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
                item.text = input.value;
                void this.save();
            };
            const delBtn = row.createEl('button', { cls: 'improve-input-del', text: '×' });
            delBtn.onclick = () => void this.removeImprovementItem(item.id);
        }
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

    /** 把分钟数格式化为 HH:MM */
    private formatMinutes(minutes: number): string {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
}
