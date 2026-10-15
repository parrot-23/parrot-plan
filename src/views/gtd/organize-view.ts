// 组织视图（GTD 第二步）：左右结构，左侧菜单切换右侧内容。
// 菜单：任务（各任务的收集篮子）+ 设置（源管理）。
import type { App } from 'obsidian';

import type { GtdData, GtdSourceType } from '../../datatypes/gtd';
import type { InboxData } from '../../datatypes/domain';
import { t } from '../../i18n';

/** 左侧菜单项标识 */
type OrganizeMenu = 'tasks' | 'settings';

/** 可添加的源类型（顺序即下拉/按钮顺序） */
const SOURCE_TYPES: GtdSourceType[] = ['okr', 'pdca', 'media', 'finance', 'intel'];

/** 源类型 → i18n key */
const SOURCE_LABEL_KEY: Record<GtdSourceType, 'gtd.sourceOkr' | 'gtd.sourcePdca' | 'gtd.sourceMedia' | 'gtd.sourceFinance' | 'gtd.sourceIntel'> = {
    okr: 'gtd.sourceOkr',
    pdca: 'gtd.sourcePdca',
    media: 'gtd.sourceMedia',
    finance: 'gtd.sourceFinance',
    intel: 'gtd.sourceIntel',
};

/**
 * 组织视图：与 WorkbenchView 一致，通过 renderInto 渲染到指定容器。
 */
export class GtdOrganizeView {
    private app: App;
    private gtdData: GtdData;
    private inboxData: InboxData;
    private save: () => Promise<void>;
    /** 当前选中的左侧菜单 */
    private activeMenu: OrganizeMenu = 'tasks';
    /** 当前渲染容器（用于菜单切换时局部刷新） */
    private container?: HTMLElement;

    constructor(app: App, gtdData: GtdData, inboxData: InboxData, save: () => Promise<void>) {
        this.app = app;
        this.gtdData = gtdData;
        this.inboxData = inboxData;
        this.save = save;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('gtd-organize-view');

        const layout = container.createDiv({ cls: 'gtd-organize-layout' });

        // 左侧菜单
        const menu = layout.createDiv({ cls: 'gtd-organize-menu' });
        const menuItems: { id: OrganizeMenu; labelKey: 'gtd.organizeTasks' | 'gtd.organizeSettings' }[] = [
            { id: 'tasks', labelKey: 'gtd.organizeTasks' },
            { id: 'settings', labelKey: 'gtd.organizeSettings' },
        ];
        for (const item of menuItems) {
            const btn = menu.createEl('button', {
                cls: 'gtd-organize-menu-item',
                text: t(item.labelKey),
                attr: { 'data-menu': item.id },
            });
            if (item.id === this.activeMenu) btn.addClass('is-active');
            btn.onclick = () => {
                if (this.activeMenu === item.id) return;
                this.activeMenu = item.id;
                void this.renderInto(container);
            };
        }

        // 右侧内容
        const content = layout.createDiv({ cls: 'gtd-organize-content' });
        if (this.activeMenu === 'tasks') {
            this.renderTasks(content);
        } else {
            this.renderSettings(content);
        }
    }

    /** 任务页：每个任务及其收集篮子 */
    private renderTasks(container: HTMLElement) {
        const items = this.inboxData.items.filter((it) => !it.removed);
        if (items.length === 0) {
            container.createDiv({ cls: 'gtd-organize-empty', text: t('gtd.organizeTasksEmpty') });
            return;
        }
        for (const item of items) {
            const block = container.createDiv({ cls: 'gtd-organize-block' });
            block.createDiv({ cls: 'gtd-organize-block-title', text: item.title });

            const list = block.createDiv({ cls: 'gtd-organize-basket-list' });
            const entries = item.basket ?? [];
            if (entries.length === 0) {
                list.createDiv({ cls: 'gtd-organize-empty', text: t('basket.empty') });
                continue;
            }
            for (const entry of entries) {
                const row = list.createDiv({ cls: 'gtd-organize-basket-item' });
                row.createSpan({ cls: 'gtd-organize-basket-text', text: entry.text });
            }
        }
    }

    /** 设置页：源管理 */
    private renderSettings(container: HTMLElement) {
        const block = container.createDiv({ cls: 'gtd-organize-block' });
        block.createDiv({ cls: 'gtd-organize-block-title', text: t('gtd.sourceBlockTitle') });

        // 添加按钮 + 类型选择
        const addRow = block.createDiv({ cls: 'gtd-organize-add-row' });
        const select = addRow.createEl('select', { cls: 'gtd-organize-source-select' });
        for (const type of SOURCE_TYPES) {
            select.createEl('option', { text: t(SOURCE_LABEL_KEY[type]), value: type });
        }
        const addBtn = addRow.createEl('button', {
            cls: 'gtd-organize-add-btn',
            text: t('gtd.sourceAdd'),
        });
        addBtn.onclick = () => {
            const type = select.value as GtdSourceType;
            this.gtdData.sources.push({
                id: crypto.randomUUID(),
                type,
                createdAt: Date.now(),
            });
            void this.save().then(() => {
                if (this.container) void this.renderInto(this.container);
            });
        };

        // 已添加的源卡片
        const list = block.createDiv({ cls: 'gtd-organize-source-list' });
        if (this.gtdData.sources.length === 0) {
            list.createDiv({ cls: 'gtd-organize-empty', text: t('gtd.sourceEmpty') });
            return;
        }
        for (const source of this.gtdData.sources) {
            const card = list.createDiv({ cls: 'gtd-organize-source-card' });
            card.createSpan({ cls: 'gtd-organize-source-name', text: t(SOURCE_LABEL_KEY[source.type]) });
            const delBtn = card.createEl('button', {
                cls: 'gtd-organize-source-delete',
                text: '×',
            });
            delBtn.onclick = () => {
                this.gtdData.sources = this.gtdData.sources.filter((s) => s.id !== source.id);
                void this.save().then(() => {
                    if (this.container) void this.renderInto(this.container);
                });
            };
        }
    }
}
