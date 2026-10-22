// 卡片组件：封装单张卡片的外壳渲染与编辑态交互。
// 职责：创建 .wb-card 元素、定位/尺寸、应用皮肤、编辑态按钮（删除/设置/皮肤）、
// 拖拽/缩放、调用渲染器渲染内容。
// 工作台视图（WorkbenchView）只负责布局与卡片排布，把每张卡片交给本组件渲染。

import type { App } from 'obsidian';

import type { CardTemplate, DataSourceType } from '../datatypes/form';
import type { CardInstance } from '../datatypes/card';
import type { WorkbenchRepo } from '../repos/workbench-repo';
import type { GtdRepo } from '../repos/gtd-repo';
import { getCardRenderer } from './renderer/card-registry';
import { DATA_SOURCE_CATALOG, getDataSourceMeta } from '../datatypes/source-catalog';
import {
    SKIN_BACKGROUND_PRESETS,
    SKIN_SHADOW_OPTIONS,
    SKIN_SHADOW_CSS,
    SKIN_RADIUS_OPTIONS,
} from '../datatypes/skin';
import type { CardSkin } from '../datatypes/skin';
import type { CardRenderContext } from '../datatypes/renderer';
import type { DataProvider } from '../datatypes/chart';
import { createDataProvider } from './engine/provider';
import type { EventBlock, ExecutionRecord } from '../datatypes/domain';
import type { InboxItem } from '../datatypes/domain';
import { t } from '../i18n';

/** 网格单位（像素） */
const GRID = 30;
/** 卡片默认宽高（像素） */
const DEFAULT_W = 300;
const DEFAULT_H = 240;
/** 卡片最小宽高（像素） */
const MIN_W = 180;
const MIN_H = 120;

/** 吸附到网格 */
function snap(v: number): number {
    return Math.round(v / GRID) * GRID;
}

/** 向上取整到网格 */
function snapUp(v: number): number {
    return Math.ceil(v / GRID) * GRID;
}

/** 卡片组件依赖（由工作台视图注入） */
export interface CardComponentDeps {
    app: App;
    workbenchRepo: WorkbenchRepo;
    save: () => Promise<void>;
    /** 重新渲染整个工作台 */
    refresh: () => void;
    /** 拖拽/缩放后做碰撞避让 */
    resolveCollisions: () => void;
    getEvents: () => EventBlock[];
    getExecutions: () => ExecutionRecord[];
    getInboxItems: () => InboxItem[];
    addGtdItem: (content: string) => Promise<void>;
    gtdRepo: GtdRepo;
    templates: CardTemplate[];
}

/**
 * 卡片组件：把一张卡片实例渲染到画布，并挂载编辑态交互。
 */
export class CardComponent {
    private deps: CardComponentDeps;

    constructor(deps: CardComponentDeps) {
        this.deps = deps;
    }

    /**
     * 渲染卡片到画布。
     * @param grid 画布容器
     * @param instance 卡片实例
     * @param pos 网格坐标（col/row）
     * @param editing 是否处于编辑布局态
     */
    render(grid: HTMLElement, instance: CardInstance, pos: { col: number; row: number }, editing: boolean): void {
        const template = this.deps.templates.find((t) => t.id === instance.templateId);
        if (!template) return;

        const card = grid.createDiv({ cls: 'wb-card' });
        // 按渲染器类型加标识类，便于针对特定卡片类型定制样式（如 list 卡片需允许溢出）
        card.addClass(`wb-card-${template.renderer}`);
        card.style.setProperty('left', `${pos.col * GRID}px`);
        card.style.setProperty('top', `${pos.row * GRID}px`);

        const w = snap(instance.width ?? DEFAULT_W);
        const h = snap(instance.height ?? DEFAULT_H);
        card.style.setProperty('width', `${w}px`);
        card.style.setProperty('height', `${h}px`);

        // 应用皮肤
        this.applySkin(card, instance.skin);

        // 编辑态：按钮 + 缩放手柄
        if (editing) {
            card.addClass('is-editing');
            this.renderHeader(card, instance, template);
            this.renderResizeHandles(card, instance);
        }

        // 渲染内容
        const body = card.createDiv({ cls: 'wb-card-content' });

        // 标题：编辑布局时显示为输入框，非编辑态显示为普通文本
        this.renderTitle(body, instance, template, editing);

        const renderer = getCardRenderer(template.renderer);
        const ctx: CardRenderContext = {
            app: this.deps.app,
            save: this.deps.save,
            refresh: this.deps.refresh,
            provider: createDataProvider(this.deps.getEvents, this.deps.getExecutions, this.deps.getInboxItems),
            addGtdItem: this.deps.addGtdItem,
            getGtdItems: () => this.deps.gtdRepo.data.items,
            removeGtdItem: async (id: string) => {
                this.deps.gtdRepo.removeItem(id);
                await this.deps.save();
            },
        };
        renderer.render(body, instance, template, ctx);
    }

