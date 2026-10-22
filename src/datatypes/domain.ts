// 核心领域数据契约：计划事件、执行记录、收集盒任务。
// 这些是插件最核心的数据标准，被周计划、日执行、年计划、泳道图、工作台等多个视图共用，
// 统一在此定义，保证各视图读取的数据口径一致。

import type { WeekKey } from '../shared/plan-data';

/** 计划事件（周计划视图排布的事件） */
export interface EventBlock {
    id: string;
    day: number;
    start: number;
    end: number;
    title: string;
    categoryId?: string;
    /** 来源收集盒任务 id（手动新建的事件无此字段） */
    inboxId?: string;
    /** 全天事件（start=0, end=1440） */
    allDay?: boolean;
    completed?: boolean;
    notePath?: string;
    /** 额外备注（纯文本，名称来源于任务不可改，仅可补充备注） */
    note?: string;
    /** 预估执行时长（分钟），未填写时为空 */
    estimatedMinutes?: number;
    /** 所属周键（如 2026-W40） */
    weekKey?: WeekKey;
}

/** 进行中任务（日执行视图点击「开始任务」后写入，随主数据一起持久化） */
export interface RunningTask {
    /** 来源收集盒任务 id */
    inboxId: string;
    /** 起始时间（当天分钟数） */
    start: number;
    /** 所属日期键（如 2026-10-16） */
    dayKey: string;
    /** 用户填写的结束时间（当天分钟数，可选，旧数据无此字段） */
    end?: number;
    /** 结束时间是否跨到次日（0 或省略=当天，1=次日） */
    endDayOffset?: number;
    /** 实际开始时刻（Unix 毫秒时间戳，用于精确展示已执行时长；旧数据无此字段） */
    startedAt?: number;
}

/** 执行记录（日执行视图写入） */
export interface ExecutionRecord {
    id: string;
    eventId?: string;
    /** 来源收集盒任务 id（与事件一致，便于按任务聚合） */
    inboxId?: string;
    day: number;
    start: number;
    end: number;
    /** 结束时间相对起始日的天数偏移（0 或省略=当天，1=次日），用于跨天记录 */
    endDayOffset?: number;
    note?: string;
    /** 所属周键（如 2026-W40） */
    weekKey?: WeekKey;
    /**
     * 是否为「替换」执行：原计划未按原样执行，实际执行了另一任务。
     * 此类记录关联原计划事件（eventId），但不改变原计划事件本身，也不使其状态变为「已执行」。
     */
    replaced?: boolean;
}

/**
 * 执行记录的实际结束分钟数：以起始日为基准，
 * 跨天记录（endDayOffset=1）的结束时间需加上 24 小时。
 */
export function executionEndMinutes(ex: ExecutionRecord): number {
    return ex.end + (ex.endDayOffset ?? 0) * 24 * 60;
}

/** 执行记录的实际执行时长（分钟），跨天记录自动计入次日部分 */
export function executionDuration(ex: ExecutionRecord): number {
    return Math.max(0, executionEndMinutes(ex) - ex.start);
}

/** 任务类型：一次性任务 / 习惯型任务 */
export type TaskType = 'oneTime' | 'habit';

/** 任务状态 */
export type TaskStatus = 'notStarted' | 'inProgress' | 'done' | 'paused';

/** 收集盒任务（可无限层级子任务） */
export interface InboxItem {
    id: string;
    title: string;
    description: string;
    categoryId?: string;
    createdAt: number;
    /** 父任务 id（无则为顶层任务），支持无限层级子任务 */
    parentId?: string;
    /** 已分配到的周键列表（如 ['2026-W40']），可分配到多个周 */
    assignedWeekKeys?: string[];
    /** 已分配到的日期列表（如 ['2026-10-02']），可分配到多天 */
    assignedDayKeys?: string[];
    /** 已手动标记为「当天已完成」的日期列表（如 ['2026-10-19']） */
    doneDayKeys?: string[];
    /** 已手动标记为「当天未完成」的日期列表（如 ['2026-10-19']），优先级高于预估/执行时长的自动判定 */
    undoneDayKeys?: string[];
    /** 已从收集盒移除（不再显示，但数据保留，可查历史） */
    removed?: boolean;
    /** 板块：任务内部的结构化内容（可选，旧任务无此字段） */
    sections?: Section[];
    /** OKR 信息（可选，旧任务无此字段） */
    okr?: OkrInfo;
    /** 记录卡片（自定义表单设计，与 OKR 平级，可选，旧任务无此字段） */
    records?: OkrRecordCard[];
    /** 截止日期（可选，格式 YYYY-MM-DD，旧任务无此字段） */
    dueDate?: string;
    /** 任务状态（可选，旧任务无此字段，默认未开始） */
    status?: TaskStatus;
    /** 任务类型（可选：oneTime / habit，旧任务无此字段，默认一次性任务） */
    taskType?: TaskType;
    /** 习惯时间点（可选，起始时间，单位分钟，如 540 表示 09:00，旧任务无此字段） */
    habitTime?: number;
    /** 习惯时间点是否启用（可选，旧任务无此字段，默认未启用） */
    habitTimeEnabled?: boolean;
    /** 预估执行时长（分钟，可选，旧任务无此字段，未填写时为空） */
    estimatedMinutes?: number;
    /** 收集篮子：待归入本任务的笔记/条目（可选，旧任务无此字段，供 GTD 梳理阶段放置） */
    basket?: BasketItem[];
    /** 改进项：本任务的改进条目（可选，旧任务无此字段，可勾选完成） */
    improvements?: ImprovementEntry[];
}

