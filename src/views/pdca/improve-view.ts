import type { App } from 'obsidian';

import type { PlanCategoryData } from '../../shared/plan-category-manager';
import type { InboxData, EventBlock, ExecutionRecord, ImprovementItem } from '../../datatypes/domain';
import { getEventStatus, OKR_CONDITION_META } from '../../datatypes/domain';
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
        const box = col.createDiv({ cls: 'improve-box' });
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

            // 分类色点 + 任务名
            const cat = item.categoryId
                ? this.categoryData.categories.find(c => c.id === item.categoryId)
                : undefined;
            const dot = row.createSpan({ cls: 'improve-week-task-dot' });
            dot.setCssProps({ '--dot-color': cat?.color ?? '#888888' });
            row.createSpan({ cls: 'improve-week-task-name', text: item.title });

            // 本周执行情况：执行次数 + 总时长
            const execs = weekExecs.filter(ex => ex.inboxId === item.id);
            const totalMinutes = execs.reduce((s, ex) => s + Math.max(0, ex.end - ex.start), 0);
            const meta = row.createDiv({ cls: 'improve-week-task-meta' });
            meta.createSpan({
                cls: 'improve-week-task-chip',
                text: t('improve.weekTaskExecCount', { count: String(execs.length) }),
            });
            meta.createSpan({
                cls: 'improve-week-task-chip',
                text: t('improve.weekTaskDuration', { duration: formatHours(totalMinutes) }),
            });

            // 本周新增 OKR 进度：仅统计本周执行记录带来的增量
            const conditions = item.okr?.conditions ?? [];
            if (conditions.length > 0) {
                const okrRow = row.createDiv({ cls: 'improve-week-task-okr' });
                okrRow.createSpan({ cls: 'improve-week-task-okr-label', text: t('improve.weekTaskOkrNew') });
                for (const cond of conditions) {
                    const unit = t(OKR_CONDITION_META[cond.type].unitKey as Parameters<typeof t>[0]);
                    // 时长类型：本周执行总时长；成果类型：本周执行次数
                    const added = cond.type === 'duration' ? totalMinutes : execs.length;
                    okrRow.createSpan({
                        cls: 'improve-week-task-okr-chip',
                        text: `+${added} ${unit}`,
                    });
                }
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
}
