import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, type SettingDefinitionItem } from 'obsidian';

import type { WeekRangeData, RangeSchemeData } from './src/views/week-view/timeblock-data';
import { getCurrentWeekKey, ensureDefaultScheme } from './src/views/week-view/timeblock-data';
import type { TimeBlockCategoryData } from './src/views/week-view/timeblock-category-manager';
import { ensureUncategorizedCategory } from './src/views/week-view/timeblock-category-manager';
import type { DayTemplateData } from './src/views/week-view/template-manager';

import { DEFAULT_WEEK_RANGE } from './src/views/week-view/timeblock-data';
import type { EventBlock, ExecutionRecord } from './src/views/week-view/week-schedule-view';
import { DEFAULT_INBOX_DATA, type InboxData } from './src/shared/task-panel';
import { VIEW_TYPE_MAIN, MainView } from './src/main-view';
import { defaultWorkbenchData, type WorkbenchData } from './src/workbench/data/card-data';
import { initI18n, t, getLangDebugInfo } from './src/i18n';
import { initLogger, log } from './src/shared/logger';
import {
    type AccountData,
    createLoginToken,
    checkLoginToken,
} from './src/shared/account';
import * as QRCode from 'qrcode';

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

    /** 账号信息（随主数据一起持久化） */
    account: AccountData = {};

    /**
     * 保存账号信息：读取当前主数据 → 合并 account → 写回，
     * 避免覆盖其他字段（主数据由 week-schedule-view.save() 整体写入）。
     */
    async saveAccountData(account: AccountData): Promise<void> {
        this.account = account;
        const rawData: unknown = await this.loadData();
        const savedData: Record<string, unknown> =
            rawData && typeof rawData === 'object' ? rawData as Record<string, unknown> : {};
        savedData.account = account;
        await this.saveData(savedData);
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

        // 读取账号信息（随主数据一起存储）
        this.account = (savedData.account ?? {}) as AccountData;

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

    /** 传统设置页渲染（兼容 Obsidian 1.13 以下版本） */
    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName(t('settings.title'))
            .setDesc(t('settings.about'));

        // ===== 账号 =====
        new Setting(containerEl)
            .setName(t('settings.account'))
            .setHeading();

        const loggedIn = !!this.plugin.account.userId;
        new Setting(containerEl)
            .setName(t('settings.accountName'))
            .setDesc(this.plugin.account.userId ?? t('settings.accountNotLoggedIn'))
            .addButton((btn) => {
                btn.setButtonText(loggedIn ? t('settings.loggedIn') : t('settings.login'))
                    .setCta()
                    .setDisabled(loggedIn)
                    .onClick(() => {
                        new LoginModal(this.app, this.plugin, () => this.display()).open();
                    });
            });

        // 微信小程序：右侧二维码缩略图，点击弹窗放大
        const wechatSetting = new Setting(containerEl)
            .setName(t('settings.wechatMiniProgram'))
            .setDesc(t('settings.wechatMiniProgramDesc'));
        const thumb = wechatSetting.controlEl.createEl('img', {
            cls: 'parrot-wechat-qr-thumb',
            attr: { src: getWechatQrPath(this.app), alt: t('settings.wechatMiniProgram') },
        });
        thumb.onclick = () => new QrCodeModal(this.app).open();

        new Setting(containerEl)
            .setName(t('settings.data'))
            .setHeading();

        new Setting(containerEl)
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
                name: t('settings.account'),
                searchable: false,
                render: (setting) => {
                    setting.setName(t('settings.account')).setHeading();
                },
            },
            {
                name: t('settings.wechatMiniProgram'),
                desc: t('settings.wechatMiniProgramDesc'),
                render: (setting) => {
                    setting
                        .setName(t('settings.wechatMiniProgram'))
                        .setDesc(t('settings.wechatMiniProgramDesc'));
                    const thumb = setting.controlEl.createEl('img', {
                        cls: 'parrot-wechat-qr-thumb',
                        attr: { src: getWechatQrPath(this.app), alt: t('settings.wechatMiniProgram') },
                    });
                    thumb.onclick = () => new QrCodeModal(this.app).open();
                },
            },
            {
                name: t('settings.accountName'),
                desc: this.plugin.account.userId ?? t('settings.accountNotLoggedIn'),
                render: (setting) => {
                    const loggedIn = !!this.plugin.account.userId;
                    setting
                        .setName(t('settings.accountName'))
                        .setDesc(this.plugin.account.userId ?? t('settings.accountNotLoggedIn'))
                        .addButton((btn) => {
                            btn.setButtonText(loggedIn ? t('settings.loggedIn') : t('settings.login'))
                                .setCta()
                                .setDisabled(loggedIn)
                                .onClick(() => {
                                    new LoginModal(this.app, this.plugin, () => this.display()).open();
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

/** 微信小程序二维码图片相对 vault 的路径 */
const WECHAT_QR_PATH = '.obsidian/plugins/parrot-plan/src/images/qrcode.jpg';

/** 获取微信小程序二维码的可访问 URL */
function getWechatQrPath(app: App): string {
    return app.vault.adapter.getResourcePath(WECHAT_QR_PATH);
}

/** 微信小程序二维码弹窗：展示放大的二维码图片 */
class QrCodeModal extends Modal {
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('settings.wechatMiniProgramTitle') });
        const wrap = contentEl.createDiv({ cls: 'parrot-wechat-qr-modal' });
        wrap.createEl('img', {
            attr: { src: getWechatQrPath(this.app), alt: t('settings.wechatMiniProgram') },
        });
        contentEl.createEl('p', {
            cls: 'parrot-wechat-qr-hint',
            text: t('settings.wechatMiniProgramHint'),
        });
    }

    onClose() {
        this.contentEl.empty();
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

/** 登录弹窗：获取登录二维码并轮询登录结果 */
class LoginModal extends Modal {
    private plugin: ParrotPlanPlugin;
    private onLoggedIn: () => void;
    /** 轮询定时器 */
    private timer?: number;
    /** 轮询开始时间（用于超时判断） */
    private startedAt = 0;
    /** 是否已结束（登录成功或超时），避免重复处理 */
    private finished = false;

    /** 轮询间隔：3 秒 */
    private static readonly POLL_INTERVAL = 3000;
    /** 最长轮询时长：5 分钟 */
    private static readonly POLL_TIMEOUT = 5 * 60 * 1000;

    constructor(app: App, plugin: ParrotPlanPlugin, onLoggedIn: () => void) {
        super(app);
        this.plugin = plugin;
        this.onLoggedIn = onLoggedIn;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('settings.loginTitle') });

        const statusEl = contentEl.createEl('p', {
            cls: 'parrot-login-status',
            text: t('settings.loginLoading'),
        });
        const qrWrap = contentEl.createDiv({ cls: 'parrot-login-qr' });

        void this.startLogin(qrWrap, statusEl);
    }

    /** 创建登录令牌 → 渲染二维码 → 开始轮询 */
    private async startLogin(qrWrap: HTMLElement, statusEl: HTMLElement): Promise<void> {
        let token: string;
        try {
            const res = await createLoginToken();
            token = res.token;
        } catch (err) {
            log('创建登录令牌失败', err);
            statusEl.setText(t('settings.loginCreateFailed'));
            return;
        }

        // 用 token 生成二维码
        try {
            const dataUrl = await QRCode.toDataURL(token, { width: 220, margin: 1 });
            qrWrap.empty();
            qrWrap.createEl('img', { attr: { src: dataUrl, alt: 'login qr' } });
        } catch (err) {
            log('生成二维码失败', err);
            statusEl.setText(t('settings.loginQrFailed'));
            return;
        }

        statusEl.setText(t('settings.loginScanHint'));
        this.startedAt = Date.now();
        this.timer = window.setInterval(() => {
            void this.poll(token, statusEl);
        }, LoginModal.POLL_INTERVAL);
    }

    /** 轮询登录结果 */
    private async poll(token: string, statusEl: HTMLElement): Promise<void> {
        if (this.finished) return;
        // 超时判断
        if (Date.now() - this.startedAt > LoginModal.POLL_TIMEOUT) {
            this.finish();
            statusEl.setText(t('settings.loginTimeout'));
            return;
        }
        try {
            const res = await checkLoginToken(token);
            if (res.loggedIn) {
                this.finish();
                await this.plugin.saveAccountData({
                    token,
                    userId: res.userId,
                });
                statusEl.setText(t('settings.loginSuccess'));
                new Notice(t('settings.loginSuccess'));
                this.onLoggedIn();
                this.close();
            }
        } catch (err) {
            // 单次轮询失败不终止，等待下次轮询
            log('轮询登录结果失败', err);
        }
    }

    /** 结束轮询 */
    private finish(): void {
        this.finished = true;
        if (this.timer !== undefined) {
            window.clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    onClose() {
        this.finish();
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