/** 改进项条目（任务改进方框内可勾选的条目） */
export interface ImprovementEntry {
    id: string;
    /** 改进内容文本 */
    text: string;
    /** 是否已完成（可选，旧数据无此字段默认未完成） */
    done?: boolean;
    /** 创建时间（时间戳） */
    createdAt: number;
}

/** 收集篮子条目（GTD 梳理阶段放置到某任务的笔记/条目） */
export interface BasketItem {
    id: string;
    /** 条目文本（笔记内容或标题） */
    text: string;
    /** 关联的 vault 文件路径（可选，如 'notes/foo.md'） */
    path?: string;
    /** 放入时间（时间戳） */
    createdAt: number;
}

/** 任务 OKR 信息（计划值，手填） */
export interface OkrInfo {
    /** OKR 条目列表（每条：类型 + 对应字段） */
    conditions: OkrCondition[];
}

/**
 * OKR 条目类型：
 * - 拆解型：任务整体一次性达成
 *   - milestone 里程碑（任务的具体状态进度）
 *   - outcome   成果（任务的实际交付物成果）
 *   - cumulative 累积（某种累积的数值）
 * - 周期型：每个周期内用某种判定，需要打卡记录
 *   - frequency 频次（执行次数等）
 *   - range     区间（保持合理睡眠时长等）
 */
export type OkrConditionType = 'milestone' | 'outcome' | 'cumulative' | 'frequency' | 'range';

/** OKR 条目所属大类 */
export type OkrConditionGroup = 'breakdown' | 'periodic';

/** 周期型条目的周期粒度 */
export type OkrPeriod = 'day' | 'week' | 'month';

/** 周期型条目的打卡记录（每个周期一条） */
export interface OkrRecord {
    /** 周期键：day → 2026-10-18，week → 2026-W42，month → 2026-10 */
    periodKey: string;
    /** 记录值：频次为次数，区间为数值 */
    value: number;
}

/** 里程碑 / 成果条目下的清单行（一个条目可包含多行） */
export interface OkrConditionItem {
    id: string;
    /** 行文本（如「里程碑1」） */
    text: string;
    /** 是否已完成 */
    done: boolean;
}

/** 记录卡片的字段类型 */
export type OkrRecordFieldType = 'text' | 'number' | 'date' | 'duration' | 'boolean' | 'select';

/** 记录卡片的一个字段定义（表单设计的一行） */
export interface OkrRecordField {
    id: string;
    type: OkrRecordFieldType;
    /** 字段名称 */
    name: string;
}

/**
 * 记录卡片（自定义表单设计，与 OKR 概念平级，但当前仍展示在 OKR 页面下）。
 * 记录卡片不是 OKR 条目，而是任务执行时按字段收集结构化数据的「追踪器」。
 */
export interface OkrRecordCard {
    id: string;
    /** 记录卡片标题（可选，旧数据无此字段） */
    title?: string;
    /** 表单字段定义 */
    fields: OkrRecordField[];
}

/**
 * 记录卡片的一次填写结果（顶层独立存储，不挂在任务上）。
 * 日数据量可能很大，放顶层便于按需查询、统计与未来索引/分文件落盘。
 */
export interface OkrRecordEntry {
    id: string;
    /** 归属哪个记录卡片（对应 OkrRecordCard.id，全局唯一） */
    recordId: string;
    /** 归属哪个任务（冗余存储，便于按任务查询；任务删除后依然保留作历史） */
    inboxId: string;
    /** 所属日期键（YYYY-MM-DD） */
    dayKey: string;
    /** 创建时间戳（毫秒） */
    createdAt: number;
    /** 字段值：fieldId -> 值（类型随字段定义：文本/选项/日期→string，数字/时长→number，是否→boolean） */
    values: Record<string, string | number | boolean>;
}

