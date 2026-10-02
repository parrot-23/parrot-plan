import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { Plugin } from 'obsidian';

import type { WeekRangeData, RangeSchemeData } from './week/timeblock-data';
import type { TimeBlockCategoryData } from './week/timeblock-category-manager';
import type { DayTemplateData } from './week/template-manager';
import type { InboxData } from './shared/task-panel';
import {
    WeekScheduleView,
    type EventBlock,
    type ExecutionRecord,
} from './week/week-schedule-view';
import { YearView } from './views/year-view';
import { TodayView } from './views/today-view';
import { SwimlaneView } from './views/swimlane-view';
import { t } from './i18n';

export const VIEW_TYPE_MAIN = 'parrot-plan-main-view';

/** 主导航 tab 标识 */
type NavTab = 'year' | 'week' | 'today' | 'swimlane' | 'achievement';

/** 主导航按钮定义 */
const NAV_TABS: { id: NavTab; label: string }[] = [
    { id: 'year', label: t('nav.year') },
    { id: 'week', label: t('nav.week') },
    { id: 'today', label: t('nav.today') },
    { id: 'swimlane', label: t('nav.swimlane') },
    { id: 'achievement', label: t('nav.achievement') },
];

/**
 * 主视图：作为顶层 tab 容器，左上角按钮组切换不同页面。
 * 其中「周计划」复用 WeekScheduleView 的渲染逻辑。
 */
export class MainView extends ItemView {
    plugin: Plugin;
    private weekView: WeekScheduleView;
    private yearView: YearView;
    private todayView: TodayView;
    private swimlaneView: SwimlaneView;
    private activeTab: NavTab = 'week';
    private contentRoot!: HTMLElement;

    constructor(
        leaf: WorkspaceLeaf,
        plugin: Plugin,
        data: WeekRangeData,
        templateData: DayTemplateData,
        categoryData: TimeBlockCategoryData,
        events: EventBlock[],
        executions: ExecutionRecord[],
        inboxData: InboxData,
        schemeData: RangeSchemeData,
    ) {
        super(leaf);
        this.plugin = plugin;
        this.weekView = new WeekScheduleView(
            leaf,
            plugin,
            data,
            templateData,
            categoryData,
            events,
            executions,
            inboxData,
            schemeData,
        );
        this.yearView = new YearView(
            this.app,
            this.weekView.inboxData,
            this.weekView.timeBlockCategoryData,
            () => this.weekView.save(),
            (weekKey) => {
                // 未选中任务时点击周格子 → 切到周计划并定位到该周
                this.weekView.currentWeekKey = weekKey;
                this.activeTab = 'week';
                void this.renderContent();
            },
        );
        this.todayView = new TodayView(
            this.app,
            this.weekView.inboxData,
            this.weekView.timeBlockCategoryData,
            () => this.weekView.save(),
        );
        this.swimlaneView = new SwimlaneView(
            this.app,
            this.weekView.inboxData,
            this.weekView.timeBlockCategoryData,
            () => this.weekView.save(),
            () => this.weekView.executions,
        );
    }

    getViewType(): string {
        return VIEW_TYPE_MAIN;
    }

    getDisplayText(): string {
        return t('view.title');
    }

    /** 保存数据（委托给周计划视图） */
    async save() {
        await this.weekView.save();
    }

    async onOpen() {
        const root = this.containerEl.children[1] as HTMLElement;
        root.empty();
        root.addClass('parrot-plan-main');

        // 顶部导航栏（左上角按钮组）
        const nav = root.createDiv({ cls: 'parrot-plan-nav' });
        for (const tab of NAV_TABS) {
            const btn = nav.createEl('button', {
                text: tab.label,
                cls: 'parrot-plan-nav-btn',
            });
            if (tab.id === this.activeTab) btn.addClass('is-active');
            btn.onclick = () => {
                this.activeTab = tab.id;
                void this.renderContent();
            };
        }

        // 内容区
        this.contentRoot = root.createDiv({ cls: 'parrot-plan-content' });
        await this.renderContent();
    }

    /** 根据当前 tab 渲染内容区 */
    private async renderContent() {
        // 刷新导航高亮
        const navBtns = this.containerEl.querySelectorAll('.parrot-plan-nav-btn');
        navBtns.forEach((btn, i) => {
            btn.toggleClass('is-active', NAV_TABS[i].id === this.activeTab);
        });

        this.contentRoot.empty();

        if (this.activeTab === 'week') {
            await this.weekView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'year') {
            await this.yearView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'today') {
            await this.todayView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'swimlane') {
            await this.swimlaneView.renderInto(this.contentRoot);
            return;
        }

        // 其余页面：占位
        const tab = NAV_TABS.find(t => t.id === this.activeTab)!;
        const placeholder = this.contentRoot.createDiv({ cls: 'parrot-plan-placeholder' });
        placeholder.setText(t('nav.placeholder', { name: tab.label }));
    }

    async onClose() {
        this.todayView.destroy();
        this.containerEl.empty();
    }
}
