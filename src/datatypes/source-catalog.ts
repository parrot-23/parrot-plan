// 数据源目录：集中定义 stats 卡片可用的全部数据源（source.type）。
// 供设置面板列出可选数据源，也作为聚合器 switch 的单一事实来源。
// 新增数据源时：在此登记 + 在 aggregators.ts 的 aggregate() 中实现分发。

import type { ChartType } from './form';

/** 数据源参数定义（设置面板据此渲染参数输入控件） */
export interface SourceParamDef {
    /** 参数键（写入 source.params） */
    key: string;
    /** 参数显示名 */
    label: string;
    /** 参数类型 */
    type: 'select' | 'text';
    /** select 类型的可选项（value → 显示名） */
    options?: Array<{ value: string; label: string }>;
    /** 默认值 */
    default?: string;
}

/** 数据源元数据 */
export interface SourceMeta {
    /** 数据源标识（source.type） */
    type: string;
    /** 数据源显示名 */
    label: string;
    /** 数据源描述 */
    description: string;
    /** 该数据源支持的图表类型（设置面板切换数据源时用于校验/提示） */
    charts: ChartType[];
    /** 参数定义（无参数则为空数组） */
    params: SourceParamDef[];
}

/** 全部数据源清单 */
export const SOURCE_CATALOG: SourceMeta[] = [
    {
        type: 'task-count',
        label: '任务总数',
        description: '收集盒中未移除的任务数量',
        charts: ['metric'],
        params: [],
    },
    {
        type: 'event-completion',
        label: '事件完成率',
        description: '计划事件总数 / 已完成 / 完成率',
        charts: ['metric'],
        params: [],
    },
    {
        type: 'execution-count',
        label: '执行记录总数',
        description: '全部执行记录的数量',
        charts: ['metric'],
        params: [],
    },
    {
        type: 'execution-summary',
        label: '执行统计',
        description: '按维度聚合执行记录（次数或时长）',
        charts: ['bar', 'line', 'area'],
        params: [
            {
                key: 'dimension',
                label: '维度',
                type: 'select',
                options: [
                    { value: 'day', label: '按天' },
                    { value: 'week', label: '按周' },
                ],
                default: 'day',
            },
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
        type: 'category-distribution',
        label: '分类占比',
        description: '按分类聚合执行记录或计划事件的占比',
        charts: ['pie', 'donut', 'hbar'],
        params: [
            {
                key: 'target',
                label: '统计对象',
                type: 'select',
                options: [
                    { value: 'execution', label: '执行记录' },
                    { value: 'event', label: '计划事件' },
                ],
                default: 'execution',
            },
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
        type: 'activity-heatmap',
        label: '执行热力图',
        description: '按天聚合执行活跃度（最近一年）',
        charts: ['heatmap'],
        params: [
            {
                key: 'metric',
                label: '指标',
                type: 'select',
                options: [
                    { value: 'duration', label: '时长(分钟)' },
                    { value: 'count', label: '次数' },
                ],
                default: 'duration',
            },
        ],
    },
    {
        type: 'plan-heatmap',
        label: '计划热力图',
        description: '按天聚合计划事件活跃度（最近一年）',
        charts: ['heatmap'],
        params: [
            {
                key: 'metric',
                label: '指标',
                type: 'select',
                options: [
                    { value: 'duration', label: '时长(分钟)' },
                    { value: 'count', label: '次数' },
                ],
                default: 'duration',
            },
        ],
    },
    {
        type: 'usage-days',
        label: '累计使用天数',
        description: '有执行记录的不同日期数',
        charts: ['metric'],
        params: [],
    },
    {
        type: 'executed-task-count',
        label: '执行任务总数',
        description: '有执行记录的不同任务数',
        charts: ['metric'],
        params: [],
    },
    {
        type: 'execution-total-duration',
        label: '执行总时长',
        description: '全部执行记录的时长之和（分钟）',
        charts: ['metric'],
        params: [],
    },
    {
        type: 'radar-overview',
        label: '雷达图总览',
        description: '多维度综合指标（任务/执行/完成率等）',
        charts: ['radar'],
        params: [],
    },
    {
        type: 'scatter-duration',
        label: '散点图',
        description: '执行时间与时长分布',
        charts: ['scatter'],
        params: [],
    },
    {
        type: 'funnel-status',
        label: '漏斗图',
        description: '任务状态流转（未开始/进行中/已完成）',
        charts: ['funnel'],
        params: [],
    },
    {
        type: 'wordcloud-titles',
        label: '词云',
        description: '任务标题关键词词频',
        charts: ['wordcloud'],
        params: [],
    },
];

/** 按 type 查找数据源元数据 */
export function getSourceMeta(type: string): SourceMeta | undefined {
    return SOURCE_CATALOG.find((s) => s.type === type);
}
