// 卡片数据模型：卡片实例（用户填写的结果）与模板分离存储。
import type { CardMode, CardSource, FormValues } from './form';
import type { CardSkin } from './skin';

/** 周期填写记录（periodic 模式） */
export interface CardRecord {
    id: string;
    /** 周期键：day → "2026-10-05"，week → "2026-W41"，month → "2026-10" */
    periodKey: string;
    values: FormValues;
    createdAt: number;
}

/** 收集记录（collect 模式：输入框卡片逐条追加） */
export interface CardEntry {
    id: string;
    /** 记录内容（用户输入） */
    content: string;
    /** 创建时间（毫秒时间戳） */
    createdAt: number;
}

/** 自定义列表行类型：手写 / 任务时长 */
export type TimelogRowKind = 'manual' | 'task';

/** 自定义列表行（list 渲染器：每行一个下拉选项 + 内容） */
export interface TimelogRow {
    id: string;
    /** 行类型：手写（自由文本）/ 任务时长（关联已有任务） */
    kind: TimelogRowKind;
    /** 手写内容（kind = manual 时使用） */
    text?: string;
    /** 关联的任务 id（kind = task 时使用） */
    taskId?: string;
}

/** 卡片实例：工作台上的一张卡片 */
export interface CardInstance {
    /** 实例 id（添加卡片时生成） */
    id: string;
    /** 指向 templates/*.json 的模板 id */
    templateId: string;
    /** 卡片分类（冗余存储，便于快速判断；渲染器类型见模板 renderer 字段） */
    mode: CardMode;
    /** periodic：周期填写记录 */
    records?: CardRecord[];
    /** collect：收集记录（输入框卡片逐条追加） */
    entries?: CardEntry[];
    /** list：自定义列表行（下拉选择手写/任务时长） */
    timelogRows?: TimelogRow[];
    /** stats：数据来源定义 */
    source?: CardSource;
    /** fixed：填写后固定的值 */
    value?: FormValues;
    /** fixed 模式填写后置 true，锁定展示 */
    locked?: boolean;
    /** 卡片标题（用户可自定义，缺省用模板名） */
    title?: string;
    /** 卡片皮肤（自定义样式：背景色、阴影、圆角等） */
    skin?: CardSkin;
    /** 卡片自定义宽度（像素，编辑布局时拖拽调整；吸附到 30px 网格） */
    width?: number;
    /** 卡片自定义高度（像素，编辑布局时拖拽调整；吸附到 30px 网格） */
    height?: number;
    /** 网格列坐标（单位 30px，编辑布局时拖动排布；缺省按顺序自动排布） */
    col?: number;
    /** 网格行坐标（单位 30px，编辑布局时拖动排布；缺省按顺序自动排布） */
    row?: number;
}

/** 工作台布局：一组卡片实例的命名快照 */
export interface WorkbenchLayout {
    /** 布局 id（默认布局固定为 DEFAULT_LAYOUT_ID） */
    id: string;
    /** 布局名称 */
    name: string;
    /** 该布局包含的卡片实例 */
    instances: CardInstance[];
}

/** 默认布局固定 id，不可删除 */
export const DEFAULT_LAYOUT_ID = 'default';

/** 工作台数据顶层容器（随 plugin.data 持久化） */
export interface WorkbenchData {
    /** 当前工作台正在展示的卡片实例 */
    instances: CardInstance[];
    /** 用户创建的全部布局（含默认布局） */
    layouts?: WorkbenchLayout[];
    /** 当前激活的布局 id */
    activeLayoutId?: string;
}

/** 默认空工作台数据 */
export function defaultWorkbenchData(): WorkbenchData {
    return { instances: [] };
}

/**
 * 确保工作台数据中存在默认布局，且默认布局始终对应当前工作台展示的内容。
 * - 首次初始化：用当前 instances 快照生成默认布局，并激活它。
 * - 已存在：默认布局的 instances 同步为当前 instances（保持「默认布局 = 当前展示」）。
 */
export function ensureDefaultLayout(data: WorkbenchData, name: string): void {
    if (!data.layouts) data.layouts = [];
    const existing = data.layouts.find(l => l.id === DEFAULT_LAYOUT_ID);
    if (existing) {
        existing.instances = data.instances;
    } else {
        data.layouts.unshift({ id: DEFAULT_LAYOUT_ID, name, instances: data.instances });
    }
    if (!data.activeLayoutId) data.activeLayoutId = DEFAULT_LAYOUT_ID;
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
