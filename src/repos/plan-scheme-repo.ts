// 时间计划方案领域仓库：封装 PlanSchemeData 的增删改业务逻辑。
// 视图不再直接赋值 planSchemeData.schemes / activeSchemeId / defaultSchemeId，改调本仓库方法；
// 底层仍操作 base-repo 持有的同一引用。
// 注意：所有写操作均「原地替换数组内容」或「原地修改字段」，不重新赋值 planSchemeData 本身，
// 以保证子视图持有的 planSchemeData 引用不被切断。
import type { PlanSchemeData, PlanScheme, DailyRange } from '../shared/plan-data';
import { DEFAULT_SCHEME_ID, ensureDefaultScheme } from '../shared/plan-data';
import type { BaseRepo } from './base-repo';

/**
 * 时间计划方案领域仓库：只管 planSchemeData（方案集合 + 激活/默认方案）。
 * 通过 baseRepo 拿到 planSchemeData 引用，写操作后由调用方触发 baseRepo.saveAll()。
 */
export class PlanSchemeRepo {
    private baseRepo: BaseRepo;

    constructor(baseRepo: BaseRepo) {
        this.baseRepo = baseRepo;
    }

    /** 方案数据引用（视图读取用） */
    get data(): PlanSchemeData {
        return this.baseRepo.data!.schemeData;
    }

    /** 方案列表引用（视图读取用） */
    get schemes(): PlanScheme[] {
        return this.data.schemes;
    }

    /** 当前激活方案 id（视图读取用） */
    get activeSchemeId(): string | undefined {
        return this.data.activeSchemeId;
    }

    /** 默认方案 id（视图读取用） */
    get defaultSchemeId(): string | undefined {
        return this.data.defaultSchemeId;
    }

    /** 按 id 查找方案 */
    findById(id: string): PlanScheme | undefined {
        return this.schemes.find(s => s.id === id);
    }

    /** 获取当前激活方案（未激活时回退到默认方案，再回退到首个方案） */
    getActiveScheme(): PlanScheme | undefined {
        const active = this.schemes.find(s => s.id === this.data.activeSchemeId);
        if (active) return active;
        return this.schemes.find(s => s.id === DEFAULT_SCHEME_ID)
            ?? this.schemes[0];
    }

    /**
     * 整体替换方案列表（方案管理弹窗确认时用）。
     * 原地替换数组内容，保持 schemes 数组引用不变（子视图持有同一引用）。
     */
    replaceAll(next: PlanScheme[]): void {
        this.schemes.splice(0, this.schemes.length, ...next);
    }

    /** 设置当前激活方案（传 undefined 表示未激活） */
    setActiveSchemeId(id: string | undefined): void {
        this.data.activeSchemeId = id;
    }

    /** 设置默认方案 id */
    setDefaultSchemeId(id: string): void {
        this.data.defaultSchemeId = id;
    }

    /** 确保默认方案始终存在且位于首位（原地调整） */
    ensureDefault(name: string): void {
        ensureDefaultScheme(this.data, name);
    }

    /**
     * 在指定方案、指定星期几上追加一个时间区间。
     * 方案不存在时静默返回；日数据不存在时自动创建。
     */
    addRange(schemeId: string, day: number, range: DailyRange['ranges'][number]): void {
        const scheme = this.findById(schemeId);
        if (!scheme) return;
        if (!scheme.days) scheme.days = [];
        let dayData = scheme.days.find(d => d.day === day);
        if (!dayData) {
            dayData = { day, ranges: [] };
            scheme.days.push(dayData);
        }
        dayData.ranges.push(range);
    }

    /**
     * 用一组区间整体替换指定方案、指定星期几的区间（应用日模板时用）。
     * 方案不存在时静默返回；日数据不存在时自动创建。
     */
    setDayRanges(schemeId: string, day: number, ranges: DailyRange['ranges']): void {
        const scheme = this.findById(schemeId);
        if (!scheme) return;
        if (!scheme.days) scheme.days = [];
        let dayData = scheme.days.find(d => d.day === day);
        if (!dayData) {
            dayData = { day, ranges: [] };
            scheme.days.push(dayData);
        }
        dayData.ranges = ranges;
    }

    /** 删除指定方案、指定星期几上的某个区间 */
    removeRange(schemeId: string, day: number, rangeId: string): void {
        const scheme = this.findById(schemeId);
        const dayData = scheme?.days?.find(d => d.day === day);
        if (!dayData) return;
        dayData.ranges = dayData.ranges.filter(r => r.id !== rangeId);
    }

    /** 更新指定方案、指定星期几上的某个区间（原地修改，保持对象引用不变） */
    updateRange(schemeId: string, day: number, rangeId: string, patch: Partial<DailyRange['ranges'][number]>): void {
        const scheme = this.findById(schemeId);
        const dayData = scheme?.days?.find(d => d.day === day);
        const range = dayData?.ranges.find(r => r.id === rangeId);
        if (range) Object.assign(range, patch);
    }

    /** 清空为默认方案（重置数据用，原地替换数组内容保持引用不变） */
    resetToDefault(name: string): void {
        this.replaceAll([{ id: DEFAULT_SCHEME_ID, name, days: [] }]);
        this.data.activeSchemeId = DEFAULT_SCHEME_ID;
        this.data.defaultSchemeId = DEFAULT_SCHEME_ID;
    }
}
