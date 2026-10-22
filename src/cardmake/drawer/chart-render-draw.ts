// 图表渲染器：纯 SVG 自绘柱状图 / 折线图 / 饼图 / 环形图 / 面积图 / 条形图 / 雷达图 / 散点图 / 漏斗图 / 词云。
// 不引入第三方图表库，体积小、可控、无兼容风险。
import type { ChartType } from '../../datatypes/form';
import type {
    ChartSeries,
    HeatmapSeries,
    RadarSeries,
    ScatterSeries,
    FunnelSeries,
    WordCloudSeries,
} from '../../datatypes/chart';
import { makeDayKeyFromWeek } from '../../shared/plan-data';

/** 图表渲染配置 */
export interface ChartRenderOptions {
    width?: number;
    height?: number;
    /** 是否绘制坐标轴（X 底部轴线 + Y 轴刻度线） */
    showAxes?: boolean;
    /** Y 轴刻度单位：minutes（分钟）/ hours（小时换算） */
    yAxisUnit?: 'minutes' | 'hours';
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
        case 'area':
            renderAreaChart(container, data, options);
            break;
        case 'hbar':
            renderHBarChart(container, data, options);
            break;
        default:
            renderBarChart(container, data, options);
    }
}

/** 渲染雷达图 */
export function renderRadar(container: HTMLElement, series: RadarSeries, options: ChartRenderOptions = {}): void {
    const data = series.data;
    if (data.length === 0) {
        container.createDiv({ cls: 'wb-chart-empty', text: '暂无数据' });
        return;
    }
    renderRadarChart(container, data, options);
}

/** 渲染散点图 */
export function renderScatter(container: HTMLElement, series: ScatterSeries, options: ChartRenderOptions = {}): void {
    const data = series.data;
    if (data.length === 0) {
        container.createDiv({ cls: 'wb-chart-empty', text: '暂无数据' });
        return;
    }
    renderScatterChart(container, data, series.xLabel, series.yLabel, options);
}

/** 渲染漏斗图 */
export function renderFunnel(container: HTMLElement, series: FunnelSeries, options: ChartRenderOptions = {}): void {
    const data = series.data;
    if (data.length === 0) {
        container.createDiv({ cls: 'wb-chart-empty', text: '暂无数据' });
        return;
    }
    renderFunnelChart(container, data, options);
}

/** 渲染词云 */
export function renderWordCloud(container: HTMLElement, series: WordCloudSeries): void {
    const data = series.data;
    if (data.length === 0) {
        container.createDiv({ cls: 'wb-chart-empty', text: '暂无数据' });
        return;
    }
    renderWordCloudView(container, data);
}

