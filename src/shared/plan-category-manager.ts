import { App, Modal, Setting } from 'obsidian';
import type { PlanCategoryId } from './plan-data';
import type { CategoryRepo } from '../repos/category-repo';
import { t } from '../i18n';


export interface PlanCategory {
    id: PlanCategoryId;
    label: string;
    color?: string;
}

export interface PlanCategoryData {
    categories: PlanCategory[];
}

/** 未分类：固定 id 与颜色，作为默认分类，不可删除 */
export const UNCATEGORIZED_CATEGORY_ID = 'uncategorized';
export const UNCATEGORIZED_CATEGORY_COLOR = '#888888';

/** 生成「未分类」分类对象（label 走 i18n） */
export function makeUncategorizedCategory(): PlanCategory {
    return {
        id: UNCATEGORIZED_CATEGORY_ID,
        label: t('defaultCategory.uncategorized'),
        color: UNCATEGORIZED_CATEGORY_COLOR,
    };
}

/** 确保分类列表中始终存在「未分类」，且位于首位（作为默认选择） */
export function ensureUncategorizedCategory(categoryData: PlanCategoryData): void {
    const list = categoryData.categories;
    const existing = list.find(c => c.id === UNCATEGORIZED_CATEGORY_ID);
    if (existing) {
        // 已存在：修正颜色并移到首位
        existing.color = UNCATEGORIZED_CATEGORY_COLOR;
        if (list[0] !== existing) {
            categoryData.categories = [existing, ...list.filter(c => c !== existing)];
        }
    } else {
        categoryData.categories = [makeUncategorizedCategory(), ...list];
    }
}

export function renderPlanCategoryLegend(    
    app: App,
    container: HTMLElement,
    categoryData: PlanCategoryData,
    onChange?: () => void,
    selectedId?: string,
    onSelect?: (id: string) => void,
    /** 是否显示配置（齿轮）按钮，默认显示 */
    showConfigButton: boolean = true,
    /** 分类领域仓库（提供后，配置弹窗保存走仓库方法，保证跨视图一致） */
    categoryRepo?: CategoryRepo,
): void {
    const legend = container.createDiv({ cls: 'range-legend' });
    legend.createDiv({ text: t('category.legend'), cls: 'legend-title' });

    for (const cat of categoryData.categories) {
        const row = legend.createDiv({ cls: 'legend-item' });
        if (cat.id === selectedId) row.addClass('is-selected');
        const swatch = row.createDiv({ cls: `legend-color` });
        swatch.setCssProps({ '--swatch-color': cat.color ?? '#888888' });
        row.createSpan({ text: cat.label });
        row.onclick = () => onSelect?.(cat.id);
    }

    // 齿轮按钮（可选，放在图例末尾）
    if (showConfigButton) {
        const gearBtn = legend.createDiv({ cls: 'category-gear-btn' });
        gearBtn.setText('⚙️');
        gearBtn.onclick = () => {
            new CategoryConfigModal(app, categoryData, () => {
                 onChange?.();
            }, categoryRepo).open();
        };
    }
}


export class CategoryConfigModal extends Modal {
    private categoryData: PlanCategoryData;
    private draft: PlanCategory[];
    private listEl!: HTMLElement;
    private onConfirm?: () => void;
    /** 分类领域仓库（提供后，保存走仓库方法，保证跨视图一致） */
    private categoryRepo?: CategoryRepo;

    constructor(
        app: App, 
        categoryData: PlanCategoryData,
        onConfirm?: () => void,
        categoryRepo?: CategoryRepo,
    ) {
        super(app);
        this.categoryData = categoryData;
        this.onConfirm = onConfirm;
        this.categoryRepo = categoryRepo;
        // 拷贝一份草稿，取消不影响原数据
        this.draft = categoryData.categories.map(c => ({ ...c }));
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        // 标题 + 右上角 +
        const header = contentEl.createDiv({ cls: 'tbcat-modal-header' });
        header.createEl('h3', { text: t('category.config') });

        const addBtn = header.createEl('button', {
            text: '+',
            cls: 'tbcat-add-btn',
        });
        addBtn.addEventListener('click', () => {
            this.draft.push({
                id: 'cat_' + Date.now().toString(36),
                label: t('category.new'),
                color: '#888888',
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
                    // 先不接 main.ts，验证用
                    if (this.categoryRepo) {
                        this.categoryRepo.replaceAll(this.draft);
                        // 兜底：确保「未分类」始终存在且位于首位
                        this.categoryRepo.ensureUncategorized();
                    } else {
                        this.categoryData.categories = this.draft;
                        // 兜底：确保「未分类」始终存在且位于首位
                        ensureUncategorizedCategory(this.categoryData);
                    }
                    this.onConfirm?.();
                    this.close();
                }));
    }

    private renderList() {
        this.listEl.empty();

        if (this.draft.length === 0) {
            this.listEl.createDiv({
                text: t('category.empty'),
                cls: 'tbcat-empty',
            });
            return;
        }

        this.draft.forEach((cat, index) => {
            const row = this.listEl.createDiv({ cls: 'tbcat-row' });

            // 色块
            const color = row.createEl('input', {
                type: 'color',
                cls: 'tbcat-color',
            });
            color.value = cat.color ?? '#888888';
            color.addEventListener('input', () => {
                cat.color = color.value;
            });

            // 名称
            const name = row.createEl('input', {
                type: 'text',
                placeholder: t('category.namePlaceholder'),
                cls: 'tbcat-name',
            });
            name.value = cat.label;
            name.addEventListener('input', () => {
                cat.label = name.value;
            });

            // 删除（「未分类」不可删除）
            if (cat.id === UNCATEGORIZED_CATEGORY_ID) {
                const lock = row.createSpan({
                    text: '🔒',
                    cls: 'tbcat-lock',
                });
                lock.setAttribute('aria-label', t('category.uncategorizedLocked'));
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
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
