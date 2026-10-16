import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { Plugin } from 'obsidian';

import type { PlanSchemeData } from './shared/plan-data';
import type { PlanCategoryData } from './shared/plan-category-manager';
import type { DayTemplateData } from './shared/template-manager';
import type { InboxData } from './datatypes/domain';
import { WeekScheduleView } from './views/pdca/week-schedule-view';
import type { EventBlock, ExecutionRecord, RunningTask } from './datatypes/domain';
import { YearView } from './views/pdca/year-view';
import { TaskPlanView } from './views/pdca/task-plan-view';
import { TodayView } from './views/pdca/today-view';
import { CheckView } from './views/pdca/check-view';
import { ImproveView } from './views/pdca/improve-view';
import { SwimlaneView } from './views/pdca/projectpicture-view';
import { WorkbenchView } from './views/workbench/workbench-view';
import { OkrView } from './views/okr/okr-view';
import { OkrTaskPlanView } from './views/okr/okr-task-plan-view';
import { AchievementView } from './views/okr/achievement-view';
import { ScriptManageView } from './views/okr/script-manage-view';
import { SceneView } from './views/okr/scene-view';
import { GtdCollectView } from './views/gtd/collect-view';
import { GtdConfigView } from './views/gtd/organize-view';
import { GtdClarifyView } from './views/gtd/clarify-view';
import { GtdReviewView } from './views/gtd/review-view';
import type { WorkbenchData } from './datatypes/card';
import type { GtdData } from './datatypes/gtd';
import type { GtdRepo } from './repos/gtd-repo';
import type { PdcaRepo } from './repos/pdca-repo';
import type { WorkbenchRepo } from './repos/workbench-repo';
import type { InboxRepo } from './repos/inbox-repo';
import type { CategoryRepo } from './repos/category-repo';
import type { TemplateRepo } from './repos/template-repo';
import type { PlanSchemeRepo } from './repos/plan-scheme-repo';
import { t } from './i18n';
import { log } from './shared/logger';
import { HelpModal } from './helper/help-modal';

export const VIEW_TYPE_MAIN = 'parrot-plan-main-view';

/** 一级视图标识 */
type PrimaryView = 'pdca' | 'okr' | 'workbench' | 'gtd';

/** 二级视图（tab）标识 */
type NavTab = 'year' | 'taskPlan' | 'week' | 'today' | 'check' | 'improve' | 'swimlane' | 'workbench' | 'achievement' | 'gtd' | 'okrHome' | 'okrTaskPlan' | 'scene' | 'scriptManage' | 'gtdCollect' | 'gtdConfig' | 'gtdClarify' | 'gtdReview' | 'gtdEngage';

/** 一级视图定义（顶部第一行） */
const PRIMARY_VIEWS: { id: PrimaryView; labelKey: 'nav.pdca' | 'nav.okr' | 'nav.workbench' | 'nav.gtd' }[] = [
    { id: 'workbench', labelKey: 'nav.workbench' },
    { id: 'okr', labelKey: 'nav.okr' },
    { id: 'pdca', labelKey: 'nav.pdca' },
    { id: 'gtd', labelKey: 'nav.gtd' },
];

/** 二级视图定义（顶部第二行，按一级视图分组；label 存 i18n key，渲染时再求值） */
const SECONDARY_TABS: Record<PrimaryView, { id: NavTab; labelKey: 'nav.year' | 'nav.taskPlan' | 'nav.week' | 'nav.today' | 'nav.check' | 'nav.improve' | 'nav.projectPicture' | 'nav.workbench' | 'nav.achievement' | 'nav.gtd' | 'nav.okr' | 'nav.scene' | 'nav.scriptManage' | 'nav.gtdCollect' | 'nav.gtdConfig' | 'nav.gtdClarify' | 'nav.gtdReview' | 'nav.gtdEngage' }[]> = {
    pdca: [
        { id: 'week', labelKey: 'nav.week' },
        { id: 'today', labelKey: 'nav.today' },
        { id: 'check', labelKey: 'nav.check' },
        { id: 'improve', labelKey: 'nav.improve' },
    ],
    okr: [
        { id: 'okrTaskPlan', labelKey: 'nav.taskPlan' },
        { id: 'achievement', labelKey: 'nav.achievement' },
        { id: 'scene', labelKey: 'nav.scene' },
        { id: 'scriptManage', labelKey: 'nav.scriptManage' },
    ],
    workbench: [
        { id: 'workbench', labelKey: 'nav.workbench' },
    ],
    gtd: [
        { id: 'gtdCollect', labelKey: 'nav.gtdCollect' },
        { id: 'gtdClarify', labelKey: 'nav.gtdClarify' },
        { id: 'gtdReview', labelKey: 'nav.gtdReview' },
        { id: 'gtdConfig', labelKey: 'nav.gtdConfig' },
    ],
};

