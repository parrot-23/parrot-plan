import { App, PluginSettingTab, Setting } from 'obsidian';
import { Plugin } from 'obsidian';

import type { WeekRangeData } from './src/timeblock-data';
import type { TimeBlockCategoryData } from './src/timeblock-category-manager';
import type { DayTemplateData } from './src/template-manager';

import { DEFAULT_WEEK_RANGE } from './src/timeblock-data';
import { VIEW_TYPE_WEEK, WeekScheduleView } from './src/week-schedule-view';
import { DEFAULT_INBOX_DATA, type InboxData } from './src/inbox-manager';
import { initI18n } from './src/i18n';

export default class MyPlugin extends Plugin {

    async onload() {
        console.log('loading plugin');

        // 初始化 i18n（跟随 Obsidian 界面语言）
        initI18n();

        // 读取数据
        let savedData = await this.loadData();

        const defaultCategories: TimeBlockCategoryData = {
            categories: [
                { id: 'work', label: '工作', color: '#4c8dff' },
                { id: 'rest', label: '休息', color: '#43b581' },
                { id: 'play', label: '娱乐', color: '#f2a65a' },
            ],
        };

        if (!savedData || savedData.version !== 1 || !Array.isArray(savedData.days)) {
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

        const initialData = savedData as WeekRangeData;
        const initialTemplateData: DayTemplateData = savedData.dayTemplateData ?? { dayTemplates: [], dayProperties: [] };
        const initialCategoryData: TimeBlockCategoryData = savedData.timeBlockCategoryData ?? defaultCategories;
        const initialInboxData: InboxData = savedData.inboxData ?? DEFAULT_INBOX_DATA;
        
        // 注册视图
        this.registerView(
            VIEW_TYPE_WEEK,
            (leaf) => new WeekScheduleView(leaf, this, initialData, initialTemplateData, initialCategoryData,
                savedData.events ?? [], 
                savedData.executions ?? [],
                initialInboxData,
            )
        );

        // Ribbon 图标
        this.addRibbonIcon('calendar-clock', '打开周日程', async () => {
            const { workspace } = this.app;
            let leaf = workspace.getLeavesOfType(VIEW_TYPE_WEEK)[0];
            if (!leaf) {
                leaf = workspace.getLeaf(false)!;
                await leaf.setViewState({ type: VIEW_TYPE_WEEK });
            }
            workspace.revealLeaf(leaf);
        });

        // 命令面板
        this.addCommand({
            id: 'open-week-schedule',
            name: '打开周日程面板',
            callback: async () => {
                const { workspace } = this.app;
                let leaf = workspace.getLeavesOfType(VIEW_TYPE_WEEK)[0];
                if (!leaf) {
                    leaf = workspace.getRightLeaf(false)!;
                    await leaf.setViewState({ type: VIEW_TYPE_WEEK });
                }
                workspace.revealLeaf(leaf);
            }
        });

        // 设置页
        this.addSettingTab(new SampleSettingTab(this.app, this));
    }

    async onunload() {
        console.log('unloading plugin');

        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_WEEK);
        for (const leaf of leaves) {
            if (leaf.view instanceof WeekScheduleView) {
                const view = leaf.view as WeekScheduleView;
                await view.save();
            }
        }

        this.app.workspace.detachLeavesOfType(VIEW_TYPE_WEEK);
    }
}


class SampleSettingTab extends PluginSettingTab {
    display(): void {
        this.containerEl.empty();
        this.containerEl.createEl('h2', { text: 'Settings for my awesome plugin.' });

        new Setting(this.containerEl)
            .setName('Setting #1')
            .setDesc('It\'s a secret')
            .addText(text => text
                .setPlaceholder('Enter your secret')
                .setValue('')
                .onChange((value) => {
                    console.log('Secret: ' + value);
                }));
    }
}