/** 柱状图 */
function renderBarChart(container: HTMLElement, data: ChartSeries['data'], options: ChartRenderOptions) {
    const width = options.width ?? 260;
    const height = options.height ?? 140;
    const showAxes = !!options.showAxes;
    // 绘制坐标轴时左侧预留刻度与数值区域，否则沿用紧凑布局
    const padLeft = showAxes ? 34 : 8;
    const padRight = 8;
    // 堆叠柱：柱顶需额外预留显示总时长的空间
    const stacked = data.some((d) => !!d.segments && d.segments.length > 0);
    const padTop = stacked ? 22 : 8;
    // 含周键时底部预留月份行
    const hasWeekKeys = data.some((d) => !!d.weekKey);
    const padBottom = hasWeekKeys ? 44 : 20;
    const chartH = height - padTop - padBottom;
    let max = Math.max(...data.map((d) => d.value), 1);
    // hours 单位：纵轴按 10h 一个刻度，将最大值向上取整到 10h 的整数倍，保证柱体与刻度对齐
    if (options.yAxisUnit === 'hours') {
        max = Math.ceil(max / 600) * 600 || 600;
    }
    // 柱宽与间隔相等：plotWidth = n*barW + (n-1)*barW = (2n-1)*barW
    const plotWidth = width - padLeft - padRight;
    const barW = Math.max(2, plotWidth / (data.length * 2 - 1));
    const step = barW;

    const svg = createChartSvg(container, width, height);

    if (showAxes) {
        drawBarAxes(svg, width, padLeft, padTop, chartH, max, options.yAxisUnit);
    }

    // 悬浮面板：鼠标移到柱子上时显示各任务时长
    container.style.setProperty('position', 'relative');
    const tooltip = container.createDiv({ cls: 'wb-chart-tooltip' });

    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        const x = padLeft + i * (barW + step);

        if (stacked && d.segments && d.segments.length > 0) {
            const group = drawStackedBar(svg, d, x, barW, padTop, chartH, max, options.yAxisUnit);
            // 整根柱子（含分段）绑定悬浮：面板锚定在柱子左侧或右侧
            const barCenterY = padTop + chartH / 2;
            group.addEventListener('mouseenter', () => {
                showTooltip(tooltip, d, options.yAxisUnit);
                positionTooltip(tooltip, container, x, barW, barCenterY);
            });
            group.addEventListener('mouseleave', () => {
                tooltip.style.display = 'none';
            });
        } else {
            const h = (d.value / max) * chartH;
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

            // 时长为 0 的柱：柱顶显示 0
            if (stacked) {
                const total = svgEl('text', {
                    x: String(x + barW / 2),
                    y: String(y - 4),
                    'text-anchor': 'middle',
                });
                total.setAttribute('class', 'wb-chart-seg-total');
                total.textContent = '0';
                svg.appendChild(total);
            }
        }

        // 底部标签（周号，截断过长文本）
        const label = svgEl('text', {
            x: String(x + barW / 2),
            y: String(height - (hasWeekKeys ? 26 : 6)),
            'text-anchor': 'middle',
        });
        label.setAttribute('class', 'wb-chart-label');
        label.textContent = truncate(d.label, 6);
        svg.appendChild(label);
    }

    // 底部月份行：从左到右，进入新月份的位置显示月份名称
    if (hasWeekKeys) {
        let prevMonth = -1;
        for (let i = 0; i < data.length; i++) {
            const wk = data[i].weekKey;
            if (!wk) continue;
            const dayKey = makeDayKeyFromWeek(wk, 1);
            const month = Number(dayKey.slice(5, 7));
            if (month !== prevMonth) {
                const x = padLeft + i * (barW + step) + barW / 2;
                const monthLabel = svgEl('text', {
                    x: String(x),
                    y: String(height - 4),
                    'text-anchor': 'middle',
                });
                monthLabel.setAttribute('class', 'wb-chart-month-label');
                monthLabel.textContent = `${month}月`;
                svg.appendChild(monthLabel);
                prevMonth = month;
            }
        }
    }
}

/** 绘制单根堆叠柱：按分段从底部向上堆叠（白线分隔），柱顶显示总时长；返回包含全部段的分组元素 */
function drawStackedBar(
    svg: SVGSVGElement,
    d: { segments?: { label: string; value: number; color?: string }[]; value: number },
    x: number,
    barW: number,
    padTop: number,
    chartH: number,
    max: number,
    unit: 'minutes' | 'hours' | undefined,
): SVGGElement {
    const baseY = padTop + chartH;
    let cursorY = baseY;

    const group = svgEl('g', {});
    group.setAttribute('class', 'wb-chart-bar-group');

    for (const seg of d.segments ?? []) {
        const h = (seg.value / max) * chartH;
        const segTop = cursorY - h;
        const y = Math.max(padTop, segTop);

        const rect = svgEl('rect', {
            x: String(x),
            y: String(y),
            width: String(barW),
            height: String(Math.max(1, h)),
        });
        rect.setAttribute('class', 'wb-chart-bar wb-chart-seg');
        if (seg.color) rect.style.setProperty('fill', seg.color);
        rect.setAttribute('data-value', String(seg.value));
        rect.setAttribute('data-label', seg.label);
        group.appendChild(rect);

        // 白线分隔（段与段之间，最底部不画）
        if (cursorY < baseY) {
            const divider = svgEl('line', {
                x1: String(x),
                y1: String(y),
                x2: String(x + barW),
                y2: String(y),
            });
            divider.setAttribute('class', 'wb-chart-seg-divider');
            group.appendChild(divider);
        }

        cursorY = segTop;
    }

    // 柱顶总时长：紧贴该柱的实际顶边（cursorY 为堆叠后的柱顶）
    const barTop = Math.max(padTop, cursorY);
    const total = svgEl('text', {
        x: String(x + barW / 2),
        y: String(barTop - 4),
        'text-anchor': 'middle',
    });
    total.setAttribute('class', 'wb-chart-seg-total');
    total.textContent = formatAxisValue(d.value, unit);
    svg.appendChild(total);

    svg.appendChild(group);
    return group;
}

