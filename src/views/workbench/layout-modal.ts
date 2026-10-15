import { Modal, type App } from 'obsidian';

import { t } from '../../i18n';
import type { WorkbenchData } from '../../datatypes/card';
import { DEFAULT_LAYOUT_ID } from '../../datatypes/card';

/** 布局方案菜单项定义 */
interface LayoutMenuItem {
    id: string;
    label: string;
}

/** 布局方案弹窗：左侧菜单 + 右侧内容，点击菜单切换右侧内容 */
export class LayoutModal extends Modal {
    /** 当前选中的菜单 id */
    private activeId: string;
    /** 右侧内容容器 */
    private contentPane?: HTMLElement;
    /** 左侧菜单项元素（用于高亮切换） */
    private menuEls = new Map<string, HTMLElement>();
    /** 工作台数据（读取布局列表） */
    private workbenchData: WorkbenchData;

    constructor(app: App, workbenchData: WorkbenchData) {
        super(app);
        this.workbenchData = workbenchData;
        this.activeId = 'custom';
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('parrot-layout-modal');
        this.modalEl.addClass('parrot-layout-modal-container');
        contentEl.createEl('h2', { text: t('layout.title') });

        const body = contentEl.createDiv({ cls: 'parrot-layout-body' });

        // 左侧菜单（自定义布局在上，通用布局在下）
        const menu = body.createDiv({ cls: 'parrot-layout-menu' });
        const items: LayoutMenuItem[] = [
            { id: 'custom', label: t('layout.custom') },
            { id: 'general', label: t('layout.general') },
        ];
        for (const item of items) {
            const el = menu.createDiv({ cls: 'parrot-layout-menu-item', text: item.label });
            el.onclick = () => this.selectMenu(item.id);
            this.menuEls.set(item.id, el);
        }

        // 右侧内容
        this.contentPane = body.createDiv({ cls: 'parrot-layout-content' });

        this.selectMenu(this.activeId);
    }

    /** 切换选中菜单并刷新右侧内容 */
    private selectMenu(id: string) {
        this.activeId = id;
        this.menuEls.forEach((el, key) => {
            el.toggleClass('is-active', key === id);
        });
        if (!this.contentPane) return;
        this.contentPane.empty();
        if (id === 'general') {
            this.contentPane.createEl('p', { text: t('layout.generalDesc') });
        } else if (id === 'custom') {
            this.renderCustomLayouts();
        }
    }

    /** 渲染自定义布局列表：默认布局始终存在且为激活状态 */
    private renderCustomLayouts() {
        if (!this.contentPane) return;
        const layouts = this.workbenchData.layouts ?? [];
        if (layouts.length === 0) {
            this.contentPane.createEl('p', { text: t('layout.empty') });
            return;
        }
        const list = this.contentPane.createDiv({ cls: 'parrot-layout-list' });
        for (const layout of layouts) {
            const row = list.createDiv({ cls: 'parrot-layout-item' });
            row.createSpan({ cls: 'parrot-layout-item-name', text: layout.name });
            // 默认布局 / 当前激活布局显示「使用中」标记
            if (layout.id === DEFAULT_LAYOUT_ID || layout.id === this.workbenchData.activeLayoutId) {
                row.createSpan({ cls: 'parrot-layout-item-badge', text: t('layout.active') });
            }
        }
    }

    onClose() {
        this.contentEl.empty();
        this.menuEls.clear();
    }
}
