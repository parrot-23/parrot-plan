// 收集视图（GTD 第一步）：顶部输入框记录信息，下方列出所有未处理的卡片。
import type { App } from 'obsidian';

import type { GtdData } from '../../datatypes/gtd';
import { t } from '../../i18n';

/** 时间戳格式化为 YYYY-MM-DD HH:MM */
function formatTime(ts: number): string {
    const d = new Date(ts);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${mo}-${da} ${h}:${mi}`;
}

/**
 * 收集视图：与 WorkbenchView 一致，通过 renderInto 渲染到指定容器。
 * 持有 GTD 数据引用 + 保存回调。
 */
export class GtdCollectView {
    private app: App;
    private gtdData: GtdData;
    private save: () => Promise<void>;
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
        container.addClass('gtd-collect-view');

        // 顶部输入区
        const inputRow = container.createDiv({ cls: 'gtd-collect-input-row' });
        const input = inputRow.createEl('input', {
            cls: 'gtd-collect-input',
            attr: { type: 'text', placeholder: t('gtd.collectPlaceholder') },
        });
        const addBtn = inputRow.createEl('button', {
            cls: 'gtd-collect-add-btn',
            text: t('common.add'),
        });

        const submit = () => {
            const content = input.value.trim();
            if (!content) return;
            this.gtdData.items.push({
                id: crypto.randomUUID(),
                content,
                createdAt: Date.now(),
                status: 'inbox',
            });
            void this.save().then(() => {
                if (this.container) void this.renderInto(this.container);
            });
        };
        addBtn.onclick = submit;
        input.onkeydown = (e) => {
            if (e.key === 'Enter') submit();
        };

        // 未处理卡片列表
        const list = container.createDiv({ cls: 'gtd-collect-list' });
        const pending = this.gtdData.items.filter((it) => it.status === 'inbox');

        if (pending.length === 0) {
            list.createDiv({ cls: 'gtd-collect-empty', text: t('gtd.collectEmpty') });
            return;
        }

        for (const item of pending) {
            const card = list.createDiv({ cls: 'gtd-collect-card' });
            card.createDiv({ cls: 'gtd-collect-card-content', text: item.content });
            const meta = card.createDiv({ cls: 'gtd-collect-card-meta' });
            meta.createSpan({ cls: 'gtd-collect-card-time', text: formatTime(item.createdAt) });
            meta.createSpan({ cls: 'gtd-collect-card-status', text: t('gtd.statusInbox') });

            const delBtn = card.createEl('button', {
                cls: 'gtd-collect-card-delete',
                text: '×',
            });
            delBtn.onclick = () => {
                this.gtdData.items = this.gtdData.items.filter((it) => it.id !== item.id);
                void this.save().then(() => {
                    if (this.container) void this.renderInto(this.container);
                });
            };
        }
    }
}
