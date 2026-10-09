

import { ItemView, WorkspaceLeaf, Modal, Setting, Notice, App } from 'obsidian';
import type { Plugin } from 'obsidian';
import type { WeekRangeData, CategorizedRange, TimeBlockCategoryId, RangeSchemeData, DailyRange, WeekKey } from './timeblock-data';
import { hexToTransparent, getCurrentWeekKey, makeWeekKey, parseWeekKey, shiftWeekKey, makeDayKeyFromWeek, makeDefaultScheme, DEFAULT_SCHEME_ID, DEFAULT_WEEK_RANGE } from './timeblock-data';
import type { TimeBlockCategoryData } from './timeblock-category-manager';
import type { DayTemplateData } from './template-manager';
import { renderTimeBlockCategoryLegend } from './timeblock-category-manager';
import { renderDayTemplateRow } from './template-manager';
import { renderTaskPanel } from '../../shared/task-panel';
import { DEFAULT_INBOX_DATA, type InboxData, type InboxItem } from '../../datatypes/domain';
import { renderWeekGrid } from '../../shared/week-grid';
import { RangeSchemeModal } from './range-scheme-modal';
import { t, getWeekDays } from '../../i18n';
import { log } from '../../shared/logger';
import { EVENT_STATUS_EMOJI, EVENT_STATUS_LABEL_KEY, getEventStatus } from '../../datatypes/domain';
import type { EventBlock, ExecutionRecord, EventStatus } from '../../datatypes/domain';

