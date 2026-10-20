// 基础数据仓库：持有插件全量数据，作为唯一数据源与唯一持久化出口。
// 各领域 repo（gtd / pdca / workbench）通过 get data() 拿到数据对象引用，
// 视图读引用、写走领域 repo 方法，底层仍是同一个对象引用，保证跨视图同步不破坏。
import type { Plugin } from 'obsidian';

import type { PlanSchemeData } from '../shared/plan-data';
import { ensureDefaultScheme } from '../shared/plan-data';
import type { PlanCategoryData } from '../shared/plan-category-manager';
import { ensureUncategorizedCategory } from '../shared/plan-category-manager';
import type { DayTemplateData } from '../shared/template-manager';
import type { EventBlock, ExecutionRecord, InboxData, ImprovementData, RunningTask, OkrRecordEntry } from '../datatypes/domain';
import { DEFAULT_INBOX_DATA, DEFAULT_IMPROVEMENT_DATA, migrateOkrConditions, migrateOkrEntries, migrateOkrRecordCards } from '../datatypes/domain';
import type { WorkbenchData } from '../datatypes/card';
import { defaultWorkbenchData } from '../datatypes/card';
import type { GtdData } from '../datatypes/gtd';
import { defaultGtdData } from '../datatypes/gtd';
import { t } from '../i18n';

/** 缓存目录默认名称 */
export const DEFAULT_CACHE_DIR_NAME = '.parrot-plan/cache';

/** 插件持有的全量数据（唯一数据源） */
export interface PluginData {
    templateData: DayTemplateData;
    categoryData: PlanCategoryData;
    events: EventBlock[];
    executions: ExecutionRecord[];
    inboxData: InboxData;
    schemeData: PlanSchemeData;
    /** 已标记为「已制定周计划」的周键列表（如 ["2026-W41"]） */
    plannedWeeks: string[];
    /** 工作台卡片数据 */
    workbench: WorkbenchData;
    /** GTD 数据（收集箱等） */
    gtdData: GtdData;
    /** 改进数据（改进视图右侧可填写列表，按周键存储） */
    improvementData: ImprovementData;
    /** OKR 记录卡片的填写结果（顶层独立存储，不挂在任务上，避免任务对象膨胀） */
    recordEntries: OkrRecordEntry[];
    /** 当前正在执行的事件 id（日执行视图顶部执行卡片，随主数据一起持久化） */
    executingEventId?: string;
    /** 当前进行中的任务（日执行视图点击「开始任务」后写入，随主数据一起持久化） */
    runningTask?: RunningTask;
    /** 周计划视图是否折叠习惯任务（随主数据一起持久化） */
    habitsCollapsed?: boolean;
    /** 周计划视图是否激活「时间计划」模式（随主数据一起持久化） */
    timePlanActive?: boolean;
    /** 时间计划模式下是否在日历上显示习惯任务（随主数据一起持久化，默认显示） */
    timePlanShowHabits?: boolean;
}

/**
 * 基础数据仓库：持有全量数据 + 唯一保存出口 + 加载/迁移/清空逻辑。
 * 从 main.ts 迁入，不新增业务逻辑，仅做职责归位。
 */
export class BaseRepo {
    private plugin: Plugin;

    /** 插件持有的唯一数据源（视图重建时从这里读取最新数据） */
    data: PluginData | null = null;

    /** 缓存目录名称（随主数据一起持久化） */
    cacheDirName = DEFAULT_CACHE_DIR_NAME;

    /** 是否启用缓存（随主数据一起持久化） */
    cacheEnabled = true;

    /** 是否已勾选「不再提示」帮助弹窗（随主数据一起持久化） */
    helpDismissed = false;

