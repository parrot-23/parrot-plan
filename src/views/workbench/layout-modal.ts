import { Modal, type App } from 'obsidian';

import { t } from '../../i18n';

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

    constructor(app: App) {
        super(app);
        this.activeId = 'general';
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('parrot-layout-modal');
        this.modalEl.addClass('parrot-layout-modal-container');
        contentEl.createEl('h2', { text: t('layout.title') });

        const body = contentEl.createDiv({ cls: 'parrot-layout-body' });

        // 左侧菜单
        const menu = body.createDiv({ cls: 'parrot-layout-menu' });
        const items: LayoutMenuItem[] = [
            { id: 'general', label: t('layout.general') },
            { id: 'custom', label: t('layout.custom') },
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
            this.contentPane.createEl('p', { text: t('layout.customDesc') });
        }
    }

    onClose() {
        this.contentEl.empty();
        this.menuEls.clear();
    }
}
