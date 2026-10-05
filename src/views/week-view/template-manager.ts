import { App, Modal, Setting, Notice } from 'obsidian';
import type { CategorizedRange, WeekRangeData, DailyRange } from './timeblock-data';
import { t, getWeekDays } from '../../i18n';

// 数据全部由 main.ts 中的主视图，自己持有。

/**主视图标准 */
export interface TemplateViewContext {
    rangeData: WeekRangeData;
    dayTemplateData: DayTemplateData;
    save(): Promise<void>;
    onOpen(): Promise<void>;
    /** 获取当前激活方案的日区间配置（周无关的模板数据） */
    getSchemeDays(): DailyRange[];
}

/** 日模板 */
export interface DayTemplate {
    id: string;
    name: string;
    /** 模板包含的时间区块（不含 id，应用时再生成） */
    ranges: Omit<CategorizedRange, 'id'>[];
}

/** 单日的模板属性（日属性绑定） */
export interface DayProperty {
    /** 星期几（1=周一 ～ 7=周日） */
    day: number;
    /** 绑定的日模板 ID */
    templateId: string;
}

/** 日模板相关数据的顶层容器 */
export interface DayTemplateData {
    dayTemplates: DayTemplate[];
    dayProperties: DayProperty[];
}


/**
 * 渲染模板行（表头下方）
 */
export function renderDayTemplateRow(
    container: HTMLElement,
    dayProperties: DayProperty[],
    dayTemplates: DayTemplate[],
    onCellClick: (day: number) => void
) {
    const row = container.createDiv({ cls: 'day-template-row' });
    row.createDiv({ cls: 'template-corner' });

    const cells = row.createDiv({ cls: 'day-templates' });

    for (let d = 1; d <= 7; d++) {
        const cell = cells.createDiv({ cls: 'day-template-cell' });
        const prop = dayProperties.find(p => p.day === d);
        const tpl = dayTemplates.find(t => t.id === prop?.templateId);
        cell.setText(tpl?.name ?? '');
        cell.onclick = () => onCellClick(d);
    }
}

// 当前选中的模板 ID
let selectedTemplateId: string | null = null;

/**
 * 渲染右侧模板面板
 */
export function renderTemplatePanel(
    app: App,
    container: HTMLElement,
    ctx: TemplateViewContext,
    onApply: (templateId: string, targetDays: number[]) => void | Promise<void>,
    onRefresh?: () => void
) {
    const panel = container.createDiv({ cls: 'template-panel' });

    const titleRow = panel.createDiv({ cls: 'template-title-row' });
    titleRow.createDiv({ text: t('template.title'), cls: 'template-title' });

    const addBtn = titleRow.createEl('button', {
        text: '+',
        cls: 'template-add-btn',
    });
    addBtn.onclick = () => {
        new TemplateCreateModal(app, ctx, () => {
            selectedTemplateId = null; // 新增后清空选中
            // 刷新面板
            if (onRefresh) { onRefresh(); }
            else { void ctx.onOpen(); }
        }).open();
    };

    
    // 模板列表容器
    const list = panel.createDiv({ cls: 'template-list' });

    // 模板列表
    for (const tpl of ctx.dayTemplateData.dayTemplates) {
        const item = list.createDiv({ cls: 'template-item' });
        item.setText(tpl.name);

        // 选中态
        if (tpl.id === selectedTemplateId) {
            item.addClass('is-selected');
        }

        item.onclick = () => {
            // 清除其他选中
            list.querySelectorAll('.template-item').forEach(el => {
                el.classList.remove('is-selected');
            });
            // 选中当前
            item.addClass('is-selected');
            selectedTemplateId = tpl.id;
        };
    }

     // 底部操作栏
    const actionBar = panel.createDiv({ cls: 'template-action-bar' });

    const applyBtn = actionBar.createEl('button', {
        text: t('common.apply'),
        cls: 'template-action-btn',
    });
    applyBtn.onclick = () => {
        if (!selectedTemplateId) {
            new Notice(t('template.selectFirst'));
            return;
        }
        new ApplyTemplateModal(app, ctx, selectedTemplateId, onApply).open();
    };

    const deleteBtn = actionBar.createEl('button', {
        text: t('common.delete'),
        cls: 'template-action-btn danger',
    });
    
    
    deleteBtn.onclick = () => {
        if (!selectedTemplateId) {
            new Notice(t('template.selectFirst'));
            return;
        }

        const tpl = ctx.dayTemplateData.dayTemplates.find(t => t.id === selectedTemplateId);
        if (!tpl) {
            new Notice(t('template.notFound'));
            return;
        }

        new ConfirmDeleteModal(app, tpl.name, async () => {
            // 1. 从 dayTemplates 移除
            ctx.dayTemplateData.dayTemplates = ctx.dayTemplateData.dayTemplates.filter(
                t => t.id !== selectedTemplateId
            );

            // 2. 清理 dayProperties 里的引用（不影响网格，纯卫生）
            ctx.dayTemplateData.dayProperties = ctx.dayTemplateData.dayProperties.filter(
                p => p.templateId !== selectedTemplateId
            );

            // 3. 清空选中态
            selectedTemplateId = null;

            // 4. 保存 + 刷新
            await ctx.save();
            if (onRefresh) { onRefresh(); }
            else { await ctx.onOpen(); }
        }).open();
    };

}