    /** 渲染卡片标题：编辑布局时为输入框，非编辑态为普通文本 */
    private renderTitle(container: HTMLElement, instance: CardInstance, template: CardTemplate, editing: boolean) {
        if (!editing) {
            // 标题允许为空：为空时不渲染标题行
            const title = instance.title ?? template.name;
            if (title) container.createDiv({ cls: 'wb-card-title', text: title });
            return;
        }

        const input = container.createEl('input', {
            cls: 'wb-card-title-input',
            attr: { type: 'text', placeholder: template.name },
        });
        input.value = instance.title ?? '';
        input.onchange = () => {
            // 标题允许为空：清空后保存为空字符串，不再回退到模板名
            instance.title = input.value.trim();
            void this.deps.save();
        };
    }

    /** 渲染编辑态头部按钮（删除 / 设置 / 皮肤） */
    private renderHeader(card: HTMLElement, instance: CardInstance, template: CardTemplate) {
        // 顶部中间的拖拽手柄：按住拖动整张卡片
        const dragHandle = card.createDiv({ cls: 'wb-card-drag-handle' });
        this.attachDrag(dragHandle, card, instance);

        const header = card.createDiv({ cls: 'wb-card-header' });

        const delBtn = header.createEl('button', { cls: 'wb-card-delete', text: '×' });
        delBtn.onclick = () => {
            this.deps.workbenchRepo.removeInstance(instance.id);
            void this.deps.save().then(() => this.deps.refresh());
        };

        const settingsBtn = header.createEl('button', { cls: 'wb-card-settings', text: '⚙' });
        settingsBtn.onclick = () => this.showSettings(settingsBtn, card, instance, template);

        const skinBtn = header.createEl('button', { cls: 'wb-card-skin', text: '🎨' });
        skinBtn.onclick = () => this.showSkinPanel(skinBtn, card, instance);
    }

    /** 应用皮肤样式 */
    private applySkin(card: HTMLElement, skin?: CardSkin) {
        if (!skin) return;
        if (skin.background) card.style.setProperty('background', skin.background);
        if (skin.shadow) card.style.setProperty('box-shadow', SKIN_SHADOW_CSS[skin.shadow]);
        if (skin.radius !== undefined) card.style.setProperty('border-radius', `${skin.radius}px`);
    }

    /** 弹出设置面板（数据源 + 聚合方式） */
    private showSettings(anchor: HTMLElement, card: HTMLElement, instance: CardInstance, template: CardTemplate) {
        card.querySelectorAll('.wb-card-settings-panel').forEach((el) => el.remove());
        const panel = card.createDiv({ cls: 'wb-card-settings-panel' });

        if (template.renderer !== 'stats') {
            panel.createDiv({ cls: 'wb-card-settings-empty', text: t('workbench.settingsNoConfig') });
        } else {
            const currentSource = instance.source ?? template.source;
            const currentDataSource = currentSource?.dataSource ?? 'executions';
            const currentAggregation = currentSource?.aggregation ?? 'count';
            const chart = instance.source?.chart ?? template.source?.chart;

            panel.createDiv({ cls: 'wb-card-settings-label', text: t('workbench.settingsDataSource') });
            const dsSelect = panel.createEl('select', { cls: 'wb-card-settings-select' });
            for (const meta of DATA_SOURCE_CATALOG) {
                const opt = dsSelect.createEl('option', { text: meta.label, value: meta.key });
                if (meta.key === currentDataSource) opt.selected = true;
            }

            panel.createDiv({ cls: 'wb-card-settings-label', text: t('workbench.settingsAggregation') });
            const aggSelect = panel.createEl('select', { cls: 'wb-card-settings-select' });

            const renderAggregations = (dataSource: string) => {
                aggSelect.empty();
                const meta = getDataSourceMeta(dataSource as DataSourceType);
                if (!meta) return;
                for (const agg of meta.aggregations) {
                    const opt = aggSelect.createEl('option', { text: agg.label, value: agg.key });
                    if (agg.key === currentAggregation) opt.selected = true;
                }
            };
            renderAggregations(currentDataSource);

            const apply = () => {
                const dataSource = dsSelect.value;
                const aggregation = aggSelect.value;
                const meta = getDataSourceMeta(dataSource as DataSourceType);
                const aggDef = meta?.aggregations.find((a) => a.key === aggregation);
                const params: Record<string, unknown> = {};
                for (const p of aggDef?.params ?? []) {
                    if (p.default !== undefined) params[p.key] = p.default;
                }
                this.deps.workbenchRepo.updateInstance(instance.id, {
                    source: { dataSource: dataSource as DataSourceType, aggregation, chart, params },
                });
                void this.deps.save().then(() => this.deps.refresh());
            };

            dsSelect.onchange = () => {
                renderAggregations(dsSelect.value);
                apply();
            };
            aggSelect.onchange = () => apply();
        }

        this.closeOnOutsideClick(panel, anchor);
    }

