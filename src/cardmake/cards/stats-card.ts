// stats 模式渲染器：定义数据来源，展示统计信息（数字卡 + 可选图表）。
import type { CardRenderer, CardRenderContext } from '../../datatypes/renderer';
import { aggregate } from '../data/aggregators';
import { renderChart } from '../engine/chart-renderer';

export const statsCardRenderer: CardRenderer = {
    render(container, instance, template, ctx) {
        container.createDiv({ cls: 'wb-card-title', text: instance.title ?? template.name });

        const body = container.createDiv({ cls: 'wb-card-body' });
        const source = template.source ?? instance.source;
        if (!source) {
            body.createDiv({ cls: 'wb-stat-row' })
                .createDiv({ cls: 'wb-stat-value', text: '—' });
            return;
        }

        const result = aggregate(source, ctx.provider);

        // 数字指标（数字卡 / 进度条）
        for (const item of result.stats) {
            const row = body.createDiv({ cls: 'wb-stat-row' });
            row.createDiv({ cls: 'wb-stat-label', text: item.label });
            row.createDiv({ cls: 'wb-stat-value', text: String(item.value) });
        }

        // 图表（模板声明了 chart 类型且有序列数据时绘制）
        if (source.chart && result.series) {
            const chartWrap = body.createDiv({ cls: 'wb-chart-wrap' });
            renderChart(chartWrap, source.chart, result.series);
        }
    },
};
