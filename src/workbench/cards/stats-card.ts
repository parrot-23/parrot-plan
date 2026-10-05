// stats 模式渲染器：定义数据来源，展示统计信息。
import type { CardRenderer, CardRenderContext } from './card-types';
import type { CardTemplate } from '../form-engine/types';
import type { CardInstance } from '../data/card-data';

export const statsCardRenderer: CardRenderer = {
    render(container, instance, template, ctx) {
        container.createDiv({ cls: 'wb-card-title', text: instance.title ?? template.name });

        const body = container.createDiv({ cls: 'wb-card-body' });
        const sourceType = template.source?.type ?? instance.source?.type ?? '';

        const stats = computeStats(sourceType, ctx);

        // 渲染统计项
        for (const item of stats) {
            const row = body.createDiv({ cls: 'wb-stat-row' });
            row.createDiv({ cls: 'wb-stat-label', text: item.label });
            row.createDiv({ cls: 'wb-stat-value', text: String(item.value) });
        }
    },
};

interface StatItem {
    label: string;
    value: number | string;
}

/** 内置数据源统计 */
function computeStats(sourceType: string, ctx: CardRenderContext): StatItem[] {
    switch (sourceType) {
        case 'task-count': {
            const total = ctx.getInboxItems().filter((i) => !i.removed).length;
            return [{ label: '任务总数', value: total }];
        }
        case 'event-completion': {
            const events = ctx.getEvents();
            const total = events.length;
            const done = events.filter((e) => e.completed).length;
            return [
                { label: '计划事件', value: total },
                { label: '已完成', value: done },
                { label: '完成率', value: total > 0 ? `${Math.round((done / total) * 100)}%` : '—' },
            ];
        }
        case 'execution-count': {
            const count = ctx.getExecutions().length;
            return [{ label: '执行记录', value: count }];
        }
        default:
            return [{ label: '统计', value: '—' }];
    }
}
