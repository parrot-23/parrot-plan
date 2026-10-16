// 日模板领域仓库：封装日模板（DayTemplateData）的增删改业务逻辑。
// 视图不再直接 push/filter dayTemplates / dayProperties，改调本仓库方法；
// 底层仍操作 base-repo 持有的同一引用。
// 注意：所有写操作均「原地修改」或「原地替换数组内容」，不重新赋值 dayTemplateData 本身，
// 以保证子视图持有的引用不被切断。
import type { DayTemplateData, DayTemplate } from '../shared/template-manager';
import type { BaseRepo } from './base-repo';

/**
 * 日模板领域仓库：只管 dayTemplateData（日模板列表 + 日属性绑定）。
 * 通过 baseRepo 拿到 dayTemplateData 引用，写操作后由调用方触发 baseRepo.saveAll()。
 */
export class TemplateRepo {
    private baseRepo: BaseRepo;

    constructor(baseRepo: BaseRepo) {
        this.baseRepo = baseRepo;
    }

    /** 日模板数据引用（视图读取用） */
    get data(): DayTemplateData {
        return this.baseRepo.data!.templateData;
    }

    /** 日模板列表引用（视图读取用） */
    get dayTemplates(): DayTemplate[] {
        return this.data.dayTemplates;
    }

    /** 日属性绑定列表引用（视图读取用） */
    get dayProperties(): DayTemplateData['dayProperties'] {
        return this.data.dayProperties;
    }

    /** 按 id 查找日模板 */
    findTemplate(id: string): DayTemplate | undefined {
        return this.dayTemplates.find(t => t.id === id);
    }

    /** 追加一个日模板（原地 push，保持数组引用不变） */
    addTemplate(tpl: DayTemplate): void {
        this.dayTemplates.push(tpl);
    }

    /**
     * 删除一个日模板，并清理日属性中的引用（原地替换数组内容，保持引用不变）。
     */
    removeTemplate(id: string): void {
        const templates = this.dayTemplates;
        templates.splice(0, templates.length, ...templates.filter(t => t.id !== id));
        const props = this.dayProperties;
        props.splice(0, props.length, ...props.filter(p => p.templateId !== id));
    }

    /** 设置某星期几绑定的日模板（有则更新，无则追加） */
    setDayProperty(day: number, templateId: string): void {
        const prop = this.dayProperties.find(p => p.day === day);
        if (prop) {
            prop.templateId = templateId;
        } else {
            this.dayProperties.push({ day, templateId });
        }
    }

    /** 清空全部日模板与日属性（重置数据用，原地清空保持引用不变） */
    clear(): void {
        this.dayTemplates.length = 0;
        this.dayProperties.length = 0;
    }
}
