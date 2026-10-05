import type { EventBlock, ExecutionRecord } from '../views/week-view/week-schedule-view';

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
export const EVENT_STATUS_LABEL_KEY: Record<EventStatus, string> = {
    planned: 'today.statusPlanned',
    executed: 'today.statusExecuted',
    changed: 'today.statusChanged',
    added: 'today.statusAdded',
};

/**
 * 计算计划事件的执行状态：替换 > 已执行 > 计划。
 * 注意：仅适用于计划事件（EventBlock），「新增」状态由非计划执行记录单独判定。
 */
export function getEventStatus(ev: EventBlock, executions: ExecutionRecord[]): EventStatus {
    if (ev.replacedFromInboxId) return 'changed';
    const executed = executions.some(ex => ex.eventId === ev.id);
    return executed ? 'executed' : 'planned';
}