/** 填充并显示悬浮面板：列出该柱每个任务的时长 */
function showTooltip(
    tooltip: HTMLElement,
    d: { segments?: { label: string; value: number; color?: string }[] },
    unit: 'minutes' | 'hours' | undefined,
) {
    tooltip.empty();
    const segs = d.segments ?? [];
    // 逆序遍历：柱体从上到下（drawStackedBar 中数组首元素在底部、末元素在顶部）
    for (let i = segs.length - 1; i >= 0; i--) {
        const seg = segs[i];
        const row = tooltip.createDiv({ cls: 'wb-chart-tooltip-row' });
        const dot = row.createSpan({ cls: 'wb-chart-tooltip-dot' });
        if (seg.color) dot.style.background = seg.color;
        row.createSpan({ cls: 'wb-chart-tooltip-name', text: seg.label });
        row.createSpan({ cls: 'wb-chart-tooltip-val', text: formatAxisValue(seg.value, unit) });
    }
    tooltip.style.display = 'block';
}

/** 定位悬浮面板：优先在柱子右侧显示，右侧空间不足则放左侧；宽度保证单行文字完整显示 */
function positionTooltip(
    tooltip: HTMLElement,
    container: HTMLElement,
    x: number,
    barW: number,
    barCenterY: number,
) {
    // 先显示以测量面板尺寸
    tooltip.style.visibility = 'hidden';
    tooltip.style.display = 'block';
    const panelW = tooltip.offsetWidth;
    const panelH = tooltip.offsetHeight;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;
    const margin = 8;

    // 根据柱子左右两侧可用空间决定面板放置侧
    const spaceRight = containerW - (x + barW) - margin;
    const spaceLeft = x - margin;
    let left: number;
    if (spaceRight >= panelW || spaceRight >= spaceLeft) {
        left = x + barW + margin; // 右侧
    } else {
        left = x - panelW - margin; // 左侧
    }
    // 兜底收束到容器内（极长单行可能略溢出）
    if (left + panelW > containerW) left = containerW - panelW;
    if (left < 0) left = 0;

    let top = barCenterY - panelH / 2;
    top = Math.max(0, Math.min(top, containerH - panelH));

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.style.visibility = 'visible';
}

/** 绘制柱状图坐标轴：X 底部轴线 + Y 轴左侧轴线 + 均分刻度线与数值标签 */
function drawBarAxes(
    svg: SVGSVGElement,
    width: number,
    padLeft: number,
    padTop: number,
    chartH: number,
    max: number,
    unit: 'minutes' | 'hours' | undefined,
): void {
    const baseY = padTop + chartH;

    // X 轴底部轴线
    const xAxis = svgEl('line', {
        x1: String(padLeft),
        y1: String(baseY),
        x2: String(width - 8),
        y2: String(baseY),
    });
    xAxis.setAttribute('class', 'wb-chart-axis');
    svg.appendChild(xAxis);

    // Y 轴左侧轴线
    const yAxis = svgEl('line', {
        x1: String(padLeft),
        y1: String(padTop),
        x2: String(padLeft),
        y2: String(baseY),
    });
    yAxis.setAttribute('class', 'wb-chart-axis');
    svg.appendChild(yAxis);

    // Y 轴刻度：hours 单位按 10h 一个刻度，否则均分 4 段（0 / 1/3 / 2/3 / max）
    const tickValues: number[] = [];
    if (unit === 'hours') {
        const stepMinutes = 600; // 10 小时
        const count = Math.max(1, Math.ceil(max / stepMinutes));
        for (let i = 0; i <= count; i++) {
            tickValues.push(stepMinutes * i);
        }
    } else {
        const ticks = 4;
        for (let i = 0; i < ticks; i++) {
            tickValues.push((max / (ticks - 1)) * i);
        }
    }

    for (const value of tickValues) {
        const y = baseY - (value / max) * chartH;

        const tick = svgEl('line', {
            x1: String(padLeft),
            y1: String(y),
            x2: String(padLeft - 3),
            y2: String(y),
        });
        tick.setAttribute('class', 'wb-chart-tick');
        svg.appendChild(tick);

        const label = svgEl('text', {
            x: String(padLeft - 5),
            y: String(y + 3),
            'text-anchor': 'end',
        });
        label.setAttribute('class', 'wb-chart-axis-label');
        label.textContent = formatAxisValue(value, unit);
        svg.appendChild(label);
    }
}

