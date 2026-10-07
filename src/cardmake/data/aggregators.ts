// 统计聚合：按 source.type 分发，从 DataProvider 读取规范数据并聚合出指标。
// 输出两类结果：数字指标（StatItem[]）与图表序列（ChartSeries），
// 供 stats 卡片渲染器分别绘制数字卡与图表。

import type { CardSource } from '../../datatypes/form';
import type { DataProvider, StatItem, ChartSeries, ChartDatum, HeatmapSeries } from '../../datatypes/chart';
import { getEventStatus } from '../../datatypes/domain';
import { makeDayKeyFromWeek } from '../../views/week-view/timeblock-data';

/** 聚合结果：数字指标 + 可选图表序列 */
export interface AggregationResult {
    /** 数字指标（数字卡 / 进度条） */
    stats: StatItem[];
    /** 图表序列（柱状/折线/饼图），无图表需求时为空 */
    series?: ChartSeries;
    /** 热力图序列（GitHub 贡献图风格），无热力图需求时为空 */
    heatmap?: HeatmapSeries;
}

/** 按 source.type 聚合数据 */
export function aggregate(source: CardSource, provider: DataProvider): AggregationResult {
    switch (source.type) {
        case 'task-count':
            return aggregateTaskCount(provider);
        case 'event-completion':
            return aggregateEventCompletion(provider);
        case 'execution-count':
            return aggregateExecutionCount(provider);
        case 'execution-summary':
            return aggregateExecutionSummary(source, provider);
        case 'category-distribution':
            return aggregateCategoryDistribution(source, provider);
        case 'activity-heatmap':
            return aggregateActivityHeatmap(source, provider);
        case 'plan-heatmap':
            return aggregatePlanHeatmap(source, provider);
        default:
            return { stats: [] };
    }
}

/** 任务总数（收集盒未移除任务） */
function aggregateTaskCount(provider: DataProvider): AggregationResult {
    const total = provider.getTasks().filter((i) => !i.removed).length;
    return { stats: [{ label: '任务总数', value: total }] };
}

/** 事件完成率：计划事件总数 / 已完成 / 完成率 */
function aggregateEventCompletion(provider: DataProvider): AggregationResult {
    const events = provider.getEvents();
    const executions = provider.getExecutions();
    const total = events.length;
    const done = events.filter((e) => getEventStatus(e, executions) === 'executed').length;
    return {
        stats: [
            { label: '计划事件', value: total },
            { label: '已完成', value: done },
            { label: '完成率', value: total > 0 ? Math.round((done / total) * 100) : 0 },
        ],
    };
}

/** 执行记录总数 */
function aggregateExecutionCount(provider: DataProvider): AggregationResult {
    const count = provider.getExecutions().length;
    return { stats: [{ label: '执行记录', value: count }] };
}

/**
 * 日执行统计：按维度聚合执行记录。
 * dimension: day（按天）/ week（按周）/ category（按分类）
 * metric: count（次数）/ duration（时长，分钟）
 */
function aggregateExecutionSummary(source: CardSource, provider: DataProvider): AggregationResult {
    const dimension = (source.params?.dimension as string) ?? 'day';
    const metric = (source.params?.metric as string) ?? 'count';
    const executions = provider.getExecutions();

    const buckets = new Map<string, number>();
    for (const ex of executions) {
        const key = dimensionKey(ex, dimension);
        const val = metric === 'duration'
            ? Math.max(0, (ex.end ?? ex.start) - ex.start)
            : 1;
        buckets.set(key, (buckets.get(key) ?? 0) + val);
    }

    const data: ChartDatum[] = Array.from(buckets.entries())
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => a.label.localeCompare(b.label));

    return {
        stats: [{ label: '执行总量', value: data.reduce((s, d) => s + d.value, 0) }],
        series: { data, metricLabel: metric === 'duration' ? '时长(分钟)' : '次数' },
    };
}

/** 分类分布：按分类聚合执行记录（或计划事件）的占比 */
function aggregateCategoryDistribution(source: CardSource, provider: DataProvider): AggregationResult {
    const target = (source.params?.target as string) ?? 'execution';
    const metric = (source.params?.metric as string) ?? 'count';

    const buckets = new Map<string, number>();
    if (target === 'event') {
        for (const ev of provider.getEvents()) {
            const cat = ev.categoryId ?? 'uncategorized';
            const val = metric === 'duration' ? Math.max(0, ev.end - ev.start) : 1;
            buckets.set(cat, (buckets.get(cat) ?? 0) + val);
        }
    } else {
        for (const ex of provider.getExecutions()) {
            const cat = resolveExecutionCategory(ex, provider);
            const val = metric === 'duration' ? Math.max(0, ex.end - ex.start) : 1;
            buckets.set(cat, (buckets.get(cat) ?? 0) + val);
        }
    }

    const data: ChartDatum[] = Array.from(buckets.entries())
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value);

    return {
        stats: [{ label: '分类总数', value: data.length }],
        series: { data, metricLabel: metric === 'duration' ? '时长(分钟)' : '次数' },
    };
}