    /** 弹出皮肤配置面板 */
    private showSkinPanel(anchor: HTMLElement, card: HTMLElement, instance: CardInstance) {
        card.querySelectorAll('.wb-card-skin-panel').forEach((el) => el.remove());
        const panel = card.createDiv({ cls: 'wb-card-skin-panel' });
        const skin: CardSkin = instance.skin ?? {};

        panel.createDiv({ cls: 'wb-card-settings-label', text: t('workbench.skinBackground') });
        const bgSelect = panel.createEl('select', { cls: 'wb-card-settings-select' });
        for (const preset of SKIN_BACKGROUND_PRESETS) {
            const opt = bgSelect.createEl('option', { text: preset.label, value: preset.value });
            if ((skin.background ?? '') === preset.value) opt.selected = true;
        }

        panel.createDiv({ cls: 'wb-card-settings-label', text: t('workbench.skinShadow') });
        const shadowSelect = panel.createEl('select', { cls: 'wb-card-settings-select' });
        for (const opt of SKIN_SHADOW_OPTIONS) {
            const el = shadowSelect.createEl('option', { text: opt.label, value: opt.value ?? '' });
            if ((skin.shadow ?? '') === (opt.value ?? '')) el.selected = true;
        }

        panel.createDiv({ cls: 'wb-card-settings-label', text: t('workbench.skinRadius') });
        const radiusSelect = panel.createEl('select', { cls: 'wb-card-settings-select' });
        const radiusOptions = [
            { label: t('workbench.skinRadiusDefault'), value: '' },
            ...SKIN_RADIUS_OPTIONS.map((r) => ({ label: r.label, value: String(r.value) })),
        ];
        for (const opt of radiusOptions) {
            const el = radiusSelect.createEl('option', { text: opt.label, value: opt.value });
            const current = skin.radius !== undefined ? String(skin.radius) : '';
            if (current === opt.value) el.selected = true;
        }

        const apply = () => {
            const next: CardSkin = {};
            if (bgSelect.value) next.background = bgSelect.value;
            if (shadowSelect.value) next.shadow = shadowSelect.value as CardSkin['shadow'];
            if (radiusSelect.value) next.radius = Number(radiusSelect.value);

            this.deps.workbenchRepo.updateInstance(instance.id, { skin: next });
            this.applySkin(card, next);
            void this.deps.save();
        };

        bgSelect.onchange = apply;
        shadowSelect.onchange = apply;
        radiusSelect.onchange = apply;

        this.closeOnOutsideClick(panel, anchor);
    }

    /** 渲染缩放手柄（四角 + 四边） */
    private renderResizeHandles(card: HTMLElement, instance: CardInstance) {
        const corners: Array<'nw' | 'ne' | 'sw' | 'se'> = ['nw', 'ne', 'sw', 'se'];
        for (const corner of corners) {
            const dot = card.createDiv({ cls: `wb-card-handle wb-card-handle-${corner}` });
            this.attachResize(dot, card, instance, corner);
        }
        const edges: Array<'n' | 's' | 'w' | 'e'> = ['n', 's', 'w', 'e'];
        for (const edge of edges) {
            const bar = card.createDiv({ cls: `wb-card-edge wb-card-edge-${edge}` });
            this.attachResize(bar, card, instance, edge);
        }
    }