/** 坐标轴数值格式化：hours 时换算为小时（保留 1 位小数） */
function formatAxisValue(value: number, unit?: 'minutes' | 'hours'): string {
    if (unit === 'hours') {
        const hours = Math.round(value / 6) / 10;
        return `${Number(hours.toFixed(1))}h`;
    }
    return String(Math.round(value));
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

    const svg = createChartSvg(container, width, height);
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

/** 面积图：折线下方填充渐变区域 */
function renderAreaChart(container: HTMLElement, data: ChartSeries['data'], options: ChartRenderOptions) {
    const width = options.width ?? 260;
    const height = options.height ?? 140;
    const padLeft = 8;
    const padBottom = 20;
    const padTop = 8;
    const chartH = height - padTop - padBottom;
    const max = Math.max(...data.map((d) => d.value), 1);
    const n = data.length;
    const stepX = n > 1 ? (width - padLeft * 2) / (n - 1) : 0;

    const svg = createChartSvg(container, width, height);
    const points: string[] = [];
    for (let i = 0; i < n; i++) {
        const x = padLeft + i * stepX;
        const y = padTop + chartH - (data[i].value / max) * chartH;
        points.push(`${x},${y}`);
    }

    // 面积填充路径（折线 + 底部闭合）
    const baseline = padTop + chartH;
    const areaPath = `M ${padLeft} ${baseline} L ${points.join(' L ')} L ${padLeft + (n - 1) * stepX} ${baseline} Z`;
    const area = svgEl('path', { d: areaPath });
    area.setAttribute('class', 'wb-chart-area');
    svg.appendChild(area);

    // 折线
    const polyline = svgEl('polyline', { points: points.join(' ') });
    polyline.setAttribute('class', 'wb-chart-line');
    svg.appendChild(polyline);

    // 数据点与标签
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

/** 条形图（横向柱状图） */
function renderHBarChart(container: HTMLElement, data: ChartSeries['data'], options: ChartRenderOptions) {
    const width = options.width ?? 260;
    const rowH = 22;
    const padLeft = 60;
    const padRight = 8;
    const height = data.length * rowH + 8;
    const max = Math.max(...data.map((d) => d.value), 1);
    const barMaxW = width - padLeft - padRight;

    const svg = createChartSvg(container, width, height);
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        const y = i * rowH + 4;
        const barW = Math.max(2, (d.value / max) * barMaxW);

        // 标签（左侧）
        const label = svgEl('text', {
            x: String(padLeft - 6),
            y: String(y + rowH / 2 + 3),
            'text-anchor': 'end',
        });
        label.setAttribute('class', 'wb-chart-label');
        label.textContent = truncate(d.label, 6);
        svg.appendChild(label);

        // 条形
        const rect = svgEl('rect', {
            x: String(padLeft),
            y: String(y),
            width: String(barW),
            height: String(rowH - 6),
            rx: '2',
        });
        rect.setAttribute('class', 'wb-chart-bar');
        rect.setAttribute('data-value', String(d.value));
        svg.appendChild(rect);
    }
}

/** 雷达图：多维度指标的多边形 */
function renderRadarChart(
    container: HTMLElement,
    data: RadarSeries['data'],
    options: ChartRenderOptions,
) {
    const size = options.width ?? 200;
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 24;
    const n = data.length;
    const max = Math.max(...data.map((d) => d.value), 1);

    const svg = createChartSvg(container, size, size);

    // 网格（同心多边形）
    for (let level = 1; level <= 4; level++) {
        const r = (radius * level) / 4;
        const pts: string[] = [];
        for (let i = 0; i < n; i++) {
            const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
            pts.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
        }
        const poly = svgEl('polygon', { points: pts.join(' ') });
        poly.setAttribute('class', 'wb-chart-radar-grid');
        svg.appendChild(poly);
    }

    // 轴线
    for (let i = 0; i < n; i++) {
        const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
        const x = cx + radius * Math.cos(angle);
        const y = cy + radius * Math.sin(angle);
        const line = svgEl('line', {
            x1: String(cx),
            y1: String(cy),
            x2: String(x),
            y2: String(y),
        });
        line.setAttribute('class', 'wb-chart-radar-axis');
        svg.appendChild(line);

        // 维度标签
        const lx = cx + (radius + 14) * Math.cos(angle);
        const ly = cy + (radius + 14) * Math.sin(angle);
        const label = svgEl('text', {
            x: String(lx),
            y: String(ly),
            'text-anchor': 'middle',
        });
        label.setAttribute('class', 'wb-chart-label');
        label.textContent = truncate(data[i].label, 4);
        svg.appendChild(label);
    }

    // 数据多边形
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
        const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
        const r = (data[i].value / max) * radius;
        pts.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
    }
    const poly = svgEl('polygon', { points: pts.join(' ') });
    poly.setAttribute('class', 'wb-chart-radar-data');
    svg.appendChild(poly);
}

