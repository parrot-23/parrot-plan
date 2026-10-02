// timeblock-data.ts
export type TimeBlockCategoryId = string;

/** 时间块的分类（类别） */

/** 时间区间，以分钟计（0–1440） */
export interface TimeRange {
	id: string;
	start: number;
	end: number;
}

/** 带分类的时间区间 */
export interface CategorizedRange extends TimeRange {
	sort: TimeBlockCategoryId;
}

/** 单日区间数据 */
export interface DailyRange {
	/** 1 = 周一 ... 7 = 周日 */
	day: number;
	ranges: CategorizedRange[];
}

/** 周区间数据（持久化根节点） */
export interface WeekRangeData {
	version: 1;
	days: DailyRange[];
}

/** 时间区间方案：一组命名的时间区块配置 */
export interface RangeScheme {
	id: string;
	name: string;
	days: DailyRange[];
}

/** 方案集合（持久化） */
export interface RangeSchemeData {
	schemes: RangeScheme[];
	/** 当前激活的方案 */
	activeSchemeId?: string;
	/** 默认方案 */
	defaultSchemeId?: string;
}

/** 将 #rgb / #rrggbb 颜色转为带透明度的 rgba 字符串 */
export function hexToTransparent(hex: string, alpha: number): string {
	let h = hex.replace('#', '');
	if (h.length === 3) {
		h = h.split('').map(c => c + c).join('');
	}
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 默认周日程数据（兜底用）
export const DEFAULT_WEEK_RANGE: WeekRangeData = {
	version: 1,
	days: [
		{
			day: 1, // 周一
			ranges: [
				{ id: 'r1', start: 690, end: 720, sort: 'work' },
				{ id: 'r2', start: 720, end: 840, sort: 'rest' },
				{ id: 'r3', start: 1200, end: 1320, sort: 'play' },
			],
		},
		{
			day: 3, // 周三
			ranges: [
				{ id: 'r4', start: 600, end: 960, sort: 'work' },
			],
		},
		{
			day: 7, // 周六
			ranges: [
				{ id: 'r5', start: 240, end: 1080, sort: 'play' },
			],
		},
	],
};

