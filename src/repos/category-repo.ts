// 分类领域仓库：封装计划分类（PlanCategoryData）的增删改业务逻辑。
// 视图不再直接赋值 categoryData.categories，改调本仓库方法；底层仍操作 base-repo 持有的同一引用。
// 注意：所有写操作均「原地替换数组内容」，不重新赋值 categoryData 本身，
// 以保证子视图持有的 categoryData 引用不被切断。
import type { PlanCategoryData, PlanCategory } from '../shared/plan-category-manager';
import { ensureUncategorizedCategory } from '../shared/plan-category-manager';
import type { BaseRepo } from './base-repo';

/**
 * 分类领域仓库：只管 categoryData（计划分类列表）。
 * 通过 baseRepo 拿到 categoryData 引用，写操作后由调用方触发 baseRepo.saveAll()。
 */
export class CategoryRepo {
    private baseRepo: BaseRepo;

    constructor(baseRepo: BaseRepo) {
        this.baseRepo = baseRepo;
    }

    /** 分类数据引用（视图读取用） */
    get data(): PlanCategoryData {
        return this.baseRepo.data!.categoryData;
    }

    /** 分类列表引用（视图读取用） */
    get categories(): PlanCategory[] {
        return this.data.categories;
    }

    /** 按 id 查找分类 */
    findById(id: string): PlanCategory | undefined {
        return this.categories.find(c => c.id === id);
    }

    /**
     * 整体替换分类列表（配置弹窗确认时用）。
     * 原地替换数组内容，保持 categories 数组引用不变（子视图持有同一引用）。
     */
    replaceAll(next: PlanCategory[]): void {
        this.categories.splice(0, this.categories.length, ...next);
    }

    /** 确保「未分类」始终存在且位于首位（原地调整） */
    ensureUncategorized(): void {
        ensureUncategorizedCategory(this.data);
    }
}
