import { App, Modal, Notice, Plugin, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';

import type { WeekRangeData, RangeSchemeData } from './src/views/week-view/timeblock-data';
import { getCurrentWeekKey, ensureDefaultScheme } from './src/views/week-view/timeblock-data';
import type { TimeBlockCategoryData } from './src/views/week-view/timeblock-category-manager';
import { ensureUncategorizedCategory } from './src/views/week-view/timeblock-category-manager';
import type { DayTemplateData } from './src/views/week-view/template-manager';

import { DEFAULT_WEEK_RANGE } from './src/views/week-view/timeblock-data';
import type { EventBlock, ExecutionRecord } from './src/datatypes/domain';
import { DEFAULT_INBOX_DATA, type InboxData } from './src/datatypes/domain';
import { VIEW_TYPE_MAIN, MainView } from './src/main-view';
import { defaultWorkbenchData, type WorkbenchData } from './src/datatypes/card';
import { initI18n, t, getLangDebugInfo } from './src/i18n';
import { initLogger, log } from './src/shared/logger';
import { downloadImageToCache } from './src/helper/cache-image';
import { HelpModal } from './src/helper/help-modal';

/** 缓存目录默认名称 */
const DEFAULT_CACHE_DIR_NAME = 'parrotPlanCache';

export default class ParrotPlanPlugin extends Plugin {
    /**
     * 插件持有的唯一数据源。
     * 视图重建（registerView 工厂再次调用）时从这里读取最新数据，
     * 避免用 onload 时的旧快照导致内存中的新数据丢失。
     */
    data: {
        weekRange: WeekRangeData;
        templateData: DayTemplateData;
        categoryData: TimeBlockCategoryData;
        events: EventBlock[];
        executions: ExecutionRecord[];
        inboxData: InboxData;
        schemeData: RangeSchemeData;
        /** 已标记为「已制定周计划」的周键列表（如 ["2026-W41"]） */
        plannedWeeks: string[];
        /** 工作台卡片数据 */
        workbench: WorkbenchData;
    } | null = null;

    /** 缓存目录名称（随主数据一起持久化） */
    cacheDirName = DEFAULT_CACHE_DIR_NAME;

    /** 是否启用缓存（随主数据一起持久化） */
    cacheEnabled = true;

    /** 是否已勾选「不再提示」帮助弹窗（随主数据一起持久化） */
    helpDismissed = false;

    /**
     * 唯一的数据保存出口：把插件持有的全部数据一次性写回。
     * 所有视图与设置项都通过此方法保存，避免「全量覆盖」与「合并写回」两套逻辑并存
     * 导致字段互相覆盖（例如周计划视图保存时抹掉 cacheDirName 等设置字段）。
     */
    async saveAll(): Promise<void> {
        const d = this.data;
        if (!d) return;
        await this.saveData({
            version: 1,
            days: d.weekRange.days,
            weeks: d.weekRange.weeks,
            dayTemplateData: d.templateData,
            timeBlockCategoryData: d.categoryData,
            schemeData: d.schemeData,
            events: d.events,
            executions: d.executions,
            inboxData: d.inboxData,
            plannedWeeks: d.plannedWeeks,
            workbench: d.workbench,
            cacheDirName: this.cacheDirName,
            cacheEnabled: this.cacheEnabled,
            helpDismissed: this.helpDismissed,
        });
    }

    /** 保存缓存目录名称 */
    async saveCacheDirName(name: string): Promise<void> {
        this.cacheDirName = name;
        await this.saveAll();
    }

    /** 保存是否启用缓存 */
    async saveCacheEnabled(enabled: boolean): Promise<void> {
        this.cacheEnabled = enabled;
        await this.saveAll();
    }

    /** 保存「不再提示」帮助弹窗标记 */
    async saveHelpDismissed(dismissed: boolean): Promise<void> {
        this.helpDismissed = dismissed;
        await this.saveAll();
    }

    async onload() {
        // 初始化 i18n（跟随 Obsidian 界面语言）
        initI18n();

        // 初始化日志（清空上一次的日志内容）
        await initLogger(this.app);
        log('插件 onload 开始');
        // 记录语言检测的原始信息，便于排查 i18n 显示问题
        log('i18n 语言检测:', getLangDebugInfo());
        log('i18n 视图标题:', t('view.title'));

        // 读取数据
        const rawData: unknown = await this.loadData();
        let savedData: Record<string, unknown> =
            rawData && typeof rawData === 'object' ? rawData as Record<string, unknown> : {};

        // 读取缓存目录名称（随主数据一起存储，兼容旧数据：默认值）
        this.cacheDirName = typeof savedData.cacheDirName === 'string' && savedData.cacheDirName
            ? savedData.cacheDirName
            : DEFAULT_CACHE_DIR_NAME;

        // 读取是否启用缓存（兼容旧数据：默认启用）
        this.cacheEnabled = typeof savedData.cacheEnabled === 'boolean'
            ? savedData.cacheEnabled
            : true;

        // 读取「不再提示」帮助弹窗标记（兼容旧数据：默认未勾选）
        this.helpDismissed = typeof savedData.helpDismissed === 'boolean'
            ? savedData.helpDismissed
            : false;

        const defaultCategories: TimeBlockCategoryData = {
            categories: [
                { id: 'uncategorized', label: t('defaultCategory.uncategorized'), color: '#888888' },
                { id: 'work', label: t('defaultCategory.work'), color: '#4c8dff' },
                { id: 'rest', label: t('defaultCategory.rest'), color: '#43b581' },
                { id: 'play', label: t('defaultCategory.play'), color: '#f2a65a' },
            ],
        };

        if (savedData.version !== 1 || !Array.isArray(savedData.days)) {
            savedData = {
                version: 1,
                days: DEFAULT_WEEK_RANGE.days,
                dayTemplateData: { dayTemplates: [], dayProperties: [] },
                timeBlockCategoryData: defaultCategories,
                inboxData: DEFAULT_INBOX_DATA,
                schemeData: { schemes: [] },
                events: [],
                executions: [],
            };
        }

        const initialData = migrateWeekRangeData(savedData);
        const initialTemplateData = (savedData.dayTemplateData ?? { dayTemplates: [], dayProperties: [] }) as DayTemplateData;
        const initialCategoryData = (savedData.timeBlockCategoryData ?? defaultCategories) as TimeBlockCategoryData;
        // 兼容旧数据：确保「未分类」始终存在且位于首位
        ensureUncategorizedCategory(initialCategoryData);
        const initialInboxData = (savedData.inboxData ?? DEFAULT_INBOX_DATA) as InboxData;
        const initialSchemeData = (savedData.schemeData ?? { schemes: [] }) as RangeSchemeData;
        // 兼容旧数据：确保默认方案始终存在且位于首位
        ensureDefaultScheme(initialSchemeData, t('rangeScheme.defaultName'));
        // 已制定周计划的周键列表（兼容旧数据：默认空数组）
        const initialPlannedWeeks = Array.isArray(savedData.plannedWeeks)
            ? savedData.plannedWeeks as string[]
            : [];
        // 工作台卡片数据（兼容旧数据：默认空）
        const initialWorkbench = (savedData.workbench && typeof savedData.workbench === 'object')
            ? savedData.workbench as WorkbenchData
            : defaultWorkbenchData();

        // 存入插件实例，作为唯一数据源（视图重建时从这里读取最新数据）
        this.data = {
            weekRange: initialData,
            templateData: initialTemplateData,
            categoryData: initialCategoryData,
            events: (savedData.events ?? []) as EventBlock[],
            executions: (savedData.executions ?? []) as ExecutionRecord[],
            inboxData: initialInboxData,
            schemeData: initialSchemeData,
            plannedWeeks: initialPlannedWeeks,
            workbench: initialWorkbench,
        };

        // 注册视图
        this.registerView(
            VIEW_TYPE_MAIN,
            (leaf) => {
                // 每次创建视图都从插件实例读取最新数据，避免使用旧快照
                const d = this.data!;
                log('创建主视图（registerView 工厂被调用）', {
                    events: d.events.length,
                    executions: d.executions.length,
                });
                return new MainView(leaf, this, d.weekRange, d.templateData, d.categoryData,
                    d.events, d.executions, d.inboxData, d.schemeData, d.plannedWeeks, d.workbench,
                    this.cacheDirName,
                );
            }
        );

        // Ribbon 图标
        this.addRibbonIcon('calendar-clock', t('ribbon.open'), async () => {
            const { workspace } = this.app;
            let leaf = workspace.getLeavesOfType(VIEW_TYPE_MAIN)[0];
            if (!leaf) {
                // 在主编辑区新建标签页打开（而非当前活动 leaf，避免落到右侧边栏）
                leaf = workspace.getLeaf('tab');
                await leaf.setViewState({ type: VIEW_TYPE_MAIN });
            }
            await workspace.revealLeaf(leaf);
        });

        // 命令面板
        this.addCommand({
            id: 'open-week-schedule',
            name: t('command.open'),
            callback: async () => {
                const { workspace } = this.app;
                let leaf = workspace.getLeavesOfType(VIEW_TYPE_MAIN)[0];
                if (!leaf) {
                    // 在主编辑区新建标签页打开（而非右侧边栏）
                    leaf = workspace.getLeaf('tab');
                    await leaf.setViewState({ type: VIEW_TYPE_MAIN });
                }
                await workspace.revealLeaf(leaf);
            }
        });

        // 设置页
        this.addSettingTab(new ParrotPlanSettingTab(this.app, this));

        // 缓存启用时，把说明图片下载到缓存目录
        void downloadImageToCache(this.app, this.cacheDirName, this.cacheEnabled);

        // 首次启动（未勾选「不再提示」）时自动打开帮助弹窗
        if (!this.helpDismissed) {
            this.app.workspace.onLayoutReady(() => {
                new HelpModal(this.app, this.cacheDirName, (dismissed) => {
                    void this.saveHelpDismissed(dismissed);
                }).open();
            });
        }
    }

    onunload() {
        log('插件 onunload（卸载/重载）');
        // 只保存数据，不 detach leaf（否则会打乱用户布局）
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MAIN);
        for (const leaf of leaves) {
            if (leaf.view instanceof MainView) {
                void leaf.view.save();
            }
        }
    }

    /** 清空全部插件数据并重置为默认值 */
    async clearAllData(): Promise<void> {
        await this.saveData({});
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MAIN);
        for (const leaf of leaves) {
            if (leaf.view instanceof MainView) {
                await leaf.view.resetData();
            }
        }
    }
}


