// 卡片注册表：mode → 渲染器 的映射。
// 新增卡片类型只需在此注册，无需改动引擎。
import type { CardMode } from '../../datatypes/form';
import type { CardRenderer } from '../../datatypes/renderer';
import { periodicCardRenderer } from './periodic-card';
import { statsCardRenderer } from './stats-card';
import { fixedCardRenderer } from './fixed-card';

const registry: Record<CardMode, CardRenderer> = {
    periodic: periodicCardRenderer,
    stats: statsCardRenderer,
    fixed: fixedCardRenderer,
};

/** 按模式获取渲染器 */
export function getCardRenderer(mode: CardMode): CardRenderer {
    return registry[mode];
}
