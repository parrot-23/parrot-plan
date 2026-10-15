// 回顾视图（GTD 第四步）：左右结构。
// 左：组织视图已添加的源（菜单）；右：回廊形式的已处理卡片。
import type { App } from 'obsidian';

import type { GtdSourceType } from '../../datatypes/gtd';
import type { GtdRepo } from '../../repos/gtd-repo';
import { t } from '../../i18n';

/** 源类型 → i18n key */
const SOURCE_LABEL_KEY: Record<GtdSourceType, 'gtd.sourceOkr' | 'gtd.sourcePdca' | 'gtd.sourceMedia' | 'gtd.sourceFinance' | 'gtd.sourceIntel'> = {
    okr: 'gtd.sourceOkr',
    pdca: 'gtd.sourcePdca',
    media: 'gtd.sourceMedia',
    finance: 'gtd.sourceFinance',
    intel: 'gtd.sourceIntel',
};

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
 * 回顾视图：与 WorkbenchView 一致，通过 renderInto 渲染到指定容器。
 */
export class GtdReviewView {
    private app: App;
    private gtdRepo: GtdRepo;
    /** 当前选中的源 id */
    private selectedSourceId?: string;
    /** 当前渲染容器（用于菜单切换时局部刷新） */
    private container?: HTMLElement;

    constructor(app: App, gtdRepo: GtdRepo) {
        this.app = app;
        this.gtdRepo = gtdRepo;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('gtd-review-view');

        const layout = container.createDiv({ cls: 'gtd-review-layout' });

        // 左侧菜单：已添加的源
        const menu = layout.createDiv({ cls: 'gtd-review-menu' });
        if (this.gtdRepo.data.sources.length === 0) {
            menu.createDiv({ cls: 'gtd-review-empty', text: t('gtd.clarifyNoSource') });
        } else {
            // 默认选中第一个源
            if (!this.selectedSourceId || !this.gtdRepo.data.sources.some((s) => s.id === this.selectedSourceId)) {
                this.selectedSourceId = this.gtdRepo.data.sources[0].id;
            }
            for (const source of this.gtdRepo.data.sources) {
                const btn = menu.createEl('button', {
                    cls: 'gtd-review-menu-item',
                    text: t(SOURCE_LABEL_KEY[source.type]),
                    attr: { 'data-source': source.id },
                });
                if (source.id === this.selectedSourceId) btn.addClass('is-active');
                btn.onclick = () => {
                    if (this.selectedSourceId === source.id) return;
                    this.selectedSourceId = source.id;
                    if (this.container) void this.renderInto(this.container);
                };
            }
        }

        // 右侧回廊
        const gallery = layout.createDiv({ cls: 'gtd-review-gallery' });
        const processed = this.gtdRepo.getProcessedItems();
        if (processed.length === 0) {
            gallery.createDiv({ cls: 'gtd-review-empty', text: t('gtd.reviewEmpty') });
            return;
        }
        const grid = gallery.createDiv({ cls: 'gtd-review-grid' });
        for (const item of processed) {
            const card = grid.createDiv({ cls: 'gtd-review-card' });
            card.createDiv({ cls: 'gtd-review-card-content', text: item.content });
            card.createDiv({ cls: 'gtd-review-card-time', text: formatTime(item.createdAt) });
        }
    }
}
