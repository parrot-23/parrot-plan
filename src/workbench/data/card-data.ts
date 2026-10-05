// 卡片数据模型：卡片实例（用户填写的结果）与模板分离存储。
import type { CardMode, CardSource, FormValues } from '../form-engine/types';

/** 周期填写记录（periodic 模式） */
export interface CardRecord {
    id: string;
    /** 周期键：day → "2026-10-05"，week → "2026-W41"，month → "2026-10" */
    periodKey: string;
    values: FormValues;
    createdAt: number;
}

/** 卡片实例：工作台上的一张卡片 */
export interface CardInstance {
    /** 实例 id（添加卡片时生成） */
    id: string;
    /** 指向 templates/*.json 的模板 id */
    templateId: string;
    /** 卡片模式（冗余存储，便于快速判断） */
    mode: CardMode;
    /** periodic：周期填写记录 */
    records?: CardRecord[];
    /** stats：数据来源定义 */
    source?: CardSource;
    /** fixed：填写后固定的值 */
    value?: FormValues;
    /** fixed 模式填写后置 true，锁定展示 */
    locked?: boolean;
    /** 卡片标题（用户可自定义，缺省用模板名） */
    title?: string;
}

/** 工作台数据顶层容器（随 plugin.data 持久化） */
export interface WorkbenchData {
    instances: CardInstance[];
}

/** 默认空工作台数据 */
export function defaultWorkbenchData(): WorkbenchData {
    return { instances: [] };
}

/** 生成周期键 */
export function makePeriodKey(period: 'day' | 'week' | 'month', date: Date = new Date()): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    if (period === 'day') return `${y}-${m}-${d}`;
    if (period === 'month') return `${y}-${m}`;
    // week：ISO 周键
    return makeIsoWeekKey(date);
}

/** 计算 ISO 周键（如 2026-W41） */
function makeIsoWeekKey(date: Date): string {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
