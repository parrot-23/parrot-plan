

import { ItemView, WorkspaceLeaf, Modal, Setting, Notice, App } from 'obsidian';
import type { Plugin } from 'obsidian';
import type { WeekRangeData, CategorizedRange, TimeBlockCategoryId, RangeSchemeData, DailyRange, WeekKey } from './timeblock-data';
import { hexToTransparent, getCurrentWeekKey, makeWeekKey, parseWeekKey } from './timeblock-data';
import type { TimeBlockCategoryData } from './timeblock-category-manager';
import type { DayTemplateData } from './template-manager';
import { renderTimeBlockCategoryLegend } from './timeblock-category-manager';
import { renderDayTemplateRow } from './template-manager';
import { renderTaskPanel, DEFAULT_INBOX_DATA, type InboxData } from '../shared/task-panel';
import type { InboxItem } from '../shared/task-panel';
import { renderWeekGrid } from '../shared/week-grid';
import { RangeSchemeModal } from './range-scheme-modal';
import { t } from '../i18n';

export const VIEW_TYPE_WEEK = 'week-schedule-view';


export interface EventBlock {
    id: string;
    day: number;
    start: number;
    end: number;
    title: string;
    categoryId?: string;
    /** 来源收集盒任务 id（手动新建的事件无此字段） */
    inboxId?: string;
    /** 全天事件（start=0, end=1440） */
    allDay?: boolean;
    completed?: boolean;
    notePath?: string;
    /** 所属周键（如 2026-W40） */
    weekKey?: WeekKey;
}

export interface ExecutionRecord {
    id: string;
    eventId?: string;
    /** 来源收集盒任务 id（与事件一致，便于按任务聚合） */
    inboxId?: string;
    day: number;
    start: number;
    end: number;
    note?: string;
}


export class WeekScheduleView extends ItemView {
    plugin: Plugin;
    rangeData: WeekRangeData;
    // 日模板数据。
    dayTemplateData: DayTemplateData = {
        dayTemplates: [],
        dayProperties: [],
    };
    timeBlockCategoryData: TimeBlockCategoryData;
    /** 时间区间方案数据 */
    schemeData: RangeSchemeData = { schemes: [] };
    events: EventBlock[] = [];
    executions: ExecutionRecord[] = [];
    inboxData: InboxData = DEFAULT_INBOX_DATA;
    /** 当前显示的周键（如 2026-W40） */
    currentWeekKey: WeekKey = getCurrentWeekKey();
    /** 被主视图复用时的宿主容器（用于刷新） */
    private hostContainer?: HTMLElement;

    // Obsidian 旧 API：ItemView 构造函数只接受 leaf
    constructor(leaf: WorkspaceLeaf, plugin: Plugin, data: WeekRangeData, templateData: DayTemplateData, categoryData: TimeBlockCategoryData,
        events?: EventBlock[],
        executions?: ExecutionRecord[],
        inboxData?: InboxData,
        schemeData?: RangeSchemeData,
    ) {
        super(leaf);
        this.plugin = plugin;
        this.rangeData = data;
        this.dayTemplateData = templateData;
        this.timeBlockCategoryData = categoryData;
        this.events = events ?? [];
        this.executions = executions ?? [];
        this.inboxData = inboxData ?? DEFAULT_INBOX_DATA;
        this.schemeData = schemeData ?? { schemes: [] };
    }

    // 调用插件方法，存储数据。
    async save() {
        await this.plugin.saveData({
            version: 1,
            days: this.rangeData.days,   // 网格时间区块。
            weeks: this.rangeData.weeks, // 按周存储的日历区间
            dayTemplateData: this.dayTemplateData, // 日模板数据
            timeBlockCategoryData: this.timeBlockCategoryData, // 时间区块图例
            schemeData: this.schemeData, // 时间区间方案
            events: this.events,
            executions: this.executions,
            inboxData: this.inboxData,
        });
    }
 
    getViewType(): string { return VIEW_TYPE_WEEK; }
    getDisplayText(): string { return t('view.title'); }

