// 工作台视图：卡片集合容器，负责加载模板、渲染卡片、管理卡片实例。
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type { CardTemplate } from '../../datatypes/form';
import type { CardInstance, WorkbenchData } from '../../datatypes/card';
import { loadAllTemplates } from '../../cardmake/data/template-loader';
import { getCardRenderer } from '../../cardmake/cards/card-registry';
import type { CardRenderContext } from '../../datatypes/renderer';
import { createDataProvider } from '../../cardmake/data/provider';
import type { EventBlock, ExecutionRecord } from '../week-view/week-schedule-view';
import type { InboxItem } from '../../shared/task-panel';
import { t } from '../../i18n';

/**
 * 工作台视图：与 YearView / TodayView 一致，通过 renderInto 渲染到指定容器。
 * 持有工作台数据引用 + 保存回调 + 数据访问回调（供 stats 卡片统计）。
 */
export class WorkbenchView {
    private app: App;
    private workbenchData: WorkbenchData;
    private save: () => Promise<void>;
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
        workbenchData: WorkbenchData,
        save: () => Promise<void>,
        getEvents: () => EventBlock[],
        getExecutions: () => ExecutionRecord[],
        getInboxItems: () => InboxItem[],
    ) {
        this.app = app;
        this.workbenchData = workbenchData;
        this.save = save;
        this.getEvents = getEvents;
        this.getExecutions = getExecutions;
        this.getInboxItems = getInboxItems;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('workbench-view');

        // 加载模板（首次或缓存失效时）
        if (this.templates.length === 0) {
            this.templates = await loadAllTemplates(this.app);
        }

        // 顶部工具栏：标题 + 添加卡片按钮
        const toolbar = container.createDiv({ cls: 'wb-toolbar' });
        toolbar.createDiv({ cls: 'wb-toolbar-title', text: t('workbench.title') });
        const addBtn = toolbar.createEl('button', {
            cls: 'wb-add-btn',
            text: t('workbench.addCard'),
        });
        addBtn.onclick = () => this.showAddCardMenu(addBtn);

        // 卡片网格
        const grid = container.createDiv({ cls: 'wb-grid' });

        if (this.workbenchData.instances.length === 0) {
            grid.createDiv({ cls: 'wb-empty', text: t('workbench.empty') });
            return;
        }

        for (const instance of this.workbenchData.instances) {
            const template = this.templates.find((t) => t.id === instance.templateId);
            if (!template) continue;

            const card = grid.createDiv({ cls: 'wb-card' });
            // 卡片头部操作（删除）
            const header = card.createDiv({ cls: 'wb-card-header' });
            const delBtn = header.createEl('button', {
                cls: 'wb-card-delete',
                text: '×',
            });
            delBtn.onclick = () => this.removeCard(instance);

            const body = card.createDiv({ cls: 'wb-card-content' });
            const renderer = getCardRenderer(instance.mode);
            const ctx: CardRenderContext = {
                app: this.app,
                save: this.save,
                refresh: () => void this.renderInto(container),
                provider: createDataProvider(this.getEvents, this.getExecutions, this.getInboxItems),
            };
            renderer.render(body, instance, template, ctx);
        }
    }

    /** 弹出添加卡片菜单：列出所有模板供选择 */
    private showAddCardMenu(anchor: HTMLElement) {
        const menu = anchor.createDiv({ cls: 'wb-add-menu' });
        for (const tpl of this.templates) {
            const item = menu.createDiv({ cls: 'wb-add-menu-item', text: tpl.name });
            item.onclick = () => {
                this.addCard(tpl);
                menu.remove();
            };
        }
        // 点击外部关闭
        const close = (e: MouseEvent) => {
            if (!menu.contains(e.target as Node)) {
                menu.remove();
                document.removeEventListener('click', close);
            }
        };
        window.setTimeout(() => document.addEventListener('click', close), 0);
    }

    /** 添加一张卡片实例 */
    private addCard(template: CardTemplate) {
        const instance: CardInstance = {
            id: crypto.randomUUID(),
            templateId: template.id,
            mode: template.mode,
            title: template.name,
        };
        if (template.mode === 'stats' && template.source) {
            instance.source = template.source;
        }
        this.workbenchData.instances.push(instance);
        void this.save().then(() => {
            new Notice(t('workbench.cardAdded', { name: template.name }));
            if (this.container) void this.renderInto(this.container);
        });
    }

    /** 删除一张卡片实例 */
    private removeCard(instance: CardInstance) {
        this.workbenchData.instances = this.workbenchData.instances.filter(
            (i) => i.id !== instance.id,
        );
        void this.save().then(() => {
            if (this.container) void this.renderInto(this.container);
        });
    }
}
