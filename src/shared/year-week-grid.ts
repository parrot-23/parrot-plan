import { t } from '../i18n';
import { makeWeekKey, getISOWeek, hexToTransparent } from '../views/week-view/timeblock-data';
import { EVENT_STATUS_EMOJI } from './event-status';

/**
 * 周历面板：公共组件。
 * 将一年内的所有周（1-52）按从左到右、从上到下排列成格子，
 * 每个格子显示「第几周」以及「所属月份」。
 * 多个页面（年视图、泳道图等）会复用，通过回调定制交互。
 */
export interface YearWeekGridOptions {
    /** 年份，默认当前年 */
    year?: number;
    /** 点击某周时的回调（year: 当前年份，week: 周号） */
    onWeekClick?: (week: number, year: number) => void;
    /** 高亮的周（可选） */
    activeWeek?: number;
    /** 各周已分配的任务（周键 → 任务列表），用于在格子内展示 */
    assignedTasks?: Record<string, { title: string; color?: string }[]>;
    /** 已制定周计划的周键列表，用于在格子左上角显示图标 */
    plannedWeeks?: string[];
}

/** 12 个月的固定配色（同一月份始终同色） */
const MONTH_COLORS = [
    '#e57373', // 1 月
    '#f06292', // 2 月
    '#ba68c8', // 3 月
    '#9575cd', // 4 月
    '#7986cb', // 5 月
    '#64b5f6', // 6 月
    '#4fc3f7', // 7 月
    '#4db6ac', // 8 月
    '#81c784', // 9 月
    '#aed581', // 10 月
    '#ffb74d', // 11 月
    '#a1887f', // 12 月
];

/** 计算某年第 N 周（ISO 周）所属的月份（1-12） */
function weekToMonth(year: number, week: number): number {
    // ISO 第 1 周：包含 1 月 4 日的那一周
    const jan4 = new Date(year, 0, 4);
    const jan4Day = jan4.getDay(); // 0=周日
    // 1 月 4 日所在周的周一
    const firstMonday = new Date(year, 0, 4 - ((jan4Day + 6) % 7));
    // 第 week 周的周一
    const monday = new Date(firstMonday);
    monday.setDate(firstMonday.getDate() + (week - 1) * 7);
    // 取该周周四（ISO 周的代表日）所在月份
    const thursday = new Date(monday);
    thursday.setDate(monday.getDate() + 3);
    return thursday.getMonth() + 1;
}

/** 渲染周历面板到指定容器 */
export function renderYearWeekGrid(
    container: HTMLElement,
    options: YearWeekGridOptions = {},
): void {
    let year = options.year ?? new Date().getFullYear();
    const totalWeeks = 52;

    // 当前所在周（用于特别标明）
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentWeek = getISOWeek(now);

    container.empty();
    container.addClass('year-week-grid');

    // ===== 顶部：年度切换 =====
    const nav = container.createDiv({ cls: 'year-week-nav' });

    const prevBtn = nav.createEl('button', {
        text: '‹',
        cls: 'year-week-nav-btn',
    });
    prevBtn.onclick = () => {
        year -= 1;
        render();
    };

    const yearLabel = nav.createDiv({ cls: 'year-week-nav-year' });

    const nextBtn = nav.createEl('button', {
        text: '›',
        cls: 'year-week-nav-btn',
    });
    nextBtn.onclick = () => {
        year += 1;
        render();
    };

    // 快速回到今年
    const todayBtn = nav.createEl('button', {
        text: t('year.thisYear'),
        cls: 'year-week-nav-btn year-week-nav-today',
    });
    todayBtn.onclick = () => {
        year = new Date().getFullYear();
        render();
    };

    // ===== 网格容器（每 3 个月一行，共 4 行）=====
    const grid = container.createDiv({ cls: 'year-week-grid-inner' });

    function render() {
        yearLabel.setText(String(year));
        // 当前显示的是今年时，高亮「今年」按钮
        todayBtn.toggleClass('is-active', year === new Date().getFullYear());
        grid.empty();

        // 每行 13 周（约 3 个月），共 4 行
        const weeksPerRow = 13;
        const rowCount = Math.ceil(totalWeeks / weeksPerRow);

        for (let row = 0; row < rowCount; row++) {
            const rowEl = grid.createDiv({ cls: 'year-week-row' });

            for (let i = 0; i < weeksPerRow; i++) {
                const week = row * weeksPerRow + i + 1;
                if (week > totalWeeks) {
                    // 补齐占位，保持列对齐
                    rowEl.createDiv({ cls: 'year-week-cell is-empty' });
                    continue;
                }

                const month = weekToMonth(year, week);
                const cell = rowEl.createDiv({ cls: 'year-week-cell' });

                if (options.activeWeek === week) {
                    cell.addClass('is-active');
                }

                // 当前所在周：特别标明（仅当显示的是今年时）
                if (year === currentYear && week === currentWeek) {
                    cell.addClass('is-current-week');
                }

                // 左上角：月份（带固定配色背景）；右上角：周数
                const monthEl = cell.createDiv({ cls: 'year-week-cell-month', text: t('year.monthLabel', { month }) });
                monthEl.setCssProps({ '--month-color': MONTH_COLORS[(month - 1) % 12] });
                cell.createDiv({ cls: 'year-week-cell-week', text: t('year.weekLabel', { week }) });

                // 已制定周计划：左上角显示计划图标（与事件状态「计划」图标一致）
                const weekKey = makeWeekKey(year, week);
                if (options.plannedWeeks?.includes(weekKey)) {
                    cell.createDiv({
                        cls: 'year-week-cell-planned',
                        text: EVENT_STATUS_EMOJI.planned,
                    });
                }

                // 已分配到该周的任务
                const tasks = options.assignedTasks?.[weekKey] ?? [];
                if (tasks.length > 0) {
                    const taskList = cell.createDiv({ cls: 'year-week-cell-tasks' });
                    for (const task of tasks) {
                        const taskEl = taskList.createDiv({ cls: 'year-week-cell-task', text: task.title });
                        if (task.color) {
                            taskEl.setCssProps({
                                '--task-color': task.color,
                                // 浅色同色背景：分类颜色降低透明度
                                '--task-bg': hexToTransparent(task.color, 0.18),
                            });
                        }
                    }
                }

                cell.onclick = () => options.onWeekClick?.(week, year);
            }
        }
    }

    render();
}
