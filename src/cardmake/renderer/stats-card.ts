// stats 模式渲染器：定义数据来源，展示统计信息（数字卡 + 可选图表）。
import type { CardRenderer } from '../../datatypes/renderer';
import { aggregate } from '../engine/aggregators';
import { renderChart, renderHeatmap, renderRadar, renderScatter, renderFunnel, renderWordCloud } from '../drawer/chart-render-draw';

export const statsCardRenderer: CardRenderer = {
    render(container, instance, template, ctx) {
        const body = container.createDiv({ cls: 'wb-card-body' });
        const source = instance.source ?? template.source;
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

        // 热力图（模板声明了 heatmap 类型且有数据时绘制）
        if (source.chart === 'heatmap' && result.heatmap) {
            const chartWrap = body.createDiv({ cls: 'wb-chart-wrap' });
            renderHeatmap(chartWrap, result.heatmap);
            return;
        }

        // 雷达图
        if (source.chart === 'radar' && result.radar) {
            const chartWrap = body.createDiv({ cls: 'wb-chart-wrap' });
            renderRadar(chartWrap, result.radar);
            return;
        }

        // 散点图
        if (source.chart === 'scatter' && result.scatter) {
            const chartWrap = body.createDiv({ cls: 'wb-chart-wrap' });
            renderScatter(chartWrap, result.scatter);
            return;
        }

        // 漏斗图
        if (source.chart === 'funnel' && result.funnel) {
            const chartWrap = body.createDiv({ cls: 'wb-chart-wrap' });
            renderFunnel(chartWrap, result.funnel);
            return;
        }

        // 词云
        if (source.chart === 'wordcloud' && result.wordcloud) {
            const chartWrap = body.createDiv({ cls: 'wb-chart-wrap' });
            renderWordCloud(chartWrap, result.wordcloud);
            return;
        }

        // 图表（模板声明了 chart 类型且有序列数据时绘制）
        if (source.chart && result.series) {
            const chartWrap = body.createDiv({ cls: 'wb-chart-wrap' });
            renderChart(chartWrap, source.chart, result.series, {
                width: typeof source.params?.width === 'number' ? source.params.width : undefined,
                showAxes: result.series.axes?.show,
                yAxisUnit: result.series.axes?.yUnit,
            });
        }
    },
};