/** 散点图：x-y 数据点 */
function renderScatterChart(
    container: HTMLElement,
    data: ScatterSeries['data'],
    xLabel: string,
    yLabel: string,
    options: ChartRenderOptions,
) {
    const width = options.width ?? 260;
    const height = options.height ?? 160;
    const padLeft = 28;
    const padRight = 8;
    const padTop = 8;
    const padBottom = 24;
    const chartW = width - padLeft - padRight;
    const chartH = height - padTop - padBottom;

    const maxX = Math.max(...data.map((d) => d.x), 1);
    const maxY = Math.max(...data.map((d) => d.y), 1);

    const svg = createChartSvg(container, width, height);

    // 数据点
    for (const d of data) {
        const x = padLeft + (d.x / maxX) * chartW;
        const y = padTop + chartH - (d.y / maxY) * chartH;
        const circle = svgEl('circle', { cx: String(x), cy: String(y), r: '3' });
        circle.setAttribute('class', 'wb-chart-dot');
        circle.setAttribute('data-value', `${d.x},${d.y}`);
        if (d.label) circle.setAttribute('title', d.label);
        svg.appendChild(circle);
    }

    // 轴标签
    const xl = svgEl('text', {
        x: String(padLeft + chartW / 2),
        y: String(height - 4),
        'text-anchor': 'middle',
    });
    xl.setAttribute('class', 'wb-chart-label');
    xl.textContent = xLabel;
    svg.appendChild(xl);

    const yl = svgEl('text', {
        x: String(10),
        y: String(padTop + chartH / 2),
        'text-anchor': 'middle',
        transform: `rotate(-90 10 ${padTop + chartH / 2})`,
    });
    yl.setAttribute('class', 'wb-chart-label');
    yl.textContent = yLabel;
    svg.appendChild(yl);
}

/** 漏斗图：按阶段递减的梯形 */
function renderFunnelChart(
    container: HTMLElement,
    data: FunnelSeries['data'],
    options: ChartRenderOptions,
) {
    const width = options.width ?? 220;
    const rowH = 34;
    const height = data.length * rowH + 8;
    const max = Math.max(...data.map((d) => d.value), 1);
    const maxW = width - 40;

    const svg = createChartSvg(container, width, height);
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        const frac = d.value / max;
        const w = Math.max(8, frac * maxW);
        const x = (width - w) / 2;
        const y = i * rowH + 4;

        const rect = svgEl('rect', {
            x: String(x),
            y: String(y),
            width: String(w),
            height: String(rowH - 6),
            rx: '2',
        });
        rect.setAttribute('class', 'wb-chart-bar');
        rect.setAttribute('data-value', String(d.value));
        svg.appendChild(rect);

        // 阶段标签 + 数值
        const label = svgEl('text', {
            x: String(width / 2),
            y: String(y + rowH / 2 + 3),
            'text-anchor': 'middle',
        });
        label.setAttribute('class', 'wb-chart-funnel-label');
        label.textContent = `${truncate(d.label, 6)} ${d.value}`;
        svg.appendChild(label);
    }
}

