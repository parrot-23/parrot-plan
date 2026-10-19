import { Notice, PluginSettingTab, type App, type SettingDefinitionItem } from 'obsidian';

import { t } from '../i18n';
import { DEFAULT_CACHE_DIR_NAME } from '../repos/base-repo';
import type ParrotPlanPlugin from '../../main';
import { ConfirmModal } from './confirm-modal';

/** 插件设置页 */
export class ParrotPlanSettingTab extends PluginSettingTab {
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
