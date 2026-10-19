import type { Plugin } from 'obsidian';

import { t } from '../i18n';
import { VIEW_TYPE_MAIN, MainView } from '../main-view';
import type { InboxItem, RunningTask } from '../datatypes/domain';

/**
 * 状态栏「进行中任务」：显示「任务名称：已用时长」，每分钟刷新一次。
 * 状态栏元素由插件创建（插件加载即存在，不依赖主视图是否打开）；
 * 点击可打开主视图并跳转到「日执行」二级视图。
 */
export class RunningTaskStatusBar {
    /** 状态栏元素（由插件创建，随插件卸载自动清理） */
    private el?: HTMLElement;
    /** 已用时长刷新定时器（每分钟更新） */
    private timer?: number;

    constructor(
        private plugin: Plugin,
        /** 读取当前进行中任务 */
        private getRunningTask: () => RunningTask | undefined,
        /** 按 id 查找未移除的收集盒任务 */
        private findItem: (inboxId: string) => InboxItem | undefined,
    ) {}

    /** 创建状态栏元素，并开始每分钟刷新已用时长 */
    init(): void {
        this.el = this.plugin.addStatusBarItem();
        this.el.addClass('parrot-plan-status-running');
        this.render();
        this.timer = window.setInterval(() => this.render(), 60 * 1000);
    }

    /**
     * 渲染状态栏中的「进行中任务」：显示「任务名称：时长」。
     * 无进行中任务（或任务已被移除）时隐藏。
     */
    render(): void {
        const el = this.el;
        if (!el) return;
        el.empty();

        const running = this.getRunningTask();
        const item = running ? this.findItem(running.inboxId) : undefined;
        if (!running || !item) {
            el.addClass('is-hidden');
            return;
        }
        el.removeClass('is-hidden');

        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const elapsed = Math.max(0, nowMinutes - running.start);
        el.setText(t('nav.runningStatusBar', {
            name: item.title,
            duration: t('nav.runningStatusBarDuration', { minutes: String(elapsed) }),
        }));
        el.setAttribute('aria-label', t('nav.runningLabel'));
        el.onclick = () => {
            void this.openTodayTab();
        };
    }

    /** 清理定时器与状态栏元素（插件卸载时调用） */
    destroy(): void {
        if (this.timer !== undefined) {
            window.clearInterval(this.timer);
            this.timer = undefined;
        }
        this.el?.remove();
        this.el = undefined;
    }

    /** 打开主视图并切换到「日执行」二级视图（状态栏点击用） */
    private async openTodayTab(): Promise<void> {
        const { workspace } = this.plugin.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_MAIN)[0];
        if (!leaf) {
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({ type: VIEW_TYPE_MAIN });
        }
        await workspace.revealLeaf(leaf);

        const view = leaf.view;
        if (view instanceof MainView) {
            await view.openTodayTab();
        }
    }
}
