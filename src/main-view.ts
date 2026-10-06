import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { Plugin } from 'obsidian';

import type { WeekRangeData, RangeSchemeData } from './views/week-view/timeblock-data';
import type { TimeBlockCategoryData } from './views/week-view/timeblock-category-manager';
import type { DayTemplateData } from './views/week-view/template-manager';
import type { InboxData } from './datatypes/domain';
import { WeekScheduleView } from './views/week-view/week-schedule-view';
import type { EventBlock, ExecutionRecord } from './datatypes/domain';
import { YearView } from './views/year-view';
import { TodayView } from './views/today-view';
import { SwimlaneView } from './views/swimlane-view';
import { WorkbenchView } from './views/workbench/workbench-view';
import type { WorkbenchData } from './datatypes/card';
import { t } from './i18n';
import { log } from './shared/logger';

export const VIEW_TYPE_MAIN = 'parrot-plan-main-view';

/** 主导航 tab 标识 */
type NavTab = 'year' | 'week' | 'today' | 'swimlane' | 'workbench' | 'achievement';

/** 主导航按钮定义（label 存 i18n key，渲染时再求值，避免模块加载时语言未初始化） */
const NAV_TABS: { id: NavTab; labelKey: 'nav.year' | 'nav.week' | 'nav.today' | 'nav.swimlane' | 'nav.workbench' | 'nav.achievement' }[] = [
    { id: 'year', labelKey: 'nav.year' },
    { id: 'week', labelKey: 'nav.week' },
    { id: 'today', labelKey: 'nav.today' },
    { id: 'swimlane', labelKey: 'nav.swimlane' },
    { id: 'workbench', labelKey: 'nav.workbench' },
    { id: 'achievement', labelKey: 'nav.achievement' },
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
    private workbenchView: WorkbenchView;
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
        plannedWeeks: string[],
        workbenchData: WorkbenchData,
    ) {
        super(leaf);
        this.plugin = plugin;
        log('MainView 构造', {
            events: events.length,
            executions: executions.length,
        });
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
            plannedWeeks,
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
            () => this.weekView.plannedWeeks,
        );
        this.todayView = new TodayView(
            this.app,
            this.weekView.inboxData,
            this.weekView.timeBlockCategoryData,
            () => this.weekView.save(),
            () => this.weekView.events,
            () => this.weekView.executions,
        );
        this.swimlaneView = new SwimlaneView(
            this.app,
            this.weekView.inboxData,
            this.weekView.timeBlockCategoryData,
            () => this.weekView.save(),
            () => this.weekView.executions,
        );
        this.workbenchView = new WorkbenchView(
            this.app,
            workbenchData,
            () => this.weekView.save(),
            () => this.weekView.events,
            () => this.weekView.executions,
            () => this.weekView.inboxData.items,
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

    /** 清空数据后重置视图 */
    async resetData() {
        this.weekView.resetData();
        await this.renderContent();
    }

    async onOpen() {
        const root = this.containerEl.children[1] as HTMLElement;
        root.empty();
        root.addClass('parrot-plan-main');

        // 顶部导航栏（左上角按钮组）
        const nav = root.createDiv({ cls: 'parrot-plan-nav' });
        for (const tab of NAV_TABS) {
            const btn = nav.createEl('button', {
                text: t(tab.labelKey),
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
        log('MainView.renderContent', {
            tab: this.activeTab,
            events: this.weekView.events.length,
            executions: this.weekView.executions.length,
        });
        // 刷新导航高亮
        const navBtns = this.containerEl.querySelectorAll('.parrot-plan-nav-btn');
        navBtns.forEach((btn, i) => {
            btn.toggleClass('is-active', NAV_TABS[i].id === this.activeTab);
        });

        this.contentRoot.empty();
        // 清除上一次视图残留在共享容器上的视图类，避免多个视图样式叠加导致布局错乱
        this.contentRoot.removeClass('today-view', 'year-view', 'swimlane-view', 'workbench-view');

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

        if (this.activeTab === 'workbench') {
            await this.workbenchView.renderInto(this.contentRoot);
            return;
        }

        // 其余页面：占位
        const tab = NAV_TABS.find(t => t.id === this.activeTab)!;
        const placeholder = this.contentRoot.createDiv({ cls: 'parrot-plan-placeholder' });
        placeholder.setText(t('nav.placeholder', { name: t(tab.labelKey) }));
    }

    async onClose() {
        this.todayView.destroy();
        this.containerEl.empty();
    }
}
