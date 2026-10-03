import { App, Modal, Setting } from 'obsidian';

import type { TimeBlockCategoryData } from './timeblock-category-manager';
import { renderTimeBlockCategoryLegend } from './timeblock-category-manager';
import type { RangeSchemeData, RangeScheme } from './timeblock-data';
import { hexToTransparent, DEFAULT_SCHEME_ID, ensureDefaultScheme } from './timeblock-data';
import { renderTemplatePanel, type TemplateViewContext } from './template-manager';
import { renderWeekGrid } from '../shared/week-grid';
import { RangeEditModal } from './week-schedule-view';
import { t } from '../i18n';

/**
 * 时间区间设置窗口。
 * 顶部：当前方案名称 / 方案管理按钮。
 * 主体：左侧图例管理 + 日模板（复用周计划视图的图例管理），右侧日历（复用公共组件 week-grid）。
 * 右侧日历：选中图例后点击网格可添加区间，点击已有色块可编辑，× 可删除；数据写入当前激活方案。
 */
export class RangeSchemeModal extends Modal {
    private categoryData: TimeBlockCategoryData;
    private schemeData: RangeSchemeData;
    private templateCtx: TemplateViewContext;
    private onApplyTemplate: (templateId: string, targetDays: number[]) => void | Promise<void>;
    private onSave: () => Promise<void>;
    private onChange?: () => void;
    /** 图例中选中的分类（新建区间时的默认分类） */
    private selectedCategoryId?: string;
    /** 重渲染前保存的日历滚动位置，用于无感知刷新 */
    private savedScrollTop: number | null = null;

    constructor(
        app: App,
        categoryData: TimeBlockCategoryData,
        schemeData: RangeSchemeData,
        templateCtx: TemplateViewContext,
        onApplyTemplate: (templateId: string, targetDays: number[]) => void | Promise<void>,
        onSave: () => Promise<void>,
        onChange?: () => void,
    ) {
        super(app);
        this.categoryData = categoryData;
        this.schemeData = schemeData;
        this.templateCtx = templateCtx;
        this.onApplyTemplate = onApplyTemplate;
        this.onSave = onSave;
        this.onChange = onChange;
    }

