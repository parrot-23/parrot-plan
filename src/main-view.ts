import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { Plugin } from 'obsidian';

import type { PlanSchemeData } from './shared/plan-data';
import type { PlanCategoryData } from './shared/plan-category-manager';
import type { DayTemplateData } from './shared/template-manager';
import type { InboxData } from './datatypes/domain';
import { WeekScheduleView } from './views/pdca/week-schedule-view';
import type { EventBlock, ExecutionRecord, RunningTask } from './datatypes/domain';
import { YearView } from './views/pdca/year-view';
import { TodayView } from './views/pdca/today-view';
import { CheckView } from './views/pdca/check-view';
import { ImproveView } from './views/pdca/improve-view';
import { WorkbenchView } from './views/workbench/workbench-view';
import { OkrTaskPlanView } from './views/task/okr-task-plan-view';
import { DataView } from './views/task/data-view';
import { AchievementView } from './views/task/achievement-view';
import { ScriptManageView } from './views/task/script-manage-view';
import { SceneView } from './views/task/scene-view';
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
type PrimaryView = 'pdca' | 'task' | 'workbench' | 'gtd';

/** 二级视图（tab）标识 */
type NavTab = 'year' | 'taskPlan' | 'week' | 'today' | 'check' | 'improve' | 'swimlane' | 'workbench' | 'achievement' | 'gtd' | 'okrHome' | 'okrTaskPlan' | 'data' | 'scene' | 'scriptManage' | 'gtdCollect' | 'gtdConfig' | 'gtdClarify' | 'gtdReview' | 'gtdEngage';

/** 一级视图定义（顶部第一行） */
const PRIMARY_VIEWS: { id: PrimaryView; labelKey: 'nav.pdca' | 'nav.task' | 'nav.workbench' | 'nav.gtd' }[] = [
    { id: 'workbench', labelKey: 'nav.workbench' },
    { id: 'task', labelKey: 'nav.task' },
    { id: 'pdca', labelKey: 'nav.pdca' },
    { id: 'gtd', labelKey: 'nav.gtd' },
];