class ParrotPlanSettingTab extends PluginSettingTab {
    private plugin: ParrotPlanPlugin;

    constructor(app: App, plugin: ParrotPlanPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /** 刷新设置页 */
    private refresh(): void {
        this.update();
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            {
                name: t('settings.title'),
                desc: t('settings.about'),
                render: (setting) => {
                    setting.setName(t('settings.title'));
                    setting.setDesc(t('settings.about'));
                },
            },
            {
                name: t('settings.cache'),
                searchable: false,
                render: (setting) => {
                    setting.setName(t('settings.cache')).setHeading();
                },
            },
            {
                name: t('settings.cacheEnabled'),
                desc: t('settings.cacheEnabledDesc'),
                render: (setting) => {
                    setting
                        .setName(t('settings.cacheEnabled'))
                        .setDesc(t('settings.cacheEnabledDesc'))
                        .addToggle((toggle) => {
                            toggle.setValue(this.plugin.cacheEnabled).onChange(async (value) => {
                                await this.plugin.saveCacheEnabled(value);
                                // 刷新设置页，更新下方缓存目录名称的禁用状态
                                this.refresh();
                            });
                        });
                },
            },
            {
                name: t('settings.cacheDirName'),
                desc: t('settings.cacheDirNameDesc'),
                render: (setting) => {
                    setting
                        .setName(t('settings.cacheDirName'))
                        .setDesc(t('settings.cacheDirNameDesc'))
                        .addText((text) => {
                            text.setPlaceholder(DEFAULT_CACHE_DIR_NAME)
                                .setValue(this.plugin.cacheDirName)
                                .onChange(async (value) => {
                                    const name = value.trim() || DEFAULT_CACHE_DIR_NAME;
                                    await this.plugin.saveCacheDirName(name);
                                });
                            // 缓存关闭时禁用输入框
                            text.setDisabled(!this.plugin.cacheEnabled);
                        });
                    // 缓存关闭时整行置灰
                    if (!this.plugin.cacheEnabled) {
                        setting.settingEl.addClass('parrot-setting-disabled');
                    }
                },
            },
            {
                name: t('settings.data'),
                searchable: false,
                render: (setting) => {
                    setting.setName(t('settings.data')).setHeading();
                },
            },
            {
                name: t('settings.clearData'),
                desc: t('settings.clearDataDesc'),
                render: (setting) => {
                    setting
                        .setName(t('settings.clearData'))
                        .setDesc(t('settings.clearDataDesc'))
                        .addButton((btn) => {
                            btn.setButtonText(t('settings.clearData'))
                                .setDestructive()
                                .onClick(() => {
                                    new ConfirmModal(
                                        this.app,
                                        t('settings.clearDataConfirm'),
                                        t('settings.clearDataConfirmDesc'),
                                        async () => {
                                            await this.plugin.clearAllData();
                                            new Notice(t('settings.clearDataDone'));
                                        },
                                    ).open();
                                });
                        });
                },
            },
        ];
    }
}

