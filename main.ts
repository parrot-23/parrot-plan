import { App, Modal, Notice, Plugin, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';

import type { WeekRangeData, RangeSchemeData } from './src/week/timeblock-data';
import { getCurrentWeekKey } from './src/week/timeblock-data';
import type { TimeBlockCategoryData } from './src/week/timeblock-category-manager';
import type { DayTemplateData } from './src/week/template-manager';

import { DEFAULT_WEEK_RANGE } from './src/week/timeblock-data';
import type { EventBlock, ExecutionRecord } from './src/week/week-schedule-view';
import { DEFAULT_INBOX_DATA, type InboxData } from './src/shared/task-panel';
import { VIEW_TYPE_MAIN, MainView } from './src/main-view';
import { initI18n, t } from './src/i18n';

export default class ParrotPlanPlugin extends Plugin {

    async onload() {
        // 初始化 i18n（跟随 Obsidian 界面语言）
        initI18n();

        // 读取数据
        const rawData: unknown = await this.loadData();
        let savedData: Record<string, unknown> =
            rawData && typeof rawData === 'object' ? rawData as Record<string, unknown> : {};

        const defaultCategories: TimeBlockCategoryData = {
            categories: [
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
        const initialInboxData = (savedData.inboxData ?? DEFAULT_INBOX_DATA) as InboxData;
        const initialSchemeData = (savedData.schemeData ?? { schemes: [] }) as RangeSchemeData;

        // 注册视图
        this.registerView(
            VIEW_TYPE_MAIN,
            (leaf) => new MainView(leaf, this, initialData, initialTemplateData, initialCategoryData,
                (savedData.events ?? []) as EventBlock[],
                (savedData.executions ?? []) as ExecutionRecord[],
                initialInboxData,
                initialSchemeData,
            )
        );

        // Ribbon 图标
        this.addRibbonIcon('calendar-clock', t('ribbon.open'), async () => {
            const { workspace } = this.app;
            let leaf = workspace.getLeavesOfType(VIEW_TYPE_MAIN)[0];
            if (!leaf) {
                leaf = workspace.getLeaf(false)!;
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
                    leaf = workspace.getRightLeaf(false)!;
                    await leaf.setViewState({ type: VIEW_TYPE_MAIN });
                }
                await workspace.revealLeaf(leaf);
            }
        });

        // 设置页
        this.addSettingTab(new ParrotPlanSettingTab(this.app, this));
    }

    onunload() {
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
                                .setWarning()
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
