import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { Plugin } from 'obsidian';

import type { WeekRangeData, RangeSchemeData } from './shared/timeblock-data';
import type { TimeBlockCategoryData } from './shared/timeblock-category-manager';
import type { DayTemplateData } from './shared/template-manager';
import type { InboxData } from './datatypes/domain';
import { WeekScheduleView } from './views/pdca/week-view/week-schedule-view';
import type { EventBlock, ExecutionRecord } from './datatypes/domain';
import { YearView } from './views/pdca/year-view';
import { TaskPlanView } from './views/pdca/task-plan-view';
import { TodayView } from './views/pdca/today-view';
import { CheckView } from './views/pdca/check-view';
import { ImproveView } from './views/pdca/improve-view';
import { SwimlaneView } from './views/pdca/projectpicture-view';
import { WorkbenchView } from './views/pdca/workbench/workbench-view';
import { OkrView } from './views/okr/okr-view';
import { OkrTaskPlanView } from './views/okr/okr-task-plan-view';
import { AchievementView } from './views/story/achievement-view';
import { ScriptManageView } from './views/story/script-manage-view';
import { SceneView } from './views/story/scene-view';
import { GtdCollectView } from './views/gtd/collect-view';
import { GtdOrganizeView } from './views/gtd/organize-view';
import type { WorkbenchData } from './datatypes/card';
import type { GtdData } from './datatypes/gtd';
import { t } from './i18n';
import { log } from './shared/logger';
import { HelpModal } from './helper/help-modal';

export const VIEW_TYPE_MAIN = 'parrot-plan-main-view';

/** 一级视图标识 */
type PrimaryView = 'pdca' | 'okr' | 'workbench' | 'story' | 'gtd';

/** 二级视图（tab）标识 */
type NavTab = 'year' | 'taskPlan' | 'week' | 'today' | 'check' | 'improve' | 'swimlane' | 'workbench' | 'achievement' | 'gtd' | 'okrHome' | 'okrTaskPlan' | 'scene' | 'scriptManage' | 'gtdCollect' | 'gtdOrganize' | 'gtdClarify' | 'gtdReview' | 'gtdEngage';

/** 一级视图定义（顶部第一行） */
const PRIMARY_VIEWS: { id: PrimaryView; labelKey: 'nav.pdca' | 'nav.okr' | 'nav.workbench' | 'nav.story' | 'nav.gtd' }[] = [
    { id: 'okr', labelKey: 'nav.okr' },
    { id: 'pdca', labelKey: 'nav.pdca' },
    { id: 'workbench', labelKey: 'nav.workbench' },
    { id: 'story', labelKey: 'nav.story' },
    { id: 'gtd', labelKey: 'nav.gtd' },
];

/** 二级视图定义（顶部第二行，按一级视图分组；label 存 i18n key，渲染时再求值） */
const SECONDARY_TABS: Record<PrimaryView, { id: NavTab; labelKey: 'nav.year' | 'nav.taskPlan' | 'nav.week' | 'nav.today' | 'nav.check' | 'nav.improve' | 'nav.projectPicture' | 'nav.workbench' | 'nav.achievement' | 'nav.gtd' | 'nav.okr' | 'nav.scene' | 'nav.scriptManage' | 'nav.gtdCollect' | 'nav.gtdOrganize' | 'nav.gtdClarify' | 'nav.gtdReview' | 'nav.gtdEngage' }[]> = {
    pdca: [
        { id: 'week', labelKey: 'nav.week' },
        { id: 'today', labelKey: 'nav.today' },
        { id: 'check', labelKey: 'nav.check' },
        { id: 'improve', labelKey: 'nav.improve' },
    ],
    okr: [
        { id: 'okrTaskPlan', labelKey: 'nav.taskPlan' },
    ],
    workbench: [
        { id: 'workbench', labelKey: 'nav.workbench' },
    ],
    story: [
        { id: 'achievement', labelKey: 'nav.achievement' },
        { id: 'scene', labelKey: 'nav.scene' },
        { id: 'scriptManage', labelKey: 'nav.scriptManage' },
    ],
    gtd: [
        { id: 'gtdCollect', labelKey: 'nav.gtdCollect' },
        { id: 'gtdOrganize', labelKey: 'nav.gtdOrganize' },
        { id: 'gtdClarify', labelKey: 'nav.gtdClarify' },
        { id: 'gtdReview', labelKey: 'nav.gtdReview' },
        { id: 'gtdEngage', labelKey: 'nav.gtdEngage' },
    ],
};

/** 各一级视图的默认二级视图（切换一级视图时激活） */
const DEFAULT_TAB: Record<PrimaryView, NavTab> = {
    pdca: 'today',
    okr: 'okrTaskPlan',
    workbench: 'workbench',
    story: 'achievement',
    gtd: 'gtdCollect',
};

