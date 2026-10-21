import { getWeekDays } from '../i18n';

/**
 * 周面板：公共组件。
 * 渲染「一周七天，每天一列」的面板骨架（表头 + 7 列）。
 * 各视图拿到返回的容器引用后，再渲染各自的业务内容（当天任务清单等）。
 */

/** 周面板渲染后返回的关键容器引用 */
export interface WeekPanelRefs {
    /** 整个面板容器（.week-panel） */
    panel: HTMLElement;
    /** 表头行（.week-panel-header） */
    headerRow: HTMLElement;
    /** 统计行（.week-panel-stats），每天一个统计单元格 */
    statsRow: HTMLElement;
    /** 7 个统计单元格（.week-panel-stats-cell） */
    statsCells: HTMLElement[];
    /** 表体滚动容器（.week-panel-columns） */
    columnsRow: HTMLElement;
    /** 习惯任务网格（.week-panel-habit-grid），与日列网格同宽、按周等分 7 列 */
    habitGrid: HTMLElement;
    /** 当天任务网格（.week-panel-day-grid），7 个日期列 */
    dayGrid: HTMLElement;
    /** 7 个日期列（.week-panel-column） */
    dayColumns: HTMLElement[];
}

export interface WeekPanelOptions {
    /** 点击某天列时的回调（day: 1-7） */
    onColumnClick?: (day: number) => void;
}

/**
 * 渲染周面板骨架到指定容器。
 * 注意：调用方需自行在容器内创建根节点（或直接传入该根节点）。
 */
export function renderWeekPanel(
    container: HTMLElement,
    options: WeekPanelOptions = {},
): WeekPanelRefs {
    const panel = container.createDiv({ cls: 'week-panel' });

    // ===== 表头行（星期表头）=====
    const headerRow = panel.createDiv({ cls: 'week-panel-header' });
    const days = getWeekDays();
    for (let d = 1; d <= 7; d++) {
        const header = headerRow.createDiv({ cls: 'week-panel-header-cell' });
        header.setText(days[d - 1]);
    }

    // ===== 统计行（每天一个统计单元格，由调用方填充内容）=====
    const statsRow = panel.createDiv({ cls: 'week-panel-stats' });
    const statsCells: HTMLElement[] = [];
    for (let d = 1; d <= 7; d++) {
        const cell = statsRow.createDiv({ cls: 'week-panel-stats-cell' });
        statsCells.push(cell);
    }

    // ===== 表体滚动容器 =====
    const columnsRow = panel.createDiv({ cls: 'week-panel-columns' });

    // ===== 习惯任务网格（跨列合并同一任务，与日列网格同宽） =====
    const habitGrid = columnsRow.createDiv({ cls: 'week-panel-habit-grid' });

    // ===== 当天任务网格（7 列日期面板） =====
    const dayGrid = columnsRow.createDiv({ cls: 'week-panel-day-grid' });
    const dayColumns: HTMLElement[] = [];
    for (let d = 1; d <= 7; d++) {
        const col = dayGrid.createDiv({ cls: 'week-panel-column' });
        col.onclick = () => options.onColumnClick?.(d);
        dayColumns.push(col);
    }

    return { panel, headerRow, statsRow, statsCells, columnsRow, habitGrid, dayGrid, dayColumns };
}
