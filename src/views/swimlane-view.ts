import type { App } from 'obsidian';

import type { TimeBlockCategoryData } from '../week/timeblock-category-manager';
import type { InboxData } from '../shared/task-panel';
import { renderTaskPanel } from '../shared/task-panel';
import type { ExecutionRecord } from '../week/week-schedule-view';
import { parseWeekKey } from '../week/timeblock-data';
import { t } from '../i18n';

/**
 * 泳道图视图：左侧任务面板 + 右侧泳道图（W1–W52 从左到右排列）。
 * 选中任务后，在泳道图上显示该任务的「计划线」与「执行线」。
 * 通过 renderInto 渲染到指定容器（与 WeekScheduleView / YearView 一致）。
 */
export class SwimlaneView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: TimeBlockCategoryData;
    private save: () => Promise<void>;
    /** 获取执行记录（用于绘制执行线） */
    private getExecutions: () => ExecutionRecord[];
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: TimeBlockCategoryData,
        save: () => Promise<void>,
        getExecutions: () => ExecutionRecord[],
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.save = save;
        this.getExecutions = getExecutions;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('swimlane-view');

        // ===== 左侧：任务面板 =====
        const taskPanel = container.createDiv({ cls: 'swimlane-task-panel' });
        renderTaskPanel(
            this.app,
            taskPanel,
            this.inboxData,
            this.categoryData,
            async () => {
                await this.save();
            },
            () => {
                void this.refresh();
            },
            undefined,
            async () => {
                await this.save();
            },
        );

        // ===== 右侧：泳道图 =====
        const board = container.createDiv({ cls: 'swimlane-board' });
        // 鼠标滚轮左右滚动
        board.addEventListener('wheel', (evt) => {
            if (evt.deltaY === 0) return;
            evt.preventDefault();
            board.scrollLeft += evt.deltaY;
        }, { passive: false });
        this.renderBoard(board);
    }

    /** 重新渲染自身 */
    private async refresh(): Promise<void> {
        if (this.container) await this.renderInto(this.container);
    }

    /** 渲染泳道图网格（W1–W52 从左到右） */
    private renderBoard(board: HTMLElement) {
        const totalWeeks = 52;

        // 表头行：周号
        const headerRow = board.createDiv({ cls: 'swimlane-header-row' });
        for (let w = 1; w <= totalWeeks; w++) {
            headerRow.createDiv({
                cls: 'swimlane-header-cell',
                text: t('swimlane.weekLabel', { week: w }),
            });
        }

        // 当前选中的任务
        const selectedId = this.inboxData.selectedId;
        const selected = selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;

        // 计划周集合（来自任务的 assignedWeekKeys）
        const planWeeks = new Set<number>();
        if (selected?.assignedWeekKeys) {
            for (const key of selected.assignedWeekKeys) {
                planWeeks.add(parseWeekKey(key).week);
            }
        }

        // 执行周集合（来自执行记录，按 inboxId 匹配）
        const execWeeks = new Set<number>();
        if (selected) {
            for (const rec of this.getExecutions()) {
                if (rec.inboxId === selected.id && rec.weekKey) {
                    execWeeks.add(parseWeekKey(rec.weekKey).week);
                }
            }
        }

        // 计划线
        const planRow = board.createDiv({ cls: 'swimlane-lane-row' });
        for (let w = 1; w <= totalWeeks; w++) {
            const cell = planRow.createDiv({ cls: 'swimlane-cell' });
            if (planWeeks.has(w)) cell.addClass('is-plan');
        }

        // 执行线
        const execRow = board.createDiv({ cls: 'swimlane-lane-row' });
        for (let w = 1; w <= totalWeeks; w++) {
            const cell = execRow.createDiv({ cls: 'swimlane-cell' });
            if (execWeeks.has(w)) cell.addClass('is-exec');
        }
    }
}