    async onOpen() {
        // 若已被主视图渲染到指定容器，则刷新该容器；否则用自身视图容器
        const content = this.hostContainer ?? (this.containerEl.children[1] as HTMLElement);
        await this.renderInto(content);
    }

    /** 将周计划渲染到指定容器（供主视图复用） */
    async renderInto(content: HTMLElement) {
        this.hostContainer = content;
        content.empty();

        // 在容器内部创建 .week-schedule 根节点，避免与宿主容器样式冲突
        const root = content.createDiv({ cls: 'week-schedule' });

        // ===== 周网格骨架（公共组件）=====
        const { grid, headerRow, bodyRowInner } = renderWeekGrid(root, {
            onHeaderClick: (d) => {
                // 点击星期表头添加全天事件
                void this.addAllDayEvent(d);
            },
        });

        // ===== 日模板行（周计划特有）=====
        renderDayTemplateRow(
            headerRow.parentElement!,
            this.dayTemplateData.dayProperties,
            this.dayTemplateData.dayTemplates,
            (day) => {
                // 点击模板行单元格添加全天事件
                void this.addAllDayEvent(day);
            }
        );

        // ===== 全天事件行 =====
        this.renderAllDayRow(grid);

        // ===== 事件层 =====
        this.renderEventLayer(bodyRowInner);

        this.renderToolbar(root);
    }

    async onClose() {
        const content = this.containerEl.children[1] as HTMLElement;
        content.empty();
    }
   
    // ===== 全天事件行 =====
    private renderAllDayRow(grid: HTMLElement) {
        const row = grid.createDiv({ cls: 'all-day-row' });
        // 左侧占位（与时间轴对齐）
        const allDayCorner = row.createDiv({ cls: 'all-day-corner' });
        allDayCorner.setText(t('allday.label'));

        const cells = row.createDiv({ cls: 'all-day-cells' });
        for (let d = 1; d <= 7; d++) {
            const cell = cells.createDiv({ cls: 'all-day-cell' });

            // 已有全天事件
            const dayAllDay = this.events.filter(ev => ev.day === d && ev.allDay && ev.weekKey === this.currentWeekKey);
            for (const ev of dayAllDay) {
                const chip = cell.createDiv({ cls: 'all-day-chip' });
                const cat = ev.categoryId
                    ? this.timeBlockCategoryData.categories.find(c => c.id === ev.categoryId)
                    : undefined;
                chip.setCssProps({ '--chip-color': cat?.color ?? '#888888' });
                chip.setText(ev.title);

                // 可删除
                const delBtn = chip.createDiv({ cls: 'all-day-chip-del' });
                delBtn.setText('×');
                delBtn.onclick = async (e) => {
                    e.stopPropagation();
                    this.events = this.events.filter(x => x.id !== ev.id);
                    await this.save();
                    await this.onOpen();
                };
            }

            // 点击格子添加全天事件
            cell.onclick = (e) => {
                if ((e.target as HTMLElement).closest('.all-day-chip-del')) return;
                void this.addAllDayEvent(d);
            };
        }
    }

    // 添加全天事件（选中收集盒条目时）
    private async addAllDayEvent(day: number) {
        const selectedInboxItem = this.getSelectedInboxItem();
        if (!selectedInboxItem) {
            new Notice(t('allday.needSelect'));
            return;
        }
        this.events.push({
            id: `ev_${Date.now()}`,
            day,
            start: 0,
            end: 1440,
            title: selectedInboxItem.title,
            categoryId: selectedInboxItem.categoryId,
            inboxId: selectedInboxItem.id,
            allDay: true,
            completed: false,
            weekKey: this.currentWeekKey,
        });
        await this.save();
        await this.onOpen();
        new Notice(t('allday.added', { title: selectedInboxItem.title }));
    }

