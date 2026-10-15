// 基础数据仓库：持有插件全量数据，作为唯一数据源与唯一持久化出口。
// 各领域 repo（gtd / pdca / workbench）通过 get data() 拿到数据对象引用，
// 视图读引用、写走领域 repo 方法，底层仍是同一个对象引用，保证跨视图同步不破坏。
import type { Plugin } from 'obsidian';

import type { WeekRangeData, RangeSchemeData } from '../shared/timeblock-data';
import { getCurrentWeekKey, ensureDefaultScheme, DEFAULT_WEEK_RANGE } from '../shared/timeblock-data';
import type { TimeBlockCategoryData } from '../shared/timeblock-category-manager';
import { ensureUncategorizedCategory } from '../shared/timeblock-category-manager';
import type { DayTemplateData } from '../shared/template-manager';
import type { EventBlock, ExecutionRecord, InboxData, ImprovementData } from '../datatypes/domain';
import { DEFAULT_INBOX_DATA, DEFAULT_IMPROVEMENT_DATA } from '../datatypes/domain';
import type { WorkbenchData } from '../datatypes/card';
import { defaultWorkbenchData } from '../datatypes/card';
import type { GtdData } from '../datatypes/gtd';
import { defaultGtdData } from '../datatypes/gtd';
import { t } from '../i18n';

/** 缓存目录默认名称 */
export const DEFAULT_CACHE_DIR_NAME = 'parrotPlanCache';

/** 插件持有的全量数据（唯一数据源） */
export interface PluginData {
    weekRange: WeekRangeData;
    templateData: DayTemplateData;
    categoryData: TimeBlockCategoryData;
    events: EventBlock[];
    executions: ExecutionRecord[];
    inboxData: InboxData;
    schemeData: RangeSchemeData;
    /** 已标记为「已制定周计划」的周键列表（如 ["2026-W41"]） */
    plannedWeeks: string[];
    /** 工作台卡片数据 */
    workbench: WorkbenchData;
    /** GTD 数据（收集箱等） */
    gtdData: GtdData;
    /** 改进数据（改进视图右侧可填写列表，按周键存储） */
    improvementData: ImprovementData;
    /** 当前正在执行的事件 id（日执行视图顶部执行卡片，随主数据一起持久化） */
    executingEventId?: string;
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
            days: d.weekRange.days,
            weeks: d.weekRange.weeks,
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
            executingEventId: d.executingEventId,
            cacheDirName: this.cacheDirName,
            cacheEnabled: this.cacheEnabled,
            helpDismissed: this.helpDismissed,
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

    /**
     * 加载数据：读取 + 迁移 + 兼容旧数据，最终写入 this.data。
     * 从 main.ts 的 onload 迁入。
     */
    async load(): Promise<void> {
        const rawData: unknown = await this.plugin.loadData();
        let savedData: Record<string, unknown> =
            rawData && typeof rawData === 'object' ? rawData as Record<string, unknown> : {};

        // 读取缓存目录名称（随主数据一起存储，兼容旧数据：默认值）
        this.cacheDirName = typeof savedData.cacheDirName === 'string' && savedData.cacheDirName
            ? savedData.cacheDirName
            : DEFAULT_CACHE_DIR_NAME;

        // 读取是否启用缓存（兼容旧数据：默认启用）
        this.cacheEnabled = typeof savedData.cacheEnabled === 'boolean'
            ? savedData.cacheEnabled
            : true;

        // 读取「不再提示」帮助弹窗标记（兼容旧数据：默认未勾选）
        this.helpDismissed = typeof savedData.helpDismissed === 'boolean'
            ? savedData.helpDismissed
            : false;

        const defaultCategories: TimeBlockCategoryData = {
            categories: [
                { id: 'uncategorized', label: t('defaultCategory.uncategorized'), color: '#888888' },
                { id: 'work', label: t('defaultCategory.work'), color: '#4c8dff' },
                { id: 'rest', label: t('defaultCategory.rest'), color: '#43b581' },
                { id: 'play', label: t('defaultCategory.play'), color: '#f2a65a' },
            ],
        };

        if (savedData.version !== 1 || !Array.isArray(savedData.days)) {
            savedData = {
                version: 1,
                days: DEFAULT_WEEK_RANGE.days,
                dayTemplateData: { dayTemplates: [], dayProperties: [] },
                timeBlockCategoryData: defaultCategories,
                inboxData: DEFAULT_INBOX_DATA,
                schemeData: { schemes: [] },
                events: [],
                executions: [],
            };
        }

        const initialData = migrateWeekRangeData(savedData);
        const initialTemplateData = (savedData.dayTemplateData ?? { dayTemplates: [], dayProperties: [] }) as DayTemplateData;
        const initialCategoryData = (savedData.timeBlockCategoryData ?? defaultCategories) as TimeBlockCategoryData;
        // 兼容旧数据：确保「未分类」始终存在且位于首位
        ensureUncategorizedCategory(initialCategoryData);
        const initialInboxData = (savedData.inboxData ?? DEFAULT_INBOX_DATA) as InboxData;
        const initialSchemeData = (savedData.schemeData ?? { schemes: [] }) as RangeSchemeData;
        // 兼容旧数据：确保默认方案始终存在且位于首位
        ensureDefaultScheme(initialSchemeData, t('rangeScheme.defaultName'));
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
        // 当前正在执行的事件 id（兼容旧数据：默认无）
        const initialExecutingEventId = typeof savedData.executingEventId === 'string'
            ? savedData.executingEventId
            : undefined;

        // 存入仓库实例，作为唯一数据源（视图重建时从这里读取最新数据）
        this.data = {
            weekRange: initialData,
            templateData: initialTemplateData,
            categoryData: initialCategoryData,
            events: (savedData.events ?? []) as EventBlock[],
            executions: (savedData.executions ?? []) as ExecutionRecord[],
            inboxData: initialInboxData,
            schemeData: initialSchemeData,
            plannedWeeks: initialPlannedWeeks,
            workbench: initialWorkbench,
            gtdData: initialGtdData,
            improvementData: initialImprovementData,
            executingEventId: initialExecutingEventId,
        };
    }

    /** 清空全部插件数据并重置为默认值 */
    async clearAll(): Promise<void> {
        await this.plugin.saveData({});
    }
}

/** 迁移旧版周区间数据：把旧的 days 归入当前周的 weeks */
function migrateWeekRangeData(savedData: Record<string, unknown>): WeekRangeData {
    const days = Array.isArray(savedData.days) ? savedData.days : DEFAULT_WEEK_RANGE.days;
    const weeks = (savedData.weeks && typeof savedData.weeks === 'object')
        ? savedData.weeks as Record<string, unknown>
        : {};
    // 旧数据没有 weeks，把 days 归入当前周
    if (Object.keys(weeks).length === 0 && Array.isArray(savedData.days)) {
        weeks[getCurrentWeekKey()] = savedData.days;
    }
    return {
        version: 1,
        days: days as WeekRangeData['days'],
        weeks: weeks as WeekRangeData['weeks'],
    };
}
