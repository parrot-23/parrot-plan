// PDCA 领域仓库：封装计划事件、执行记录、周计划标记、改进项的增删改业务逻辑。
// 视图不再直接 push/splice 数据，改调本仓库方法；底层仍操作 base-repo 持有的同一引用。
import type { EventBlock, ExecutionRecord, ImprovementData, ImprovementItem, RunningTask } from '../datatypes/domain';
import type { BaseRepo } from './base-repo';

/**
 * PDCA 领域仓库：只管 events / executions / plannedWeeks / improvementData / 执行状态。
 * 通过 baseRepo 拿到数据引用，写操作后由调用方触发 baseRepo.saveAll()。
 */
export class PdcaRepo {
    private baseRepo: BaseRepo;

    constructor(baseRepo: BaseRepo) {
        this.baseRepo = baseRepo;
    }

    /** 计划事件列表引用（视图读取用） */
    get events(): EventBlock[] {
        return this.baseRepo.data!.events;
    }

    /** 执行记录列表引用（视图读取用） */
    get executions(): ExecutionRecord[] {
        return this.baseRepo.data!.executions;
    }

    /** 已制定周计划的周键列表引用（视图读取用） */
    get plannedWeeks(): string[] {
        return this.baseRepo.data!.plannedWeeks;
    }

    /** 改进数据引用（视图读取用） */
    get improvementData(): ImprovementData {
        return this.baseRepo.data!.improvementData;
    }

    /** 当前正在执行的事件 id（视图读取用） */
    get executingEventId(): string | undefined {
        return this.baseRepo.data!.executingEventId;
    }

    /** 当前进行中的任务（视图读取用） */
    get runningTask(): RunningTask | undefined {
        return this.baseRepo.data!.runningTask;
    }

    // ===== 计划事件 =====

    /** 追加一条计划事件（原地 push，保持数组引用不变） */
    addEvent(ev: EventBlock): void {
        this.events.push(ev);
    }

    /** 删除一条计划事件（原地 splice，保持数组引用不变） */
    removeEvent(id: string): void {
        const idx = this.events.findIndex(x => x.id === id);
        if (idx >= 0) this.events.splice(idx, 1);
    }

    /** 更新一条计划事件（原地修改，保持数组引用不变） */
    updateEvent(id: string, patch: Partial<EventBlock>): void {
        const target = this.events.find(x => x.id === id);
        if (target) Object.assign(target, patch);
    }

    /** 清空全部计划事件（重置数据用，原地清空保持数组引用不变） */
    clearEvents(): void {
        this.events.length = 0;
    }

    // ===== 执行记录 =====

    /** 追加一条执行记录（原地 push，保持数组引用不变） */
    addExecution(ex: ExecutionRecord): void {
        this.executions.push(ex);
    }

    /** 删除一条执行记录（原地 splice，保持数组引用不变） */
    removeExecution(id: string): void {
        const idx = this.executions.findIndex(x => x.id === id);
        if (idx >= 0) this.executions.splice(idx, 1);
    }

    /** 更新一条执行记录（原地修改，保持数组引用不变） */
    updateExecution(id: string, patch: Partial<ExecutionRecord>): void {
        const target = this.executions.find(x => x.id === id);
        if (target) Object.assign(target, patch);
    }

    /** 清空全部执行记录（重置数据用，原地清空保持数组引用不变） */
    clearExecutions(): void {
        this.executions.length = 0;
    }

    // ===== 执行状态（正在执行的事件 / 进行中的任务）=====

    /** 设置当前正在执行的事件 id（传 undefined 清除） */
    setExecutingEventId(id: string | undefined): void {
        this.baseRepo.data!.executingEventId = id;
    }

    /** 设置当前进行中的任务（传 undefined 清除） */
    setRunningTask(task: RunningTask | undefined): void {
        this.baseRepo.data!.runningTask = task;
    }

    // ===== 周计划标记 =====

    /** 切换某周「已制定周计划」标记；返回切换后是否已标记 */
    togglePlannedWeek(weekKey: string): boolean {
        const idx = this.plannedWeeks.indexOf(weekKey);
        if (idx >= 0) {
            this.plannedWeeks.splice(idx, 1);
            return false;
        }
        this.plannedWeeks.push(weekKey);
        return true;
    }

    /** 某周是否已制定周计划 */
    isWeekPlanned(weekKey: string): boolean {
        return this.plannedWeeks.includes(weekKey);
    }

    // ===== 改进项 =====

    /** 取某周的改进项列表（不存在则初始化） */
    getWeekImprovements(weekKey: string): ImprovementItem[] {
        if (!this.improvementData.byWeek[weekKey]) {
            this.improvementData.byWeek[weekKey] = [];
        }
        return this.improvementData.byWeek[weekKey];
    }

    /** 新增一条改进项 */
    addImprovement(weekKey: string, text: string): ImprovementItem {
        const item: ImprovementItem = {
            id: `imp_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            text,
            createdAt: Date.now(),
        };
        this.getWeekImprovements(weekKey).push(item);
        return item;
    }

    /** 删除一条改进项 */
    removeImprovement(weekKey: string, id: string): void {
        const items = this.getWeekImprovements(weekKey);
        this.improvementData.byWeek[weekKey] = items.filter(i => i.id !== id);
    }

    /** 更新一条改进项的文本（原地修改，保持数组引用不变） */
    updateImprovement(weekKey: string, id: string, text: string): void {
        const target = this.getWeekImprovements(weekKey).find(i => i.id === id);
        if (target) target.text = text;
    }
}
