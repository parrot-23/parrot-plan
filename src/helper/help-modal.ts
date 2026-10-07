import { Modal, type App } from 'obsidian';

import { t } from '../i18n';

/** 帮助弹窗：左侧展示缓存图片，右侧展示文字介绍，右下角提供「不再提示」勾选 */
export class HelpModal extends Modal {
    private cacheDirName: string;
    /** 勾选状态变化回调（用于持久化「不再提示」标记） */
    private onDismissChange?: (dismissed: boolean) => void;

    constructor(app: App, cacheDirName: string, onDismissChange?: (dismissed: boolean) => void) {
        super(app);
        this.cacheDirName = cacheDirName;
        this.onDismissChange = onDismissChange;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('parrot-help-modal');
        // 给外层 modal 容器加类，便于覆盖默认宽高限制
        this.modalEl.addClass('parrot-help-modal-container');
        contentEl.createEl('h2', { text: t('help.title') });

        const body = contentEl.createDiv({ cls: 'parrot-help-body' });

        // 左侧：缓存后的图片（通过 vault 引用）
        const left = body.createDiv({ cls: 'parrot-help-left' });
        const imgPath = `${this.cacheDirName}/说明.png`;
        const imgUrl = this.app.vault.adapter.getResourcePath(imgPath);
        left.createEl('img', {
            cls: 'parrot-help-image',
            attr: { src: imgUrl, alt: t('help.title') },
        });

        // 右侧：文字介绍
        const right = body.createDiv({ cls: 'parrot-help-right' });
        right.createEl('p', { text: t('help.todayIntro') });

        // 右下角：不再提示勾选框
        const footer = contentEl.createDiv({ cls: 'parrot-help-footer' });
        const label = footer.createEl('label', { cls: 'parrot-help-dismiss' });
        const checkbox = label.createEl('input', { type: 'checkbox' });
        label.createSpan({ text: t('help.dontShowAgain') });
        checkbox.onchange = () => {
            this.onDismissChange?.(checkbox.checked);
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}