    /** 是否启用剧本模式（随主数据一起持久化，默认关闭） */
    scriptModeEnabled = false;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
    }

    /**
     * 唯一的数据保存出口：把插件持有的全部数据一次性写回。
     * 所有视图与设置项都通过此方法保存，避免「全量覆盖」与「合并写回」两套逻辑并存
     * 导致字段互相覆盖。
     */
    async saveAll(): Promise<void> {
        const d = this.data;
        if (!d) return;
        await this.plugin.saveData({
            version: 1,
            dayTemplateData: d.templateData,
            timeBlockCategoryData: d.categoryData,
            schemeData: d.schemeData,
            events: d.events,
            executions: d.executions,
            inboxData: d.inboxData,
            plannedWeeks: d.plannedWeeks,
            workbench: d.workbench,
            gtdData: d.gtdData,
            improvementData: d.improvementData,
            recordEntries: d.recordEntries,
            executingEventId: d.executingEventId,
            runningTask: d.runningTask,
            habitsCollapsed: d.habitsCollapsed,
            timePlanActive: d.timePlanActive,
            timePlanShowHabits: d.timePlanShowHabits,
            cacheDirName: this.cacheDirName,
            cacheEnabled: this.cacheEnabled,
            helpDismissed: this.helpDismissed,
            scriptModeEnabled: this.scriptModeEnabled,
        });
    }

    /** 保存缓存目录名称 */
    async saveCacheDirName(name: string): Promise<void> {
        this.cacheDirName = name;
        await this.saveAll();
    }

    /** 保存是否启用缓存 */
    async saveCacheEnabled(enabled: boolean): Promise<void> {
        this.cacheEnabled = enabled;
        await this.saveAll();
    }

    /** 保存「不再提示」帮助弹窗标记 */
    async saveHelpDismissed(dismissed: boolean): Promise<void> {
        this.helpDismissed = dismissed;
        await this.saveAll();
    }

    /** 保存是否启用剧本模式 */
    async saveScriptModeEnabled(enabled: boolean): Promise<void> {
        this.scriptModeEnabled = enabled;
        await this.saveAll();
    }

    /**
     * 加载数据：读取 + 迁移 + 兼容旧数据，最终写入 this.data。
     * 从 main.ts 的 onload 迁入。
     */
    async load(): Promise<void> {
        const rawData: unknown = await this.plugin.loadData();
        let savedData: Record<string, unknown> =
            rawData && typeof rawData === 'object' ? rawData as Record<string, unknown> : {};

        // 读取缓存目录名称（随主数据一起存储，兼容旧数据：默认值）
        const savedCacheDirName = typeof savedData.cacheDirName === 'string' && savedData.cacheDirName
            ? savedData.cacheDirName
            : '';
        // 兼容旧数据：旧默认目录 parrotPlanCache 迁移为新默认 .parrot-plan/cache
        this.cacheDirName = savedCacheDirName && savedCacheDirName !== 'parrotPlanCache'
            ? savedCacheDirName
            : DEFAULT_CACHE_DIR_NAME;

        // 读取是否启用缓存（兼容旧数据：默认启用）
        this.cacheEnabled = typeof savedData.cacheEnabled === 'boolean'
            ? savedData.cacheEnabled
            : true;

        // 读取「不再提示」帮助弹窗标记（兼容旧数据：默认未勾选）
        this.helpDismissed = typeof savedData.helpDismissed === 'boolean'
            ? savedData.helpDismissed
            : false;

        // 读取是否启用剧本模式（兼容旧数据：默认关闭）
        this.scriptModeEnabled = typeof savedData.scriptModeEnabled === 'boolean'
            ? savedData.scriptModeEnabled
            : false;

        const defaultCategories: PlanCategoryData = {
            categories: [
                { id: 'uncategorized', label: t('defaultCategory.uncategorized'), color: '#888888' },
                { id: 'work', label: t('defaultCategory.work'), color: '#4c8dff' },
                { id: 'rest', label: t('defaultCategory.rest'), color: '#43b581' },
                { id: 'play', label: t('defaultCategory.play'), color: '#f2a65a' },
            ],
        };

        if (savedData.version !== 1) {
            savedData = {
                version: 1,
                dayTemplateData: { dayTemplates: [], dayProperties: [] },
                timeBlockCategoryData: defaultCategories,
                inboxData: DEFAULT_INBOX_DATA,
                schemeData: { schemes: [] },
                events: [],
                executions: [],
            };
        }

        const initialTemplateData = (savedData.dayTemplateData ?? { dayTemplates: [], dayProperties: [] }) as DayTemplateData;
        const initialCategoryData = (savedData.timeBlockCategoryData ?? defaultCategories) as PlanCategoryData;
        // 兼容旧数据：确保「未分类」始终存在且位于首位
        ensureUncategorizedCategory(initialCategoryData);
        const initialInboxData = (savedData.inboxData ?? DEFAULT_INBOX_DATA) as InboxData;
        // 兼容旧数据：把旧的 OKR 条件（duration / outcome）迁移为新类型
        for (const item of initialInboxData.items ?? []) {
            if (item.okr) {
                const rawConditions = item.okr.conditions ?? [];
                // 兼容旧数据：旧的「记录」是 type 为 record 的 OKR 条件，拆出到 item.records
                const legacyRecords = rawConditions.filter(c => (c as { type?: unknown })?.type === 'record');
                if (legacyRecords.length > 0) {
                    const migrated = migrateOkrRecordCards(legacyRecords);
                    if (migrated.length > 0) {
                        item.records = [...(item.records ?? []), ...migrated];
                    }
                }
                item.okr.conditions = migrateOkrConditions(rawConditions);
            }
            // 兼容旧数据：规范化记录卡片
            if (item.records) {
                item.records = migrateOkrRecordCards(item.records);
            }
            // 兼容旧数据：把旧的 habitTimeEnabled 迁移为 taskType（习惯型任务）
            if (item.taskType === undefined && item.habitTimeEnabled === true) {
                item.taskType = 'habit';
            }
        }
        const initialPlanSchemeData = (savedData.schemeData ?? { schemes: [] }) as PlanSchemeData;
        // 兼容旧数据：确保默认方案始终存在且位于首位
        ensureDefaultScheme(initialPlanSchemeData, t('planScheme.defaultName'));
        // 已制定周计划的周键列表（兼容旧数据：默认空数组）
        const initialPlannedWeeks = Array.isArray(savedData.plannedWeeks)
            ? savedData.plannedWeeks as string[]
            : [];
        // 工作台卡片数据（兼容旧数据：默认空）
        const initialWorkbench = (savedData.workbench && typeof savedData.workbench === 'object')
            ? savedData.workbench as WorkbenchData
            : defaultWorkbenchData();
        // GTD 数据（兼容旧数据：默认空）
        const initialGtdData = (savedData.gtdData && typeof savedData.gtdData === 'object')
            ? savedData.gtdData as GtdData
            : defaultGtdData();
        // 兼容旧数据：确保 items / sources 字段存在
        if (!Array.isArray(initialGtdData.items)) initialGtdData.items = [];
        if (!Array.isArray(initialGtdData.sources)) initialGtdData.sources = [];
        // 改进数据（兼容旧数据：默认空）
        const initialImprovementData = (savedData.improvementData && typeof savedData.improvementData === 'object')
            ? savedData.improvementData as ImprovementData
            : DEFAULT_IMPROVEMENT_DATA;
        if (!initialImprovementData.byWeek || typeof initialImprovementData.byWeek !== 'object') {
            initialImprovementData.byWeek = {};
        }
        // OKR 记录卡片填写结果（顶层独立存储，兼容旧数据：默认空）
        const initialOkrEntries = migrateOkrEntries(savedData.recordEntries ?? savedData.okrEntries);
        // 当前正在执行的事件 id（兼容旧数据：默认无）
        const initialExecutingEventId = typeof savedData.executingEventId === 'string'
            ? savedData.executingEventId
            : undefined;
        // 当前进行中的任务（兼容旧数据：默认无）
        const initialRunningTask = parseRunningTask(savedData.runningTask);
        // 周计划视图是否折叠习惯任务（兼容旧数据：默认不折叠）
        const initialHabitsCollapsed = savedData.habitsCollapsed === true;
        // 周计划视图是否激活「时间计划」模式（兼容旧数据：默认未激活）
        const initialTimePlanActive = savedData.timePlanActive === true;
        // 时间计划模式下是否显示习惯任务（兼容旧数据：默认显示）
        const initialTimePlanShowHabits = savedData.timePlanShowHabits !== false;

        // 存入仓库实例，作为唯一数据源（视图重建时从这里读取最新数据）
        this.data = {
            templateData: initialTemplateData,
            categoryData: initialCategoryData,
            events: (savedData.events ?? []) as EventBlock[],
            executions: (savedData.executions ?? []) as ExecutionRecord[],
            inboxData: initialInboxData,
            schemeData: initialPlanSchemeData,
            plannedWeeks: initialPlannedWeeks,
            workbench: initialWorkbench,
            gtdData: initialGtdData,
            improvementData: initialImprovementData,
            recordEntries: initialOkrEntries,
            executingEventId: initialExecutingEventId,
            runningTask: initialRunningTask,
            habitsCollapsed: initialHabitsCollapsed,
            timePlanActive: initialTimePlanActive,
            timePlanShowHabits: initialTimePlanShowHabits,
        };
    }

    /** 清空全部插件数据并重置为默认值 */
    async clearAll(): Promise<void> {
        await this.plugin.saveData({});
    }
}

/** 解析持久化的进行中任务（兼容旧数据 / 非法数据：返回 undefined） */
function parseRunningTask(raw: unknown): RunningTask | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    if (typeof r.inboxId !== 'string' || typeof r.start !== 'number' || typeof r.dayKey !== 'string') {
        return undefined;
    }
    const task: RunningTask = { inboxId: r.inboxId, start: r.start, dayKey: r.dayKey };
    // 兼容旧数据：end 为可选字段
    if (typeof r.end === 'number') task.end = r.end;
    return task;
}
