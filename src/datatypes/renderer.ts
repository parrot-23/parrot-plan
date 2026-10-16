// 卡片渲染器接口与上下文。
// 每种卡片模式对应一个渲染器，通过注册表按 mode 分发。
import type { App } from 'obsidian';
import type { CardTemplate } from './form';
import type { CardInstance } from './card';
import type { DataProvider } from './chart';
import type { GtdItem } from './gtd';

/** 渲染器上下文：提供数据访问与保存回调 */
export interface CardRenderContext {
    app: App;
    /** 保存工作台数据（由上层注入） */
    save: () => Promise<void>;
    /** 刷新当前卡片（重新渲染） */
    refresh: () => void;
    /** 统一数据提供者（stats 模式统计用，返回完整类型数据） */
    provider: DataProvider;
    /**
     * 追加一条 GTD 收集箱条目（collect 模式使用）。
     * 由上层注入，写入 GtdData.items 并持久化；未注入时该能力不可用。
     */
    addGtdItem?: (content: string) => Promise<void>;
    /**
     * 读取 GTD 收集箱全部条目（collect 模式使用）。
     * 与 GTD「收集」视图共用同一数据源（GtdData.items），保证两处同步。
     */
    getGtdItems?: () => GtdItem[];
    /**
     * 删除一条 GTD 收集箱条目（collect 模式使用）。
     * 由上层注入，从 GtdData.items 移除并持久化。
     */
    removeGtdItem?: (id: string) => Promise<void>;
}

/** 卡片渲染器：把一张卡片实例渲染到容器 */
export interface CardRenderer {
    render(
        container: HTMLElement,
        instance: CardInstance,
        template: CardTemplate,
        ctx: CardRenderContext,
    ): void;
}