/** 通用确认弹窗 */
class ConfirmModal extends Modal {
    private message: string;
    private detail: string;
    private onConfirm: () => void | Promise<void>;

    constructor(app: App, message: string, detail: string, onConfirm: () => void | Promise<void>) {
        super(app);
        this.message = message;
        this.detail = detail;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: this.message });
        contentEl.createEl('p', { text: this.detail });

        const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
        btnRow.createEl('button', { text: t('settings.cancel') }).onclick = () => this.close();
        const confirmBtn = btnRow.createEl('button', {
            text: t('settings.confirm'),
            cls: 'mod-warning',
        });
        confirmBtn.onclick = () => {
            void (async () => {
                await this.onConfirm();
                this.close();
            })();
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}

/** 迁移旧版周区间数据：把旧的 days 归入当前周的 weeks */
function migrateWeekRangeData(savedData: Record<string, unknown>): WeekRangeData {
    const days = Array.isArray(savedData.days) ? savedData.days : DEFAULT_WEEK_RANGE.days;
    const weeks = (savedData.weeks && typeof savedData.weeks === 'object')
        ? savedData.weeks as Record<string, unknown>
        : {};
    // 旧数据没有 weeks，把 days 归入当前周
    if (Object.keys(weeks).length === 0 && Array.isArray(savedData.days)) {
        weeks[getCurrentWeekKey()] = savedData.days;
    }
    return {
        version: 1,
        days: days as WeekRangeData['days'],
        weeks: weeks as WeekRangeData['weeks'],
    };
}