/** OKR 条目（一条：类型 + 对应字段） */
export interface OkrCondition {
    id: string;
    type: OkrConditionType;
    /** 条目名称（如「里程碑1」「每周运动」），旧数据无此字段 */
    title?: string;
    /** 目标值（里程碑 / 累积 / 频次使用） */
    target: number;
    /** 成果文本（成果类型使用，纯文字描述） */
    text?: string;
    /** 是否已完成（里程碑 / 成果使用，旧数据无此字段默认未完成） */
    done?: boolean;
    /** 清单行（里程碑 / 成果使用：一个条目表示一整个清单，可包含多行） */
    items?: OkrConditionItem[];
    /** 单位（累积 / 区间使用，如「分钟」「小时」） */
    unit?: string;
    /** 周期粒度（周期型使用） */
    period?: OkrPeriod;
    /** 区间下限（区间类型使用） */
    min?: number;
    /** 区间上限（区间类型使用） */
    max?: number;
    /** 打卡记录（周期型使用） */
    records?: OkrRecord[];
    /** 期望时间点（维度信息，格式 YYYY-MM-DD） */
    dueDate?: string;
    /** 绑定的子任务 id 列表（可关联多个子任务） */
    subtaskIds?: string[];
}

/**
 * OKR 条目类型原型数据：统一维护各类型的名称 i18n key、所属大类与单位 i18n key。
 * 各视图统一从此处读取，避免各处重复判断。
 */
export const OKR_CONDITION_META: Record<OkrConditionType, { labelKey: string; group: OkrConditionGroup; unitKey: string }> = {
    milestone: { labelKey: 'okr.typeMilestone', group: 'breakdown', unitKey: 'okr.unitCount' },
    outcome: { labelKey: 'okr.typeOutcome', group: 'breakdown', unitKey: 'okr.unitCount' },
    cumulative: { labelKey: 'okr.typeCumulative', group: 'breakdown', unitKey: 'okr.unitMinute' },
    frequency: { labelKey: 'okr.typeFrequency', group: 'periodic', unitKey: 'okr.unitTimes' },
    range: { labelKey: 'okr.typeRange', group: 'periodic', unitKey: 'okr.unitCount' },
};

/** 记录卡片字段类型原型数据：统一维护各类型的名称 i18n key */
export const OKR_RECORD_FIELD_META: Record<OkrRecordFieldType, { labelKey: string }> = {
    text: { labelKey: 'okr.recordFieldText' },
    number: { labelKey: 'okr.recordFieldNumber' },
    date: { labelKey: 'okr.recordFieldDate' },
    duration: { labelKey: 'okr.recordFieldDuration' },
    boolean: { labelKey: 'okr.recordFieldBoolean' },
    select: { labelKey: 'okr.recordFieldSelect' },
};

/** OKR 大类原型数据：名称 i18n key + 该大类下的条目类型（按展示顺序） */
export const OKR_GROUP_META: Record<OkrConditionGroup, { labelKey: string; types: OkrConditionType[] }> = {
    breakdown: { labelKey: 'okr.groupBreakdown', types: ['milestone', 'outcome', 'cumulative'] },
    periodic: { labelKey: 'okr.groupPeriodic', types: ['frequency', 'range'] },
};

/** 周期粒度原型数据：名称 i18n key */
export const OKR_PERIOD_META: Record<OkrPeriod, { labelKey: string }> = {
    day: { labelKey: 'okr.periodDay' },
    week: { labelKey: 'okr.periodWeek' },
    month: { labelKey: 'okr.periodMonth' },
};

/**
 * 兼容旧数据：把旧的 OKR 条件（duration / outcome）迁移为新类型。
 * - duration → cumulative（累积，单位分钟）
 * - outcome  → outcome（成果）
 * 已是新类型的条目原样返回；非法条目丢弃。
 */
