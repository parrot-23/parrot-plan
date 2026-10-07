// 模板加载器：模板 JSON 在构建时被打包进 main.js（通过 @rollup/plugin-json）。
// 运行时不再读取文件系统，避免插件发布时 templates/ 目录无法随包分发的问题。
import type { CardTemplate } from '../../datatypes/form';

import activityHeatmap from '../templates/activity-heatmap.json';
import categoryDistribution from '../templates/category-distribution.json';
import dailyMood from '../templates/daily-mood.json';
import dayExecutionChart from '../templates/day-execution-chart.json';
import eventCompletion from '../templates/event-completion.json';
import taskStats from '../templates/task-stats.json';
import weeklyReview from '../templates/weekly-review.json';
import yearGoal from '../templates/year-goal.json';

/** 内置模板列表（构建时内联，随 main.js 一起分发） */
const BUILTIN_TEMPLATES: CardTemplate[] = [
    activityHeatmap as CardTemplate,
    categoryDistribution as CardTemplate,
    dailyMood as CardTemplate,
    dayExecutionChart as CardTemplate,
    eventCompletion as CardTemplate,
    taskStats as CardTemplate,
    weeklyReview as CardTemplate,
    yearGoal as CardTemplate,
];

/** 模板缓存：id → 模板 */
const cache = new Map<string, CardTemplate>();

/**
 * 加载全部模板。
 * 返回内置模板列表（已内联到 main.js，无需读取文件系统）。
 */
export async function loadAllTemplates(): Promise<CardTemplate[]> {
    for (const tpl of BUILTIN_TEMPLATES) {
        if (tpl && tpl.id && tpl.mode) {
            cache.set(tpl.id, tpl);
        }
    }
    return BUILTIN_TEMPLATES.filter((tpl) => tpl && tpl.id && tpl.mode);
}

/** 按 id 获取模板（优先缓存） */
export async function getTemplate(id: string): Promise<CardTemplate | undefined> {
    if (cache.has(id)) return cache.get(id);
    await loadAllTemplates();
    return cache.get(id);
}
