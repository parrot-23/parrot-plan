// 图表渲染器：纯 SVG 自绘柱状图 / 折线图 / 饼图 / 环形图。
// 不引入第三方图表库，体积小、可控、无兼容风险。
import type { ChartType } from '../form-engine/types';
import type { ChartSeries } from '../data-sources/types';

/** 图表渲染配置 */
export interface ChartRenderOptions {
    width?: number;
    height?: number;
}

/** 把图表序列渲染到容器 */
export function renderChart(
    container: HTMLElement,
    type: ChartType,
    series: ChartSeries,
    options: ChartRenderOptions = {},
): void {
    const data = series.data;
    if (data.length === 0) {
        container.createDiv({ cls: 'wb-chart-empty', text: '暂无数据' });
        return;
    }

    switch (type) {
        case 'bar':
            renderBarChart(container, data, options);
            break;
        case 'line':
            renderLineChart(container, data, options);
            break;
        case 'pie':
            renderPieChart(container, data, false, options);
            break;
        case 'donut':
            renderPieChart(container, data, true, options);
            break;
        default:
            renderBarChart(container, data, options);
    }
}

/** 柱状图 */
function renderBarChart(container: HTMLElement, data: ChartSeries['data'], options: ChartRenderOptions) {
    const width = options.width ?? 260;
    const height = options.height ?? 140;
    const padLeft = 8;
    const padBottom = 20;
    const padTop = 8;
    const chartH = height - padTop - padBottom;
    const max = Math.max(...data.map((d) => d.value), 1);
    const barGap = 4;
    const barW = Math.max(2, (width - padLeft * 2 - barGap * (data.length - 1)) / data.length);

    const svg = createSvg(container, width, height);
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        const h = (d.value / max) * chartH;
        const x = padLeft + i * (barW + barGap);
        const y = padTop + (chartH - h);
        const rect = svgEl('rect', {
            x: String(x),
            y: String(y),
            width: String(barW),
            height: String(Math.max(1, h)),
            rx: '2',
        });
        rect.setAttribute('class', 'wb-chart-bar');
        rect.setAttribute('data-value', String(d.value));
        svg.appendChild(rect);

        // 底部标签（截断过长文本）
        const label = svgEl('text', {
            x: String(x + barW / 2),
            y: String(height - 6),
            'text-anchor': 'middle',
        });
        label.setAttribute('class', 'wb-chart-label');
        label.textContent = truncate(d.label, 6);
        svg.appendChild(label);
    }
}

/** 折线图 */
function renderLineChart(container: HTMLElement, data: ChartSeries['data'], options: ChartRenderOptions) {
    const width = options.width ?? 260;
    const height = options.height ?? 140;
    const padLeft = 8;
    const padBottom = 20;
    const padTop = 8;
    const chartH = height - padTop - padBottom;
    const max = Math.max(...data.map((d) => d.value), 1);
    const n = data.length;
    const stepX = n > 1 ? (width - padLeft * 2) / (n - 1) : 0;

    const svg = createSvg(container, width, height);
    const points: string[] = [];
    for (let i = 0; i < n; i++) {
        const x = padLeft + i * stepX;
        const y = padTop + chartH - (data[i].value / max) * chartH;
        points.push(`${x},${y}`);
    }

    // 折线
    const polyline = svgEl('polyline', { points: points.join(' ') });
    polyline.setAttribute('class', 'wb-chart-line');
    svg.appendChild(polyline);

    // 数据点
    for (let i = 0; i < n; i++) {
        const [x, y] = points[i].split(',').map(Number);
        const circle = svgEl('circle', { cx: String(x), cy: String(y), r: '3' });
        circle.setAttribute('class', 'wb-chart-dot');
        circle.setAttribute('data-value', String(data[i].value));
        svg.appendChild(circle);

        const label = svgEl('text', {
            x: String(x),
            y: String(height - 6),
            'text-anchor': 'middle',
        });
        label.setAttribute('class', 'wb-chart-label');
        label.textContent = truncate(data[i].label, 6);
        svg.appendChild(label);
    }
}

/** 饼图 / 环形图 */
function renderPieChart(
    container: HTMLElement,
    data: ChartSeries['data'],
    donut: boolean,
    options: ChartRenderOptions,
) {
    const size = options.width ?? 160;
    const cx = size / 2;
    const cy = size / 2;
    const outerR = size / 2 - 4;
    const innerR = donut ? outerR * 0.55 : 0;

    const total = data.reduce((s, d) => s + d.value, 0);
    if (total <= 0) {
        container.createDiv({ cls: 'wb-chart-empty', text: '暂无数据' });
        return;
    }

    const svg = createSvg(container, size, size);
    let angle = -Math.PI / 2; // 从顶部开始
    for (let i = 0; i < data.length; i++) {
        const frac = data[i].value / total;
        const endAngle = angle + frac * Math.PI * 2;
        const path = pieSlice(cx, cy, outerR, innerR, angle, endAngle);
        const p = svgEl('path', { d: path });
        p.setAttribute('class', 'wb-chart-slice');
        p.setAttribute('data-index', String(i));
        p.setAttribute('data-value', String(data[i].value));
        svg.appendChild(p);
        angle = endAngle;
    }

    // 图例（放在图表下方）
    const legend = container.createDiv({ cls: 'wb-chart-legend' });
    for (let i = 0; i < data.length; i++) {
        const item = legend.createDiv({ cls: 'wb-chart-legend-item' });
        const dot = item.createSpan({ cls: 'wb-chart-legend-dot' });
        dot.setCssProps({ '--slice-index': String(i) });
        item.createSpan({ cls: 'wb-chart-legend-label', text: truncate(data[i].label, 10) });
        item.createSpan({ cls: 'wb-chart-legend-value', text: String(data[i].value) });
    }
}

/** 生成饼图/环形图扇区路径 */
function pieSlice(cx: number, cy: number, outerR: number, innerR: number, start: number, end: number): string {
    const largeArc = end - start > Math.PI ? 1 : 0;
    const x1 = cx + outerR * Math.cos(start);
    const y1 = cy + outerR * Math.sin(start);
    const x2 = cx + outerR * Math.cos(end);
    const y2 = cy + outerR * Math.sin(end);

    if (innerR <= 0) {
        return `M ${cx} ${cy} L ${x1} ${y1} A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    }
    const x3 = cx + innerR * Math.cos(end);
    const y3 = cy + innerR * Math.sin(end);
    const x4 = cx + innerR * Math.cos(start);
    const y4 = cy + innerR * Math.sin(start);
    return `M ${x1} ${y1} A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2} `
        + `L ${x3} ${y3} A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4} ${y4} Z`;
}

/** 创建 SVG 根节点 */
function createSvg(container: HTMLElement, width: number, height: number): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'wb-chart-svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    container.appendChild(svg);
    return svg;
}

/** 创建 SVG 元素 */
function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
    }
    return el;
}

/** 截断过长文本 */
function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
