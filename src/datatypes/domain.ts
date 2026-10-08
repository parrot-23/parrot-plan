// 核心领域数据契约：计划事件、执行记录、收集盒任务。
// 这些是插件最核心的数据标准，被周计划、日执行、年计划、泳道图、工作台等多个视图共用，
// 统一在此定义，保证各视图读取的数据口径一致。

import type { WeekKey } from '../views/week-view/timeblock-data';

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
    /** 被「替换计划」修改前的原任务 id（用于标记「变更计划」状态） */
    replacedFromInboxId?: string;
    /** 全天事件（start=0, end=1440） */
    allDay?: boolean;
    completed?: boolean;
    notePath?: string;
    /** 额外备注（纯文本，名称来源于任务不可改，仅可补充备注） */
    note?: string;
    /** 所属周键（如 2026-W40） */
    weekKey?: WeekKey;
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
    note?: string;
    /** 所属周键（如 2026-W40） */
    weekKey?: WeekKey;
}

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
    /** 已从收集盒移除（不再显示，但数据保留，可查历史） */
    removed?: boolean;
    /** 板块：任务内部的结构化内容（可选，旧任务无此字段） */
    sections?: Section[];
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
    /** 选中的板块 id（选中板块时，selectedId 同时指向所属项目） */
    selectedSectionId?: string;
    /** 选中的板块条目 id（选中条目时，同时选中其所属板块与项目） */
    selectedSectionItemId?: string;
}

/** 默认空收集盒数据 */
export const DEFAULT_INBOX_DATA: InboxData = {
    items: [],
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
 * 计算计划事件的执行状态：替换 > 已执行 > 计划。
 * 注意：仅适用于计划事件（EventBlock），「新增」状态由非计划执行记录单独判定。
 */
export function getEventStatus(ev: EventBlock, executions: ExecutionRecord[]): EventStatus {
    if (ev.replacedFromInboxId) return 'changed';
    const executed = executions.some(ex => ex.eventId === ev.id);
    return executed ? 'executed' : 'planned';
}
