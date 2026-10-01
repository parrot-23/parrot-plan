import { App, Plugin, PluginSettingTab, Setting, type SettingDefinitionItem } from 'obsidian';

import type { WeekRangeData } from './src/timeblock-data';
import type { TimeBlockCategoryData } from './src/timeblock-category-manager';
import type { DayTemplateData } from './src/template-manager';

import { DEFAULT_WEEK_RANGE } from './src/timeblock-data';
import { VIEW_TYPE_WEEK, WeekScheduleView, type EventBlock, type ExecutionRecord } from './src/week-schedule-view';
import { DEFAULT_INBOX_DATA, type InboxData } from './src/inbox-manager';
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
                events: [],
                executions: [],
            };
        }

        const initialData = savedData as unknown as WeekRangeData;
        const initialTemplateData = (savedData.dayTemplateData ?? { dayTemplates: [], dayProperties: [] }) as DayTemplateData;
        const initialCategoryData = (savedData.timeBlockCategoryData ?? defaultCategories) as TimeBlockCategoryData;
        const initialInboxData = (savedData.inboxData ?? DEFAULT_INBOX_DATA) as InboxData;

        // 注册视图
        this.registerView(
            VIEW_TYPE_WEEK,
            (leaf) => new WeekScheduleView(leaf, this, initialData, initialTemplateData, initialCategoryData,
                (savedData.events ?? []) as EventBlock[],
                (savedData.executions ?? []) as ExecutionRecord[],
                initialInboxData,
            )
        );

        // Ribbon 图标
        this.addRibbonIcon('calendar-clock', t('ribbon.open'), async () => {
            const { workspace } = this.app;
            let leaf = workspace.getLeavesOfType(VIEW_TYPE_WEEK)[0];
            if (!leaf) {
                leaf = workspace.getLeaf(false)!;
                await leaf.setViewState({ type: VIEW_TYPE_WEEK });
            }
            await workspace.revealLeaf(leaf);
        });

        // 命令面板
        this.addCommand({
            id: 'open-week-schedule',
            name: t('command.open'),
            callback: async () => {
                const { workspace } = this.app;
                let leaf = workspace.getLeavesOfType(VIEW_TYPE_WEEK)[0];
                if (!leaf) {
                    leaf = workspace.getRightLeaf(false)!;
                    await leaf.setViewState({ type: VIEW_TYPE_WEEK });
                }
                await workspace.revealLeaf(leaf);
            }
        });

        // 设置页
        this.addSettingTab(new ParrotPlanSettingTab(this.app, this));
    }

    onunload() {
        // 只保存数据，不 detach leaf（否则会打乱用户布局）
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_WEEK);
        for (const leaf of leaves) {
            if (leaf.view instanceof WeekScheduleView) {
                void leaf.view.save();
            }
        }
    }
}


class ParrotPlanSettingTab extends PluginSettingTab {
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
        ];
    }

    display(): void {
        this.containerEl.empty();
        new Setting(this.containerEl).setName(t('settings.title')).setHeading();
        this.containerEl.createEl('p', { text: t('settings.about') });
    }
}