    // ===== 事件区块层（占位）=====
    private renderEventLayer(bodyRowInner: HTMLElement) {
        const cols = bodyRowInner.querySelectorAll('.day-column');
        for (let d = 1; d <= 7; d++) {
            const col = cols[d - 1] as HTMLElement;

            // ===== 渲染只读时间区块背景（当前激活方案）=====
            const dayData = this.getSchemeDays().find(day => day.day === d);
            const dayRanges = dayData?.ranges ?? [];
            for (const range of dayRanges) {
                const bgBlock = col.createDiv({ cls: 'range-block range-bg' });
                const cat = this.timeBlockCategoryData.categories.find(c => c.id === range.sort);
                const rawColor = cat?.color ?? '#888888';
                const afColor = this.hexToTransparent(rawColor, 0.5);

                const top = (range.start / 120) * 80;
                const height = ((range.end - range.start) / 120) * 80;
                bgBlock.setCssProps({
                    '--range-color': afColor,
                    '--range-top': `${top}px`,
                    '--range-height': `${height}px`,
                });
            }

            // 点击空白 → 新建事件（后续接弹窗）
            col.onclick = async (e) => {
                const target = e.target as HTMLElement;
                if (target.closest('.event-card')) return;

                const rect = col.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const startMinutes = Math.floor((y / 80) * 120 / 30) * 30;
                const endMinutes = startMinutes + 60;

                // ===== 新增：检查收集盒是否有选中条目 =====
                const selectedInboxItem = this.getSelectedInboxItem();
                if (selectedInboxItem) {
                    // 直接创建事件，标题和分类从收集盒条目继承，并记录来源任务
                    this.events.push({
                        id: `ev_${Date.now()}`,
                        day: d,
                        start: startMinutes,
                        end: endMinutes,
                        title: selectedInboxItem.title,
                        categoryId: selectedInboxItem.categoryId,
                        inboxId: selectedInboxItem.id,
                        completed: false,
                        weekKey: this.currentWeekKey,
                    });
                    await this.save();
                    await this.onOpen();
                    new Notice(t('event.scheduled', { title: selectedInboxItem.title }));
                    return;
                }

                // ===== 原有逻辑：弹窗新建 =====
                new EventEditModal(this.app, startMinutes, endMinutes, this.timeBlockCategoryData,
                    (title, start, end, categoryId) => {
                        this.events.push({
                            id: `ev_${Date.now()}`,
                            day: d,
                            start,
                            end,
                            title,
                            categoryId,
                            completed: false,
                            weekKey: this.currentWeekKey,
                        });
                        void (async () => {
                            await this.save();
                            await this.onOpen();
                        })();
                    }
                ).open();
            };

            // 渲染已有事件（排除全天事件，仅当前周）
            const dayEvents = this.events.filter(ev => ev.day === d && !ev.allDay && ev.weekKey === this.currentWeekKey);
            for (const ev of dayEvents) {
                const card = this.createEventCard(col, ev);
                const cat = ev.categoryId
                    ? this.timeBlockCategoryData.categories.find(c => c.id === ev.categoryId)
                    : undefined;

                const rawColor = cat?.color ?? '#888888';
                card.addClass('event-card-clickable');
                card.setCssProps({
                    '--card-color': rawColor,
                    '--card-bg': '#eeeeee88',
                });

                // ===== 右上角 × 删除按钮 =====
                const delBtn = card.createDiv({ cls: 'event-delete-btn' });
                delBtn.setText('×');
                delBtn.onclick = async (e) => {
                    e.stopPropagation();
                    this.events = this.events.filter(e => e.id !== ev.id);
                    await this.save();
                    await this.onOpen();
                };

                card.onclick = (e) => {
                    e.stopPropagation();
                    new EventEditModal(this.app, ev.start, ev.end, this.timeBlockCategoryData,
                        (title, start, end, categoryId) => {
                            ev.title = title;
                            ev.start = start;
                            ev.end = end;
                            ev.categoryId = categoryId;
                            void (async () => {
                                await this.save();
                                await this.onOpen();
                            })();
                        }, ev
                    ).open();
                };
            }
        }

        // 当前时间红线（仅当天列）
        this.renderCurrentTimeLine(bodyRowInner);
    }

