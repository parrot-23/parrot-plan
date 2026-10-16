// 收集盒领域仓库：封装收集盒任务（InboxData）的增删改与 UI 状态业务逻辑。
// 视图不再直接 push/filter/赋值 inboxData，改调本仓库方法；底层仍操作 base-repo 持有的同一 inboxData 引用。
// 注意：所有写操作均「原地修改」或「原地替换数组内容」，不重新赋值 inboxData 本身，
// 以保证子视图持有的 inboxData 引用不被切断。
import type { InboxData, InboxItem } from '../datatypes/domain';
import type { BaseRepo } from './base-repo';

/**
 * 收集盒领域仓库：只管 inboxData（任务列表 + 选中/折叠/聚焦等 UI 状态）。
 * 通过 baseRepo 拿到 inboxData 引用，写操作后由调用方触发 baseRepo.saveAll()。
 */
export class InboxRepo {
    private baseRepo: BaseRepo;

    constructor(baseRepo: BaseRepo) {
        this.baseRepo = baseRepo;
    }

    /** 收集盒数据引用（视图读取用） */
    get data(): InboxData {
        return this.baseRepo.data!.inboxData;
    }

    /** 任务列表引用（视图读取用） */
    get items(): InboxItem[] {
        return this.data.items;
    }

    // ===== 任务增删改 =====

    /** 追加一条任务（原地 push，保持数组引用不变） */
    addItem(item: InboxItem): void {
        this.items.push(item);
    }

    /** 按 id 查找任务 */
    findItem(id: string): InboxItem | undefined {
        return this.items.find(i => i.id === id);
    }

    /** 更新一条任务（原地修改，保持对象引用不变） */
    updateItem(id: string, patch: Partial<InboxItem>): void {
        const target = this.findItem(id);
        if (target) Object.assign(target, patch);
    }

    /** 软删除一条任务（标记 removed，数据保留可查历史） */
    removeItem(id: string): void {
        const target = this.findItem(id);
        if (target) target.removed = true;
    }

    /** 批量软删除（原地标记，保持数组引用不变） */
    removeItems(ids: string[]): void {
        for (const id of ids) this.removeItem(id);
    }

    /** 设置任务的父级（原地修改） */
    setParent(id: string, parentId: string | undefined): void {
        this.updateItem(id, { parentId });
    }

    /**
     * 重排任务数组（拖拽排序用）。
     * 原地替换数组内容（splice），保持 items 数组引用不变。
     */
    reorderItems(next: InboxItem[]): void {
        this.items.splice(0, this.items.length, ...next);
    }

    // ===== 分配（周 / 日）=====

    /** 把任务分配到某天（去重追加，原地修改） */
    assignToDay(id: string, dayKey: string): void {
        const item = this.findItem(id);
        if (!item) return;
        const dayKeys = item.assignedDayKeys ?? [];
        if (!dayKeys.includes(dayKey)) {
            item.assignedDayKeys = [...dayKeys, dayKey];
        }
    }

    /** 把任务分配到某周（去重追加，原地修改） */
    assignToWeek(id: string, weekKey: string): void {
        const item = this.findItem(id);
        if (!item) return;
        const weekKeys = item.assignedWeekKeys ?? [];
        if (!weekKeys.includes(weekKey)) {
            item.assignedWeekKeys = [...weekKeys, weekKey];
        }
    }

    // ===== UI 状态（选中 / 折叠 / 聚焦）=====

    /** 设置当前选中任务（传 undefined 取消选中） */
    setSelectedId(id: string | undefined): void {
        this.data.selectedId = id;
    }

    /** 设置项目聚焦任务（传 undefined 取消聚焦） */
    setProjectFocusId(id: string | undefined): void {
        this.data.projectFocusId = id;
    }

    /** 某任务是否处于折叠状态 */
    isCollapsed(id: string): boolean {
        return this.data.collapsedIds?.includes(id) ?? false;
    }

    /** 展开某任务（从折叠列表移除，原地替换数组内容） */
    expand(id: string): void {
        const ids = this.data.collapsedIds;
        if (!ids) return;
        const idx = ids.indexOf(id);
        if (idx >= 0) ids.splice(idx, 1);
    }

    /** 折叠某任务（去重追加） */
    collapse(id: string): void {
        if (!this.data.collapsedIds) this.data.collapsedIds = [];
        if (!this.data.collapsedIds.includes(id)) {
            this.data.collapsedIds.push(id);
        }
    }

    /** 切换某任务的折叠状态；返回切换后是否处于折叠 */
    toggleCollapse(id: string): boolean {
        if (this.isCollapsed(id)) {
            this.expand(id);
            return false;
        }
        this.collapse(id);
        return true;
    }

    /**
     * 清空收集盒（重置数据用）。
     * 原地清空 items 数组并重置 UI 状态，保持 inboxData 引用不变（子视图持有同一引用）。
     */
    clear(): void {
        this.items.length = 0;
        this.data.selectedId = undefined;
        this.data.collapsedIds = [];
        this.data.weekGoalOnly = false;
    }
}