/** 各一级视图的默认二级视图（切换一级视图时激活） */
const DEFAULT_TAB: Record<PrimaryView, NavTab> = {
    pdca: 'today',
    okr: 'okrTaskPlan',
    workbench: 'workbench',
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
    private gtdConfigView: GtdConfigView;
    private gtdClarifyView: GtdClarifyView;
    private gtdReviewView: GtdReviewView;
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
        templateData: DayTemplateData,
        categoryData: PlanCategoryData,
        events: EventBlock[],
        executions: ExecutionRecord[],
        inboxData: InboxData,
        planSchemeData: PlanSchemeData,
        plannedWeeks: string[],
        workbenchData: WorkbenchData,
        gtdData: GtdData,
        cacheDirName: string,
        executingEventId?: string,
        runningTask?: RunningTask,
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
            templateData,
            categoryData,
            events,
            executions,
            inboxData,
            planSchemeData,
            plannedWeeks,
        );
        this.yearView = new YearView(
            this.app,
            this.weekView.inboxData,
            this.weekView.planCategoryData,
            () => this.weekView.save(),
            undefined,
            () => this.weekView.plannedWeeks,
            this.inboxRepo(),
        );
        this.taskPlanView = new TaskPlanView(
            this.app,
            this.weekView.inboxData,
            this.weekView.planCategoryData,
            () => this.weekView.save(),
            this.inboxRepo(),
        );
        this.todayView = new TodayView(
            this.app,
            this.weekView.inboxData,
            this.weekView.planCategoryData,
            () => this.weekView.save(),
            () => this.weekView.events,
            () => this.weekView.executions,
            this.pdcaRepo(),
            executingEventId,
            undefined,
            () => this.weekView.getPlanSchemeDays(),
            runningTask,
            this.inboxRepo(),
        );
        this.checkView = new CheckView(
            this.app,
            this.weekView.inboxData,
            this.weekView.planCategoryData,
            () => this.weekView.events,
            () => this.weekView.executions,
            () => this.weekView.getPlanSchemeDays(),
        );
        this.improveView = new ImproveView(
            this.app,
            this.weekView.inboxData,
            this.weekView.planCategoryData,
            () => this.weekView.events,
            () => this.weekView.executions,
            this.pdcaRepo(),
            () => this.weekView.save(),
            this.inboxRepo(),
        );
        this.swimlaneView = new SwimlaneView(
            this.app,
            this.weekView.inboxData,
            this.weekView.planCategoryData,
            () => this.weekView.save(),
            () => this.weekView.executions,
            () => this.weekView.events,
            this.inboxRepo(),
        );
        this.workbenchView = new WorkbenchView(
            this.app,
            workbenchData,
            this.workbenchRepo(),
            () => this.weekView.save(),
            () => this.weekView.events,
            () => this.weekView.executions,
            () => this.weekView.inboxData.items,
            async (content: string) => {
                this.gtdRepo().addItem(content);
                await this.weekView.save();
            },
            this.gtdRepo(),
        );
        this.okrView = new OkrView(this.app);
        this.okrTaskPlanView = new OkrTaskPlanView(
            this.app,
            this.weekView.inboxData,
            this.weekView.planCategoryData,
            () => this.weekView.save(),
            this.inboxRepo(),
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
            this.weekView.planCategoryData,
            () => this.weekView.events,
        );
        this.gtdCollectView = new GtdCollectView(
            this.app,
            this.gtdRepo(),
            () => this.weekView.save(),
        );
        this.gtdConfigView = new GtdConfigView(
            this.app,
            this.gtdRepo(),
            () => this.weekView.save(),
        );
        this.gtdClarifyView = new GtdClarifyView(
            this.app,
            this.gtdRepo(),
            this.weekView.inboxData,
            this.weekView.planCategoryData,
            () => this.weekView.save(),
            this.inboxRepo(),
        );
        this.gtdReviewView = new GtdReviewView(this.app, this.gtdRepo());
    }

    /** 从插件实例获取 GTD 领域仓库 */
    private gtdRepo(): GtdRepo {
        return (this.plugin as Plugin & { gtdRepo: GtdRepo }).gtdRepo;
    }

    /** 从插件实例获取 PDCA 领域仓库 */
    private pdcaRepo(): PdcaRepo {
        return (this.plugin as Plugin & { pdcaRepo: PdcaRepo }).pdcaRepo;
    }

    /** 从插件实例获取工作台领域仓库 */
    private workbenchRepo(): WorkbenchRepo {
        return (this.plugin as Plugin & { workbenchRepo: WorkbenchRepo }).workbenchRepo;
    }

    /** 从插件实例获取收集盒领域仓库 */
    private inboxRepo(): InboxRepo {
        return (this.plugin as Plugin & { inboxRepo: InboxRepo }).inboxRepo;
    }

    /** 从插件实例获取分类领域仓库 */
    private categoryRepo(): CategoryRepo {
        return (this.plugin as Plugin & { categoryRepo: CategoryRepo }).categoryRepo;
    }

    /** 从插件实例获取日模板领域仓库 */
    private templateRepo(): TemplateRepo {
        return (this.plugin as Plugin & { templateRepo: TemplateRepo }).templateRepo;
    }

    /** 从插件实例获取时间计划方案领域仓库 */
    private planSchemeRepo(): PlanSchemeRepo {
        return (this.plugin as Plugin & { planSchemeRepo: PlanSchemeRepo }).planSchemeRepo;
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

        // 第一行：一级视图（工作台 / 任务OKR / PDCA / GTD）
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
            // 工作台二级视图：标签显示当前激活布局的名称（与布局管理保持一致）
            const label = tab.id === 'workbench'
                ? this.workbenchView.getActiveLayoutName()
                : t(tab.labelKey);
            const btn = this.secondaryRow.createEl('button', {
                text: label,
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
        this.contentRoot.removeClass('today-view', 'year-view', 'task-plan-view', 'swimlane-view', 'workbench-view', 'check-view', 'improve-view', 'achievement-view', 'script-manage-view', 'scene-view', 'gtd-collect-view', 'gtd-config-view', 'gtd-clarify-view', 'gtd-review-view');

        // 从其他页面进入周计划视图时，若未选中任务则默认激活「周目标」
        if (this.activeTab === 'week' && this.prevTab !== 'week' && !this.weekView.inboxData.selectedId) {
            this.inboxRepo().data.weekGoalOnly = true;
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

        if (this.activeTab === 'gtdConfig') {
            await this.gtdConfigView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'gtdClarify') {
            await this.gtdClarifyView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'gtdReview') {
            await this.gtdReviewView.renderInto(this.contentRoot);
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