/** 解析执行记录的分类：优先来源任务，其次来源事件，兜底「未分类」 */
function resolveExecutionCategory(ex: { inboxId?: string; eventId?: string }, provider: DataProvider): string {
    if (ex.inboxId) {
        const task = provider.getTasks().find((t) => t.id === ex.inboxId);
        if (task?.categoryId) return task.categoryId;
    }
    if (ex.eventId) {
        const ev = provider.getEvents().find((e) => e.id === ex.eventId);
        if (ev?.categoryId) return ev.categoryId;
    }
    return 'uncategorized';
}

/** 计算执行记录在指定维度下的键 */
function dimensionKey(ex: { weekKey?: string; day?: number }, dimension: string): string {
    if (dimension === 'week') {
        return ex.weekKey ?? '未知周';
    }
    // 默认按天：由周键 + 星期几换算日期键
    if (ex.weekKey && ex.day) {
        return makeDayKeyFromWeek(ex.weekKey, ex.day);
    }
    return '未知日期';
}

/**
 * 执行记录热力活跃图：按天聚合执行时长（分钟），输出 GitHub 贡献图风格的热力图序列。
 * 时间范围：最近一年（365 天）。
 * 范围过滤：source.params.projectId 指定聚焦项目时，仅统计该项目及其子任务的执行记录。
 */
function aggregateActivityHeatmap(source: CardSource, provider: DataProvider): AggregationResult {
    const metric = (source.params?.metric as string) ?? 'duration';
    const projectId = source.params?.projectId as string | undefined;

    // 计算聚焦项目及其所有子任务的 id 集合（未指定时统计全部）
    let visibleIds: Set<string> | undefined;
    if (projectId) {
        visibleIds = new Set<string>([projectId]);
        const walk = (parentId: string) => {
            for (const t of provider.getTasks()) {
                if (t.removed || t.parentId !== parentId) continue;
                visibleIds!.add(t.id);
                walk(t.id);
            }
        };
        walk(projectId);
    }

    // 按天聚合执行时长（分钟）
    const buckets = new Map<string, number>();
    for (const ex of provider.getExecutions()) {
        if (!ex.weekKey || !ex.day) continue;
        if (visibleIds && ex.inboxId && !visibleIds.has(ex.inboxId)) continue;
        const dateKey = makeDayKeyFromWeek(ex.weekKey, ex.day);
        const val = metric === 'duration'
            ? Math.max(0, (ex.end ?? ex.start) - ex.start)
            : 1;
        buckets.set(dateKey, (buckets.get(dateKey) ?? 0) + val);
    }

    const data = Array.from(buckets.entries())
        .map(([date, value]) => ({ date, value }));

    const total = data.reduce((s, d) => s + d.value, 0);
    return {
        stats: [{ label: '活跃总量', value: total }],
        heatmap: { data, metricLabel: metric === 'duration' ? '时长(分钟)' : '次数' },
    };
}

/**
 * 计划事件热力活跃图：按天聚合计划事件时长（分钟），输出 GitHub 贡献图风格的热力图序列。
 * 时间范围：最近一年（365 天）。
 * 范围过滤：source.params.projectId 指定聚焦项目时，仅统计该项目及其子任务的计划事件。
 */
function aggregatePlanHeatmap(source: CardSource, provider: DataProvider): AggregationResult {
    const metric = (source.params?.metric as string) ?? 'duration';
    const projectId = source.params?.projectId as string | undefined;

    // 计算聚焦项目及其所有子任务的 id 集合（未指定时统计全部）
    let visibleIds: Set<string> | undefined;
    if (projectId) {
        visibleIds = new Set<string>([projectId]);
        const walk = (parentId: string) => {
            for (const t of provider.getTasks()) {
                if (t.removed || t.parentId !== parentId) continue;
                visibleIds!.add(t.id);
                walk(t.id);
            }
        };
        walk(projectId);
    }

    // 按天聚合计划事件时长（分钟）
    const buckets = new Map<string, number>();
    for (const ev of provider.getEvents()) {
        if (!ev.weekKey || !ev.day) continue;
        if (visibleIds && ev.inboxId && !visibleIds.has(ev.inboxId)) continue;
        const dateKey = makeDayKeyFromWeek(ev.weekKey, ev.day);
        const val = metric === 'duration'
            ? Math.max(0, ev.end - ev.start)
            : 1;
        buckets.set(dateKey, (buckets.get(dateKey) ?? 0) + val);
    }

    const data = Array.from(buckets.entries())
        .map(([date, value]) => ({ date, value }));

    const total = data.reduce((s, d) => s + d.value, 0);
    return {
        stats: [{ label: '计划总量', value: total }],
        heatmap: { data, metricLabel: metric === 'duration' ? '时长(分钟)' : '次数' },
    };
}