    onOpen() {
        const { contentEl } = this;
        // 重渲染前记录日历滚动位置，避免刷新后跳回顶部
        const prevScroll = contentEl.querySelector('.grid-body-row') as HTMLElement | null;
        if (prevScroll) this.savedScrollTop = prevScroll.scrollTop;
        contentEl.empty();
        contentEl.addClass('range-scheme-modal');

        // ===== 顶部：当前方案名称 / 方案管理 =====
        const header = contentEl.createDiv({ cls: 'range-scheme-header' });
        header.createEl('h3', { text: t('rangeScheme.title') });

        const actions = header.createDiv({ cls: 'range-scheme-actions' });

        // 当前方案名称（纯展示）
        const activeScheme = this.getActiveScheme();
        actions.createSpan({
            text: activeScheme?.name ?? t('rangeScheme.noActive'),
            cls: 'range-scheme-current',
        });

        const manageBtn = actions.createEl('button', {
            text: t('rangeScheme.manage'),
            cls: 'range-scheme-btn',
        });
        manageBtn.onclick = () => {
            new SchemeManageModal(this.app, this.schemeData, () => {
                this.onChange?.();
                // 方案数据可能变化，重新渲染以刷新当前方案名称
                this.onOpen();
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
                // 图例分类增删改后：通知宿主刷新，并重渲染本弹窗以更新图例
                this.onChange?.();
                this.onOpen();
            },
            this.selectedCategoryId,
            (id) => {
                // 点击图例选中/取消选中分类
                this.selectedCategoryId = this.selectedCategoryId === id ? undefined : id;
                this.onOpen();
            },
        );

        // 日模板（图例下方）
        const templateContainer = legendPanel.createDiv({ cls: 'template-container' });
        renderTemplatePanel(this.app, templateContainer, this.templateCtx, async (templateId, targetDays) => {
            await this.onApplyTemplate(templateId, targetDays);
            // 应用后刷新弹窗内的日历
            this.onOpen();
        }, () => {
            // 新增模板后刷新弹窗
            this.onOpen();
        });

        // 右侧：日历
        const calendarPanel = body.createDiv({ cls: 'range-scheme-calendar' });
        const refs = renderWeekGrid(calendarPanel);
        this.renderRangeLayer(refs.bodyRowInner);

        // 恢复滚动位置（无感知刷新）
        if (this.savedScrollTop !== null) {
            const scrollContainer = refs.bodyRowInner.closest('.grid-body-row') as HTMLElement | null;
            if (scrollContainer) scrollContainer.scrollTop = this.savedScrollTop;
            this.savedScrollTop = null;
        }
    }

    /** 获取当前激活方案（未激活时回退到默认方案） */
    private getActiveScheme(): RangeScheme | undefined {
        const active = this.schemeData.schemes.find(s => s.id === this.schemeData.activeSchemeId);
        if (active) return active;
        return this.schemeData.schemes.find(s => s.id === DEFAULT_SCHEME_ID)
            ?? this.schemeData.schemes[0];
    }

    /** 在日历网格上渲染当前激活方案的时间区间，并绑定添加/编辑/删除交互 */
    private renderRangeLayer(bodyRowInner: HTMLElement) {
        const scheme = this.getActiveScheme();
        const cols = bodyRowInner.querySelectorAll('.day-column');

        for (let d = 1; d <= 7; d++) {
            const col = cols[d - 1] as HTMLElement;

            // 点击空白 → 新建时间区间（写入当前激活方案）
            col.onclick = (e) => {
                if (!scheme) return;
                const target = e.target as HTMLElement;
                if (!target.classList.contains('day-column') && !target.classList.contains('hour-cell')) return;
                const rect = col.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const startMinutes = Math.floor((y / 80) * 120 / 30) * 30;
                new RangeEditModal(this.app, startMinutes, (start, end, sort) => {
                    if (!scheme.days) scheme.days = [];
                    let dayData = scheme.days.find(day => day.day === d);
                    if (!dayData) {
                        dayData = { day: d, ranges: [] };
                        scheme.days.push(dayData);
                    }
                    const id = `r_${Date.now()}`;
                    dayData.ranges.push({ id, start, end, sort });
                    void (async () => {
                        await this.onSave();
                        this.onOpen();
                    })();
                }, this.categoryData, undefined, this.selectedCategoryId).open();
            };

            // 已有色块
            const dayData = scheme?.days?.find(day => day.day === d);
            const dayRanges = dayData?.ranges ?? [];
            for (const range of dayRanges) {
                const block = col.createDiv({ cls: 'range-block range-block-fill' });
                const cat = this.categoryData.categories.find(c => c.id === range.sort);
                const rawColor = cat?.color ?? '#888888';

                const top = (range.start / 120) * 80;
                const height = ((range.end - range.start) / 120) * 80;
                block.setCssProps({
                    '--range-color': rawColor,
                    '--range-bg': hexToTransparent(rawColor, 0.1),
                    '--range-top': `${top}px`,
                    '--range-height': `${height}px`,
                });

                block.onclick = (e) => {
                    e.stopPropagation();
                    new RangeEditModal(this.app, 0, (start, end, sort) => {
                        range.start = start;
                        range.end = end;
                        range.sort = sort;
                        void (async () => {
                            await this.onSave();
                            this.onOpen();
                        })();
                    }, this.categoryData, range).open();
                };

                const delBtn = block.createDiv({ cls: 'range-delete-btn' });
                delBtn.setText('×');
                delBtn.onclick = async (e) => {
                    e.stopPropagation();
                    dayData!.ranges = dayData!.ranges.filter(r => r.id !== range.id);
                    await this.onSave();
                    this.onOpen();
                };
            }
        }
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
        this.draft = schemeData.schemes.map(s => ({
            ...s,
            days: (s.days ?? []).map(d => ({ ...d, ranges: [...d.ranges] })),
        }));
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
                    // 兜底：确保默认方案始终存在且位于首位
                    ensureDefaultScheme(this.schemeData, t('rangeScheme.defaultName'));
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

            // 设为默认
            const defaultBtn = row.createEl('button', {
                text: t('rangeScheme.isDefault'),
                cls: 'tbcat-action-btn',
            });
            if (scheme.id === this.schemeData.defaultSchemeId) {
                defaultBtn.addClass('is-active');
            }
            defaultBtn.addEventListener('click', () => {
                this.schemeData.schemes = this.draft;
                this.schemeData.defaultSchemeId = scheme.id;
                this.onConfirm?.();
                this.renderList();
            });

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

            // 删除（默认方案不可删除）
            if (scheme.id === DEFAULT_SCHEME_ID) {
                const lock = row.createEl('span', {
                    text: '🔒',
                    cls: 'tbcat-lock',
                });
                lock.setAttribute('aria-label', t('rangeScheme.defaultLocked'));
            } else {
                const del = row.createEl('button', {
                    text: '✕',
                    cls: 'tbcat-del-btn',
                });
                del.addEventListener('click', () => {
                    this.draft.splice(index, 1);
                    this.renderList();
                });
            }

            // 切换（设为当前方案）
            const switchBtn = row.createEl('button', {
                text: t('rangeScheme.switchTo'),
                cls: 'tbcat-action-btn',
            });
            if (scheme.id === this.schemeData.activeSchemeId) {
                switchBtn.addClass('is-active');
            }
            switchBtn.addEventListener('click', () => {
                this.schemeData.schemes = this.draft;
                this.schemeData.activeSchemeId = scheme.id;
                this.onConfirm?.();
                this.renderList();
            });
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