export const VIEW_TYPE_WEEK = 'week-schedule-view';

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
    /** 全天面板是否展开（覆盖在日历上方，不改变日历位置） */
    private allDayPanelOpen = false;
    /** 日历主体的滚动位置（刷新时保留，避免跳动） */
    private savedScrollTop: number | null = null;
    /** 被主视图复用时的宿主容器（用于刷新） */
    private hostContainer?: HTMLElement;
    /** 事件剪贴板：暂存「复制某天全部事件」的事件模板（不含 id/day/weekKey） */
    private clipboardEvents: Omit<EventBlock, 'id' | 'day' | 'weekKey'>[] | null = null;
    /** 剪贴板来源：周键 + 星期几（1=周一 ... 7=周日），用于粘贴弹窗提示 */
    private clipboardSource: { weekKey: WeekKey; day: number } | null = null;
    /** 全周事件剪贴板：暂存「复制全周事件」的事件模板（保留 day，不含 id/weekKey） */
    private clipboardWeekEvents: Omit<EventBlock, 'id' | 'weekKey'>[] | null = null;
    /** 全周剪贴板来源周键，用于粘贴弹窗提示 */
    private clipboardWeekSource: WeekKey | null = null;
    /** 「更多工具」下拉面板是否展开 */
    private moreToolsOpen = false;
    /** 已标记为「已制定周计划」的周键列表（与年视图联动） */
    plannedWeeks: string[] = [];

    // Obsidian 旧 API：ItemView 构造函数只接受 leaf
    constructor(leaf: WorkspaceLeaf, plugin: Plugin, data: WeekRangeData, templateData: DayTemplateData, categoryData: TimeBlockCategoryData,
        events?: EventBlock[],
        executions?: ExecutionRecord[],
        inboxData?: InboxData,
        schemeData?: RangeSchemeData,
        plannedWeeks?: string[],
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
        this.plannedWeeks = plannedWeeks ?? [];
        log('WeekScheduleView 构造', {
            events: this.events.length,
            executions: this.executions.length,
        });
    }

    // 调用插件方法，存储数据。
    async save() {
        log('保存数据', {
            weekKey: this.currentWeekKey,
            events: this.events.length,
            executions: this.executions.length,
        });
        // 记录本次保存的全部计划事件数据
        for (const ev of this.events) {
            log('  保存事件', {
                id: ev.id,
                day: ev.day,
                start: ev.start,
                end: ev.end,
                allDay: ev.allDay ?? false,
                title: ev.title,
                inboxId: ev.inboxId,
                weekKey: ev.weekKey,
            });
        }
        // 统一委托给插件层的 saveAll，作为唯一保存出口
        await (this.plugin as Plugin & { saveAll: () => Promise<void> }).saveAll();
    }

    /** 重置为默认数据（清空全部数据后调用） */
    resetData() {
        // 注意：子视图（年/当日/泳道）持有 inboxData、timeBlockCategoryData 的引用，
        // 因此这里必须「原地清空」而非重新赋值，否则子视图仍指向旧对象。
        this.rangeData.days = DEFAULT_WEEK_RANGE.days;
        this.rangeData.weeks = {};

        this.dayTemplateData.dayTemplates = [];
        this.dayTemplateData.dayProperties = [];

        this.timeBlockCategoryData.categories = [
            { id: 'uncategorized', label: t('defaultCategory.uncategorized'), color: '#888888' },
            { id: 'work', label: t('defaultCategory.work'), color: '#4c8dff' },
            { id: 'rest', label: t('defaultCategory.rest'), color: '#43b581' },
            { id: 'play', label: t('defaultCategory.play'), color: '#f2a65a' },
        ];

        this.schemeData.schemes = [makeDefaultScheme(t('rangeScheme.defaultName'))];
        this.schemeData.activeSchemeId = DEFAULT_SCHEME_ID;
        this.schemeData.defaultSchemeId = DEFAULT_SCHEME_ID;

        this.events.length = 0;
        this.executions.length = 0;

        this.inboxData.items.length = 0;
        this.inboxData.selectedId = undefined;
        this.inboxData.collapsedIds = [];
        this.inboxData.weekGoalOnly = false;

        this.currentWeekKey = getCurrentWeekKey();
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

        // 清理可能残留的事件悬浮提示（重渲染时卡片被移除，mouseleave 不会触发）
        document.querySelectorAll('.event-tooltip').forEach(el => el.remove());

        log('渲染周表日历', {
            weekKey: this.currentWeekKey,
            events: this.events.length,
            executions: this.executions.length,
        });
        // 记录本周每个计划事件的具体数据（用于排查位置/时间错位）
        for (const ev of this.events) {
            if (ev.weekKey !== this.currentWeekKey) continue;
            log('  计划事件', {
                id: ev.id,
                day: ev.day,
                start: ev.start,
                end: ev.end,
                allDay: ev.allDay ?? false,
                title: ev.title,
                inboxId: ev.inboxId,
            });
        }

        // 刷新前记录日历主体的滚动位置，渲染后恢复，避免位置跳动
        const prevScroll = content.querySelector('.grid-body-row');
        if (prevScroll) {
            this.savedScrollTop = prevScroll.scrollTop;
        }

        content.empty();

        // 在容器内部创建 .week-schedule 根节点，避免与宿主容器样式冲突
        const root = content.createDiv({ cls: 'week-schedule' });

        // ===== 左侧：任务面板 =====
        const taskPanel = root.createDiv({ cls: 'week-task-panel' });
        renderTaskPanel(
            this.app,
            taskPanel,
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
            },
            { currentWeekKey: this.currentWeekKey, events: this.events },  // 用于「周目标」筛选与统计
        );

        // ===== 右侧：顶部工具栏 + 日历 =====
        const main = root.createDiv({ cls: 'week-main' });

        // 右上角工具栏（年周标签、时间区间设置、切换方案、图例）
        this.renderToolbar(main);

        // 日历区域
        const calendar = main.createDiv({ cls: 'week-calendar' });

        // ===== 周网格骨架（公共组件）=====
        const { grid, headerRow, bodyRowInner } = renderWeekGrid(calendar, {
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

        // ===== 全天事件行（放在星期表头下方、日历主体上方）=====
        this.renderAllDayRow(grid, bodyRowInner.parentElement!);

        // ===== 事件层 =====
        this.renderEventLayer(bodyRowInner);
    }

    async onClose() {
        const content = this.containerEl.children[1] as HTMLElement;
        content.empty();
    }
   
    // ===== 全天事件行 =====
    private renderAllDayRow(grid: HTMLElement, beforeEl: HTMLElement) {
        const row = grid.createDiv({ cls: 'all-day-row' });
        // 插入到日历主体行之前（即星期表头下方）
        grid.insertBefore(row, beforeEl);

        // 左侧：展开/收起按钮（替代原来的「全天」文字）
        const allDayCorner = row.createDiv({ cls: 'all-day-corner' });
        const toggleBtn = allDayCorner.createEl('button', {
            text: t('allday.label'),
            cls: 'all-day-toggle-btn',
        });

        const cells = row.createDiv({ cls: 'all-day-cells' });
        for (let d = 1; d <= 7; d++) {
            const cell = cells.createDiv({ cls: 'all-day-cell' });

            // 已有全天事件（显示为颜色小方块）
            for (const ev of this.getAllDayEvents(d)) {
                this.renderAllDaySquare(cell, ev);
            }

            // 点击格子添加全天事件
            cell.onclick = (e) => {
                if ((e.target as HTMLElement).closest('.all-day-chip-del')) return;
                void this.addAllDayEvent(d);
            };
        }

        // ===== 展开面板：从全天行向下展开，覆盖在日历上方，不改变日历位置 =====
        const panel = row.createDiv({ cls: 'all-day-panel' });
        panel.toggleClass('is-open', this.allDayPanelOpen);
        toggleBtn.toggleClass('is-active', this.allDayPanelOpen);
        toggleBtn.onclick = () => {
            this.allDayPanelOpen = !this.allDayPanelOpen;
            panel.toggleClass('is-open', this.allDayPanelOpen);
            toggleBtn.toggleClass('is-active', this.allDayPanelOpen);
        };

        // 面板内容：7 列，分别显示当天安排在全天的所有任务（任务清单）
        const panelCells = panel.createDiv({ cls: 'all-day-panel-cells' });
        for (let d = 1; d <= 7; d++) {
            const cell = panelCells.createDiv({ cls: 'all-day-panel-cell' });
            const dayEvents = this.getAllDayEvents(d);
            if (dayEvents.length === 0) {
                cell.createDiv({ cls: 'all-day-panel-empty', text: t('allday.empty') });
                continue;
            }
            for (const ev of dayEvents) {
                this.renderAllDayChip(cell, ev);
            }
        }
    }

    /** 某天在当前周的全天事件 */
    private getAllDayEvents(day: number): EventBlock[] {
        return this.events.filter(ev => ev.day === day && ev.allDay && ev.weekKey === this.currentWeekKey);
    }

    /** 渲染单个全天事件条目（颜色小方块，用于全天行；不可删除） */
    private renderAllDaySquare(cell: HTMLElement, ev: EventBlock) {
        const square = cell.createDiv({ cls: 'all-day-square' });
        const cat = ev.categoryId
            ? this.timeBlockCategoryData.categories.find(c => c.id === ev.categoryId)
            : undefined;
        square.setCssProps({ '--chip-color': cat?.color ?? '#888888' });
        // 方块内不显示文字，用 title 提示任务名
        square.setAttribute('title', ev.title);
    }

    /** 渲染单个全天事件条目（带文字的清单条目，用于展开面板） */
    private renderAllDayChip(cell: HTMLElement, ev: EventBlock) {
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
            // 原地删除，保持数组引用不变（插件持有同一引用）
            const idx = this.events.findIndex(x => x.id === ev.id);
            if (idx >= 0) this.events.splice(idx, 1);
            await this.save();
            await this.onOpen();
        };
    }

    // 添加全天事件（选中收集盒条目时）
    private async addAllDayEvent(day: number) {
        const selectedInboxItem = this.getSelectedInboxItem();
        if (!selectedInboxItem) {
            new Notice(t('allday.needSelect'));
            return;
        }
        // 当天已有该任务的任何事件（全天或时间点），则不再重复添加
        if (this.hasAnyEventForItem(selectedInboxItem, day)) {
            new Notice(t('event.alreadyScheduled', { title: selectedInboxItem.title }));
            return;
        }
        this.events.push({
            id: `ev_${Date.now()}`,
            day,
            start: 0,
            end: 1440,
            title: this.getSelectedEventTitle(selectedInboxItem),
            categoryId: selectedInboxItem.categoryId,
            inboxId: selectedInboxItem.id,
            allDay: true,
            completed: false,
            weekKey: this.currentWeekKey,
        });
        // 加入某天时，同时成为该周的周目标
        this.assignItemToDay(selectedInboxItem, day);
        log('分配计划事件（全天）', {
            weekKey: this.currentWeekKey,
            day,
            title: selectedInboxItem.title,
            inboxId: selectedInboxItem.id,
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

                // 已制定周计划时计划已固定，不允许再创建计划
                if (this.plannedWeeks.includes(this.currentWeekKey)) {
                    new Notice(t('event.weekPlannedLocked'));
                    return;
                }

                const rect = col.getBoundingClientRect();
                const y = e.clientY - rect.top;
                // 限制在一天范围内（列可能被拉伸到高于 24 小时的高度）
                const rawStart = Math.floor((y / 80) * 120 / 30) * 30;
                const startMinutes = Math.max(0, Math.min(rawStart, 1440 - 60));
                const endMinutes = startMinutes + 60;

                // ===== 新增：检查收集盒是否有选中条目 =====
                const selectedInboxItem = this.getSelectedInboxItem();
                if (selectedInboxItem) {
                    // 时间点事件可与其他时刻重复；但若当天全天已有该任务，则移除全天事件
                    this.removeAllDayEventForItem(selectedInboxItem, d);
                    // 直接创建事件，标题和分类从收集盒条目继承，并记录来源任务
                    this.events.push({
                        id: `ev_${Date.now()}`,
                        day: d,
                        start: startMinutes,
                        end: endMinutes,
                        title: this.getSelectedEventTitle(selectedInboxItem),
                        categoryId: selectedInboxItem.categoryId,
                        inboxId: selectedInboxItem.id,
                        completed: false,
                        weekKey: this.currentWeekKey,
                    });
                    // 加入某天时，同时成为该周的周目标
                    this.assignItemToDay(selectedInboxItem, d);
                    log('分配计划事件（时间点）', {
                        weekKey: this.currentWeekKey,
                        day: d,
                        start: startMinutes,
                        end: endMinutes,
                        title: selectedInboxItem.title,
                        inboxId: selectedInboxItem.id,
                    });
                    await this.save();
                    await this.onOpen();
                    new Notice(t('event.scheduled', { title: selectedInboxItem.title }));
                    return;
                }

                // ===== 未选中任务：事件名称来源于任务，必须先选择任务 =====
                new Notice(t('event.needSelectTask'));
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

                // 执行情况图标（当前周已制定周计划时显示，叠加在卡片左上角，不改变卡片本身）
                if (this.plannedWeeks.includes(this.currentWeekKey)) {
                    const status = getEventStatus(ev, this.executions);
                    card.createDiv({
                        cls: `event-status-icon-badge is-${status}`,
                        text: EVENT_STATUS_EMOJI[status],
                    });
                }

                // ===== 右上角 × 删除按钮（已制定周计划激活时计划已固定，不允许删除，故不显示） =====
                if (!this.plannedWeeks.includes(this.currentWeekKey)) {
                    const delBtn = card.createDiv({ cls: 'event-delete-btn' });
                    delBtn.setText('×');
                    delBtn.onclick = async (e) => {
                        e.stopPropagation();
                        // 原地删除，保持数组引用不变（插件持有同一引用）
                        const idx = this.events.findIndex(x => x.id === ev.id);
                        if (idx >= 0) this.events.splice(idx, 1);
                        await this.save();
                        await this.onOpen();
                    };
                }

                card.onclick = (e) => {
                    e.stopPropagation();
                    new EventEditModal(this.app, ev.start, ev.end, this.timeBlockCategoryData,
                        (note, start, end, categoryId) => {
                            // 名称来源于任务，不可修改；仅更新备注、时间、分类
                            ev.note = note || undefined;
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

                // 左侧任务面板选中该任务时，高亮对应事件卡片
                if (this.inboxData.selectedId && ev.inboxId === this.inboxData.selectedId) {
                    card.addClass('is-task-selected');
                }

                // 悬浮提示：展示事件详细信息
                // 已制定周计划时，改为按背景网格 2 小时区间悬浮（见下方），卡片本身不再显示提示
                if (!this.plannedWeeks.includes(this.currentWeekKey)) {
                    this.attachEventTooltip(card, ev);
                }
            }

            // 已制定周计划：按背景网格 2 小时区间悬浮，显示该区间内所有计划/执行信息
            if (this.plannedWeeks.includes(this.currentWeekKey)) {
                this.attachRangeHover(col, d);
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

    /** 分钟数 → HH:MM */
    private formatMinutes(min: number): string {
        const h = Math.floor(min / 60);
        const m = min % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    /**
     * 给事件卡片绑定悬浮提示：鼠标移入时在卡片旁显示详细信息
     * （标题、时间、分类、执行状态），移出时移除。
     */
    private attachEventTooltip(card: HTMLElement, ev: EventBlock) {
        let tip: HTMLElement | null = null;

        const show = () => {
            if (tip) return;
            tip = document.body.createDiv({ cls: 'event-tooltip' });

            // 标题
            tip.createDiv({ cls: 'event-tooltip-title', text: ev.title });

            // 时间
            const timeText = ev.allDay
                ? t('eventTooltip.allDay')
                : `${this.formatMinutes(ev.start)} - ${this.formatMinutes(ev.end)}`;
            const timeRow = tip.createDiv({ cls: 'event-tooltip-row' });
            timeRow.createSpan({ cls: 'event-tooltip-label', text: t('eventTooltip.time') });
            timeRow.createSpan({ cls: 'event-tooltip-value', text: timeText });

            // 分类
            const cat = ev.categoryId
                ? this.timeBlockCategoryData.categories.find(c => c.id === ev.categoryId)
                : undefined;
            const catRow = tip.createDiv({ cls: 'event-tooltip-row' });
            catRow.createSpan({ cls: 'event-tooltip-label', text: t('eventTooltip.category') });
            const catValue = catRow.createSpan({ cls: 'event-tooltip-value' });
            if (cat) {
                const dot = catValue.createSpan({ cls: 'event-tooltip-dot' });
                dot.setCssProps({ '--dot-color': cat.color });
                catValue.createSpan({ text: cat.label });
            } else {
                catValue.setText(t('inbox.noCategory'));
            }

            // 执行状态（仅当前周已制定周计划时才有意义）
            if (this.plannedWeeks.includes(this.currentWeekKey)) {
                const status = getEventStatus(ev, this.executions);
                const statusRow = tip.createDiv({ cls: 'event-tooltip-row' });
                statusRow.createSpan({ cls: 'event-tooltip-label', text: t('eventTooltip.status') });
                statusRow.createSpan({
                    cls: 'event-tooltip-value',
                    text: `${EVENT_STATUS_EMOJI[status]} ${t(EVENT_STATUS_LABEL_KEY[status])}`,
                });
            }

            // 定位：优先显示在卡片右侧，空间不足则显示在左侧
            const rect = card.getBoundingClientRect();
            const tipRect = tip.getBoundingClientRect();
            let left = rect.right + 8;
            if (left + tipRect.width > window.innerWidth) {
                left = rect.left - tipRect.width - 8;
            }
            let top = rect.top;
            if (top + tipRect.height > window.innerHeight) {
                top = window.innerHeight - tipRect.height - 8;
            }
            tip.setCssProps({
                '--tip-left': `${Math.max(8, left)}px`,
                '--tip-top': `${Math.max(8, top)}px`,
            });
        };

        const hide = () => {
            if (tip) {
                tip.remove();
                tip = null;
            }
        };

        card.addEventListener('mouseenter', show);
        card.addEventListener('mouseleave', hide);
    }

    /**
     * 已制定周计划时：按背景网格的 2 小时区间悬浮。
     * 鼠标在某天列的某个 2 小时区间内移动时，显示该区间内的所有事件：
     * - 第 1 列：原计划信息（区间内所有计划事件，每个一张详细卡片，从上到下）
     * - 第 2 列：执行信息（区间内所有执行记录）；若某执行记录关联的计划事件被替换过，
     *   则该执行卡片与第 1 列对应的原计划卡片行对齐。
     */
    private attachRangeHover(col: HTMLElement, day: number) {
        let tip: HTMLElement | null = null;
        let currentRangeStart = -1;

        const hide = () => {
            if (tip) {
                tip.remove();
                tip = null;
            }
            currentRangeStart = -1;
        };

        const show = (rangeStart: number, clientX: number, clientY: number) => {
            if (tip) tip.remove();
            tip = document.body.createDiv({ cls: 'event-tooltip range-hover-tooltip' });

            const rangeEnd = rangeStart + 120;

            // 区间内所有计划事件（按开始时间排序）
            const plannedEvents = this.events
                .filter(ev => ev.day === day && !ev.allDay && ev.weekKey === this.currentWeekKey
                    && ev.start < rangeEnd && ev.end > rangeStart)
                .sort((a, b) => a.start - b.start);

            // 区间内所有执行记录（按开始时间排序）
            const execs = this.executions
                .filter(ex => ex.day === day && ex.weekKey === this.currentWeekKey
                    && ex.start < rangeEnd && ex.end > rangeStart)
                .sort((a, b) => a.start - b.start);

            // 两列容器
            const cols = tip.createDiv({ cls: 'range-hover-cols' });

            // ===== 第 1 列：原计划 =====
            const plannedCol = cols.createDiv({ cls: 'range-hover-col' });
            plannedCol.createDiv({ cls: 'range-hover-col-title', text: t('eventTooltip.plannedCol') });
            // 记录每个计划事件在第 1 列中的行号（用于第 2 列对齐）
            const plannedRowIndex = new Map<string, number>();
            if (plannedEvents.length === 0) {
                plannedCol.createDiv({ cls: 'range-hover-empty', text: t('eventTooltip.none') });
            } else {
                plannedEvents.forEach((ev, idx) => {
                    plannedRowIndex.set(ev.id, idx);
                    this.renderRangeHoverCard(plannedCol, ev);
                });
            }

            // ===== 第 2 列：执行 =====
            const execCol = cols.createDiv({ cls: 'range-hover-col' });
            execCol.createDiv({ cls: 'range-hover-col-title', text: t('eventTooltip.execCol') });
            if (execs.length === 0) {
                execCol.createDiv({ cls: 'range-hover-empty', text: t('eventTooltip.none') });
            } else {
                // 先按「是否替换了某原计划」分组：替换的按原计划行号对齐，其余顺序排列
                const aligned = new Map<number, ExecutionRecord>();
                const unaligned: ExecutionRecord[] = [];
                for (const ex of execs) {
                    const planned = ex.eventId
                        ? this.events.find(e => e.id === ex.eventId)
                        : undefined;
                    // 该执行关联的计划事件被替换过 → 与第 1 列对应原计划卡片对齐
                    if (planned && planned.replacedFromInboxId && plannedRowIndex.has(planned.id)) {
                        aligned.set(plannedRowIndex.get(planned.id)!, ex);
                    } else {
                        unaligned.push(ex);
                    }
                }

                // 按第 1 列行数逐行渲染：对齐的执行卡片放在对应行，其余依次填充空行
                const totalRows = Math.max(plannedEvents.length, aligned.size + unaligned.length);
                let unalignedIdx = 0;
                for (let row = 0; row < totalRows; row++) {
                    const ex = aligned.get(row) ?? unaligned[unalignedIdx++];
                    if (ex) {
                        this.renderRangeHoverExecCard(execCol, ex);
                    } else {
                        // 占位，保持与第 1 列行对齐
                        execCol.createDiv({ cls: 'range-hover-placeholder' });
                    }
                }
            }

            // 定位：优先显示在鼠标右侧，空间不足则显示在左侧
            const tipRect = tip.getBoundingClientRect();
            let left = clientX + 12;
            if (left + tipRect.width > window.innerWidth) {
                left = clientX - tipRect.width - 12;
            }
            let top = clientY + 12;
            if (top + tipRect.height > window.innerHeight) {
                top = window.innerHeight - tipRect.height - 8;
            }
            tip.setCssProps({
                '--tip-left': `${Math.max(8, left)}px`,
                '--tip-top': `${Math.max(8, top)}px`,
            });
        };

        col.addEventListener('mousemove', (e) => {
            const rect = col.getBoundingClientRect();
            const y = e.clientY - rect.top;
            // 固定 2 小时网格：每 120 分钟一段（与背景网格一致，80px = 2 小时）
            const rangeStart = Math.floor((y / 80) * 120 / 120) * 120;
            if (rangeStart === currentRangeStart && tip) {
                // 同一区间内移动：仅更新位置，避免重复重建
                const tipRect = tip.getBoundingClientRect();
                let left = e.clientX + 12;
                if (left + tipRect.width > window.innerWidth) {
                    left = e.clientX - tipRect.width - 12;
                }
                let top = e.clientY + 12;
                if (top + tipRect.height > window.innerHeight) {
                    top = window.innerHeight - tipRect.height - 8;
                }
                tip.setCssProps({
                    '--tip-left': `${Math.max(8, left)}px`,
                    '--tip-top': `${Math.max(8, top)}px`,
                });
                return;
            }
            currentRangeStart = rangeStart;
            show(rangeStart, e.clientX, e.clientY);
        });

        col.addEventListener('mouseleave', hide);
    }

    /** 渲染区间悬浮中的「计划事件」详细卡片（与现有悬浮提示字段一致） */
    private renderRangeHoverCard(parent: HTMLElement, ev: EventBlock) {
        const card = parent.createDiv({ cls: 'range-hover-card' });
        card.createDiv({ cls: 'event-tooltip-title', text: ev.title });

        const timeRow = card.createDiv({ cls: 'event-tooltip-row' });
        timeRow.createSpan({ cls: 'event-tooltip-label', text: t('eventTooltip.time') });
        timeRow.createSpan({
            cls: 'event-tooltip-value',
            text: `${this.formatMinutes(ev.start)} - ${this.formatMinutes(ev.end)}`,
        });

        const cat = ev.categoryId
            ? this.timeBlockCategoryData.categories.find(c => c.id === ev.categoryId)
            : undefined;
        const catRow = card.createDiv({ cls: 'event-tooltip-row' });
        catRow.createSpan({ cls: 'event-tooltip-label', text: t('eventTooltip.category') });
        const catValue = catRow.createSpan({ cls: 'event-tooltip-value' });
        if (cat) {
            const dot = catValue.createSpan({ cls: 'event-tooltip-dot' });
            dot.setCssProps({ '--dot-color': cat.color });
            catValue.createSpan({ text: cat.label });
        } else {
            catValue.setText(t('inbox.noCategory'));
        }

        // 第 1 列仅展示计划情况：状态固定为「计划」，不反映执行信息（执行情况在第 2 列展示）
        const status: EventStatus = 'planned';
        const statusRow = card.createDiv({ cls: 'event-tooltip-row' });
        statusRow.createSpan({ cls: 'event-tooltip-label', text: t('eventTooltip.status') });
        statusRow.createSpan({
            cls: 'event-tooltip-value',
            text: `${EVENT_STATUS_EMOJI[status]} ${t(EVENT_STATUS_LABEL_KEY[status])}`,
        });
    }

    /** 渲染区间悬浮中的「执行记录」详细卡片 */
    private renderRangeHoverExecCard(parent: HTMLElement, ex: ExecutionRecord) {
        const card = parent.createDiv({ cls: 'range-hover-card' });

        // 状态：关联计划事件 → 已执行；无关联 → 新增
        const status: EventStatus = ex.eventId ? 'executed' : 'added';

        // 标题：优先取来源任务标题，否则用关联计划事件标题；名称前加对应类型图标
        const item = ex.inboxId
            ? this.inboxData.items.find(i => i.id === ex.inboxId && !i.removed)
            : undefined;
        const planned = ex.eventId ? this.events.find(e => e.id === ex.eventId) : undefined;
        const title = item?.title ?? planned?.title ?? t('eventTooltip.execTitle');
        const titleEl = card.createDiv({ cls: 'event-tooltip-title' });
        titleEl.createSpan({ cls: 'range-hover-exec-icon', text: EVENT_STATUS_EMOJI[status] });
        titleEl.createSpan({ text: title });

        const timeRow = card.createDiv({ cls: 'event-tooltip-row' });
        timeRow.createSpan({ cls: 'event-tooltip-label', text: t('eventTooltip.time') });
        timeRow.createSpan({
            cls: 'event-tooltip-value',
            text: `${this.formatMinutes(ex.start)} - ${this.formatMinutes(ex.end)}`,
        });

        const cat = item?.categoryId
            ? this.timeBlockCategoryData.categories.find(c => c.id === item.categoryId)
            : undefined;
        const catRow = card.createDiv({ cls: 'event-tooltip-row' });
        catRow.createSpan({ cls: 'event-tooltip-label', text: t('eventTooltip.category') });
        const catValue = catRow.createSpan({ cls: 'event-tooltip-value' });
        if (cat) {
            const dot = catValue.createSpan({ cls: 'event-tooltip-dot' });
            dot.setCssProps({ '--dot-color': cat.color });
            catValue.createSpan({ text: cat.label });
        } else {
            catValue.setText(t('inbox.noCategory'));
        }

        const statusRow = card.createDiv({ cls: 'event-tooltip-row' });
        statusRow.createSpan({ cls: 'event-tooltip-label', text: t('eventTooltip.status') });
        statusRow.createSpan({
            cls: 'event-tooltip-value',
            text: `${EVENT_STATUS_EMOJI[status]} ${t(EVENT_STATUS_LABEL_KEY[status])}`,
        });
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

        // 滚动到红线位置（居中显示）；若刷新前已有滚动位置，则保留原位置
        const scrollContainer = bodyRowInner.closest('.grid-body-row');
        if (scrollContainer) {
            if (this.savedScrollTop !== null) {
                scrollContainer.scrollTop = this.savedScrollTop;
                this.savedScrollTop = null;
            } else {
                const lineTop = (totalMinutes / 120) * 80;
                scrollContainer.scrollTop = Math.max(0, lineTop - scrollContainer.clientHeight / 2);
            }
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

        

        // 上一周 / 下一周
        const prevBtn = nav.createEl('button', {
            text: '‹',
            cls: 'week-nav-arrow-btn',
        });
        prevBtn.onclick = () => {
            this.currentWeekKey = shiftWeekKey(this.currentWeekKey, -1);
            void this.onOpen();
        };

        const nextBtn = nav.createEl('button', {
            text: '›',
            cls: 'week-nav-arrow-btn',
        });
        nextBtn.onclick = () => {
            this.currentWeekKey = shiftWeekKey(this.currentWeekKey, 1);
            void this.onOpen();
        };

        // 「本周」按钮：切回本周，且在本周时高亮
        const thisWeekBtn = nav.createEl('button', {
            text: t('weekNav.thisWeek'),
            cls: 'week-nav-today-btn',
        });
        thisWeekBtn.toggleClass('is-active', this.currentWeekKey === getCurrentWeekKey());
        thisWeekBtn.onclick = () => {
            this.currentWeekKey = getCurrentWeekKey();
            void this.onOpen();
        };
    }

    // ===== 工具栏（右上角）=====
    private renderToolbar(content: HTMLElement) {
        const toolbar = content.createDiv({ cls: 'schedule-toolbar' });

        // 年 / 周切换
        this.renderWeekNav(toolbar);

        // 已制定周计划按钮（标记当前周，与年视图联动）
        const plannedBtn = toolbar.createEl('button', {
            text: t('week.markPlanned'),
            cls: 'week-planned-toggle-btn',
        });
        if (this.plannedWeeks.includes(this.currentWeekKey)) plannedBtn.addClass('is-active');
        plannedBtn.onclick = () => {
            void (async () => {
                const idx = this.plannedWeeks.indexOf(this.currentWeekKey);
                if (idx >= 0) {
                    this.plannedWeeks.splice(idx, 1);
                } else {
                    this.plannedWeeks.push(this.currentWeekKey);
                }
                await this.save();
                await this.onOpen();
            })();
        };

        // 时间区间设置按钮 + 当前方案下拉框
        const schemeBar = toolbar.createDiv({ cls: 'range-scheme-bar' });

        // 当前时间区间方案下拉框（至少存在默认方案，无需「未选择方案」选项）
        const schemeSelect = schemeBar.createEl('select', { cls: 'range-scheme-select' });
        for (const scheme of this.schemeData.schemes) {
            schemeSelect.createEl('option', { text: scheme.name, value: scheme.id });
        }
        // 未激活时默认选中默认方案
        const activeId = this.schemeData.activeSchemeId
            ?? this.schemeData.defaultSchemeId
            ?? this.schemeData.schemes[0]?.id
            ?? '';
        schemeSelect.value = activeId;
        schemeSelect.onchange = () => {
            this.schemeData.activeSchemeId = schemeSelect.value || undefined;
            void (async () => {
                await this.save();
                await this.onOpen();
            })();
        };

        // 图例（日历顶部：不显示配置按钮）
        const legendContainer = toolbar.createDiv({ cls: 'legend-container' });
        renderTimeBlockCategoryLegend(
            this.app,
            legendContainer,
            this.timeBlockCategoryData,
            () => {
                void this.onOpen();
            },
            undefined,
            undefined,
            false,
        );


        // 「更多工具」按钮 + 下拉面板（放在工具栏最后，始终钉在最右边）
        const moreToolsWrap = toolbar.createDiv({ cls: 'more-tools-wrap' });
        const moreToolsBtn = moreToolsWrap.createEl('button', {
            text: t('eventCopy.moreTools'),
            cls: 'more-tools-btn',
        });
        if (this.moreToolsOpen) moreToolsBtn.addClass('is-active');
        moreToolsBtn.onclick = () => {
            this.moreToolsOpen = !this.moreToolsOpen;
            void this.onOpen();
        };

        // 下拉面板：每行一个按钮
        if (this.moreToolsOpen) {
            const panel = moreToolsWrap.createDiv({ cls: 'more-tools-panel' });

            // 时间区间设置
            const schemeBtn = panel.createEl('button', {
                text: t('rangeScheme.open'),
                cls: 'more-tools-item',
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

            // 复制一天事件
            const copyBtn = panel.createEl('button', {
                text: t('eventCopy.copy'),
                cls: 'more-tools-item',
            });
            copyBtn.onclick = () => {
                new CopyDayEventsModal(this.app, (day) => this.copyDayEvents(day)).open();
            };

            // 粘贴一天事件
            const pasteBtn = panel.createEl('button', {
                text: t('eventCopy.paste'),
                cls: 'more-tools-item',
            });
            pasteBtn.onclick = () => {
                if (!this.clipboardEvents || this.clipboardEvents.length === 0) {
                    new Notice(t('eventCopy.emptyClipboard'));
                    return;
                }
                new PasteDayEventsModal(this.app, this.clipboardSource, (days) => {
                    void this.pasteEventsToDays(days);
                }).open();
            };

            // 复制本周事件
            const copyWeekBtn = panel.createEl('button', {
                text: t('eventCopy.copyWeek'),
                cls: 'more-tools-item',
            });
            copyWeekBtn.onclick = () => {
                this.copyWeekEvents();
            };

            // 粘贴一周事件
            const pasteWeekBtn = panel.createEl('button', {
                text: t('eventCopy.pasteWeek'),
                cls: 'more-tools-item',
            });
            pasteWeekBtn.onclick = () => {
                if (!this.clipboardWeekEvents || this.clipboardWeekEvents.length === 0) {
                    new Notice(t('eventCopy.emptyClipboard'));
                    return;
                }
                new PasteWeekEventsModal(
                    this.app,
                    this.clipboardWeekSource,
                    this.currentWeekKey,
                    () => {
                        void this.pasteWeekEvents();
                    },
                ).open();
            };
        }
    }

    /** 获取当前激活方案（未激活时回退到默认方案） */
    private getActiveScheme() {
        const active = this.schemeData.schemes.find(s => s.id === this.schemeData.activeSchemeId);
        if (active) return active;
        return this.schemeData.schemes.find(s => s.id === DEFAULT_SCHEME_ID)
            ?? this.schemeData.schemes[0];
    }

    /** 获取当前激活方案的日区间配置（周无关的模板数据） */
    getSchemeDays(): DailyRange[] {
        return this.getActiveScheme()?.days ?? [];
    }

    /** 应用日模板到指定日期（写入当前激活方案） */
    private async applyTemplate(templateId: string, targetDays: number[]) {
        const tpl = this.dayTemplateData.dayTemplates.find(t => t.id === templateId);
        if (!tpl) { new Notice(t('template.notFound')); return; }
        const scheme = this.getActiveScheme();
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

    /** 复制某天（当前周）的全部事件到剪贴板 */
    private copyDayEvents(day: number) {
        const dayEvents = this.events.filter(ev => ev.day === day && ev.weekKey === this.currentWeekKey);
        if (dayEvents.length === 0) {
            new Notice(t('eventCopy.nothingToCopy'));
            return;
        }
        // 暂存事件模板（去掉 id / day / weekKey，粘贴时重新生成）
        this.clipboardEvents = dayEvents.map(({ id, day: _d, weekKey: _w, ...rest }) => rest);
        this.clipboardSource = { weekKey: this.currentWeekKey, day };
        new Notice(t('eventCopy.copied', { count: dayEvents.length }));
    }

    /** 将剪贴板事件粘贴到当前周的指定星期几（保留源事件，可多次粘贴） */
    private async pasteEventsToDays(days: number[]) {
        if (!this.clipboardEvents || this.clipboardEvents.length === 0) {
            new Notice(t('eventCopy.emptyClipboard'));
            return;
        }
        let added = 0;
        for (const day of days) {
            for (const tpl of this.clipboardEvents) {
                this.events.push({
                    ...tpl,
                    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    day,
                    weekKey: this.currentWeekKey,
                });
                added++;
            }
        }
        await this.save();
        await this.onOpen();
        new Notice(t('eventCopy.pasted', { count: added }));
    }

    /** 复制当前周的全部事件到全周剪贴板（保留 day，粘贴时按原星期几还原） */
    private copyWeekEvents() {
        const weekEvents = this.events.filter(ev => ev.weekKey === this.currentWeekKey);
        if (weekEvents.length === 0) {
            new Notice(t('eventCopy.nothingToCopy'));
            return;
        }
        // 暂存事件模板（去掉 id / weekKey，保留 day）
        this.clipboardWeekEvents = weekEvents.map(({ id, weekKey: _w, ...rest }) => rest);
        this.clipboardWeekSource = this.currentWeekKey;
        new Notice(t('eventCopy.copied', { count: weekEvents.length }));
    }

    /** 将全周剪贴板事件粘贴到当前周（按原星期几还原，保留源事件，可多次粘贴） */
    private async pasteWeekEvents() {
        if (!this.clipboardWeekEvents || this.clipboardWeekEvents.length === 0) {
            new Notice(t('eventCopy.emptyClipboard'));
            return;
        }
        let added = 0;
        for (const tpl of this.clipboardWeekEvents) {
            this.events.push({
                ...tpl,
                id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                weekKey: this.currentWeekKey,
            });
            added++;
        }
        await this.save();
        await this.onOpen();
        new Notice(t('eventCopy.pasted', { count: added }));
    }

    
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

    /**
     * 计算排入事件时使用的标题。
     * - 选中子条目：返回「项目名 · 板块名 · 子条目名」
     * - 仅选中板块：返回「项目名 · 板块名」
     * - 未选中板块：返回项目名
     */
    private getSelectedEventTitle(item: InboxItem): string {
        const sectionId = this.inboxData.selectedSectionId;
        if (!sectionId || !item.sections) return item.title;
        const section = item.sections.find(s => s.id === sectionId);
        if (!section) return item.title;
        const typeLabel = section.type === 'checklist'
            ? t('section.typeChecklist')
            : section.type === 'steps'
                ? t('section.typeSteps')
                : section.type === 'habit'
                    ? t('section.typeHabit')
                    : t('section.typeFile');
        const sectionName = section.title || typeLabel;

        // 若选中了具体子条目，追加条目名
        const entryId = this.inboxData.selectedSectionItemId;
        if (entryId) {
            const entries = (section.data as { items?: { id: string; text: string }[] }).items ?? [];
            const entry = entries.find(e => e.id === entryId);
            if (entry && entry.text) {
                return `${item.title} · ${sectionName} · ${entry.text}`;
            }
        }
        return `${item.title} · ${sectionName}`;
    }

    /** 判断某任务在当前周的某天是否已排入任何事件（全天或时间点） */
    private hasAnyEventForItem(item: InboxItem, day: number): boolean {
        return this.events.some(ev =>
            ev.inboxId === item.id
            && ev.day === day
            && ev.weekKey === this.currentWeekKey,
        );
    }

    /** 移除某任务在当前周某天的全天事件（用于时间点事件创建时替换全天事件） */
    private removeAllDayEventForItem(item: InboxItem, day: number): void {
        // 原地删除，保持数组引用不变（插件持有同一引用）
        for (let i = this.events.length - 1; i >= 0; i--) {
            const ev = this.events[i];
            if (ev.inboxId === item.id
                && ev.day === day
                && ev.weekKey === this.currentWeekKey
                && ev.allDay) {
                this.events.splice(i, 1);
            }
        }
    }

    /**
     * 将任务标记为「已加入某天」，同时加入当前周目标。
     * 加入某天时，该任务也应成为这一周的周目标。
     */
    private assignItemToDay(item: InboxItem, day: number): void {
        const dayKey = makeDayKeyFromWeek(this.currentWeekKey, day);
        const dayKeys = item.assignedDayKeys ?? [];
        if (!dayKeys.includes(dayKey)) {
            item.assignedDayKeys = [...dayKeys, dayKey];
        }
        const weekKeys = item.assignedWeekKeys ?? [];
        if (!weekKeys.includes(this.currentWeekKey)) {
            item.assignedWeekKeys = [...weekKeys, this.currentWeekKey];
        }
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

        // 结束时间（可选到 24:00）
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
                dropdown.addOption('1440', '24:00');
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
    private note: string = '';
    private start: number;
    private end: number;
    private categoryId: string;

    constructor(
        app: App,
        defaultStart: number,
        defaultEnd: number,
        private categoryData: TimeBlockCategoryData,
        private onSubmit: (note: string, start: number, end: number, categoryId?: string) => void,
        private defaultEvent?: EventBlock,
    ) {
        super(app);
        this.start = defaultStart;
        this.end = defaultEnd;
        this.categoryId = categoryData.categories[0]?.id ?? '';
        if (defaultEvent) {
            this.title = defaultEvent.title;
            this.note = defaultEvent.note ?? '';
            this.start = defaultEvent.start;
            this.end = defaultEvent.end;
            this.categoryId = defaultEvent.categoryId ?? this.categoryId;
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('event.edit') });

        // 事件名称来源于任务，只读展示，不可编辑
        new Setting(contentEl)
            .setName(t('event.title'))
            .setDesc(t('event.titleFromTask'))
            .addText(text => {
                text.setValue(this.title).setDisabled(true);
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
            dd.addOption('1440', '24:00');
            dd.setValue(String(this.end)).onChange(val => this.end = Number(val));
        });

        new Setting(contentEl).setName(t('event.category')).addDropdown(dd => {
            dd.addOption('', t('event.noCategory'));
            for (const cat of this.categoryData.categories) {
                dd.addOption(cat.id, cat.label);
            }
            dd.setValue(this.categoryId).onChange(val => this.categoryId = val);
        });

        // 额外备注（可编辑）
        new Setting(contentEl).setName(t('event.note')).addTextArea(text => {
            text.setPlaceholder(t('event.notePlaceholder')).setValue(this.note)
                .onChange(val => this.note = val);
            text.inputEl.rows = 3;
        });

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText(t('common.save')).setCta().onClick(() => {
                this.onSubmit(this.note.trim(), this.start, this.end, this.categoryId || undefined);
                this.close();
            }))
            .addButton(btn => btn.setButtonText(t('common.cancel')).onClick(() => this.close()));
    }

    onClose() { this.contentEl.empty(); }
}

/** 复制某天事件弹窗：单选一天 */
class CopyDayEventsModal extends Modal {
    constructor(
        app: App,
        private onConfirm: (day: number) => void,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('eventCopy.copyTitle') });

        let selectedDay: number | null = null;
        const days = getWeekDays();
        const dayRow = contentEl.createDiv({ cls: 'apply-day-row' });
        const dayBtns: HTMLElement[] = [];

        for (let i = 1; i <= 7; i++) {
            const btn = dayRow.createEl('button', {
                text: days[i - 1],
                cls: 'apply-day-btn',
            });
            dayBtns.push(btn);
            btn.onclick = () => {
                selectedDay = i;
                dayBtns.forEach((b, idx) => b.toggleClass('is-selected', idx === i - 1));
            };
        }

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('common.confirm'))
                .setCta()
                .onClick(() => {
                    if (selectedDay === null) {
                        new Notice(t('eventCopy.selectDay'));
                        return;
                    }
                    this.onConfirm(selectedDay);
                    this.close();
                })
            )
            .addButton(btn => btn
                .setButtonText(t('common.cancel'))
                .onClick(() => this.close())
            );
    }

    onClose() { this.contentEl.empty(); }
}

/** 粘贴事件弹窗：多选星期几 */
class PasteDayEventsModal extends Modal {
    constructor(
        app: App,
        /** 被复制的来源（周键 + 星期几），用于提示 */
        private source: { weekKey: WeekKey; day: number } | null,
        private onConfirm: (days: number[]) => void,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('eventCopy.pasteTitle') });

        // 显示当前被复制的是哪一年、哪一周、哪一天
        if (this.source) {
            const { year, week } = parseWeekKey(this.source.weekKey);
            const dayName = getWeekDays()[this.source.day - 1] ?? '';
            contentEl.createDiv({
                cls: 'event-copy-source-hint',
                text: t('eventCopy.sourceHint', { year, week, day: dayName }),
            });
        }

        const selectedDays = new Set<number>();
        const days = getWeekDays();
        const dayRow = contentEl.createDiv({ cls: 'apply-day-row' });
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

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('common.confirm'))
                .setCta()
                .onClick(() => {
                    if (selectedDays.size === 0) {
                        new Notice(t('template.selectAtLeastOne'));
                        return;
                    }
                    this.onConfirm(Array.from(selectedDays));
                    this.close();
                })
            )
            .addButton(btn => btn
                .setButtonText(t('common.cancel'))
                .onClick(() => this.close())
            );
    }

    onClose() { this.contentEl.empty(); }
}

/** 粘贴全周事件弹窗：显示「来源周 → 复制到 → 当前周」，确认后生效 */
class PasteWeekEventsModal extends Modal {
    constructor(
        app: App,
        /** 来源周键 */
        private sourceWeekKey: WeekKey | null,
        /** 目标周键（当前周） */
        private targetWeekKey: WeekKey,
        private onConfirm: () => void,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('eventCopy.pasteWeekTitle') });

        const source = this.sourceWeekKey ? parseWeekKey(this.sourceWeekKey) : null;
        const target = parseWeekKey(this.targetWeekKey);

        // 来源周 → 复制到 → 当前周
        const row = contentEl.createDiv({ cls: 'event-copy-week-row' });
        row.createDiv({
            cls: 'event-copy-week-side',
            text: source
                ? t('eventCopy.weekLabel', { year: source.year, week: source.week })
                : t('eventCopy.weekUnknown'),
        });
        row.createDiv({ cls: 'event-copy-week-arrow', text: '→' });
        row.createDiv({
            cls: 'event-copy-week-side',
            text: t('eventCopy.weekLabel', { year: target.year, week: target.week }),
        });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('common.confirm'))
                .setCta()
                .onClick(() => {
                    this.onConfirm();
                    this.close();
                })
            )
            .addButton(btn => btn
                .setButtonText(t('common.cancel'))
                .onClick(() => this.close())
            );
    }

    onClose() { this.contentEl.empty(); }
}

