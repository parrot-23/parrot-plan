// 剧本管理视图：左右结构，左侧菜单切换右侧内容。
// 菜单：官方剧本 / 本地剧本 / 设置。
import type { App } from 'obsidian';

import { t } from '../../i18n';

/** 左侧菜单项标识 */
type ScriptMenu = 'official' | 'local' | 'settings';

/** 官方剧本示例数据（内置，只读展示） */
interface OfficialScript {
    id: string;
    name: string;
    description: string;
}

/** 内置官方剧本列表 */
const OFFICIAL_SCRIPTS: OfficialScript[] = [
    { id: 'morning-routine', name: '晨间例行', description: '起床后的固定流程，开启高效的一天' },
    { id: 'deep-work', name: '深度工作', description: '专注时段安排，屏蔽干扰完成核心任务' },
    { id: 'weekly-review', name: '每周回顾', description: '回顾本周执行情况并规划下周重点' },
];

/**
 * 剧本管理视图：与 WorkbenchView 一致，通过 renderInto 渲染到指定容器。
 */
export class ScriptManageView {
    private app: App;
    /** 当前选中的左侧菜单 */
    private activeMenu: ScriptMenu = 'official';
    /** 当前渲染容器（用于菜单切换时局部刷新） */
    private container?: HTMLElement;

    constructor(app: App) {
        this.app = app;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        container.empty();
        container.addClass('script-manage-view');

        // 左右结构：左侧菜单 + 右侧内容
        const layout = container.createDiv({ cls: 'script-manage-layout' });

        // 左侧菜单
        const menu = layout.createDiv({ cls: 'script-manage-menu' });
        const menuItems: { id: ScriptMenu; labelKey: 'scriptManage.official' | 'scriptManage.local' | 'scriptManage.settings' }[] = [
            { id: 'official', labelKey: 'scriptManage.official' },
            { id: 'local', labelKey: 'scriptManage.local' },
            { id: 'settings', labelKey: 'scriptManage.settings' },
        ];
        for (const item of menuItems) {
            const btn = menu.createEl('button', {
                cls: 'script-manage-menu-item',
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
        const content = layout.createDiv({ cls: 'script-manage-content' });
        if (this.activeMenu === 'official') {
            this.renderOfficial(content);
        } else if (this.activeMenu === 'local') {
            this.renderLocal(content);
        } else {
            this.renderSettings(content);
        }
    }

    /** 官方剧本：内置示例列表 */
    private renderOfficial(container: HTMLElement) {
        container.createDiv({ cls: 'script-manage-title', text: t('scriptManage.official') });
        const list = container.createDiv({ cls: 'script-manage-list' });
        for (const script of OFFICIAL_SCRIPTS) {
            const card = list.createDiv({ cls: 'script-manage-card' });
            card.createDiv({ cls: 'script-manage-card-name', text: script.name });
            card.createDiv({ cls: 'script-manage-card-desc', text: script.description });
        }
    }

    /** 本地剧本：空列表 + 提示 */
    private renderLocal(container: HTMLElement) {
        container.createDiv({ cls: 'script-manage-title', text: t('scriptManage.local') });
        container.createDiv({ cls: 'script-manage-empty', text: t('scriptManage.localEmpty') });
    }

    /** 设置：占位提示 */
    private renderSettings(container: HTMLElement) {
        container.createDiv({ cls: 'script-manage-title', text: t('scriptManage.settings') });
        container.createDiv({ cls: 'script-manage-empty', text: t('scriptManage.settingsPlaceholder') });
    }
}