/**
 * 主视图：作为顶层 tab 容器，左上角按钮组切换不同页面。
 * 其中「周计划」复用 WeekScheduleView 的渲染逻辑。
 */
export class MainView extends ItemView {
    plugin: Plugin;
    private weekView: WeekScheduleView;
    private yearView: YearView;
    private taskPlanView: TaskPlanView;
    private todayView: TodayView;
    private checkView: CheckView;
    private improveView: ImproveView;
    private swimlaneView: SwimlaneView;
    private workbenchView: WorkbenchView;
    private okrView: OkrView;
    private okrTaskPlanView: OkrTaskPlanView;
    private achievementView: AchievementView;
    private scriptManageView: ScriptManageView;
    private sceneView: SceneView;
    private gtdCollectView: GtdCollectView;
    private gtdOrganizeView: GtdOrganizeView;
    /** 当前一级视图 */
    private activePrimary: PrimaryView = 'pdca';
    /** 当前二级视图（tab） */
    private activeTab: NavTab = 'today';
    /** 记录每个一级视图上次打开的二级视图（切换一级视图时恢复） */
    private lastTabByPrimary: Partial<Record<PrimaryView, NavTab>> = {};
    /** 上一次渲染的 tab（用于判断是否「进入」周计划视图） */
    private prevTab: NavTab | undefined;
    private contentRoot!: HTMLElement;
    /** 二级视图 tab 行容器（切换一级视图时重建） */
    private secondaryRow?: HTMLElement;
    /** 缓存目录名称（用于帮助弹窗引用缓存图片） */
    private cacheDirName: string;

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
        gtdData: GtdData,
        cacheDirName: string,
        executingEventId?: string,
    ) {
        super(leaf);
        this.plugin = plugin;
        this.cacheDirName = cacheDirName;
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
            undefined,
            () => this.weekView.plannedWeeks,
        );
        this.taskPlanView = new TaskPlanView(
            this.app,
            this.weekView.inboxData,
            this.weekView.timeBlockCategoryData,
            () => this.weekView.save(),
        );
        this.todayView = new TodayView(
            this.app,
            this.weekView.inboxData,
            this.weekView.timeBlockCategoryData,
            () => this.weekView.save(),
            () => this.weekView.events,
            () => this.weekView.executions,
            executingEventId,
            (id) => {
                // 写回插件数据源，随 saveAll 一起持久化
                const p = this.plugin as Plugin & { data?: { executingEventId?: string } };
                if (p.data) p.data.executingEventId = id;
            },
            undefined,
            () => this.weekView.getSchemeDays(),
        );
        this.checkView = new CheckView(
            this.app,
            this.weekView.inboxData,
            this.weekView.timeBlockCategoryData,
            () => this.weekView.events,
            () => this.weekView.executions,
        );
        this.improveView = new ImproveView(
            this.app,
            this.weekView.inboxData,
            this.weekView.timeBlockCategoryData,
            () => this.weekView.events,
            () => this.weekView.executions,
        );
        this.swimlaneView = new SwimlaneView(
            this.app,
            this.weekView.inboxData,
            this.weekView.timeBlockCategoryData,
            () => this.weekView.save(),
            () => this.weekView.executions,
            () => this.weekView.events,
        );
        this.workbenchView = new WorkbenchView(
            this.app,
            workbenchData,
            () => this.weekView.save(),
            () => this.weekView.events,
            () => this.weekView.executions,
            () => this.weekView.inboxData.items,
        );
        this.okrView = new OkrView(this.app);
        this.okrTaskPlanView = new OkrTaskPlanView(
            this.app,
            this.weekView.inboxData,
            this.weekView.timeBlockCategoryData,
            () => this.weekView.save(),
        );
        this.achievementView = new AchievementView(
            this.app,
            () => this.weekView.events,
            () => this.weekView.executions,
            () => this.weekView.inboxData.items,
        );
        this.scriptManageView = new ScriptManageView(this.app);
        this.sceneView = new SceneView(
            this.app,
            this.weekView.timeBlockCategoryData,
            () => this.weekView.events,
        );
        this.gtdCollectView = new GtdCollectView(
            this.app,
            gtdData,
            () => this.weekView.save(),
        );
        this.gtdOrganizeView = new GtdOrganizeView(
            this.app,
            gtdData,
            () => this.weekView.save(),
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

        // 顶部导航栏：第一行一级视图，第二行二级视图
        const nav = root.createDiv({ cls: 'parrot-plan-nav' });

        // 第一行：一级视图（任务OKR / PDCA / 工作台 / 故事 / GTD）
        const primaryRow = nav.createDiv({ cls: 'parrot-plan-nav-primary-row' });
        for (const pv of PRIMARY_VIEWS) {
            const btn = primaryRow.createEl('button', {
                text: t(pv.labelKey),
                cls: 'parrot-plan-nav-primary-btn',
            });
            if (pv.id === this.activePrimary) btn.addClass('is-active');
            btn.onclick = () => {
                if (this.activePrimary === pv.id) return;
                // 记录当前一级视图正在查看的二级视图
                this.lastTabByPrimary[this.activePrimary] = this.activeTab;
                this.activePrimary = pv.id;
                // 恢复该一级视图上次打开的二级视图（无记录时用默认值兜底）
                this.activeTab = this.lastTabByPrimary[pv.id] ?? DEFAULT_TAB[pv.id];
                // 重建二级视图 tab 行
                this.renderSecondaryTabs();
                void this.renderContent();
            };
        }

        // 帮助按钮（第一行最右侧）
        const helpBtn = primaryRow.createEl('button', {
            text: '?',
            cls: 'parrot-plan-nav-help-btn',
            attr: { 'aria-label': t('help.title') },
        });
        helpBtn.onclick = () => {
            const plugin = this.plugin as Plugin & {
                saveHelpDismissed?: (dismissed: boolean) => Promise<void>;
            };
            new HelpModal(this.app, this.cacheDirName, (dismissed) => {
                void plugin.saveHelpDismissed?.(dismissed);
            }).open();
        };

        // 第二行：当前一级视图下的二级视图
        this.secondaryRow = nav.createDiv({ cls: 'parrot-plan-nav-secondary-row' });
        this.renderSecondaryTabs();

        // 内容区
        this.contentRoot = root.createDiv({ cls: 'parrot-plan-content' });
        await this.renderContent();
    }

    /** 重建二级视图 tab 行（切换一级视图时调用） */
    private renderSecondaryTabs() {
        if (!this.secondaryRow) return;
        this.secondaryRow.empty();
        for (const tab of SECONDARY_TABS[this.activePrimary]) {
            const btn = this.secondaryRow.createEl('button', {
                text: t(tab.labelKey),
                cls: 'parrot-plan-nav-btn',
                attr: { 'data-tab': tab.id },
            });
            if (tab.id === this.activeTab) btn.addClass('is-active');
            btn.onclick = () => {
                this.activeTab = tab.id;
                // 记录当前一级视图正在查看的二级视图
                this.lastTabByPrimary[this.activePrimary] = tab.id;
                void this.renderContent();
            };
        }
    }

    /** 根据当前 tab 渲染内容区 */
    private async renderContent() {
        log('MainView.renderContent', {
            tab: this.activeTab,
            events: this.weekView.events.length,
            executions: this.weekView.executions.length,
        });
        // 刷新导航高亮：一级视图
        const primaryBtns = this.containerEl.querySelectorAll('.parrot-plan-nav-primary-btn');
        primaryBtns.forEach((btn, i) => {
            btn.toggleClass('is-active', PRIMARY_VIEWS[i].id === this.activePrimary);
        });
        // 刷新导航高亮：二级视图
        const secondaryBtns = this.containerEl.querySelectorAll('.parrot-plan-nav-btn');
        secondaryBtns.forEach((btn) => {
            const tabId = btn.getAttribute('data-tab');
            btn.toggleClass('is-active', tabId === this.activeTab);
        });

        this.contentRoot.empty();
        // 清除上一次视图残留在共享容器上的视图类，避免多个视图样式叠加导致布局错乱
        this.contentRoot.removeClass('today-view', 'year-view', 'task-plan-view', 'swimlane-view', 'workbench-view', 'check-view', 'improve-view', 'achievement-view', 'script-manage-view', 'scene-view', 'gtd-collect-view', 'gtd-organize-view');

        // 从其他页面进入周计划视图时，若未选中任务则默认激活「周目标」
        if (this.activeTab === 'week' && this.prevTab !== 'week' && !this.weekView.inboxData.selectedId) {
            this.weekView.inboxData.weekGoalOnly = true;
        }
        this.prevTab = this.activeTab;

        if (this.activeTab === 'week') {
            await this.weekView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'year') {
            await this.yearView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'taskPlan') {
            await this.taskPlanView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'okrTaskPlan') {
            await this.okrTaskPlanView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'today') {
            await this.todayView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'check') {
            await this.checkView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'improve') {
            await this.improveView.renderInto(this.contentRoot);
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

        if (this.activeTab === 'okrHome') {
            await this.okrView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'achievement') {
            await this.achievementView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'scriptManage') {
            await this.scriptManageView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'scene') {
            await this.sceneView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'gtdCollect') {
            await this.gtdCollectView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'gtdOrganize') {
            await this.gtdOrganizeView.renderInto(this.contentRoot);
            return;
        }

        // 其余页面：占位
        const tab = SECONDARY_TABS[this.activePrimary].find(t => t.id === this.activeTab);
        const placeholder = this.contentRoot.createDiv({ cls: 'parrot-plan-placeholder' });
        placeholder.setText(t('nav.placeholder', { name: tab ? t(tab.labelKey) : '' }));
    }

    async onClose() {
        this.todayView.destroy();
        this.containerEl.empty();
    }
}
