import { t } from '../i18n';

/**
 * 周历面板：公共组件。
 * 将一年内的所有周（1-52）按从左到右、从上到下排列成格子，
 * 每个格子显示「第几周」以及「所属月份」。
 * 多个页面（年视图、泳道图等）会复用，通过回调定制交互。
 */
export interface YearWeekGridOptions {
    /** 年份，默认当前年 */
    year?: number;
    /** 点击某周时的回调 */
    onWeekClick?: (week: number) => void;
    /** 高亮的周（可选） */
    activeWeek?: number;
}

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
    const year = options.year ?? new Date().getFullYear();
    const totalWeeks = 52;

    container.empty();
    container.addClass('year-week-grid');

    const grid = container.createDiv({ cls: 'year-week-grid-inner' });

    for (let week = 1; week <= totalWeeks; week++) {
        const month = weekToMonth(year, week);
        const cell = grid.createDiv({ cls: 'year-week-cell' });

        if (options.activeWeek === week) {
            cell.addClass('is-active');
        }

        // 第几周
        cell.createDiv({ cls: 'year-week-cell-week', text: t('year.weekLabel', { week }) });
        // 所属月份
        cell.createDiv({ cls: 'year-week-cell-month', text: t('year.monthLabel', { month }) });

        cell.onclick = () => options.onWeekClick?.(week);
    }
}
