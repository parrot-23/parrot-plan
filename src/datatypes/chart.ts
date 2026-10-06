// 统一数据契约：统计图卡片读取的领域数据标准。
// 这里只定义「读取契约」，不复制数据；真实数据仍由插件持有，
// 通过 DataProvider 以完整类型暴露给统计视图，保证统计口径精确。

import type { EventBlock, ExecutionRecord } from './domain';
import type { InboxItem } from './domain';

/** 计划事件（复用周计划视图的真实类型，保证字段完整） */
export type PlanEvent = EventBlock;

/** 执行记录（复用周计划视图的真实类型） */
export type Execution = ExecutionRecord;

/** 收集盒任务（复用任务面板的真实类型） */
export type Task = InboxItem;

/** 数据提供者：统计图卡片通过它读取规范化的领域数据 */
export interface DataProvider {
    /** 全部计划事件 */
    getEvents(): PlanEvent[];
    /** 全部执行记录 */
    getExecutions(): Execution[];
    /** 全部收集盒任务（含已移除，供历史统计） */
    getTasks(): Task[];
}

/** 统计指标聚合结果：一组带标签的数值项 */
export interface StatItem {
    label: string;
    value: number;
}

/** 图表数据点：一个维度值 + 一个数值 */
export interface ChartDatum {
    /** 维度标签（如日期、周、分类名） */
    label: string;
    /** 数值 */
    value: number;
}

/** 图表数据集：一组数据点，供图表渲染器绘制 */
export interface ChartSeries {
    /** 数据点列表 */
    data: ChartDatum[];
    /** 指标名（用于图例/标题） */
    metricLabel: string;
}
