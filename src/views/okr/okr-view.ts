import type { App } from 'obsidian';

import { t } from '../../i18n';

/**
 * 任务OKR 视图（一级视图「任务OKR」下的占位页）。
 * 当前仅展示占位提示，后续在此实现 OKR 相关功能。
 */
export class OkrView {
    private app: App;

    constructor(app: App) {
        this.app = app;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        container.empty();
        container.addClass('okr-view');
        const placeholder = container.createDiv({ cls: 'parrot-plan-placeholder' });
        placeholder.setText(t('nav.okrPlaceholder'));
    }
}