    // ===== 公共：事件卡片（仅定位 + 基础外观）=====
    private createEventCard(col: HTMLElement, ev: EventBlock, title?: string): HTMLElement {
        const card = col.createDiv({ cls: 'event-card' });
        card.setCssProps({
            '--card-top': `${(ev.start / 120) * 80}px`,
            '--card-height': `${((ev.end - ev.start) / 120) * 80}px`,
        });
        card.setText(title ?? ev.title);
        return card;
    }

    // ===== 当前时间红线 =====
    private renderCurrentTimeLine(bodyRowInner: HTMLElement) {
        const now = new Date();
        const currentDay = (now.getDay() + 6) % 7 + 1;
        const totalMinutes = now.getHours() * 60 + now.getMinutes();

        const col = bodyRowInner.querySelectorAll('.day-column')[currentDay - 1] as HTMLElement;
        if (!col) return;

        const line = col.createDiv({ cls: 'current-time-line' });
        line.setCssProps({ '--line-top': `${(totalMinutes / 120) * 80}px` });

        // 滚动到红线位置（居中显示）
        const scrollContainer = bodyRowInner.closest('.grid-body-row');
        if (scrollContainer) {
            const lineTop = (totalMinutes / 120) * 80;
            scrollContainer.scrollTop = Math.max(0, lineTop - scrollContainer.clientHeight / 2);
        }
    }

    // ===== 年 / 周切换 =====
    private renderWeekNav(toolbar: HTMLElement) {
        const nav = toolbar.createDiv({ cls: 'week-nav' });
        const { year, week } = parseWeekKey(this.currentWeekKey);

        // 年份下拉（当前年 ±5）
        const yearSelect = nav.createEl('select', { cls: 'week-nav-select' });
        const nowYear = new Date().getFullYear();
        for (let y = nowYear - 5; y <= nowYear + 5; y++) {
            yearSelect.createEl('option', { text: `${y}`, value: `${y}` });
        }
        yearSelect.value = `${year}`;

        // 周号下拉（1-52）
        const weekSelect = nav.createEl('select', { cls: 'week-nav-select' });
        for (let w = 1; w <= 52; w++) {
            weekSelect.createEl('option', { text: `${t('weekNav.week')} ${w}`, value: `${w}` });
        }
        weekSelect.value = `${week}`;

        const apply = () => {
            this.currentWeekKey = makeWeekKey(Number(yearSelect.value), Number(weekSelect.value));
            void this.onOpen();
        };
        yearSelect.onchange = apply;
        weekSelect.onchange = apply;
    }

    // ===== 工具栏 =====
    private renderToolbar(content: HTMLElement) {
        const toolbar = content.createDiv({ cls: 'schedule-toolbar' });

        // 年 / 周切换
        this.renderWeekNav(toolbar);

        // 时间区间设置按钮
        const schemeBar = toolbar.createDiv({ cls: 'range-scheme-bar' });
        const schemeBtn = schemeBar.createEl('button', {
            text: t('rangeScheme.open'),
            cls: 'range-scheme-open-btn',
        });
        schemeBtn.onclick = () => {
            new RangeSchemeModal(
                this.app,
                this.timeBlockCategoryData,
                this.schemeData,
                this,
                (templateId, targetDays) => this.applyTemplate(templateId, targetDays),
                () => this.save(),
                () => {
                    void this.save();
                    void this.onOpen();
                },
            ).open();
        };

        // 当前时间区间方案下拉框
        const schemeSelect = schemeBar.createEl('select', { cls: 'range-scheme-select' });
        schemeSelect.createEl('option', {
            text: t('rangeScheme.noActive'),
            value: '',
        });
        for (const scheme of this.schemeData.schemes) {
            schemeSelect.createEl('option', { text: scheme.name, value: scheme.id });
        }
        schemeSelect.value = this.schemeData.activeSchemeId ?? '';
        schemeSelect.onchange = () => {
            this.schemeData.activeSchemeId = schemeSelect.value || undefined;
            void (async () => {
                await this.save();
                await this.onOpen();
            })();
        };

        // 图例
        const legendContainer = toolbar.createDiv({ cls: 'legend-container' });
        renderTimeBlockCategoryLegend(
            this.app,
            legendContainer,
            this.timeBlockCategoryData,
            () => {
                void this.onOpen();
            },
        );

        // 任务面板
        const inboxContainer = toolbar.createDiv({ cls: 'inbox-container' });
        renderTaskPanel(
            this.app,
            inboxContainer,
            this.inboxData,
            this.timeBlockCategoryData,
            async () => {
                // onAdd 回调
                await this.save();
            },
            () => {
                // onRefresh 回调
                void this.onOpen();
            },
            async (action, item) => {
                // 占位：后续实现各按钮功能
                new Notice(`[placeholder] ${action}: ${item.title}`);
            },
            async (item) => {              // onUpdate 回调
                await this.save();
            }
        );
    }

