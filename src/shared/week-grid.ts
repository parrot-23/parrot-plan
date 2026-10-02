import { getWeekDays } from '../i18n';

/**
 * 周网格日历：公共组件。
 * 渲染「时间轴 + 7 列日期网格」的骨架（表头、时间刻度、日期列背景格子）。
 * 多个视图（周计划、当日执行等）会复用，各视图拿到返回的容器引用后，
 * 再渲染各自的业务内容（时间区块、事件卡片等）。
 */

/** 周网格渲染后返回的关键容器引用 */
export interface WeekGridRefs {
    /** 整个网格容器（.schedule-grid） */
    grid: HTMLElement;
    /** 表头行（.grid-header-row） */
    headerRow: HTMLElement;
    /** 7 列日期网格容器（.day-bodies） */
    bodyRowInner: HTMLElement;
    /** 7 个日期列（.day-column） */
    dayColumns: HTMLElement[];
}

export interface WeekGridOptions {
    /** 点击星期表头时的回调（day: 1-7） */
    onHeaderClick?: (day: number) => void;
}

/**
 * 渲染周网格骨架到指定容器。
 * 注意：调用方需自行在容器内创建 .week-schedule 根节点（或直接传入该根节点）。
 */
export function renderWeekGrid(
    container: HTMLElement,
    options: WeekGridOptions = {},
): WeekGridRefs {
    const grid = container.createDiv({ cls: 'schedule-grid' });

    // ===== 表头行（星期表头）=====
    const headerRow = grid.createDiv({ cls: 'grid-header-row' });
    const headerRowInner = headerRow.createDiv({ cls: 'day-headers' });
    const days = getWeekDays();
    for (let d = 1; d <= 7; d++) {
        const header = headerRowInner.createDiv({ cls: 'day-header' });
        header.setText(days[d - 1]);
        header.onclick = () => options.onHeaderClick?.(d);
    }

    // ===== 主体行（时间轴 + 日期列）=====
    const bodyRow = grid.createDiv({ cls: 'grid-body-row' });
    const timeCol = bodyRow.createDiv({ cls: 'time-column' });
    const bodyRowInner = bodyRow.createDiv({ cls: 'day-bodies' });

    // 时间刻度（每 2 小时一格）
    for (let h = 0; h < 24; h += 2) {
        timeCol.createDiv({ cls: 'time-cell two-hour' })
            .setText(`${h.toString().padStart(2, '0')}:00`);
    }

    // ===== 7 列日期网格（每列 12 个半小时格子）=====
    const dayColumns: HTMLElement[] = [];
    for (let d = 1; d <= 7; d++) {
        const col = bodyRowInner.createDiv({ cls: 'day-column' });
        for (let h = 0; h < 24; h += 2) {
            // 背景格子不拦截点击，让列统一处理
            col.createDiv({ cls: 'hour-cell two-hour' });
        }
        dayColumns.push(col);
    }

    return { grid, headerRow, bodyRowInner, dayColumns };
}