export function migrateOkrConditions(raw: unknown): OkrCondition[] {
    if (!Array.isArray(raw)) return [];
    const result: OkrCondition[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const c = entry as Record<string, unknown>;
        if (typeof c.id !== 'string') continue;

        // 旧类型映射
        let type = c.type as OkrConditionType;
        if (type === ('duration' as unknown as OkrConditionType)) type = 'cumulative';
        if (!(type in OKR_CONDITION_META)) continue;

        const cond: OkrCondition = {
            id: c.id,
            type,
            target: typeof c.target === 'number' ? c.target : 0,
        };
        if (typeof c.title === 'string') cond.title = c.title;
        if (typeof c.text === 'string') cond.text = c.text;
        if (typeof c.done === 'boolean') cond.done = c.done;
        if (Array.isArray(c.items)) {
            cond.items = c.items
                .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
                .filter(it => typeof it.id === 'string' && typeof it.text === 'string')
                .map(it => ({ id: it.id as string, text: it.text as string, done: it.done === true }));
        }
        if (typeof c.unit === 'string') cond.unit = c.unit;
        if (type === 'cumulative' && !cond.unit) cond.unit = 'min';
        if (c.period === 'day' || c.period === 'week' || c.period === 'month') cond.period = c.period;
        if (typeof c.min === 'number') cond.min = c.min;
        if (typeof c.max === 'number') cond.max = c.max;
        if (Array.isArray(c.records)) {
            cond.records = c.records.filter(
                (r): r is OkrRecord => !!r && typeof r === 'object'
                    && typeof (r as OkrRecord).periodKey === 'string'
                    && typeof (r as OkrRecord).value === 'number',
            );
        }
        if (typeof c.dueDate === 'string') cond.dueDate = c.dueDate;
        // 兼容旧数据：把旧的单值 subtaskId 并入多值 subtaskIds
        if (typeof c.subtaskId === 'string' && c.subtaskId) {
            cond.subtaskIds = cond.subtaskIds ?? [];
            if (!cond.subtaskIds.includes(c.subtaskId)) cond.subtaskIds.push(c.subtaskId);
        }
        if (Array.isArray(c.subtaskIds)) {
            cond.subtaskIds = c.subtaskIds.filter((id): id is string => typeof id === 'string' && id !== '');
        }
        result.push(cond);
    }
    return result;
}

/**
 * 兼容旧数据：还原顶层 OKR 记录卡片的填写结果（OkrRecordEntry[]）。
 * 非法条目丢弃；values 只保留 string / number / boolean 三种值。
 */
export function migrateOkrEntries(raw: unknown): OkrRecordEntry[] {
    if (!Array.isArray(raw)) return [];
    const result: OkrRecordEntry[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.id !== 'string') continue;
        if (typeof e.recordId !== 'string') continue;
        if (typeof e.inboxId !== 'string') continue;
        if (typeof e.dayKey !== 'string') continue;

        const values: Record<string, string | number | boolean> = {};
        if (e.values && typeof e.values === 'object') {
            for (const [k, v] of Object.entries(e.values as Record<string, unknown>)) {
                if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                    values[k] = v;
                }
            }
        }

        result.push({
            id: e.id,
            recordId: e.recordId,
            inboxId: e.inboxId,
            dayKey: e.dayKey,
            createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
            values,
        });
    }
    return result;
}

/**
 * 兼容旧数据：还原记录卡片（OkrRecordCard[]）。
 * 旧数据中「记录」曾作为 type 为 record 的 OKR 条件存放在 conditions 里，
 * 本函数同时兼容旧结构（{ id, title?, fields[] }）与新的 records 数组结构。
 * 字段定义非法或无字段的卡片会被丢弃。
 */
export function migrateOkrRecordCards(raw: unknown): OkrRecordCard[] {
    if (!Array.isArray(raw)) return [];
    const result: OkrRecordCard[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const c = r as Record<string, unknown>;
        if (typeof c.id !== 'string') continue;

        const rawFields = Array.isArray(c.fields) ? c.fields : [];
        const fields: OkrRecordField[] = [];
        for (const f of rawFields) {
            if (!f || typeof f !== 'object') continue;
            const fo = f as Record<string, unknown>;
            if (typeof fo.id !== 'string') continue;
            if (typeof fo.type !== 'string' || !(fo.type in OKR_RECORD_FIELD_META)) continue;
            fields.push({
                id: fo.id,
                type: fo.type as OkrRecordFieldType,
                name: typeof fo.name === 'string' ? fo.name : '',
            });
        }
        if (fields.length === 0) continue;

        result.push({
            id: c.id,
            title: typeof c.title === 'string' ? c.title : undefined,
            fields,
        });
    }
    return result;
}

/** 板块类型：清单 / 步骤 / 打卡 / 文件 */
export type SectionType = 'checklist' | 'steps' | 'habit' | 'file';

/**
 * 板块类型原型数据：统一维护各类型的 Obsidian 图标名与名称 i18n key。
 * 各视图（任务面板、任务计划视图等）统一从此处读取，避免各处重复判断。
 */
export const SECTION_TYPE_META: Record<SectionType, { icon: string; labelKey: string }> = {
    checklist: { icon: 'check-square', labelKey: 'section.typeChecklist' },
    steps: { icon: 'list-ordered', labelKey: 'section.typeSteps' },
    habit: { icon: 'repeat', labelKey: 'section.typeHabit' },
    file: { icon: 'file-text', labelKey: 'section.typeFile' },
};

