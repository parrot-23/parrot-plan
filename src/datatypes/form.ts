// 表单引擎类型定义：描述表单模板（Schema）与字段类型。
// 模板是声明式的、静态的，与具体卡片无关。

/** 卡片模式：周期填写 / 来源统计 / 填写后固定 / 日历 / 时钟 / 收集记录 */
export type CardMode = 'periodic' | 'stats' | 'fixed' | 'calendar' | 'clock' | 'collect';

/** 周期类型（仅 periodic 模式使用） */
export type CardPeriod = 'day' | 'week' | 'month';

/** 字段类型 */
export type FieldType =
    | 'text'
    | 'number'
    | 'textarea'
    | 'select'
    | 'date'
    | 'checkbox';

/** 单个字段的声明式定义 */
export interface FieldSchema {
    /** 字段键（数据里存值的 key） */
    key: string;
    /** 字段显示名 */
    label: string;
    /** 字段类型 */
    type: FieldType;
    /** select 类型的可选项 */
    options?: string[];
    /** 是否必填 */
    required?: boolean;
    /** 默认值 */
    default?: unknown;
    /** 占位提示 */
    placeholder?: string;
}

/** 图表类型 */
export type ChartType =
    | 'bar'
    | 'line'
    | 'pie'
    | 'donut'
    | 'heatmap'
    | 'area'
    | 'hbar'
    | 'radar'
    | 'scatter'
    | 'funnel'
    | 'wordcloud'
    | 'metric';

/** 数据源：底层领域数据（来自 repos 目录各领域仓库） */
export type DataSourceType = 'events' | 'executions' | 'tasks';

/** stats 模式的数据来源定义 */
export interface CardSource {
    /** 数据源：底层领域数据（计划事件 / 执行记录 / 收集盒任务） */
    dataSource: DataSourceType;
    /** 聚合方式：对数据源做怎样的统计（如按天/按周/按分类/计数等） */
    aggregation: string;
    /** 聚合参数（如指标口径 count/duration） */
    params?: Record<string, unknown>;
    /** 图表类型（固定，不随数据源/聚合方式变化） */
    chart?: ChartType;
}

/** 表单模板（一个 JSON 文件对应一个模板） */
export interface CardTemplate {
    /** 模板唯一 id */
    id: string;
    /** 模板显示名 */
    name: string;
    /** 卡片模式 */
    mode: CardMode;
    /** 周期（仅 periodic） */
    period?: CardPeriod;
    /** 字段定义（periodic / fixed 使用） */
    fields?: FieldSchema[];
    /** 数据来源（stats 使用） */
    source?: CardSource;
    /** 模板描述 */
    description?: string;
}

/** 表单填写结果：字段 key → 值 */
export type FormValues = Record<string, unknown>;
