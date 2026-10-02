import { App, Modal, Setting } from 'obsidian';

import type { TimeBlockCategoryData } from './timeblock-category-manager';
import { renderTimeBlockCategoryLegend } from './timeblock-category-manager';
import type { RangeSchemeData, RangeScheme } from './timeblock-data';
import { renderTemplatePanel, type TemplateViewContext } from './template-manager';
import { renderWeekGrid } from '../shared/week-grid';
import { t } from '../i18n';

/**
 * 时间区间设置窗口。
 * 顶部：方案切换 / 方案管理按钮。
 * 主体：左侧图例管理 + 日模板（复用周计划视图的图例管理），右侧日历（复用公共组件 week-grid）。
 */
export class RangeSchemeModal extends Modal {
    private categoryData: TimeBlockCategoryData;
    private schemeData: RangeSchemeData;
    private templateCtx: TemplateViewContext;
    private onApplyTemplate: (templateId: string, targetDays: number[]) => void | Promise<void>;
    private onChange?: () => void;

    constructor(
        app: App,
        categoryData: TimeBlockCategoryData,
        schemeData: RangeSchemeData,
        templateCtx: TemplateViewContext,
        onApplyTemplate: (templateId: string, targetDays: number[]) => void | Promise<void>,
        onChange?: () => void,
    ) {
        super(app);
        this.categoryData = categoryData;
        this.schemeData = schemeData;
        this.templateCtx = templateCtx;
        this.onApplyTemplate = onApplyTemplate;
        this.onChange = onChange;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('range-scheme-modal');

        // ===== 顶部：方案切换 / 方案管理 =====
        const header = contentEl.createDiv({ cls: 'range-scheme-header' });
        header.createEl('h3', { text: t('rangeScheme.title') });

        const actions = header.createDiv({ cls: 'range-scheme-actions' });

        const switchBtn = actions.createEl('button', {
            text: t('rangeScheme.switch'),
            cls: 'range-scheme-btn',
        });
        switchBtn.onclick = () => {
            // 占位：方案切换弹窗
            new SchemePlaceholderModal(this.app, t('rangeScheme.switch')).open();
        };

        const manageBtn = actions.createEl('button', {
            text: t('rangeScheme.manage'),
            cls: 'range-scheme-btn',
        });
        manageBtn.onclick = () => {
            new SchemeManageModal(this.app, this.schemeData, () => {
                this.onChange?.();
            }).open();
        };

        // ===== 主体：左右结构 =====
        const body = contentEl.createDiv({ cls: 'range-scheme-body' });

        // 左侧：图例管理 + 日模板
        const legendPanel = body.createDiv({ cls: 'range-scheme-legend' });
        renderTimeBlockCategoryLegend(
            this.app,
            legendPanel,
            this.categoryData,
            () => {
                this.onChange?.();
            },
        );

        // 日模板（图例下方）
        const templateContainer = legendPanel.createDiv({ cls: 'template-container' });
        renderTemplatePanel(this.app, templateContainer, this.templateCtx, this.onApplyTemplate);

        // 右侧：日历
        const calendarPanel = body.createDiv({ cls: 'range-scheme-calendar' });
        renderWeekGrid(calendarPanel);
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * 方案管理弹窗：对方案进行增删改（CRUD）。
 * 交互参考图例设置弹窗（CategoryConfigModal）：草稿副本 + 列表 + 确认/取消。
 */
export class SchemeManageModal extends Modal {
    private schemeData: RangeSchemeData;
    private draft: RangeScheme[];
    private listEl!: HTMLElement;
    private onConfirm?: () => void;

    constructor(
        app: App,
        schemeData: RangeSchemeData,
        onConfirm?: () => void,
    ) {
        super(app);
        this.schemeData = schemeData;
        this.onConfirm = onConfirm;
        // 拷贝一份草稿，取消不影响原数据
        this.draft = schemeData.schemes.map(s => ({ ...s, days: s.days.map(d => ({ ...d, ranges: [...d.ranges] })) }));
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        // 标题 + 右上角 +
        const header = contentEl.createDiv({ cls: 'tbcat-modal-header' });
        header.createEl('h3', { text: t('rangeScheme.manageTitle') });

        const addBtn = header.createEl('button', {
            text: '+',
            cls: 'tbcat-add-btn',
        });
        addBtn.addEventListener('click', () => {
            this.draft.push({
                id: 'scheme_' + Date.now().toString(36),
                name: t('rangeScheme.new'),
                days: [],
            });
            this.renderList();
        });

        // 列表容器
        this.listEl = contentEl.createDiv({ cls: 'tbcat-list' });
        this.renderList();

        // 底部 确认 / 取消
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('common.cancel'))
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText(t('common.confirm'))
                .setCta()
                .onClick(() => {
                    this.schemeData.schemes = this.draft;
                    this.onConfirm?.();
                    this.close();
                }));
    }

    private renderList() {
        this.listEl.empty();

        if (this.draft.length === 0) {
            this.listEl.createDiv({
                text: t('rangeScheme.empty'),
                cls: 'tbcat-empty',
            });
            return;
        }

        this.draft.forEach((scheme, index) => {
            const row = this.listEl.createDiv({ cls: 'tbcat-row' });

            // 名称
            const name = row.createEl('input', {
                type: 'text',
                placeholder: t('rangeScheme.namePlaceholder'),
                cls: 'tbcat-name',
            });
            name.value = scheme.name;
            name.addEventListener('input', () => {
                scheme.name = name.value;
            });

            // 删除
            const del = row.createEl('button', {
                text: '✕',
                cls: 'tbcat-del-btn',
            });
            del.addEventListener('click', () => {
                this.draft.splice(index, 1);
                this.renderList();
            });
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

/** 方案切换 / 管理的占位弹窗 */
class SchemePlaceholderModal extends Modal {
    private title: string;

    constructor(app: App, title: string) {
        super(app);
        this.title = title;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: this.title });
    }

    onClose() {
        this.contentEl.empty();
    }
}
