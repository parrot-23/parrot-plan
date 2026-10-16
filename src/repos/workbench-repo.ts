// 工作台领域仓库：封装卡片实例与布局的增删改业务逻辑。
// 视图不再直接 push/filter 数据，改调本仓库方法；底层仍操作 base-repo 持有的同一引用。
import type { CardInstance, WorkbenchData } from '../datatypes/card';
import { ensureDefaultLayout } from '../datatypes/card';
import type { BaseRepo } from './base-repo';

/**
 * 工作台领域仓库：只管 workbenchData（卡片实例 + 布局）。
 * 通过 baseRepo 拿到数据引用，写操作后由调用方触发 baseRepo.saveAll()。
 */
export class WorkbenchRepo {
    private baseRepo: BaseRepo;

    constructor(baseRepo: BaseRepo) {
        this.baseRepo = baseRepo;
    }

    /** 工作台数据引用（视图读取用） */
    get data(): WorkbenchData {
        return this.baseRepo.data!.workbench;
    }

    /** 卡片实例列表引用（视图读取用） */
    get instances(): CardInstance[] {
        return this.data.instances;
    }

    /** 确保默认布局存在且对应当前展示内容 */
    ensureDefaultLayout(name: string): void {
        ensureDefaultLayout(this.data, name);
    }

    /** 追加一张卡片实例 */
    addInstance(instance: CardInstance): void {
        this.instances.push(instance);
    }

    /** 删除一张卡片实例 */
    removeInstance(id: string): void {
        this.data.instances = this.instances.filter(i => i.id !== id);
    }

    /** 更新一张卡片实例（原地修改，保持实例引用不变） */
    updateInstance(id: string, patch: Partial<CardInstance>): void {
        const target = this.instances.find(i => i.id === id);
        if (target) Object.assign(target, patch);
    }
}
