

import { ItemView, WorkspaceLeaf, Modal, Setting, Notice, App } from 'obsidian';
import type { Plugin } from 'obsidian';
import type { WeekRangeData, CategorizedRange, TimeBlockCategoryId, RangeSchemeData } from './timeblock-data';
import type { TimeBlockCategoryData } from './timeblock-category-manager';
import type { DayTemplateData } from './template-manager';
import { renderTimeBlockCategoryLegend } from './timeblock-category-manager';
import { renderDayTemplateRow } from './template-manager';
import { renderTaskPanel, DEFAULT_INBOX_DATA, type InboxData } from '../shared/task-panel';
import type { InboxItem } from '../shared/task-panel';
import { renderWeekGrid } from '../shared/week-grid';
import { RangeSchemeModal } from './range-scheme-modal';
import { t, getWeekDays } from '../i18n';

export const VIEW_TYPE_WEEK = 'week-schedule-view';


// 定义层级。
type EditLayer = 'time-range' | 'event' | 'execution';

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
    activeLayer: EditLayer = 'time-range';
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
    /** 图例中选中的分类（新建时间区块时的默认分类） */
    selectedCategoryId?: string;

    private readonly layers: { value: EditLayer; label: string; disabled: boolean }[] = [
        { value: 'time-range', label: t('view.layer.timeRange'), disabled: false },
        { value: 'event', label: t('view.layer.event'), disabled: false },
        { value: 'execution', label: t('view.layer.execution'), disabled: false },
    ];
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
        const content = this.containerEl.children[1] as HTMLElement;
        await this.renderInto(content);
    }

    /** 将周计划渲染到指定容器（供主视图复用） */
    async renderInto(content: HTMLElement) {
        content.empty();

        // 在容器内部创建 .week-schedule 根节点，避免与宿主容器样式冲突
        const root = content.createDiv({ cls: 'week-schedule' });

        // ===== 周网格骨架（公共组件）=====
        const { grid, headerRow, bodyRowInner } = renderWeekGrid(root, {
            onHeaderClick: (d) => {
                // 事件层：点击星期表头添加全天事件
                if (this.activeLayer === 'event') {
                    void this.addAllDayEvent(d);
                }
            },
        });

        // ===== 日模板行（周计划特有）=====
        renderDayTemplateRow(
            headerRow.parentElement!,
            this.dayTemplateData.dayProperties,
            this.dayTemplateData.dayTemplates,
            (day) => {
                // 事件层：点击模板行单元格添加全天事件
                if (this.activeLayer === 'event') {
                    void this.addAllDayEvent(day);
                }
            }
        );

        // ===== 全天事件行（事件层 / 执行层显示）=====
        if (this.activeLayer === 'event' || this.activeLayer === 'execution') {
            this.renderAllDayRow(grid);
        }

        // ===== 层级分支（传已创建好的容器）=====
        switch (this.activeLayer) {
            case 'time-range':
                this.renderTimeRangeLayer(bodyRowInner);
                break;
            case 'event':
                this.renderEventLayer(bodyRowInner);
                break;
            case 'execution':
                this.renderExecutionLayer(bodyRowInner);
                break;
        }

        this.renderToolbar(root);
    }

    async onClose() {
        const content = this.containerEl.children[1] as HTMLElement;
        content.empty();
    }
   
    // ===== 时间区块层（原逻辑完整搬入）=====
    private renderTimeRangeLayer(bodyRowInner: HTMLElement) {

        const cols = bodyRowInner.querySelectorAll('.day-column');
        for (let d = 1; d <= 7; d++) {
            const col = cols[d - 1] as HTMLElement;

            // 点击空白 → 新建时间区块
            col.onclick = (e) => {
                if (this.activeLayer !== 'time-range') return;
                const target = e.target as HTMLElement;
                if (!target.classList.contains('day-column') && !target.classList.contains('hour-cell')) return;
                const rect = col.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const startMinutes = Math.floor((y / 80) * 120 / 30) * 30;
                new RangeEditModal(this.app, startMinutes, (start, end, sort) => {
                    let dayData = this.rangeData.days.find(day => day.day === d);
                    if (!dayData) {
                        dayData = { day: d, ranges: [] };
                        this.rangeData.days.push(dayData);
                    }
                    const id = `r_${Date.now()}`;
                    dayData.ranges.push({ id, start, end, sort });
                    void (async () => {
                        await this.save();
                        await this.onOpen();
                    })();
                }, this.timeBlockCategoryData, undefined, this.selectedCategoryId).open();
            };

            // 已有色块
            const dayData = this.rangeData.days.find(day => day.day === d);
            const dayRanges = dayData?.ranges ?? [];
            for (const range of dayRanges) {
                const block = col.createDiv({ cls: 'range-block range-block-fill' });
                const cat = this.timeBlockCategoryData.categories.find(c => c.id === range.sort);
                const rawColor = cat?.color ?? '#888888';

                const top = (range.start / 120) * 80;
                const height = ((range.end - range.start) / 120) * 80;
                block.setCssProps({
                    '--range-color': rawColor,
                    '--range-bg': this.hexToTransparent(rawColor, 0.1),
                    '--range-top': `${top}px`,
                    '--range-height': `${height}px`,
                });

                block.onclick = (e) => {
                    e.stopPropagation();
                    if (this.activeLayer !== 'time-range') return;
                    new RangeEditModal(this.app, 0, (start, end, sort) => {
                        range.start = start;
                        range.end = end;
                        range.sort = sort;
                        void (async () => {
                            await this.save();
                            await this.onOpen();
                        })();
                    }, this.timeBlockCategoryData, range).open();
                };

                const delBtn = block.createDiv({ cls: 'range-delete-btn' });
                delBtn.setText('×');
                delBtn.onclick = async (e) => {
                    e.stopPropagation();
                    if (this.activeLayer !== 'time-range') return;
                    dayData!.ranges = dayData!.ranges.filter(r => r.id !== range.id);
                    await this.save();
                    await this.onOpen();
                };
            }
        }
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
            const dayAllDay = this.events.filter(ev => ev.day === d && ev.allDay);
            for (const ev of dayAllDay) {
                const chip = cell.createDiv({ cls: 'all-day-chip' });
                const cat = ev.categoryId
                    ? this.timeBlockCategoryData.categories.find(c => c.id === ev.categoryId)
                    : undefined;
                chip.setCssProps({ '--chip-color': cat?.color ?? '#888888' });
                chip.setText(ev.title);

                // 事件层：可删除
                if (this.activeLayer === 'event') {
                    const delBtn = chip.createDiv({ cls: 'all-day-chip-del' });
                    delBtn.setText('×');
                    delBtn.onclick = async (e) => {
                        e.stopPropagation();
                        this.events = this.events.filter(x => x.id !== ev.id);
                        await this.save();
                        await this.onOpen();
                    };
                }
            }

            // 事件层：点击格子添加全天事件
            if (this.activeLayer === 'event') {
                cell.onclick = (e) => {
                    if ((e.target as HTMLElement).closest('.all-day-chip-del')) return;
                    void this.addAllDayEvent(d);
                };
            }
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

            // ===== 新增：渲染只读时间区块背景 =====
            const dayData = this.rangeData.days.find(day => day.day === d);
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
                if (this.activeLayer !== 'event') return;
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
                        });
                        void (async () => {
                            await this.save();
                            await this.onOpen();
                        })();
                    }
                ).open();
            };

            // 渲染已有事件（排除全天事件）
            const dayEvents = this.events.filter(ev => ev.day === d && !ev.allDay);
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

    // ===== 执行层 =====
    private renderExecutionLayer(bodyRowInner: HTMLElement) {
        const now = new Date();
        const currentDay = (now.getDay() + 6) % 7 + 1;
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        const cols = bodyRowInner.querySelectorAll('.day-column');
        for (let d = 1; d <= 7; d++) {
            const col = cols[d - 1] as HTMLElement;

            // 只读时间区块背景
            const dayData = this.rangeData.days.find(day => day.day === d);
            const dayRanges = dayData?.ranges ?? [];
            for (const range of dayRanges) {
                const bgBlock = col.createDiv({ cls: 'range-block range-bg' });
                const cat = this.timeBlockCategoryData.categories.find(c => c.id === range.sort);
                const rawColor = cat?.color ?? '#888888';
                const afColor = this.hexToTransparent(rawColor, 0.5);
                bgBlock.setCssProps({
                    '--range-color': afColor,
                    '--range-top': `${(range.start / 120) * 80}px`,
                    '--range-height': `${((range.end - range.start) / 120) * 80}px`,
                });
            }

            // 事件卡片（只读展示，排除全天事件）
            const dayEvents = this.events.filter(ev => ev.day === d && !ev.allDay);
            for (const ev of dayEvents) {
                // 执行记录：该计划事件对应的实际执行
                const record = this.executions.find(ex => ex.eventId === ev.id);
                // 实际执行的任务（有记录则用记录里的任务，否则用计划任务）
                const actualInboxId = record?.inboxId ?? ev.inboxId;
                const actualTask = actualInboxId
                    ? this.inboxData.items.find(i => i.id === actualInboxId)
                    : undefined;
                const displayTitle = actualTask?.title ?? ev.title;
                const displayCategoryId = actualTask?.categoryId ?? ev.categoryId;

                const card = this.createEventCard(col, ev, displayTitle);

                // 颜色区分：本周已过的时间点用彩色，未过的用灰色
                const isPast = d < currentDay || (d === currentDay && ev.end <= currentMinutes);
                if (isPast) {
                    const cat = displayCategoryId
                        ? this.timeBlockCategoryData.categories.find(c => c.id === displayCategoryId)
                        : undefined;
                    const rawColor = cat?.color ?? '#888888';
                    card.setCssProps({
                        '--card-color': rawColor,
                        '--card-bg': this.hexToTransparent(rawColor, 0.15),
                    });
                } else {
                    card.addClass('event-card-pending');
                }

                // 当天已过的时间点：未处理则显示 ! 标识（纯状态展示，处理走信息面板）
                const isToday = d === currentDay;
                const isHandled = !!record;
                if (isToday && isPast && !isHandled) {
                    const mark = card.createDiv({ cls: 'event-confirm-mark' });
                    mark.setText('!');
                }

                // 点击卡片 → 打开信息面板
                card.addClass('event-card-clickable');
                card.onclick = (e) => {
                    e.stopPropagation();
                    // 任务记录：同一来源任务（inboxId）在所有时间点的执行记录
                    const taskRecords = ev.inboxId
                        ? this.executions.filter(ex => ex.inboxId === ev.inboxId)
                        : this.executions.filter(ex => ex.eventId === ev.id);
                    new ExecutionInfoModal(
                        this.app,
                        ev,
                        taskRecords,
                        isHandled,
                        this.inboxData.items,
                        displayTitle,
                        async (action, note, changedTask) => {
                            if (action === 'confirm') {
                                // 一个计划事件只能确认一次
                                if (this.executions.some(ex => ex.eventId === ev.id)) return;
                                this.executions.push({
                                    id: `ex_${Date.now()}`,
                                    eventId: ev.id,
                                    inboxId: ev.inboxId,
                                    day: ev.day,
                                    start: ev.start,
                                    end: ev.end,
                                    note,
                                });
                            } else if (action === 'change' && changedTask) {
                                // 变更执行：实际做的是另一个任务（不改计划层）
                                let inboxId = changedTask.inboxId;
                                // 手动新任务：加入收集盒，拿到真实 id
                                if (!inboxId) {
                                    const newItem: InboxItem = {
                                        id: `inbox_${Date.now()}`,
                                        title: changedTask.title,
                                        description: '',
                                        createdAt: Date.now(),
                                    };
                                    this.inboxData.items.unshift(newItem);
                                    inboxId = newItem.id;
                                }
                                // 执行记录：eventId 关联计划事件，inboxId 记录实际任务
                                this.executions.push({
                                    id: `ex_${Date.now()}`,
                                    eventId: ev.id,
                                    inboxId,
                                    day: ev.day,
                                    start: ev.start,
                                    end: ev.end,
                                    note,
                                });
                            }
                            await this.save();
                            await this.onOpen();
                        }
                    ).open();
                };
            }
        }

        // 当前时间红线（仅当天列）
        this.renderCurrentTimeLine(bodyRowInner);
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

    // ===== 工具栏 =====
    private renderToolbar(content: HTMLElement) {
        const toolbar = content.createDiv({ cls: 'schedule-toolbar' });

        // 层级选择
        const layerBar = toolbar.createDiv({ cls: 'layer-bar' });
        layerBar.createSpan({ text: t('view.layer'), cls: 'layer-label' });
        const select = layerBar.createEl('select', { cls: 'layer-select' });
        for (const layer of this.layers) {
            const opt = select.createEl('option', { text: layer.label, value: layer.value });
            if (layer.disabled) opt.disabled = true;
        }
        select.value = this.activeLayer;
        select.onchange = () => {
            this.activeLayer = select.value as EditLayer;
            void this.onOpen();
        };

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
                () => {
                    void this.save();
                    void this.onOpen();
                },
            ).open();
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
            this.selectedCategoryId,
            (id) => {
                // 点击图例选中/取消选中分类
                this.selectedCategoryId = this.selectedCategoryId === id ? undefined : id;
                void this.onOpen();
            }
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

    /** 应用日模板到指定日期（供时间区间弹窗的模板面板调用） */
    private async applyTemplate(templateId: string, targetDays: number[]) {
        const tpl = this.dayTemplateData.dayTemplates.find(t => t.id === templateId);
        if (!tpl) { new Notice(t('template.notFound')); return; }
        for (const day of targetDays) {
            let dayData = this.rangeData.days.find(d => d.day === day);
            if (!dayData) { dayData = { day, ranges: [] }; this.rangeData.days.push(dayData); }
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
        // 支持 #rgb 和 #rrggbb
        let h = hex.replace('#', '');
        if (h.length === 3) {
            h = h.split('').map(c => c + c).join('');
        }
        const r = parseInt(h.slice(0, 2), 16);
        const g = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
class RangeEditModal extends Modal {
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


// ===== 执行信息面板 =====
class ExecutionInfoModal extends Modal {
    private note: string = '';
    /** 变更执行时选中的任务 */
    private changedInboxId: string | undefined = undefined;
    private changedTitle: string = '';
    /** 变更执行时手动添加的新任务 */
    private manualTasks: { id: string; title: string }[] = [];
    /** 变更选择区容器 */
    private changePanelEl!: HTMLElement;
    /** 原事件信息区容器 */
    private infoPanelEl!: HTMLElement;

    constructor(
        app: App,
        private event: EventBlock,
        private records: ExecutionRecord[],
        private isHandled: boolean,
        private inboxItems: InboxItem[],
        private actualTitle: string,
        private onSubmit: (action: 'confirm' | 'change', note: string, changedTask?: { inboxId?: string; title: string }) => void | Promise<void>,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        // 原事件信息区（变更执行时隐藏）
        this.infoPanelEl = contentEl.createDiv({ cls: 'exec-info-panel' });
        this.infoPanelEl.createEl('h3', { text: this.event.title });

        // 实际执行的任务（与计划不同时提示）
        if (this.actualTitle && this.actualTitle !== this.event.title) {
            this.infoPanelEl.createDiv({
                text: t('exec.actual', { title: this.actualTitle }),
                cls: 'exec-info-actual',
            });
        }

        // 执行次数（该任务累计）
        this.infoPanelEl.createDiv({
            text: t('exec.count', { count: this.records.length }),
            cls: 'exec-info-count',
        });

        // 任务记录：该任务在哪些时间点被执行过
        this.infoPanelEl.createDiv({ text: t('exec.records'), cls: 'exec-info-subtitle' });
        const recordList = this.infoPanelEl.createDiv({ cls: 'exec-info-records' });
        if (this.records.length === 0) {
            recordList.createDiv({ cls: 'exec-info-empty', text: t('exec.noRecords') });
        } else {
            for (const rec of this.records) {
                const row = recordList.createDiv({ cls: 'exec-info-record' });
                row.createSpan({
                    text: `${this.formatDay(rec.day)} ${this.formatTime(rec.start)} - ${this.formatTime(rec.end)}`,
                    cls: 'exec-info-record-time',
                });
                if (rec.note) {
                    row.createSpan({ text: rec.note, cls: 'exec-info-record-note' });
                }
            }
        }

        // 备注输入
        new Setting(this.infoPanelEl)
            .setName(t('exec.note'))
            .addTextArea(text => text
                .setPlaceholder(t('exec.notePlaceholder'))
                .setValue(this.note)
                .onChange(val => this.note = val));

        // 变更执行选择区（默认隐藏）
        this.changePanelEl = contentEl.createDiv({ cls: 'exec-change-panel hidden' });
        this.renderChangePanel();

        // 操作按钮
        const btnSetting = new Setting(contentEl);
        if (!this.isHandled) {
            btnSetting.addButton(btn => btn
                .setButtonText(t('exec.confirm'))
                .setCta()
                .onClick(async () => {
                    await this.onSubmit('confirm', this.note.trim());
                    this.close();
                }));
            btnSetting.addButton(btn => btn
                .setButtonText(t('exec.change'))
                .onClick(() => {
                    // 隐藏原事件信息，只显示变更选择区
                    this.infoPanelEl.addClass('hidden');
                    this.changePanelEl.removeClass('hidden');
                }));
        }
        btnSetting.addButton(btn => btn
            .setButtonText(t('common.cancel'))
            .onClick(() => this.close()));
    }

    // 变更执行：选择实际做的任务
    private renderChangePanel() {
        const panel = this.changePanelEl;
        panel.empty();
        panel.createDiv({ text: t('exec.actualTask'), cls: 'exec-info-subtitle' });

        // 任务列表（收集盒任务 + 手动添加的新任务）
        const list = panel.createDiv({ cls: 'exec-change-list' });
        const allTasks = [
            ...this.inboxItems.map(i => ({ id: i.id, title: i.title })),
            ...this.manualTasks,
        ];
        if (allTasks.length === 0) {
            list.createDiv({ cls: 'exec-info-empty', text: t('exec.noTasks') });
        } else {
            for (const task of allTasks) {
                const row = list.createDiv({ cls: 'exec-change-item' });
                row.setText(task.title);
                if (this.changedInboxId === task.id) row.addClass('is-selected');
                row.onclick = () => {
                    this.changedInboxId = task.id;
                    this.changedTitle = task.title;
                    this.renderChangePanel();
                };
            }
        }

        // 手动添加新任务
        let newTitle = '';
        const addRow = panel.createDiv({ cls: 'exec-change-add-row' });
        const input = addRow.createEl('input', {
            type: 'text',
            cls: 'exec-change-add-input',
            attr: { placeholder: t('exec.newTaskPlaceholder') },
        });
        input.oninput = () => { newTitle = input.value; };
        const addBtn = addRow.createEl('button', {
            text: t('exec.addTask'),
            cls: 'exec-change-add-btn',
        });
        addBtn.onclick = () => {
            const title = newTitle.trim();
            if (!title) {
                new Notice(t('exec.taskNameRequired'));
                return;
            }
            const id = `manual_${Date.now()}`;
            this.manualTasks.push({ id, title });
            this.changedInboxId = id;
            this.changedTitle = title;
            this.renderChangePanel();
        };

        // 确认变更
        new Setting(panel)
            .addButton(btn => btn
                .setButtonText(t('exec.confirmChange'))
                .setCta()
                .onClick(async () => {
                    if (!this.changedTitle.trim()) {
                        new Notice(t('exec.selectOrAdd'));
                        return;
                    }
                    // 手动任务（manual_ 前缀）不带 inboxId，交由外部加入收集盒
                    const isManual = this.changedInboxId?.startsWith('manual_');
                    await this.onSubmit('change', this.note.trim(), {
                        inboxId: isManual ? undefined : this.changedInboxId,
                        title: this.changedTitle.trim(),
                    });
                    this.close();
                }));
    }

    private formatDay(day: number): string {
        const days = getWeekDays();
        return days[day - 1] ?? '';
    }

    private formatTime(minutes: number): string {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    onClose() { this.contentEl.empty(); }
}