/** 二级视图定义（顶部第二行，按一级视图分组；label 存 i18n key，渲染时再求值） */
const SECONDARY_TABS: Record<PrimaryView, { id: NavTab; labelKey: 'nav.year' | 'nav.taskPlan' | 'nav.week' | 'nav.today' | 'nav.check' | 'nav.improve' | 'nav.projectPicture' | 'nav.workbench' | 'nav.achievement' | 'nav.gtd' | 'nav.task' | 'nav.data' | 'nav.scene' | 'nav.scriptManage' | 'nav.gtdCollect' | 'nav.gtdConfig' | 'nav.gtdClarify' | 'nav.gtdReview' | 'nav.gtdEngage' }[]> = {
    pdca: [
        { id: 'week', labelKey: 'nav.week' },
        { id: 'today', labelKey: 'nav.today' },
        { id: 'check', labelKey: 'nav.check' },
        { id: 'improve', labelKey: 'nav.improve' },
    ],
    task: [
        { id: 'okrTaskPlan', labelKey: 'nav.taskPlan' },
        { id: 'data', labelKey: 'nav.data' },
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
    task: 'okrTaskPlan',
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
    private todayView: TodayView;
    private checkView: CheckView;
    private improveView: ImproveView;
    private workbenchView: WorkbenchView;
    private okrTaskPlanView: OkrTaskPlanView;
    private dataView: DataView;
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
    /** 导航栏容器（用于二级标签行对齐与悬停还原） */
    private navEl?: HTMLElement;
    /** 当前「预览」的一级视图：悬停时展示其二级标签，但不改变内容 */
    private previewPrimary: PrimaryView = 'pdca';
    /** 一级按钮元素映射（用于将二级标签行对齐到所属一级按钮左侧） */
    private primaryBtnEls: Partial<Record<PrimaryView, HTMLElement>> = {};
    /** 一级标签行右侧的「当前二级视图」标题 */
    private secondaryTitleEl?: HTMLElement;
    /** 缓存目录名称（用于帮助弹窗引用缓存图片） */
    private cacheDirName: string;
    /** 一级标签行中的「进行中任务」卡片容器 */
    private runningCardEl?: HTMLElement;
    /** 进行中任务卡片已用时长的刷新定时器（每分钟更新） */
    private runningCardTimer?: number;

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
            () => this.renderRunningTaskCard(),
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
        this.okrTaskPlanView = new OkrTaskPlanView(
            this.app,
            this.weekView.inboxData,
            this.weekView.planCategoryData,
            () => this.weekView.save(),
            this.inboxRepo(),
            () => this.weekView.executions,
        );
        this.dataView = new DataView(
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

    /** 是否启用剧本模式（关闭时隐藏「剧本场景」「剧本管理」二级视图） */
    private isScriptModeEnabled(): boolean {
        return (this.plugin as Plugin & { scriptModeEnabled?: boolean }).scriptModeEnabled === true;
    }

    /** 剧本模式关闭时需要隐藏的二级视图 */
    private static readonly SCRIPT_MODE_TABS: NavTab[] = ['scene', 'scriptManage'];

    /** 当前「预览」一级视图下应展示的二级视图（按剧本模式开关过滤） */
    private visibleSecondaryTabs(): { id: NavTab; labelKey: Parameters<typeof t>[0] }[] {
        const tabs = SECONDARY_TABS[this.previewPrimary];
        if (this.isScriptModeEnabled()) return tabs;
        return tabs.filter(tab => !MainView.SCRIPT_MODE_TABS.includes(tab.id));
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

    /** 外部数据变更后重新渲染当前视图（如 vault 文件移动导致路径更新） */
    async refresh() {
        await this.renderContent();
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
        this.navEl = nav;
        // 悬停预览一级视图：展示其二级标签，但内容不变；移出导航栏后还原
        this.previewPrimary = this.activePrimary;

        // 第一行：一级视图（工作台 / 任务 / PDCA / GTD）
        const primaryRow = nav.createDiv({ cls: 'parrot-plan-nav-primary-row' });
        for (const pv of PRIMARY_VIEWS) {
            const btn = primaryRow.createEl('button', {
                text: t(pv.labelKey),
                cls: 'parrot-plan-nav-primary-btn',
            });
            if (pv.id === this.activePrimary) btn.addClass('is-active');
            this.primaryBtnEls[pv.id] = btn;
            const show = () => {
                this.previewPrimary = pv.id;
                this.applyPrimaryHoverState(pv.id);
                this.setSecondaryVisible(true);
            };
            btn.onmouseenter = show;
            btn.onclick = show;
        }

        // 移出导航栏时，二级标签行完全隐藏，并清除一级按钮悬浮边框
        nav.onmouseleave = () => {
            this.applyPrimaryHoverState(null);
            this.setSecondaryVisible(false);
        };

        // 当前二级视图标题（紧贴一级标签行右侧）
        this.secondaryTitleEl = primaryRow.createDiv({ cls: 'parrot-plan-nav-secondary-title' });

        // 进行中任务卡片（一级标签行右侧，紧邻帮助按钮左侧；无进行中任务时隐藏）
        this.runningCardEl = primaryRow.createDiv({ cls: 'parrot-plan-running-card-wrap' });
        this.renderRunningTaskCard();

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

        // 第二行：当前一级视图下的二级视图（默认隐藏，悬停一级标签时显示）
        this.secondaryRow = nav.createDiv({ cls: 'parrot-plan-nav-secondary-row is-hidden' });
        this.renderSecondaryTabs();

        // 内容区
        this.contentRoot = root.createDiv({ cls: 'parrot-plan-content' });
        await this.renderContent();
    }

    /** 高亮「预览中」的一级按钮：仅加蓝色边框（不改文字/背景） */
    private applyPrimaryHoverState(hovered: PrimaryView | null) {
        for (const pv of PRIMARY_VIEWS) {
            const btn = this.primaryBtnEls[pv.id];
            if (btn) btn.toggleClass('is-hovered', pv.id === hovered);
        }
    }

    /** 显示 / 隐藏二级标签行（显示时重新填充并对齐） */
    private setSecondaryVisible(visible: boolean) {
        if (!this.secondaryRow) return;
        if (visible) {
            this.secondaryRow.removeClass('is-hidden');
            this.renderSecondaryTabs();
        } else {
            this.secondaryRow.addClass('is-hidden');
        }
    }

    /** 重建二级视图 tab 行（切换预览一级视图时调用） */
    private renderSecondaryTabs() {
        if (!this.secondaryRow) return;
        this.secondaryRow.empty();
        for (const tab of this.visibleSecondaryTabs()) {
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
                // 点击二级标签才切换内容，并让内容归属到当前预览的一级视图
                this.activePrimary = this.previewPrimary;
                this.activeTab = tab.id;
                this.lastTabByPrimary[this.activePrimary] = tab.id;
                this.previewPrimary = this.activePrimary;
                this.renderSecondaryTabs();
                void this.renderContent();
            };
        }

        // 面板左边缘对齐第一个一级按钮（工作台），按钮缩进到所属一级按钮左侧，中间留白
        const owner = this.primaryBtnEls[this.previewPrimary];
        const first = this.primaryBtnEls['workbench'];
        if (owner && first && this.navEl) {
            const navLeft = this.navEl.getBoundingClientRect().left;
            const panelLeft = first.getBoundingClientRect().left;
            const ownerLeft = owner.getBoundingClientRect().left;
            this.secondaryRow.style.left = `${Math.max(0, panelLeft - navLeft)}px`;
            this.secondaryRow.style.paddingLeft = `${Math.max(0, ownerLeft - panelLeft)}px`;
        }
    }

    /**
     * 渲染一级标签行右侧的「进行中任务」卡片。
     * 无进行中任务时清空并隐藏；有则显示任务名与已用时长，点击跳转到日执行视图。
     * 同时启动每分钟刷新已用时长的定时器。
     */
    private renderRunningTaskCard(): void {
        const wrap = this.runningCardEl;
        if (!wrap) return;
        wrap.empty();

        // 清理上一次的定时器，避免累积
        if (this.runningCardTimer !== undefined) {
            window.clearInterval(this.runningCardTimer);
            this.runningCardTimer = undefined;
        }

        const running = this.pdcaRepo().runningTask;
        if (!running) {
            wrap.addClass('is-hidden');
            this.renderStatusBarRunningTask();
            return;
        }
        const item = this.weekView.inboxData.items.find(i => i.id === running.inboxId && !i.removed);
        if (!item) {
            wrap.addClass('is-hidden');
            this.renderStatusBarRunningTask();
            return;
        }
        wrap.removeClass('is-hidden');

        const card = wrap.createDiv({ cls: 'parrot-plan-running-card' });
        card.createSpan({ cls: 'parrot-plan-running-card-label', text: t('nav.runningLabel') });
        card.createSpan({ cls: 'parrot-plan-running-card-name', text: item.title });
        const timeEl = card.createSpan({ cls: 'parrot-plan-running-card-time' });

        const updateTime = () => {
            const now = new Date();
            const nowMinutes = now.getHours() * 60 + now.getMinutes();
            const elapsed = Math.max(0, nowMinutes - running.start);
            timeEl.setText(t('nav.runningElapsed', { minutes: String(elapsed) }));
            // 状态栏与卡片同步刷新已用时长
            this.renderStatusBarRunningTask();
        };
        updateTime();
        this.runningCardTimer = window.setInterval(updateTime, 60 * 1000);

        card.onclick = () => {
            // 跳转到 PDCA 一级视图的「日执行」二级视图
            this.lastTabByPrimary[this.activePrimary] = this.activeTab;
            this.activePrimary = 'pdca';
            this.activeTab = 'today';
            this.previewPrimary = 'pdca';
            this.lastTabByPrimary['pdca'] = 'today';
            this.renderSecondaryTabs();
            void this.renderContent();
        };
    }

    /**
     * 渲染状态栏中的「进行中任务」：显示「任务名称：时长」。
     * 状态栏元素由插件创建（插件加载即存在，不依赖本视图是否打开），这里只触发插件刷新。
     */
    private renderStatusBarRunningTask(): void {
        (this.plugin as Plugin & { renderStatusBarRunningTask?: () => void })
            .renderStatusBarRunningTask?.();
    }

    /** 打开主视图并切换到「日执行」二级视图（状态栏点击用） */
    async openTodayTab(): Promise<void> {
        this.lastTabByPrimary[this.activePrimary] = this.activeTab;
        this.activePrimary = 'pdca';
        this.activeTab = 'today';
        this.previewPrimary = 'pdca';
        this.lastTabByPrimary['pdca'] = 'today';
        this.renderSecondaryTabs();
        await this.renderContent();
    }

    /** 更新一级标签行右侧的「当前二级视图」标题 */
    private renderSecondaryTitle() {
        if (!this.secondaryTitleEl) return;
        let label = '';
        if (this.activeTab === 'workbench') {
            label = this.workbenchView.getActiveLayoutName();
        } else {
            const tab = SECONDARY_TABS[this.activePrimary]?.find(t => t.id === this.activeTab);
            if (tab) label = t(tab.labelKey);
        }
        this.secondaryTitleEl.setText(label);
    }

    /** 根据当前 tab 渲染内容区 */
    private async renderContent() {
        // 剧本模式关闭时，若当前停留在被隐藏的二级视图，回退到默认二级视图
        if (!this.isScriptModeEnabled() && MainView.SCRIPT_MODE_TABS.includes(this.activeTab)) {
            this.activeTab = DEFAULT_TAB[this.activePrimary];
            this.lastTabByPrimary[this.activePrimary] = this.activeTab;
            this.renderSecondaryTabs();
        }
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
        this.renderSecondaryTitle();

        this.contentRoot.empty();
        // 清除上一次视图残留在共享容器上的视图类，避免多个视图样式叠加导致布局错乱
        this.contentRoot.removeClass('today-view', 'year-view', 'task-plan-view', 'swimlane-view', 'workbench-view', 'check-view', 'improve-view', 'achievement-view', 'script-manage-view', 'scene-view', 'gtd-collect-view', 'gtd-config-view', 'gtd-clarify-view', 'gtd-review-view');

        // 从其他页面进入日执行视图时，始终回到今天
        if (this.activeTab === 'today' && this.prevTab !== 'today') {
            this.todayView.resetToToday();
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

        if (this.activeTab === 'okrTaskPlan') {
            await this.okrTaskPlanView.renderInto(this.contentRoot);
            return;
        }

        if (this.activeTab === 'data') {
            await this.dataView.renderInto(this.contentRoot);
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

        if (this.activeTab === 'workbench') {
            await this.workbenchView.renderInto(this.contentRoot);
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
        // 清理进行中任务卡片的刷新定时器
        if (this.runningCardTimer !== undefined) {
            window.clearInterval(this.runningCardTimer);
            this.runningCardTimer = undefined;
        }
        // 状态栏元素由插件持有（关闭视图不销毁），无需在此处理
        this.containerEl.empty();
    }
}
