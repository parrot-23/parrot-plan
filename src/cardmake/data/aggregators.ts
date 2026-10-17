// 统计聚合：按 source.type 分发，从 DataProvider 读取规范数据并聚合出指标。
// 输出两类结果：数字指标（StatItem[]）与图表序列（ChartSeries），
// 供 stats 卡片渲染器分别绘制数字卡与图表。

import type { CardSource } from '../../datatypes/form';
import type {
    DataProvider,
    StatItem,
    ChartSeries,
    ChartDatum,
    HeatmapSeries,
    RadarSeries,
    ScatterSeries,
    FunnelSeries,
    WordCloudSeries,
} from '../../datatypes/chart';
import { getEventStatus } from '../../datatypes/domain';
import { makeDayKeyFromWeek } from '../../shared/plan-data';

/** 聚合结果：数字指标 + 可选图表序列 */
export interface AggregationResult {
    /** 数字指标（数字卡 / 进度条） */
    stats: StatItem[];
    /** 图表序列（柱状/折线/饼图），无图表需求时为空 */
    series?: ChartSeries;
    /** 热力图序列（GitHub 贡献图风格），无热力图需求时为空 */
    heatmap?: HeatmapSeries;
    /** 雷达图序列（多维指标），无雷达图需求时为空 */
    radar?: RadarSeries;
    /** 散点图序列（(x,y) 数据点），无散点图需求时为空 */
    scatter?: ScatterSeries;
    /** 漏斗图序列（阶段递减数值），无漏斗图需求时为空 */
    funnel?: FunnelSeries;
    /** 词云序列（词频），无词云需求时为空 */
    wordcloud?: WordCloudSeries;
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
        case 'usage-days':
            return aggregateUsageDays(provider);
        case 'executed-task-count':
            return aggregateExecutedTaskCount(provider);
        case 'execution-total-duration':
            return aggregateExecutionTotalDuration(provider);
        case 'radar-overview':
            return aggregateRadarOverview(provider);
        case 'scatter-duration':
            return aggregateScatterDuration(provider);
        case 'funnel-status':
            return aggregateFunnelStatus(provider);
        case 'wordcloud-titles':
            return aggregateWordCloudTitles(provider);
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
            // 计划事件统一为全天事件，时长口径改用预估执行时长（未填写按 0 计）
            const val = metric === 'duration' ? Math.max(0, ev.estimatedMinutes ?? 0) : 1;
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
        // 计划事件统一为全天事件，时长口径改用预估执行时长（未填写按 0 计）
        const val = metric === 'duration'
            ? Math.max(0, ev.estimatedMinutes ?? 0)
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

/** 累计使用天数：有执行记录的不同日期数 */
function aggregateUsageDays(provider: DataProvider): AggregationResult {
    const days = new Set<string>();
    for (const ex of provider.getExecutions()) {
        if (ex.weekKey && ex.day) {
            days.add(makeDayKeyFromWeek(ex.weekKey, ex.day));
        }
    }
    return { stats: [{ label: '累计使用天数', value: days.size }] };
}

/** 执行的任务总数：有执行记录的不同任务数（按 inboxId 去重） */
function aggregateExecutedTaskCount(provider: DataProvider): AggregationResult {
    const tasks = new Set<string>();
    for (const ex of provider.getExecutions()) {
        if (ex.inboxId) tasks.add(ex.inboxId);
    }
    return { stats: [{ label: '执行任务总数', value: tasks.size }] };
}

/** 执行总时长：全部执行记录的时长之和（分钟） */
function aggregateExecutionTotalDuration(provider: DataProvider): AggregationResult {
    let total = 0;
    for (const ex of provider.getExecutions()) {
        total += Math.max(0, (ex.end ?? ex.start) - ex.start);
    }
    return { stats: [{ label: '执行总时长', value: total }] };
}

/**
 * 雷达图总览：从多个维度聚合出综合指标，供雷达图绘制。
 * 维度：任务数、执行数、完成率、使用天数、执行时长、分类数。
 */
function aggregateRadarOverview(provider: DataProvider): AggregationResult {
    const tasks = provider.getTasks().filter((t) => !t.removed);
    const executions = provider.getExecutions();
    const events = provider.getEvents();

    const taskCount = tasks.length;
    const execCount = executions.length;
    const done = events.filter((e) => getEventStatus(e, executions) === 'executed').length;
    const completionRate = events.length > 0 ? Math.round((done / events.length) * 100) : 0;

    const days = new Set<string>();
    let totalDuration = 0;
    for (const ex of executions) {
        if (ex.weekKey && ex.day) days.add(makeDayKeyFromWeek(ex.weekKey, ex.day));
        totalDuration += Math.max(0, (ex.end ?? ex.start) - ex.start);
    }

    const categories = new Set<string>();
    for (const t of tasks) if (t.categoryId) categories.add(t.categoryId);

    const data = [
        { label: '任务数', value: taskCount },
        { label: '执行数', value: execCount },
        { label: '完成率', value: completionRate },
        { label: '使用天数', value: days.size },
        { label: '执行时长', value: totalDuration },
        { label: '分类数', value: categories.size },
    ];

    return {
        stats: [{ label: '综合维度', value: data.length }],
        radar: { data, metricLabel: '综合指标' },
    };
}

/**
 * 散点图：每个执行记录作为一个数据点，x 为开始时间（分钟），y 为时长（分钟）。
 * 用于观察执行时间分布与时长关系。
 */
function aggregateScatterDuration(provider: DataProvider): AggregationResult {
    const executions = provider.getExecutions();
    const data = executions
        .filter((ex) => ex.start !== undefined)
        .map((ex) => ({
            x: ex.start,
            y: Math.max(0, (ex.end ?? ex.start) - ex.start),
            label: ex.note ?? '',
        }));

    return {
        stats: [{ label: '执行记录', value: data.length }],
        scatter: { data, xLabel: '开始时间(分钟)', yLabel: '时长(分钟)' },
    };
}

/**
 * 漏斗图：按任务状态（未开始 / 进行中 / 已完成）统计数量，展示任务流转漏斗。
 */
function aggregateFunnelStatus(provider: DataProvider): AggregationResult {
    const tasks = provider.getTasks().filter((t) => !t.removed);
    const notStarted = tasks.filter((t) => !t.status || t.status === 'notStarted').length;
    const inProgress = tasks.filter((t) => t.status === 'inProgress').length;
    const done = tasks.filter((t) => t.status === 'done').length;

    const data = [
        { label: '未开始', value: notStarted },
        { label: '进行中', value: inProgress },
        { label: '已完成', value: done },
    ];

    return {
        stats: [{ label: '任务总数', value: tasks.length }],
        funnel: { data, metricLabel: '任务状态' },
    };
}

/**
 * 词云：从任务标题中提取词频。
 * 中文按单字切分（简单分词），英文/数字按空格与标点切分。
 */
function aggregateWordCloudTitles(provider: DataProvider): AggregationResult {
    const tasks = provider.getTasks().filter((t) => !t.removed);
    const freq = new Map<string, number>();

    const addWord = (word: string) => {
        const w = word.trim();
        if (!w) return;
        freq.set(w, (freq.get(w) ?? 0) + 1);
    };

    for (const t of tasks) {
        const title = t.title ?? '';
        // 按空格/标点切分英文与数字，中文按单字切分
        const tokens = title.split(/[\s,，。.!！?？;；:：、/\\()（）\[\]【】"“”'‘’]+/);
        for (const token of tokens) {
            if (!token) continue;
            // 若 token 含中文，按单字切分
            if (/[\u4e00-\u9fa5]/.test(token)) {
                for (const ch of token) {
                    if (/[\u4e00-\u9fa5]/.test(ch)) addWord(ch);
                }
            } else {
                addWord(token);
            }
        }
    }

    const data = Array.from(freq.entries())
        .map(([text, value]) => ({ text, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 50);

    return {
        stats: [{ label: '词条数', value: data.length }],
        wordcloud: { data, metricLabel: '任务关键词' },
    };
}