/** 词云：按词频渲染不同字号的词 */
function renderWordCloudView(container: HTMLElement, data: WordCloudSeries['data']) {
    const max = Math.max(...data.map((d) => d.value), 1);
    const wrap = container.createDiv({ cls: 'wb-wordcloud' });
    for (const d of data) {
        const ratio = d.value / max;
        const size = 12 + Math.round(ratio * 20); // 12px ~ 32px
        const span = wrap.createSpan({ cls: 'wb-wordcloud-word', text: d.text });
        span.style.setProperty('font-size', `${size}px`);
        span.setAttribute('data-value', String(d.value));
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

    const svg = createChartSvg(container, size, size);
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
function createChartSvg(container: HTMLElement, width: number, height: number): SVGSVGElement {
    return container.createSvg('svg', {
        cls: 'wb-chart-svg',
        attr: {
            width: String(width),
            height: String(height),
            viewBox: `0 0 ${width} ${height}`,
        },
    });
}

/** 创建 SVG 元素 */
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
    return createSvg(tag, { attr: attrs });
}

/** 截断过长文本 */
function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 热力活跃图（GitHub 贡献图风格）：按周排列的日历格子，颜色深浅表示活跃度。
 * 使用 HTML 网格而非 SVG，便于响应式布局与 tooltip。
 */
export function renderHeatmap(container: HTMLElement, series: HeatmapSeries): void {
    const data = series.data;
    if (data.length === 0) {
        container.createDiv({ cls: 'wb-chart-empty', text: '暂无数据' });
        return;
    }

    // 建立日期键 → 活跃度 的映射
    const valueMap = new Map<string, number>();
    for (const d of data) valueMap.set(d.date, d.value);

    // 计算最近一年（365 天）的日期范围，对齐到周一作为起始
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 364);
    // 对齐到周一（getDay: 0=周日 ... 6=周六）
    const startDow = (start.getDay() + 6) % 7; // 0=周一 ... 6=周日
    start.setDate(start.getDate() - startDow);

    // 计算最大活跃度（用于分档着色）
    const maxValue = Math.max(...data.map((d) => d.value), 1);

    const grid = container.createDiv({ cls: 'wb-heatmap' });

    // 列头：月份标签
    const monthRow = grid.createDiv({ cls: 'wb-heatmap-months' });
    // 左侧留白（星期标签列）
    monthRow.createDiv({ cls: 'wb-heatmap-month-spacer' });
    {
        let cursor = new Date(start);
        let lastMonth = -1;
        while (cursor <= today) {
            const m = cursor.getMonth();
            if (m !== lastMonth) {
                const label = monthRow.createDiv({ cls: 'wb-heatmap-month' });
                label.textContent = `${cursor.getMonth() + 1}月`;
                lastMonth = m;
            } else {
                monthRow.createDiv({ cls: 'wb-heatmap-month wb-heatmap-month-empty' });
            }
            cursor.setDate(cursor.getDate() + 7);
        }
    }

    // 主体：星期行 × 周列
    const body = grid.createDiv({ cls: 'wb-heatmap-body' });

    // 星期标签列
    const dayLabels = body.createDiv({ cls: 'wb-heatmap-days' });
    const dayNames = ['', '一', '', '三', '', '五', ''];
    for (const name of dayNames) {
        dayLabels.createDiv({ cls: 'wb-heatmap-day', text: name });
    }

    // 周列
    const weeks = body.createDiv({ cls: 'wb-heatmap-weeks' });
    const cursor = new Date(start);
    while (cursor <= today) {
        const weekCol = weeks.createDiv({ cls: 'wb-heatmap-week' });
        for (let dow = 0; dow < 7; dow++) {
            const cellDate = new Date(cursor);
            cellDate.setDate(cursor.getDate() + dow);
            const key = makeDayKeyLocal(cellDate);
            const value = valueMap.get(key) ?? 0;

            const cell = weekCol.createDiv({ cls: 'wb-heatmap-cell' });
            if (cellDate > today) {
                cell.addClass('is-future');
            } else if (value > 0) {
                const level = heatLevel(value, maxValue);
                cell.addClass(`is-level-${level}`);
                cell.setAttribute('data-value', String(value));
                cell.setAttribute('data-date', key);
                cell.setAttribute('title', `${key}: ${value} 分钟`);
            }
        }
        cursor.setDate(cursor.getDate() + 7);
    }

    // 图例
    const legend = grid.createDiv({ cls: 'wb-heatmap-legend' });
    legend.createSpan({ cls: 'wb-heatmap-legend-label', text: '少' });
    for (let i = 1; i <= 4; i++) {
        legend.createSpan({ cls: `wb-heatmap-cell is-level-${i}` });
    }
    legend.createSpan({ cls: 'wb-heatmap-legend-label', text: '多' });
}

/** 根据活跃度值分档（1-4 档） */
function heatLevel(value: number, maxValue: number): number {
    if (maxValue <= 0) return 1;
    const ratio = value / maxValue;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
}

/** 生成本地日期键（YYYY-MM-DD） */
function makeDayKeyLocal(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
