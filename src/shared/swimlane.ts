import type { InboxItem, ExecutionRecord } from '../datatypes/domain';
import type { TimeBlockCategoryData } from '../views/week-view/timeblock-category-manager';
import { parseWeekKey } from '../views/week-view/timeblock-data';
import { t } from '../i18n';

/** 泳道图渲染选项 */
export interface SwimlaneOptions {
    /** 可见任务列表（按任务面板显示顺序，已过滤折叠/移除） */
    tasks: InboxItem[];
    /** 分类数据（用于任务标题前的分类色点） */
    categoryData: TimeBlockCategoryData;
    /** 当前选中任务 id（用于高亮与滚动定位） */
    selectedId?: string;
    /** 当前显示年份 */
    currentYear: number;
    /** 年份切换回调（点击 ‹ / › / 今年 时触发） */
    onYearChange: (year: number) => void;
    /** 是否显示执行线（项目全景图为 true，任务计划视图为 false） */
    showExec: boolean;
    /** 获取执行记录（showExec 为 true 时使用） */
    getExecutions?: () => ExecutionRecord[];
    /** 获取任务层级深度（用于标题行缩进，缺省为 0） */
    getDepth?: (task: InboxItem) => number;
}

/** 每周格子宽度（像素），与 styles.css 中 .swimlane-cell 保持一致 */
const CELL_WIDTH = 60;

/**
 * 渲染泳道图网格（W1–W52 从左到右）。
 * 由项目全景图与任务计划视图共用；通过 showExec 控制是否绘制执行线。
 */
export function renderSwimlane(board: HTMLElement, options: SwimlaneOptions): void {
    const totalWeeks = 52;
    const { tasks, categoryData, selectedId, currentYear, onYearChange, showExec } = options;

    // ===== 顶部：年份切换 + 图例 =====
    const topBar = board.createDiv({ cls: 'swimlane-top-bar' });
    renderYearNav(topBar, currentYear, onYearChange);
    renderLegend(topBar, showExec);

    // 表头行：周号
    const headerRow = board.createDiv({ cls: 'swimlane-header-row' });
    for (let w = 1; w <= totalWeeks; w++) {
        headerRow.createDiv({
            cls: 'swimlane-header-cell',
            text: t('projectPicture.weekLabel', { week: w }),
        });
    }

    const executions = showExec ? (options.getExecutions?.() ?? []) : [];

    // 记录选中任务最早出现的一周，用于渲染后滚动定位
    let selectedFirstWeek: number | undefined;

    for (const task of tasks) {
        // 计划周集合（来自任务的 assignedWeekKeys，仅当前年份）
        const planWeeks = new Set<number>();
        if (task.assignedWeekKeys) {
            for (const key of task.assignedWeekKeys) {
                const parsed = parseWeekKey(key);
                if (parsed.year === currentYear) planWeeks.add(parsed.week);
            }
        }

        // 执行周集合（来自执行记录，按 inboxId 匹配，仅当前年份）
        const execWeeks = new Set<number>();
        if (showExec) {
            for (const rec of executions) {
                if (rec.inboxId === task.id && rec.weekKey) {
                    const parsed = parseWeekKey(rec.weekKey);
                    if (parsed.year === currentYear) execWeeks.add(parsed.week);
                }
            }
        }

        // 任务标题行（左侧固定，横向滚动时保持可见）
        const titleRow = board.createDiv({ cls: 'swimlane-task-row' });
        // 层级缩进：通过 CSS 变量控制，体现任务在树中的深度
        const depth = options.getDepth?.(task) ?? 0;
        if (depth > 0) {
            titleRow.setCssProps({ '--swimlane-depth': String(depth) });
            titleRow.addClass('has-depth');
        }
        const cat = task.categoryId
            ? categoryData.categories.find(c => c.id === task.categoryId)
            : undefined;
        if (cat) {
            const dot = titleRow.createSpan({ cls: 'inbox-category-dot' });
            dot.setCssProps({ '--dot-color': cat.color });
        }
        titleRow.createSpan({ cls: 'swimlane-task-name', text: task.title });
        if (selectedId === task.id) titleRow.addClass('is-selected');

        // 计划线
        const planRow = board.createDiv({ cls: 'swimlane-lane-row' });
        for (let w = 1; w <= totalWeeks; w++) {
            const cell = planRow.createDiv({ cls: 'swimlane-cell' });
            if (planWeeks.has(w)) cell.addClass('is-plan');
        }

        // 执行线（可选）
        if (showExec) {
            const execRow = board.createDiv({ cls: 'swimlane-lane-row' });
            for (let w = 1; w <= totalWeeks; w++) {
                const cell = execRow.createDiv({ cls: 'swimlane-cell' });
                if (execWeeks.has(w)) cell.addClass('is-exec');
            }
        }

        // 选中任务：记录其最早出现的一周
        if (selectedId === task.id) {
            const weeks = Array.from(planWeeks).concat(Array.from(execWeeks));
            if (weeks.length > 0) {
                selectedFirstWeek = Math.min.apply(null, weeks);
            }
        }
    }

    // 选中任务时：横向滚动到最早出现的时间点（计划 / 执行周中最小的一周）
    if (selectedFirstWeek !== undefined) {
        const firstWeek = selectedFirstWeek;
        const targetLeft = (firstWeek - 1) * CELL_WIDTH - 12;
        window.setTimeout(() => {
            board.scrollLeft = Math.max(0, targetLeft);
        }, 0);
    }
}

/** 顶部年份切换（‹ 年份 › + 今年） */
function renderYearNav(
    board: HTMLElement,
    currentYear: number,
    onYearChange: (year: number) => void,
): void {
    const nav = board.createDiv({ cls: 'swimlane-year-nav' });

    const prevBtn = nav.createEl('button', { text: '‹', cls: 'year-week-nav-btn' });
    prevBtn.onclick = () => onYearChange(currentYear - 1);

    nav.createDiv({ cls: 'year-week-nav-year', text: String(currentYear) });

    const nextBtn = nav.createEl('button', { text: '›', cls: 'year-week-nav-btn' });
    nextBtn.onclick = () => onYearChange(currentYear + 1);

    const todayBtn = nav.createEl('button', {
        text: t('year.thisYear'),
        cls: 'year-week-nav-btn year-week-nav-today',
    });
    todayBtn.toggleClass('is-active', currentYear === new Date().getFullYear());
    todayBtn.onclick = () => onYearChange(new Date().getFullYear());
}

/** 图例：说明计划项 / 执行记录的固定颜色（showExec 为 false 时仅显示计划项） */
function renderLegend(container: HTMLElement, showExec: boolean): void {
    const legend = container.createDiv({ cls: 'swimlane-legend' });

    const items: { labelKey: 'projectPicture.legendPlan' | 'projectPicture.legendExec'; color: string }[] = [
        { labelKey: 'projectPicture.legendPlan', color: 'var(--interactive-accent)' },
    ];
    if (showExec) {
        items.push({ labelKey: 'projectPicture.legendExec', color: 'var(--color-green, #43b581)' });
    }

    for (const item of items) {
        const row = legend.createDiv({ cls: 'swimlane-legend-item' });
        const swatch = row.createSpan({ cls: 'swimlane-legend-color' });
        swatch.setCssProps({ '--swatch-color': item.color });
        row.createSpan({ text: t(item.labelKey) });
    }
}
