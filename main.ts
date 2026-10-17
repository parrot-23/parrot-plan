import { App, Modal, Notice, Plugin, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';

import { VIEW_TYPE_MAIN, MainView } from './src/main-view';
import type { FileData } from './src/datatypes/domain';
import { BaseRepo, DEFAULT_CACHE_DIR_NAME, type PluginData } from './src/repos/base-repo';
import { GtdRepo } from './src/repos/gtd-repo';
import { PdcaRepo } from './src/repos/pdca-repo';
import { WorkbenchRepo } from './src/repos/workbench-repo';
import { InboxRepo } from './src/repos/inbox-repo';
import { CategoryRepo } from './src/repos/category-repo';
import { TemplateRepo } from './src/repos/template-repo';
import { PlanSchemeRepo } from './src/repos/plan-scheme-repo';
import { initI18n, t, getLangDebugInfo } from './src/i18n';
import { initLogger, log } from './src/shared/logger';
import { downloadImageToCache } from './src/helper/cache-image';
import { HelpModal } from './src/helper/help-modal';

export default class ParrotPlanPlugin extends Plugin {
    /** 基础数据仓库：唯一数据源 + 唯一保存出口 */
    repo: BaseRepo;

    /** GTD 领域仓库 */
    gtdRepo: GtdRepo;

    /** PDCA 领域仓库 */
    pdcaRepo: PdcaRepo;

    /** 工作台领域仓库 */
    workbenchRepo: WorkbenchRepo;

    /** 收集盒领域仓库 */
    inboxRepo: InboxRepo;

    /** 分类领域仓库 */
    categoryRepo: CategoryRepo;

    /** 日模板领域仓库 */
    templateRepo: TemplateRepo;

    /** 时间计划方案领域仓库 */
    planSchemeRepo: PlanSchemeRepo;

    /**
     * 插件持有的唯一数据源（委托给 BaseRepo）。
     * 视图重建（registerView 工厂再次调用）时从这里读取最新数据，
     * 避免用 onload 时的旧快照导致内存中的新数据丢失。
     */
    get data(): PluginData | null {
        return this.repo.data;
    }

    /** 缓存目录名称（随主数据一起持久化） */
    get cacheDirName(): string {
        return this.repo.cacheDirName;
    }

    /** 是否启用缓存（随主数据一起持久化） */
    get cacheEnabled(): boolean {
        return this.repo.cacheEnabled;
    }

    /** 是否已勾选「不再提示」帮助弹窗（随主数据一起持久化） */
    get helpDismissed(): boolean {
        return this.repo.helpDismissed;
    }

    /** 是否启用剧本模式（随主数据一起持久化，默认关闭） */
    get scriptModeEnabled(): boolean {
        return this.repo.scriptModeEnabled;
    }

    /**
     * 唯一的数据保存出口（委托给 BaseRepo）。
     * 所有视图与设置项都通过此方法保存。
     */
    async saveAll(): Promise<void> {
        await this.repo.saveAll();
    }

    /** 保存缓存目录名称 */
    async saveCacheDirName(name: string): Promise<void> {
        await this.repo.saveCacheDirName(name);
    }

    /** 保存是否启用缓存 */
    async saveCacheEnabled(enabled: boolean): Promise<void> {
        await this.repo.saveCacheEnabled(enabled);
    }

    /** 保存「不再提示」帮助弹窗标记 */
    async saveHelpDismissed(dismissed: boolean): Promise<void> {
        await this.repo.saveHelpDismissed(dismissed);
    }

    /** 保存是否启用剧本模式 */
    async saveScriptModeEnabled(enabled: boolean): Promise<void> {
        await this.repo.saveScriptModeEnabled(enabled);
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

        // 初始化数据仓库并加载数据
        this.repo = new BaseRepo(this);
        await this.repo.load();
        this.gtdRepo = new GtdRepo(this.repo);
        this.pdcaRepo = new PdcaRepo(this.repo);
        this.workbenchRepo = new WorkbenchRepo(this.repo);
        this.inboxRepo = new InboxRepo(this.repo);
        this.categoryRepo = new CategoryRepo(this.repo);
        this.templateRepo = new TemplateRepo(this.repo);
        this.planSchemeRepo = new PlanSchemeRepo(this.repo);

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
                return new MainView(leaf, this, d.templateData, d.categoryData,
                    d.events, d.executions, d.inboxData, d.schemeData, d.plannedWeeks, d.workbench,
                    d.gtdData, this.cacheDirName, d.executingEventId, d.runningTask,
                );
            }
        );

        // Ribbon 图标
        this.addRibbonIcon('calendar-clock', t('ribbon.open'), async () => {
            await this.openMainView();
        });

        // 命令面板
        this.addCommand({
            id: 'open-week-schedule',
            name: t('command.open'),
            callback: async () => {
                await this.openMainView();
            }
        });

        // 设置页
        this.addSettingTab(new ParrotPlanSettingTab(this.app, this));

        // 文件/文件夹在 vault 内被移动或重命名时，同步更新任务中引用的路径
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                void this.handleVaultRename(oldPath, file.path);
            }),
        );

        // 缓存启用时，把说明图片下载到缓存目录
        void downloadImageToCache(this.app, this.cacheDirName, this.cacheEnabled);
    }

    /**
     * vault 内文件/文件夹被移动或重命名后，更新任务中引用的路径：
     * 文件板块的 path、收集篮子的 path（文件夹移动时同步更新其下所有文件路径）。
     * 有变更时保存数据并刷新已打开的主视图。
     */
    private async handleVaultRename(oldPath: string, newPath: string): Promise<void> {
        const d = this.data;
        if (!d || oldPath === newPath) return;

        // 文件本身被重命名，或所在文件夹被移动/重命名
        const remap = (path: string | undefined): string | undefined => {
            if (!path) return path;
            if (path === oldPath) return newPath;
            if (path.startsWith(`${oldPath}/`)) return `${newPath}${path.slice(oldPath.length)}`;
            return path;
        };

        let changed = false;
        for (const item of d.inboxData.items) {
            for (const section of item.sections ?? []) {
                if (section.type !== 'file') continue;
                for (const fileItem of (section.data as FileData).items) {
                    const next = remap(fileItem.path);
                    if (next !== fileItem.path) {
                        fileItem.path = next;
                        changed = true;
                    }
                }
            }
            for (const entry of item.basket ?? []) {
                const next = remap(entry.path);
                if (next !== entry.path) {
                    entry.path = next;
                    changed = true;
                }
            }
        }
        if (!changed) return;

        await this.saveAll();
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MAIN)) {
            if (leaf.view instanceof MainView) {
                await leaf.view.refresh();
            }
        }
    }

    /**
     * 打开主视图（Ribbon 图标 / 命令面板共用入口）。
     * 帮助弹窗在此处触发：仅在用户主动打开插件时弹出，而非 Obsidian 启动时。
     */
    private async openMainView(): Promise<void> {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_MAIN)[0];
        if (!leaf) {
            // 在主编辑区新建标签页打开（而非当前活动 leaf，避免落到右侧边栏）
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({ type: VIEW_TYPE_MAIN });
        }
        await workspace.revealLeaf(leaf);

        // 未勾选「不再提示」时，打开插件后弹出帮助弹窗
        if (!this.helpDismissed) {
            new HelpModal(this.app, this.cacheDirName, (dismissed) => {
                void this.saveHelpDismissed(dismissed);
            }).open();
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
        await this.repo.clearAll();
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
                name: t('settings.scriptMode'),
                searchable: false,
                render: (setting) => {
                    setting.setName(t('settings.scriptMode')).setHeading();
                },
            },
            {
                name: t('settings.scriptModeEnabled'),
                desc: t('settings.scriptModeEnabledDesc'),
                render: (setting) => {
                    setting
                        .setName(t('settings.scriptModeEnabled'))
                        .setDesc(t('settings.scriptModeEnabledDesc'))
                        .addToggle((toggle) => {
                            toggle.setValue(this.plugin.scriptModeEnabled).onChange(async (value) => {
                                await this.plugin.saveScriptModeEnabled(value);
                            });
                        });
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