/**
 * 新增模板弹窗
 */
export class TemplateCreateModal extends Modal {
    private ctx: TemplateViewContext;
    private onCreated: () => void;

    constructor(
        app: App,
         ctx: TemplateViewContext,
        onCreated: () => void
    ) {
        super(app);
        this.ctx = ctx;
        this.onCreated = onCreated;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('template.create') });

        let name = '';
        let sourceDay: number = 1;

        // 模板名称
        new Setting(contentEl)
            .setName(t('template.name'))
            .addText(text => text
                .setPlaceholder(t('template.namePlaceholder'))
                .onChange(v => name = v.trim())
            );

        // 模板来源（周一到周日）
        new Setting(contentEl)
            .setName(t('template.copyFrom'))
            .addDropdown(dropdown => {
                const days = getWeekDays();
                for (let i = 1; i <= 7; i++) {
                    dropdown.addOption(String(i), days[i - 1]);
                }
                dropdown.setValue('1');
                dropdown.onChange(v => sourceDay = Number(v));
            });

        // 确认按钮
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('common.confirm'))
                .setCta()
                .onClick(async () => {
                    
                    if (!name) {
                        new Notice(t('template.nameRequired'));
                        return;
                    }

                    // 从当前激活方案的对应星期复制 ranges
                    const dayData = this.ctx.getSchemeDays().find(d => d.day === sourceDay);
                    const ranges = (dayData?.ranges ?? []).map(({ id, ...rest }) => rest);
                    
                    this.ctx.dayTemplateData.dayTemplates.push({
                        id: crypto.randomUUID(),
                        name,
                        ranges,
                    });

                    await this.ctx.save();
                    this.onCreated();
                    this.close();
                })
            )
            .addButton(btn => btn
                .setButtonText(t('common.cancel'))
                .onClick(() => this.close())
            );
    }

    onClose() {
        this.contentEl.empty();
    }
}


/**
 * 应用模板弹窗
 */
export class ApplyTemplateModal extends Modal {
    private ctx: TemplateViewContext;
    private templateId: string;
    private onApply: (templateId: string, targetDays: number[]) => void | Promise<void>;

    constructor(
        app: App,
        ctx: TemplateViewContext,
        templateId: string,
        onApply: (templateId: string, targetDays: number[]) => void | Promise<void>
    ) {
        super(app);
        this.ctx = ctx;
        this.templateId = templateId;
        this.onApply = onApply;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        const tpl = this.ctx.dayTemplateData.dayTemplates.find(
            t => t.id === this.templateId
        );
        const tplName = tpl?.name ?? t('template.unnamed');

        contentEl.createEl('h3', { text: t('template.applyTo', { name: tplName }) });

        // 选中状态
        const selectedDays: Set<number> = new Set();

        // 天的标签按钮行
        const dayRow = contentEl.createDiv({ cls: 'apply-day-row' });

        const days = getWeekDays();
        const dayBtns: HTMLElement[] = [];

        for (let i = 1; i <= 7; i++) {
            const btn = dayRow.createEl('button', {
                text: days[i - 1],
                cls: 'apply-day-btn',
            });

            dayBtns.push(btn);

            btn.onclick = () => {
                if (selectedDays.has(i)) {
                    selectedDays.delete(i);
                    btn.removeClass('is-selected');
                } else {
                    selectedDays.add(i);
                    btn.addClass('is-selected');
                }
            };
        }

        // 快捷按钮行
        const quickRow = contentEl.createDiv({ cls: 'apply-quick-row' });

        const selectAllBtn = quickRow.createEl('button', {
            text: t('template.selectAll'),
            cls: 'template-action-btn',
        });
        selectAllBtn.onclick = () => {
            for (let i = 1; i <= 7; i++) selectedDays.add(i);
            dayBtns.forEach(btn => btn.addClass('is-selected'));
        };

        const clearBtn = quickRow.createEl('button', {
            text: t('template.clearAll'),
            cls: 'template-action-btn',
        });
        clearBtn.onclick = () => {
            selectedDays.clear();
            dayBtns.forEach(btn => btn.removeClass('is-selected'));
        };

        // 确认 / 取消
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('common.confirm'))
                .setCta()
                .onClick(() => {
                    if (selectedDays.size === 0) {
                        new Notice(t('template.selectAtLeastOne'));
                        return;
                    }
                    void this.onApply(this.templateId, Array.from(selectedDays));
                    this.close();
                })
            )
            .addButton(btn => btn
                .setButtonText(t('common.cancel'))
                .onClick(() => this.close())
            );
    }

    onClose() {
        this.contentEl.empty();
    }
}


/**
 * 删除确认弹窗
 */
export class ConfirmDeleteModal extends Modal {
    private templateName: string;
    private onConfirm: () => void | Promise<void>;

    constructor(app: App, templateName: string, onConfirm: () => void | Promise<void>) {
        super(app);
        this.templateName = templateName;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h3', { text: t('template.deleteTitle') });
        contentEl.createEl('p', {
            text: t('template.deleteConfirm', { name: this.templateName }),
        });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('common.delete'))
                .setWarning()
                .setCta()
                .onClick(() => {
                    void this.onConfirm();
                    this.close();
                })
            )
            .addButton(btn => btn
                .setButtonText(t('common.cancel'))
                .onClick(() => this.close())
            );
    }

    onClose() {
        this.contentEl.empty();
    }
}