    /** 获取当前激活方案的日区间配置（周无关的模板数据） */
    getSchemeDays(): DailyRange[] {
        const scheme = this.schemeData.schemes.find(s => s.id === this.schemeData.activeSchemeId);
        return scheme?.days ?? [];
    }

    /** 应用日模板到指定日期（写入当前激活方案） */
    private async applyTemplate(templateId: string, targetDays: number[]) {
        const tpl = this.dayTemplateData.dayTemplates.find(t => t.id === templateId);
        if (!tpl) { new Notice(t('template.notFound')); return; }
        const scheme = this.schemeData.schemes.find(s => s.id === this.schemeData.activeSchemeId);
        if (!scheme) { new Notice(t('rangeScheme.noActive')); return; }
        if (!scheme.days) scheme.days = [];
        for (const day of targetDays) {
            let dayData = scheme.days.find(d => d.day === day);
            if (!dayData) { dayData = { day, ranges: [] }; scheme.days.push(dayData); }
            dayData.ranges = tpl.ranges.map(range => ({
                ...range,
                id: `r_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            }));
            let prop = this.dayTemplateData.dayProperties.find(p => p.day === day);
            if (prop) { prop.templateId = templateId; }
            else { this.dayTemplateData.dayProperties.push({ day, templateId }); }
        }
        await this.save();
        await this.onOpen();
    }

    
    // 工具方法
    private hexToTransparent(hex: string, alpha: number): string {
        return hexToTransparent(hex, alpha);
    }

    // 获取收集盒数据。
    private getSelectedInboxItem(): InboxItem | null {
        if (!this.inboxData.selectedId) return null;
        const item = this.inboxData.items.find(i => i.id === this.inboxData.selectedId);
        // 已移除的条目不可再排入
        if (!item || item.removed) return null;
        return item;
    }

}

// 时间区块。
// 弹窗。
export class RangeEditModal extends Modal {
    private start: number;
    private end: number;
    private sort: TimeBlockCategoryId;
    private onSubmit: (start: number, end: number, sort: TimeBlockCategoryId) => void;
    private categoryData: TimeBlockCategoryData;

    constructor(
        app: App,
        defaultStart: number,
        onSubmit: (start: number, end: number, sort: TimeBlockCategoryId) => void,
        categoryData: TimeBlockCategoryData,
        defaultRange?: CategorizedRange, // ✅ 新增可选默认值
        defaultSort?: string // 图例选中的分类
    ) {
        super(app);
        this.onSubmit = onSubmit;
        this.categoryData = categoryData;

        // ✅ 有默认值就用默认值，没有就走新建逻辑
        if (defaultRange) {
            this.start = defaultRange.start;
            this.end = defaultRange.end;
            this.sort = defaultRange.sort;
        } else {
            this.start = defaultStart;
            this.end = defaultStart + 120;
            this.sort = (defaultSort as TimeBlockCategoryId) ?? categoryData.categories[0]?.id ?? 'work';
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('range.title') });

        // 开始时间
        new Setting(contentEl)
            .setName(t('range.startTime'))
            .addDropdown(dropdown => {
                for (let h = 0; h < 24; h++) {
                    for (let m of [0, 30]) {
                        const val = h * 60 + m;
                        dropdown.addOption(
                            String(val),
                            `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
                        );
                    }
                }
                dropdown.setValue(String(this.start));
                dropdown.onChange(val => this.start = Number(val));
            });

