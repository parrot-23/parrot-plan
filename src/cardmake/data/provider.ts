// DataProvider 工厂：从插件持有的数据构建统一数据提供者。
// 统计图卡片通过 provider 读取完整类型的领域数据，避免弱类型回调丢失字段。

import type { EventBlock, ExecutionRecord } from '../../views/week-view/week-schedule-view';
import type { InboxItem } from '../../shared/task-panel';
import type { DataProvider } from '../../datatypes/chart';

/**
 * 构建数据提供者。
 * 传入的 getter 返回插件当前持有的数据引用（视图重建时仍指向最新数据）。
 */
export function createDataProvider(
    getEvents: () => EventBlock[],
    getExecutions: () => ExecutionRecord[],
    getTasks: () => InboxItem[],
): DataProvider {
    return {
        getEvents,
        getExecutions,
        getTasks,
    };
}
