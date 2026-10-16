// 成就榜单视图：通过底层统计卡片引擎展示用户的累计成就。
// 复用 cardmake 引擎（模板 + 聚合器 + 渲染器），以只读网格展示统计卡片。
import type { App } from 'obsidian';

import type { CardTemplate } from '../../datatypes/form';
import type { CardInstance } from '../../datatypes/card';
import { loadAllTemplates } from '../../cardmake/data/template-loader';
import { getCardRenderer } from '../../cardmake/cards/card-registry';
import type { CardRenderContext } from '../../datatypes/renderer';
import { createDataProvider } from '../../cardmake/data/provider';
import type { EventBlock, ExecutionRecord, InboxItem } from '../../datatypes/domain';
import { t } from '../../i18n';

/** 成就榜单展示的卡片模板 id（按顺序） */
const ACHIEVEMENT_TEMPLATE_IDS = [
    'usage-days',
    'executed-task-count',
    'execution-total-duration',
];

/**
 * 成就榜单视图：与 WorkbenchView 一致，通过 renderInto 渲染到指定容器。
 * 只读展示，不提供编辑布局能力。
 */
export class AchievementView {
    private app: App;
    /** 获取全部事件（stats 统计用） */
    private getEvents: () => EventBlock[];
    /** 获取全部执行记录（stats 统计用） */
    private getExecutions: () => ExecutionRecord[];
    /** 获取收集盒任务（stats 统计用） */
    private getInboxItems: () => InboxItem[];
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 已加载的模板列表 */
    private templates: CardTemplate[] = [];

    constructor(
        app: App,
        getEvents: () => EventBlock[],
        getExecutions: () => ExecutionRecord[],
        getInboxItems: () => InboxItem[],
    ) {
        this.app = app;
        this.getEvents = getEvents;
        this.getExecutions = getExecutions;
        this.getInboxItems = getInboxItems;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('achievement-view');

        // 加载模板（首次或缓存失效时）
        if (this.templates.length === 0) {
            this.templates = await loadAllTemplates();
        }

        // 顶部标题
        const toolbar = container.createDiv({ cls: 'achievement-toolbar' });
        toolbar.createDiv({ cls: 'achievement-title', text: t('achievement.title') });

        // 卡片网格
        const grid = container.createDiv({ cls: 'achievement-grid' });

        const provider = createDataProvider(this.getEvents, this.getExecutions, this.getInboxItems);
        const ctx: CardRenderContext = {
            app: this.app,
            save: async () => {},
            refresh: () => {
                if (this.container) void this.renderInto(this.container);
            },
            provider,
        };

        for (const templateId of ACHIEVEMENT_TEMPLATE_IDS) {
            const template = this.templates.find((tpl) => tpl.id === templateId);
            if (!template) continue;

            const instance: CardInstance = {
                id: templateId,
                templateId: template.id,
                mode: template.mode,
                title: template.name,
                source: template.source,
            };

            const card = grid.createDiv({ cls: 'achievement-card' });
            const body = card.createDiv({ cls: 'achievement-card-content' });
            const renderer = getCardRenderer(instance.mode);
            renderer.render(body, instance, template, ctx);
        }
    }
}