        // 结束时间
        new Setting(contentEl)
            .setName(t('range.endTime'))
            .addDropdown(dropdown => {
                for (let h = 0; h < 24; h++) {
                    for (let m of [0, 30]) {
                        const val = h * 60 + m;
                        dropdown.addOption(
                            String(val),
                            `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
                        );
                    }
                }
                dropdown.setValue(String(this.end));
                dropdown.onChange(val => this.end = Number(val));
            });

        // 分类
        new Setting(contentEl)
            .setName(t('range.category'))
            .addDropdown(dropdown => {
               for (const cat of this.categoryData.categories) {
                    dropdown.addOption(cat.id, cat.label);
                }
                dropdown.setValue(this.sort);
                dropdown.onChange(val => this.sort = val);
            });

        // 按钮
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('common.save'))
                .setCta()
                .onClick(() => {
                    this.onSubmit(this.start, this.end, this.sort);
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText(t('common.cancel'))
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
    }

}



class EventEditModal extends Modal {
    private title: string = '';
    private start: number;
    private end: number;
    private categoryId: string;

    constructor(
        app: App,
        defaultStart: number,
        defaultEnd: number,
        private categoryData: TimeBlockCategoryData,
        private onSubmit: (title: string, start: number, end: number, categoryId?: string) => void,
        private defaultEvent?: EventBlock,
    ) {
        super(app);
        this.start = defaultStart;
        this.end = defaultEnd;
        this.categoryId = categoryData.categories[0]?.id ?? '';
        if (defaultEvent) {
            this.title = defaultEvent.title;
            this.start = defaultEvent.start;
            this.end = defaultEvent.end;
            this.categoryId = defaultEvent.categoryId ?? this.categoryId;
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: this.defaultEvent ? t('event.edit') : t('event.create') });

        new Setting(contentEl).setName(t('event.title')).addText(text => {
            text.setPlaceholder(t('event.titlePlaceholder')).setValue(this.title)
                .onChange(val => this.title = val);
        });

        new Setting(contentEl).setName(t('event.startTime')).addDropdown(dd => {
            for (let h = 0; h < 24; h++) {
                for (let m of [0, 30]) {
                    const val = h * 60 + m;
                    dd.addOption(String(val), `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
                }
            }
            dd.setValue(String(this.start)).onChange(val => this.start = Number(val));
        });

        new Setting(contentEl).setName(t('event.endTime')).addDropdown(dd => {
            for (let h = 0; h < 24; h++) {
                for (let m of [0, 30]) {
                    const val = h * 60 + m;
                    dd.addOption(String(val), `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
                }
            }
            dd.setValue(String(this.end)).onChange(val => this.end = Number(val));
        });

        new Setting(contentEl).setName(t('event.category')).addDropdown(dd => {
            dd.addOption('', t('event.noCategory'));
            for (const cat of this.categoryData.categories) {
                dd.addOption(cat.id, cat.label);
            }
            dd.setValue(this.categoryId).onChange(val => this.categoryId = val);
        });

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText(t('common.save')).setCta().onClick(() => {
                if (!this.title.trim()) { new Notice(t('event.titleRequired')); return; }
                this.onSubmit(this.title.trim(), this.start, this.end, this.categoryId || undefined);
                this.close();
            }))
            .addButton(btn => btn.setButtonText(t('common.cancel')).onClick(() => this.close()));
    }

    onClose() { this.contentEl.empty(); }
}

