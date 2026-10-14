// 梳理视图（GTD 第三步）：左中右三栏结构。
// 左：收集视图的未处理卡片；中：组织视图已添加的源；右：内容编写 + 确认按钮。
import type { App } from 'obsidian';

import type { GtdData, GtdSourceType } from '../../datatypes/gtd';
import { t } from '../../i18n';

/** 源类型 → i18n key */
const SOURCE_LABEL_KEY: Record<GtdSourceType, 'gtd.sourceOkr' | 'gtd.sourcePdca' | 'gtd.sourceMedia' | 'gtd.sourceFinance' | 'gtd.sourceIntel'> = {
    okr: 'gtd.sourceOkr',
    pdca: 'gtd.sourcePdca',
    media: 'gtd.sourceMedia',
    finance: 'gtd.sourceFinance',
    intel: 'gtd.sourceIntel',
};

/**
 * 梳理视图：与 WorkbenchView 一致，通过 renderInto 渲染到指定容器。
 */
export class GtdClarifyView {
    private app: App;
    private gtdData: GtdData;
    private save: () => Promise<void>;
    /** 当前选中的收集卡片 id */
    private selectedItemId?: string;
    /** 当前选中的源 id */
    private selectedSourceId?: string;
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;

    constructor(app: App, gtdData: GtdData, save: () => Promise<void>) {
        this.app = app;
        this.gtdData = gtdData;
        this.save = save;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('gtd-clarify-view');

        const layout = container.createDiv({ cls: 'gtd-clarify-layout' });

        this.renderLeft(layout);
        this.renderMiddle(layout);
        this.renderRight(layout);
    }

    /** 左栏：收集视图的未处理卡片 */
    private renderLeft(layout: HTMLElement) {
        const col = layout.createDiv({ cls: 'gtd-clarify-col gtd-clarify-left' });
        col.createDiv({ cls: 'gtd-clarify-col-title', text: t('gtd.clarifyLeftTitle') });

        const list = col.createDiv({ cls: 'gtd-clarify-list' });
        const pending = this.gtdData.items.filter((it) => it.status === 'inbox');
        if (pending.length === 0) {
            list.createDiv({ cls: 'gtd-clarify-empty', text: t('gtd.collectEmpty') });
            return;
        }
        for (const item of pending) {
            const card = list.createDiv({ cls: 'gtd-clarify-item' });
            if (item.id === this.selectedItemId) card.addClass('is-active');
            card.setText(item.content);
            card.onclick = () => {
                this.selectedItemId = item.id;
                if (this.container) void this.renderInto(this.container);
            };
        }
    }

    /** 中栏：组织视图已添加的源 */
    private renderMiddle(layout: HTMLElement) {
        const col = layout.createDiv({ cls: 'gtd-clarify-col gtd-clarify-middle' });
        col.createDiv({ cls: 'gtd-clarify-col-title', text: t('gtd.clarifyMiddleTitle') });

        const list = col.createDiv({ cls: 'gtd-clarify-list' });
        if (this.gtdData.sources.length === 0) {
            list.createDiv({ cls: 'gtd-clarify-empty', text: t('gtd.clarifyNoSource') });
            return;
        }
        for (const source of this.gtdData.sources) {
            const card = list.createDiv({ cls: 'gtd-clarify-source' });
            if (source.id === this.selectedSourceId) card.addClass('is-active');
            card.setText(t(SOURCE_LABEL_KEY[source.type]));
            card.onclick = () => {
                this.selectedSourceId = source.id;
                if (this.container) void this.renderInto(this.container);
            };
        }
    }

    /** 右栏：内容编写 + 确认按钮 */
    private renderRight(layout: HTMLElement) {
        const col = layout.createDiv({ cls: 'gtd-clarify-col gtd-clarify-right' });
        col.createDiv({ cls: 'gtd-clarify-col-title', text: t('gtd.clarifyRightTitle') });

        const editor = col.createDiv({ cls: 'gtd-clarify-editor' });
        editor.createEl('textarea', {
            cls: 'gtd-clarify-textarea',
            attr: { placeholder: t('gtd.clarifyPlaceholder') },
        });

        const footer = col.createDiv({ cls: 'gtd-clarify-footer' });
        const confirmBtn = footer.createEl('button', {
            cls: 'gtd-clarify-confirm-btn',
            text: t('gtd.clarifyConfirm'),
        });
        confirmBtn.onclick = () => {
            if (!this.selectedItemId) return;
            const item = this.gtdData.items.find((it) => it.id === this.selectedItemId);
            if (!item) return;
            item.status = 'processed';
            this.selectedItemId = undefined;
            void this.save().then(() => {
                if (this.container) void this.renderInto(this.container);
            });
        };
    }
}