/** 清单项（可勾选） */
export interface ChecklistItem {
    id: string;
    text: string;
    done: boolean;
}

/** 步骤项（有序、有状态） */
export interface StepItem {
    id: string;
    text: string;
    /** 步骤状态：待办 / 进行中 / 已完成 */
    status: 'todo' | 'doing' | 'done';
}

/** 打卡项（周期性，按日期记录） */
export interface HabitItem {
    id: string;
    text: string;
    /** 已打卡的日期列表（如 ['2026-10-07']） */
    checkedDays?: string[];
}

/** 文件项（关联一个 vault 文件） */
export interface FileItem {
    id: string;
    /** 显示名（缺省用文件路径） */
    text: string;
    /** vault 内文件路径（如 'notes/foo.md'） */
    path: string;
}

/** 清单板块数据 */
export interface ChecklistData {
    items: ChecklistItem[];
}

/** 步骤板块数据 */
export interface StepsData {
    items: StepItem[];
}

/** 打卡板块数据 */
export interface HabitData {
    items: HabitItem[];
}

/** 文件板块数据 */
export interface FileData {
    items: FileItem[];
    /** 自动生成文件的目录（vault 内相对路径，留空表示未配置） */
    folder?: string;
    /** 自动生成文件的命名规则，支持 {{date}} / {{time}} / {{datetime}} 占位符 */
    namePattern?: string;
}

/** 板块：任务内部的结构化内容 */
export interface Section {
    id: string;
    type: SectionType;
    title?: string;
    data: ChecklistData | StepsData | HabitData | FileData;
}

/** 收集盒数据容器 */
export interface InboxData {
    items: InboxItem[];
    selectedId?: string;
    /** 已折叠的任务 id（其子任务不显示） */
    collapsedIds?: string[];
    /** 是否只看本周目标（持久化） */
    weekGoalOnly?: boolean;
    /** 项目聚焦：仅显示该任务及其所有子任务（持久化，用于「按项目排布」） */
    projectFocusId?: string;
    /** 关注任务 id 列表（持久化，用于「任务关注」选项卡的关注方框） */
    focusTaskIds?: string[];
    /** 选中的板块 id（选中板块时，selectedId 同时指向所属项目） */
    selectedSectionId?: string;
    /** 选中的板块条目 id（选中条目时，同时选中其所属板块与项目） */
    selectedSectionItemId?: string;
}

/** 默认空收集盒数据 */
export const DEFAULT_INBOX_DATA: InboxData = {
    items: [],
};

/** 单条改进项（改进视图右侧可填写列表） */
export interface ImprovementItem {
    id: string;
    /** 改进内容文本 */
    text: string;
    createdAt: number;
}

/** 改进数据：按周键存储改进项列表 */
export interface ImprovementData {
    /** 周键 → 该周的改进项列表 */
    byWeek: Record<string, ImprovementItem[]>;
}

/** 默认空改进数据 */
export const DEFAULT_IMPROVEMENT_DATA: ImprovementData = {
    byWeek: {},
};

/**
 * 事件执行状态：日执行时间轴与周计划视图共用。
 * - planned：计划（尚未执行）
 * - executed：已执行（存在匹配的执行记录）
 * - changed：替换（被「替换计划」修改过）
 * - added：新增（非计划执行记录）
 */
export type EventStatus = 'planned' | 'executed' | 'changed' | 'added';

/** 各状态对应的 emoji 图标 */
export const EVENT_STATUS_EMOJI: Record<EventStatus, string> = {
    planned: '🎯',
    executed: '✅',
    changed: '🔀',
    added: '➕',
};

/** 各状态对应的 i18n 文案 key */
export const EVENT_STATUS_LABEL_KEY = {
    planned: 'today.statusPlanned',
    executed: 'today.statusExecuted',
    changed: 'today.statusChanged',
    added: 'today.statusAdded',
} as const satisfies Record<EventStatus, string>;

/**
 * 计算计划事件的执行状态：已执行 > 计划。
 * 注意：仅适用于计划事件（EventBlock），「新增」状态由非计划执行记录单独判定。
 * 替换执行记录（replaced=true）不计入，故被替换的原计划状态仍为「计划」。
 */
export function getEventStatus(ev: EventBlock, executions: ExecutionRecord[]): EventStatus {
    const executed = executions.some(ex => ex.eventId === ev.id && !ex.replaced);
    return executed ? 'executed' : 'planned';
}
