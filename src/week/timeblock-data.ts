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

/** 周键：`${年}-W${周号}`，如 2026-W40 */
export type WeekKey = string;

/** 周区间数据（持久化根节点） */
export interface WeekRangeData {
	version: 1;
	days: DailyRange[];
	/** 按周键存储的日历区间（从方案复制而来，成为该周的固定区间） */
	weeks?: Record<WeekKey, DailyRange[]>;
}

/** 时间区间方案：一组命名的时间区块配置（周无关的模板） */
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

/** 由年 + 周号生成周键 */
export function makeWeekKey(year: number, week: number): WeekKey {
	return `${year}-W${String(week).padStart(2, '0')}`;
}

/** 解析周键为 { year, week } */
export function parseWeekKey(key: WeekKey): { year: number; week: number } {
	const [yearStr, weekStr] = key.split('-W');
	return { year: Number(yearStr), week: Number(weekStr) };
}

/** 获取指定日期所在的 ISO 周号（1-52/53） */
export function getISOWeek(date: Date): number {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	const dayNum = d.getUTCDay() || 7;
	d.setUTCDate(d.getUTCDate() + 4 - dayNum);
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/** 获取当前日期对应的周键 */
export function getCurrentWeekKey(): WeekKey {
	const now = new Date();
	return makeWeekKey(now.getFullYear(), getISOWeek(now));
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

