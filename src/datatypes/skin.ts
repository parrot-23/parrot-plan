// 卡片皮肤原型数据：定义卡片可自定义的样式选项。
// 皮肤配置写入 CardInstance.skin，渲染时以内联样式应用到卡片元素。

/** 卡片皮肤配置（用户自定义的样式选项） */
export interface CardSkin {
    /** 背景颜色（CSS 颜色值，如 #ffffff / rgba(...)） */
    background?: string;
    /** 阴影强度：none / light / medium / heavy */
    shadow?: 'none' | 'light' | 'medium' | 'heavy';
    /** 边框圆角（像素） */
    radius?: number;
}

/** 背景颜色预设色板 */
export const SKIN_BACKGROUND_PRESETS: Array<{ label: string; value: string }> = [
    { label: '默认', value: '' },
    { label: '白色', value: '#ffffff' },
    { label: '浅灰', value: '#f5f5f5' },
    { label: '浅蓝', value: '#eaf2ff' },
    { label: '浅绿', value: '#eafaf0' },
    { label: '浅黄', value: '#fff8e6' },
    { label: '浅粉', value: '#ffeef2' },
    { label: '浅紫', value: '#f3eefe' },
];

/** 阴影强度选项 */
export const SKIN_SHADOW_OPTIONS: Array<{ label: string; value: CardSkin['shadow'] }> = [
    { label: '无阴影', value: 'none' },
    { label: '浅阴影', value: 'light' },
    { label: '中阴影', value: 'medium' },
    { label: '深阴影', value: 'heavy' },
];

/** 阴影强度对应的 CSS box-shadow 值 */
export const SKIN_SHADOW_CSS: Record<NonNullable<CardSkin['shadow']>, string> = {
    none: 'none',
    light: '0 1px 3px rgba(0, 0, 0, 0.12)',
    medium: '0 4px 12px rgba(0, 0, 0, 0.18)',
    heavy: '0 8px 24px rgba(0, 0, 0, 0.28)',
};

/** 边框圆角预设（像素） */
export const SKIN_RADIUS_OPTIONS: Array<{ label: string; value: number }> = [
    { label: '小圆角', value: 4 },
    { label: '中圆角', value: 8 },
    { label: '大圆角', value: 16 },
    { label: '全圆角', value: 24 },
];

/** 默认皮肤（无自定义，使用 CSS 默认样式） */
export function defaultCardSkin(): CardSkin {
    return {};
}