    /** 绑定尺寸调整 */
    private attachResize(
        handle: HTMLElement,
        card: HTMLElement,
        instance: CardInstance,
        dir: 'n' | 's' | 'w' | 'e' | 'nw' | 'ne' | 'sw' | 'se',
    ) {
        handle.onmousedown = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            const startX = e.clientX;
            const startY = e.clientY;
            const startW = card.offsetWidth;
            const startH = card.offsetHeight;

            const onMove = (ev: MouseEvent) => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                let w = startW;
                let h = startH;
                if (dir.includes('e')) w = Math.max(MIN_W, startW + dx);
                if (dir.includes('w')) w = Math.max(MIN_W, startW - dx);
                if (dir.includes('s')) h = Math.max(MIN_H, startH + dy);
                if (dir.includes('n')) h = Math.max(MIN_H, startH - dy);
                card.style.setProperty('width', `${w}px`);
                card.style.setProperty('height', `${h}px`);
            };

            const onUp = (ev: MouseEvent) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                let w = startW;
                let h = startH;
                if (dir.includes('e')) w = Math.max(MIN_W, startW + dx);
                if (dir.includes('w')) w = Math.max(MIN_W, startW - dx);
                if (dir.includes('s')) h = Math.max(MIN_H, startH + dy);
                if (dir.includes('n')) h = Math.max(MIN_H, startH - dy);
                this.deps.workbenchRepo.updateInstance(instance.id, { width: snapUp(w), height: snapUp(h) });
                this.deps.resolveCollisions();
                void this.deps.save().then(() => this.deps.refresh());
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
    }

    /** 绑定卡片位置拖动 */
    private attachDrag(handleEl: HTMLElement, card: HTMLElement, instance: CardInstance) {
        handleEl.onmousedown = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            card.addClass('is-dragging');
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = card.offsetLeft;
            const startTop = card.offsetTop;
            const gridWidth = card.parentElement?.clientWidth ?? 0;
            const cardW = card.offsetWidth;

            const clampLeft = (raw: number) => {
                const maxLeft = Math.max(0, gridWidth - cardW);
                return Math.max(0, Math.min(raw, maxLeft));
            };

            const onMove = (ev: MouseEvent) => {
                const left = clampLeft(snap(startLeft + (ev.clientX - startX)));
                const top = Math.max(0, snap(startTop + (ev.clientY - startY)));
                card.style.setProperty('left', `${left}px`);
                card.style.setProperty('top', `${top}px`);
            };

            const onUp = (ev: MouseEvent) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                card.removeClass('is-dragging');

                const left = clampLeft(snap(startLeft + (ev.clientX - startX)));
                const top = Math.max(0, snap(startTop + (ev.clientY - startY)));
                this.deps.workbenchRepo.updateInstance(instance.id, {
                    col: Math.round(left / GRID),
                    row: Math.round(top / GRID),
                });
                this.deps.resolveCollisions();
                void this.deps.save().then(() => this.deps.refresh());
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
    }

    /** 点击面板外部关闭 */
    private closeOnOutsideClick(panel: HTMLElement, anchor: HTMLElement) {
        const close = (e: MouseEvent) => {
            if (!panel.contains(e.target as Node) && e.target !== anchor) {
                panel.remove();
                document.removeEventListener('click', close);
            }
        };
        window.setTimeout(() => document.addEventListener('click', close), 0);
    }
}

/** 无外壳内容渲染的上下文：供内嵌场景（非工作台画布）复用卡片渲染管线 */
export interface CardContentRenderOptions {
    app: App;
    save: () => Promise<void>;
    refresh: () => void;
    provider: DataProvider;
}

/**
 * 按卡片机制渲染卡片内容（template → renderer → aggregate），不创建工作台卡片外壳。
 * 供工作台之外的内嵌场景（如任务关注方框的项目活跃度柱状图）复用同一套渲染管线。
 */
export function renderCardContent(
    container: HTMLElement,
    instance: CardInstance,
    template: CardTemplate,
    opts: CardContentRenderOptions,
): void {
    const renderer = getCardRenderer(template.renderer);
    const ctx: CardRenderContext = {
        app: opts.app,
        save: opts.save,
        refresh: opts.refresh,
        provider: opts.provider,
    };
    renderer.render(container, instance, template, ctx);
}
