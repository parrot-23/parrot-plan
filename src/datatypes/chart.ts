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

/** 热力图数据点：某一天的活跃度（GitHub 贡献图风格） */
export interface HeatmapDatum {
    /** 日期键（YYYY-MM-DD） */
    date: string;
    /** 活跃度数值（如执行时长分钟数） */
    value: number;
}

/** 热力图数据集：按天聚合的活跃度，供热力图渲染器绘制 */
export interface HeatmapSeries {
    /** 按天数据点列表 */
    data: HeatmapDatum[];
    /** 指标名（用于图例/标题） */
    metricLabel: string;
}

/** 雷达图数据点：一个维度名 + 一个数值 */
export interface RadarDatum {
    /** 维度名（如「任务数」「执行数」） */
    label: string;
    /** 数值 */
    value: number;
}

/** 雷达图数据集：多个维度指标，供雷达图渲染器绘制 */
export interface RadarSeries {
    /** 维度数据点列表 */
    data: RadarDatum[];
    /** 指标名（用于图例/标题） */
    metricLabel: string;
}

/** 散点图数据点：一个 x 值 + 一个 y 值 */
export interface ScatterDatum {
    /** x 轴数值 */
    x: number;
    /** y 轴数值 */
    y: number;
    /** 数据点标签（可选，用于 tooltip） */
    label?: string;
}

/** 散点图数据集：一组 (x, y) 数据点，供散点图渲染器绘制 */
export interface ScatterSeries {
    /** 数据点列表 */
    data: ScatterDatum[];
    /** x 轴名称 */
    xLabel: string;
    /** y 轴名称 */
    yLabel: string;
}

/** 漏斗图数据点：一个阶段名 + 一个数值 */
export interface FunnelDatum {
    /** 阶段名 */
    label: string;
    /** 数值 */
    value: number;
}

/** 漏斗图数据集：按阶段递减的数值，供漏斗图渲染器绘制 */
export interface FunnelSeries {
    /** 阶段数据点列表 */
    data: FunnelDatum[];
    /** 指标名（用于图例/标题） */
    metricLabel: string;
}

/** 词云数据点：一个词 + 词频 */
export interface WordDatum {
    /** 词 */
    text: string;
    /** 词频（用于字号/颜色深浅） */
    value: number;
}

/** 词云数据集：一组词频，供词云渲染器绘制 */
export interface WordCloudSeries {
    /** 词频数据点列表 */
    data: WordDatum[];
    /** 指标名（用于图例/标题） */
    metricLabel: string;
}
