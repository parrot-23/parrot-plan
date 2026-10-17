// 数据源目录：集中定义 stats 卡片可用的全部数据源（底层领域数据）及其聚合方式。
// 数据源 = repos 目录下各领域仓库持有的数据（计划事件 / 执行记录 / 收集盒任务）。
// 聚合方式 = 对数据源做怎样的统计（计数 / 按天 / 按周 / 按分类 / 按状态等）。
// 图表类型（chart）与数据源、聚合方式无关，由卡片模板固定。

import type { DataSourceType } from './form';

/** 聚合方式定义 */
export interface AggregationDef {
    /** 聚合方式标识（写入 source.aggregation） */
    key: string;
    /** 聚合方式显示名 */
    label: string;
    /** 聚合方式描述 */
    description: string;
    /** 参数定义（无参数则为空数组） */
    params: Array<{
        key: string;
        label: string;
        type: 'select' | 'text';
        options?: Array<{ value: string; label: string }>;
        default?: string;
    }>;
}

/** 数据源元数据 */
export interface DataSourceMeta {
    /** 数据源标识（source.dataSource） */
    key: DataSourceType;
    /** 数据源显示名 */
    label: string;
    /** 数据源描述 */
    description: string;
    /** 该数据源可用的聚合方式 */
    aggregations: AggregationDef[];
}

/** 全部数据源清单 */
export const DATA_SOURCE_CATALOG: DataSourceMeta[] = [
    {
        key: 'events',
        label: '计划事件',
        description: '周计划中排布的计划事件',
        aggregations: [
            { key: 'count', label: '事件总数', description: '计划事件的数量', params: [] },
            { key: 'completion', label: '完成率', description: '计划事件完成情况', params: [] },
            {
                key: 'by-day',
                label: '按天聚合',
                description: '按天统计计划事件',
                params: [
                    {
                        key: 'metric',
                        label: '指标',
                        type: 'select',
                        options: [
                            { value: 'count', label: '次数' },
                            { value: 'duration', label: '时长(分钟)' },
                        ],
                        default: 'count',
                    },
                ],
            },
            {
                key: 'by-week',
                label: '按周聚合',
                description: '按周统计计划事件',
                params: [
                    {
                        key: 'metric',
                        label: '指标',
                        type: 'select',
                        options: [
                            { value: 'count', label: '次数' },
                            { value: 'duration', label: '时长(分钟)' },
                        ],
                        default: 'count',
                    },
                ],
            },
            {
                key: 'by-category',
                label: '按分类聚合',
                description: '按分类统计计划事件占比',
                params: [
                    {
                        key: 'metric',
                        label: '指标',
                        type: 'select',
                        options: [
                            { value: 'count', label: '次数' },
                            { value: 'duration', label: '时长(分钟)' },
                        ],
                        default: 'count',
                    },
                ],
            },
        ],
    },
    {
        key: 'executions',
        label: '执行记录',
        description: '日执行视图写入的执行记录',
        aggregations: [
            { key: 'count', label: '执行记录总数', description: '执行记录的数量', params: [] },
            {
                key: 'by-day',
                label: '按天聚合',
                description: '按天统计执行记录',
                params: [
                    {
                        key: 'metric',
                        label: '指标',
                        type: 'select',
                        options: [
                            { value: 'count', label: '次数' },
                            { value: 'duration', label: '时长(分钟)' },
                        ],
                        default: 'count',
                    },
                ],
            },
            {
                key: 'by-week',
                label: '按周聚合',
                description: '按周统计执行记录',
                params: [
                    {
                        key: 'metric',
                        label: '指标',
                        type: 'select',
                        options: [
                            { value: 'count', label: '次数' },
                            { value: 'duration', label: '时长(分钟)' },
                        ],
                        default: 'count',
                    },
                ],
            },
            {
                key: 'by-category',
                label: '按分类聚合',
                description: '按分类统计执行记录占比',
                params: [
                    {
                        key: 'metric',
                        label: '指标',
                        type: 'select',
                        options: [
                            { value: 'count', label: '次数' },
                            { value: 'duration', label: '时长(分钟)' },
                        ],
                        default: 'count',
                    },
                ],
            },
            { key: 'usage-days', label: '累计使用天数', description: '有执行记录的不同日期数', params: [] },
            { key: 'executed-task-count', label: '执行任务总数', description: '有执行记录的不同任务数', params: [] },
            { key: 'total-duration', label: '执行总时长', description: '全部执行记录的时长之和', params: [] },
            { key: 'scatter', label: '散点分布', description: '执行时间与时长分布', params: [] },
            { key: 'heatmap', label: '热力活跃图', description: '按天聚合执行活跃度（最近一年）', params: [] },
            { key: 'radar', label: '综合总览', description: '多维度综合指标（任务/执行/完成率等）', params: [] },
        ],
    },
    {
        key: 'tasks',
        label: '收集盒任务',
        description: '收集盒中的任务',
        aggregations: [
            { key: 'count', label: '任务总数', description: '收集盒中未移除的任务数量', params: [] },
            { key: 'by-status', label: '按状态聚合', description: '按任务状态统计（未开始/进行中/已完成）', params: [] },
            { key: 'wordcloud', label: '标题词云', description: '任务标题关键词词频', params: [] },
        ],
    },
];

/** 按 key 查找数据源元数据 */
export function getDataSourceMeta(key: DataSourceType): DataSourceMeta | undefined {
    return DATA_SOURCE_CATALOG.find((s) => s.key === key);
}

/** 按数据源 + 聚合方式查找聚合方式定义 */
export function getAggregationDef(dataSource: DataSourceType, aggregation: string): AggregationDef | undefined {
    return getDataSourceMeta(dataSource)?.aggregations.find((a) => a.key === aggregation);
}
