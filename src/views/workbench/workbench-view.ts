// 工作台视图：卡片集合容器，负责加载模板、渲染卡片、管理卡片实例。
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import type { CardTemplate } from '../../datatypes/form';
import type { CardInstance, WorkbenchData } from '../../datatypes/card';
import { ensureDefaultLayout } from '../../datatypes/card';
import { loadAllTemplates } from '../../cardmake/data/template-loader';
import { getCardRenderer } from '../../cardmake/cards/card-registry';
import type { CardRenderContext } from '../../datatypes/renderer';
import { createDataProvider } from '../../cardmake/data/provider';
import type { EventBlock, ExecutionRecord } from '../../datatypes/domain';
import type { InboxItem } from '../../datatypes/domain';
import { t } from '../../i18n';
import { LayoutModal } from './layout-modal';

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
    /** 是否处于「编辑布局」状态（控制添加卡片按钮显隐） */
    private editingLayout = false;
    /** 进入编辑布局时的卡片快照（用于取消时还原） */
    private editSnapshot: CardInstance[] | null = null;

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

        // 确保默认布局存在，且始终对应当前工作台展示的内容
        ensureDefaultLayout(this.workbenchData, t('layout.defaultName'));

        // 加载模板（首次或缓存失效时）
        if (this.templates.length === 0) {
            this.templates = await loadAllTemplates();
        }

        // 顶部工具栏：标题 + 编辑布局按钮 + 添加卡片按钮（仅编辑态显示）+ 布局方案按钮
        const toolbar = container.createDiv({ cls: 'wb-toolbar' });
        toolbar.createDiv({ cls: 'wb-toolbar-title', text: t('workbench.title') });
        const actions = toolbar.createDiv({ cls: 'wb-toolbar-actions' });

        // 添加卡片按钮：仅编辑态显示
        if (this.editingLayout) {
            const addBtn = actions.createEl('button', {
                cls: 'wb-add-btn',
                text: t('workbench.addCard'),
            });
            addBtn.onclick = () => this.showAddCardMenu(addBtn);

            // 保存按钮：退出编辑态并持久化
            const saveBtn = actions.createEl('button', {
                cls: 'wb-save-btn',
                text: t('workbench.saveLayout'),
            });
            saveBtn.onclick = () => {
                this.editingLayout = false;
                this.editSnapshot = null;
                void this.save().then(() => {
                    if (this.container) void this.renderInto(this.container);
                });
            };

            // 取消按钮：还原到进入编辑态前的快照
            const cancelBtn = actions.createEl('button', {
                cls: 'wb-cancel-btn',
                text: t('workbench.cancelLayout'),
            });
            cancelBtn.onclick = () => {
                if (this.editSnapshot) {
                    this.workbenchData.instances = this.editSnapshot.map((i) => ({ ...i }));
                }
                this.editingLayout = false;
                this.editSnapshot = null;
                void this.renderInto(container);
            };
        }

        // 编辑布局按钮：切换编辑态（编辑态下显示为「编辑中」，位于添加/保存/取消之后）
        const editBtn = actions.createEl('button', {
            cls: 'wb-edit-layout-btn',
            text: this.editingLayout ? t('workbench.editLayoutActive') : t('workbench.editLayout'),
        });
        editBtn.toggleClass('is-active', this.editingLayout);
        editBtn.onclick = () => {
            this.editingLayout = !this.editingLayout;
            // 进入编辑态时记录快照，退出时清空
            this.editSnapshot = this.editingLayout
                ? this.workbenchData.instances.map((i) => ({ ...i }))
                : null;
            void this.renderInto(container);
        };

        const layoutBtn = actions.createEl('button', {
            cls: 'wb-layout-btn',
            text: t('workbench.layoutScheme'),
        });
        layoutBtn.onclick = () => new LayoutModal(this.app, this.workbenchData).open();

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
            // 应用自定义尺寸（编辑布局时拖拽调整过）
            if (instance.width) card.setCssProps({ '--wb-card-width': `${instance.width}px` });
            if (instance.height) card.setCssProps({ '--wb-card-height': `${instance.height}px` });
            if (instance.width || instance.height) card.addClass('has-custom-size');

            // 卡片头部操作（删除）：仅编辑布局时显示删除按钮
            if (this.editingLayout) {
                const header = card.createDiv({ cls: 'wb-card-header' });
                const delBtn = header.createEl('button', {
                    cls: 'wb-card-delete',
                    text: '×',
                });
                delBtn.onclick = () => this.removeCard(instance);

                // 右下角三角拖拽手柄：按住拖动调整卡片尺寸
                this.renderResizeHandle(card, instance);
            }

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

    /**
     * 渲染卡片右下角的三角拖拽手柄（仅编辑布局时）。
     * 按住拖动实时调整卡片宽高，松开后持久化到卡片实例。
     */
    private renderResizeHandle(card: HTMLElement, instance: CardInstance) {
        const handle = card.createDiv({ cls: 'wb-card-resize' });
        handle.onmousedown = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            const startX = e.clientX;
            const startY = e.clientY;
            // 以卡片当前实际尺寸为起点（未设置过自定义尺寸时取渲染尺寸）
            const startW = card.offsetWidth;
            const startH = card.offsetHeight;
            const minW = 200;
            const minH = 120;

            const onMove = (ev: MouseEvent) => {
                const w = Math.max(minW, startW + (ev.clientX - startX));
                const h = Math.max(minH, startH + (ev.clientY - startY));
                card.setCssProps({
                    '--wb-card-width': `${w}px`,
                    '--wb-card-height': `${h}px`,
                });
                card.addClass('has-custom-size');
            };

            const onUp = (ev: MouseEvent) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                const w = Math.max(minW, startW + (ev.clientX - startX));
                const h = Math.max(minH, startH + (ev.clientY - startY));
                instance.width = Math.round(w);
                instance.height = Math.round(h);
                void this.save();
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
    }
}
