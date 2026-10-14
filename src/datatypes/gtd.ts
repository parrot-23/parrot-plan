// GTD 数据契约：收集箱条目（收集视图写入，后续组织/梳理视图消费）。

/** 收集箱条目状态：未处理 / 已处理 */
export type GtdItemStatus = 'inbox' | 'processed';

/** 源类型（组织视图可添加的源） */
export type GtdSourceType = 'okr' | 'pdca' | 'media' | 'finance' | 'intel';

/** 源条目 */
export interface GtdSource {
    id: string;
    /** 源类型 */
    type: GtdSourceType;
    /** 创建时间（毫秒时间戳） */
    createdAt: number;
}

/** 收集箱条目 */
export interface GtdItem {
    id: string;
    /** 条目内容（用户输入） */
    content: string;
    /** 创建时间（毫秒时间戳） */
    createdAt: number;
    /** 状态：收集阶段默认未处理 */
    status: GtdItemStatus;
}

/** GTD 数据顶层容器（随 plugin.data 持久化） */
export interface GtdData {
    /** 收集箱条目列表 */
    items: GtdItem[];
    /** 组织视图的源列表 */
    sources: GtdSource[];
}

/** 默认空 GTD 数据 */
export function defaultGtdData(): GtdData {
    return { items: [], sources: [] };
}
