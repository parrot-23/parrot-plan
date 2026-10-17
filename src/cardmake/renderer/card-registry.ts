// 卡片注册表：renderer → 渲染器 的映射。
// 新增卡片类型只需在此注册，无需改动引擎。
import type { CardRendererType } from '../../datatypes/form';
import type { CardRenderer } from '../../datatypes/renderer';
import { statsCardRenderer } from './stats-card';
import { formCardRenderer } from './form-card';
import { collectCardRenderer } from './collect-card';
import { calendarCardRenderer } from './calendar-card';
import { clockCardRenderer } from './clock-card';
import { listCardRenderer } from './list-card';

const registry: Record<CardRendererType, CardRenderer> = {
    stats: statsCardRenderer,
    form: formCardRenderer,
    collect: collectCardRenderer,
    calendar: calendarCardRenderer,
    clock: clockCardRenderer,
    list: listCardRenderer,
};

/** 按渲染器类型获取渲染器 */
export function getCardRenderer(renderer: CardRendererType): CardRenderer {
    return registry[renderer];
}
