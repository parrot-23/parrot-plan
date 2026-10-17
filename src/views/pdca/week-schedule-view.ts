

import { ItemView, WorkspaceLeaf, Modal, Setting, Notice, App } from 'obsidian';
import type { Plugin } from 'obsidian';
import type { CategorizedRange, PlanCategoryId, PlanSchemeData, DailyRange, WeekKey } from '../../shared/plan-data';
import { hexToTransparent, getCurrentWeekKey, makeWeekKey, parseWeekKey, shiftWeekKey, makeDayKeyFromWeek } from '../../shared/plan-data';
import type { PlanCategoryData } from '../../shared/plan-category-manager';
import type { DayTemplateData } from '../../shared/template-manager';
import { renderPlanCategoryLegend } from '../../shared/plan-category-manager';
import { renderDayTemplateRow } from '../../shared/template-manager';
import { renderTaskPanel } from '../../shared/task-panel';
import { DEFAULT_INBOX_DATA, type InboxData, type InboxItem } from '../../datatypes/domain';
import { renderWeekPanel } from '../../shared/week-panel';
import { PlanSchemeModal } from '../../shared/plan-scheme-modal';
import { t, getWeekDays } from '../../i18n';
import { log } from '../../shared/logger';
import { EVENT_STATUS_EMOJI, EVENT_STATUS_LABEL_KEY, getEventStatus } from '../../datatypes/domain';
import type { EventBlock, ExecutionRecord, EventStatus } from '../../datatypes/domain';
import type { PdcaRepo } from '../../repos/pdca-repo';
import type { InboxRepo } from '../../repos/inbox-repo';
import type { CategoryRepo } from '../../repos/category-repo';
import type { TemplateRepo } from '../../repos/template-repo';
import type { PlanSchemeRepo } from '../../repos/plan-scheme-repo';

export const VIEW_TYPE_WEEK = 'week-schedule-view';

export class WeekScheduleView extends ItemView {
    plugin: Plugin;
    // 日模板数据。
    dayTemplateData: DayTemplateData = {
        dayTemplates: [],
        dayProperties: [],
    };
    planCategoryData: PlanCategoryData;
    /** 时间计划方案数据 */
    planSchemeData: PlanSchemeData = { schemes: [] };
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
    /** 当前打开的「预估执行时长」悬浮面板 */
    private estimatePopover: HTMLElement | null = null;
    /** 悬浮面板的「点击外部关闭」监听器 */
    private estimateOutsideHandler: ((e: MouseEvent) => void) | null = null;

    // Obsidian 旧 API：ItemView 构造函数只接受 leaf
    constructor(leaf: WorkspaceLeaf, plugin: Plugin, templateData: DayTemplateData, categoryData: PlanCategoryData,
        events?: EventBlock[],
        executions?: ExecutionRecord[],
        inboxData?: InboxData,
        planSchemeData?: PlanSchemeData,
        plannedWeeks?: string[],
    ) {
        super(leaf);
        this.plugin = plugin;
        this.dayTemplateData = templateData;
        this.planCategoryData = categoryData;
        this.events = events ?? [];
        this.executions = executions ?? [];
        this.inboxData = inboxData ?? DEFAULT_INBOX_DATA;
        this.planSchemeData = planSchemeData ?? { schemes: [] };
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

    /** 从插件实例获取 PDCA 领域仓库 */
    private pdcaRepo(): PdcaRepo {
        return (this.plugin as Plugin & { pdcaRepo: PdcaRepo }).pdcaRepo;
    }

    /** 从插件实例获取收集盒领域仓库 */
    private inboxRepo(): InboxRepo {
        return (this.plugin as Plugin & { inboxRepo: InboxRepo }).inboxRepo;
    }

    /** 从插件实例获取分类领域仓库 */
    private categoryRepo(): CategoryRepo {
        return (this.plugin as Plugin & { categoryRepo: CategoryRepo }).categoryRepo;
    }

    /** 从插件实例获取时间计划方案领域仓库 */
    private planSchemeRepo(): PlanSchemeRepo {
        return (this.plugin as Plugin & { planSchemeRepo: PlanSchemeRepo }).planSchemeRepo;
    }

    /** 重置为默认数据（清空全部数据后调用） */
    resetData() {
        // 注意：子视图（年/当日/泳道）持有 inboxData、planCategoryData 的引用，
        // 因此这里必须「原地清空」而非重新赋值，否则子视图仍指向旧对象。
        this.templateRepo.clear();

        this.categoryRepo().replaceAll([
            { id: 'uncategorized', label: t('defaultCategory.uncategorized'), color: '#888888' },
            { id: 'work', label: t('defaultCategory.work'), color: '#4c8dff' },
            { id: 'rest', label: t('defaultCategory.rest'), color: '#43b581' },
            { id: 'play', label: t('defaultCategory.play'), color: '#f2a65a' },
        ]);

        this.planSchemeRepo().resetToDefault(t('planScheme.defaultName'));

        this.pdcaRepo().clearEvents();
        this.pdcaRepo().clearExecutions();

        this.inboxRepo().clear();

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
        // 清理预估时长悬浮面板（重渲染会移除其宿主卡片）
        this.closeEstimatePopover();

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
        // 刷新前记录左侧任务面板列表的滚动位置，渲染后恢复
        const prevTaskListScrollTop = content
            .querySelector<HTMLElement>('.week-task-panel .inbox-list')?.scrollTop ?? 0;

        content.empty();

        // 在容器内部创建 .week-schedule 根节点，避免与宿主容器样式冲突
        const root = content.createDiv({ cls: 'week-schedule' });

        // ===== 左侧：任务面板 =====
        const taskPanel = root.createDiv({ cls: 'week-task-panel' });
        renderTaskPanel(
            this.app,
            taskPanel,
            this.inboxData,
            this.planCategoryData,
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
            { currentWeekKey: this.currentWeekKey, events: this.events, inboxRepo: this.inboxRepo() },  // 用于「周目标」筛选与统计
        );
        // 恢复任务面板列表的滚动位置，实现无感刷新
        if (prevTaskListScrollTop > 0) {
            const listEl = taskPanel.querySelector<HTMLElement>('.inbox-list');
            if (listEl) listEl.scrollTop = prevTaskListScrollTop;
        }

        // ===== 右侧：顶部工具栏 + 日历 =====
        const main = root.createDiv({ cls: 'week-main' });

        // 右上角工具栏（年周标签、时间计划方案、切换方案、图例）
        this.renderToolbar(main);

        // 日历区域
        const calendar = main.createDiv({ cls: 'week-calendar' });

        // ===== 周面板（公共组件）：一周七天，每天一列 =====
        const { dayColumns, statsCells } = renderWeekPanel(calendar, {
            onColumnClick: (d) => {
                // 点击某天列：将左侧选中的任务添加到这一天
                void this.addTaskToDay(d);
            },
        });

        // 渲染每列顶部的分类时长统计（依据当前时间计划方案）
        for (let d = 1; d <= 7; d++) {
            this.renderDayStats(statsCells[d - 1], d);
        }

        // 渲染每天列内的任务清单
        for (let d = 1; d <= 7; d++) {
            this.renderDayColumn(dayColumns[d - 1], d);
        }
    }

    async onClose() {
        this.closeEstimatePopover();
        const content = this.containerEl.children[1] as HTMLElement;
        content.empty();
    }

    // ===== 周面板：单日列 =====
    /**
     * 渲染某天列顶部的分类时长统计。
     * 每个分类显示两行：
     *   1) 时间计划方案中该分类的可用时长（计划时长）
     *   2) 本列计划事件按预估时长汇总的已分配时长
     */
    private renderDayStats(cell: HTMLElement, day: number) {
        // 方案中该天各分类的可用时长（分钟）
        const dayData = this.getPlanSchemeDays().find(d => d.day === day);
        const ranges = dayData?.ranges ?? [];
        const planned = new Map<PlanCategoryId, number>();
        for (const range of ranges) {
            const minutes = Math.max(0, range.end - range.start);
            if (minutes === 0) continue;
            planned.set(range.sort, (planned.get(range.sort) ?? 0) + minutes);
        }

        // 本列计划事件按分类汇总的已分配预估时长（分钟）
        const dayEvents = this.events.filter(
            ev => ev.day === day && ev.weekKey === this.currentWeekKey,
        );
        const allocated = new Map<PlanCategoryId, number>();
        for (const ev of dayEvents) {
            const minutes = ev.estimatedMinutes ?? 0;
            if (minutes <= 0) continue;
            const key = ev.categoryId ?? '';
            allocated.set(key, (allocated.get(key) ?? 0) + minutes);
        }

        // 合并出现过的分类（方案 + 已分配），按类别列表顺序稳定输出
        const keys = new Set<PlanCategoryId>();
        planned.forEach((_v, k) => keys.add(k));
        allocated.forEach((_v, k) => keys.add(k));
        if (keys.size === 0) {
            cell.createDiv({ cls: 'week-panel-stats-empty', text: '—' });
            return;
        }

        const ordered = this.planCategoryData.categories.filter(c => keys.has(c.id));
        if (keys.has('')) {
            ordered.push({ id: '', label: t('defaultCategory.uncategorized'), color: '#888888' });
        }

        for (const cat of ordered) {
            const item = cell.createDiv({ cls: 'week-panel-stats-item' });
            item.setCssProps({ '--stats-color': cat.color });

            // 第一行：分类名 + 方案可用时长
            const head = item.createDiv({ cls: 'week-panel-stats-head' });
            head.createSpan({ cls: 'week-panel-stats-dot' });
            head.createSpan({ cls: 'week-panel-stats-label', text: cat.label });
            head.createSpan({
                cls: 'week-panel-stats-value',
                text: this.formatDuration(planned.get(cat.id) ?? 0),
            });

            // 第二行：已分配时长
            const alloc = item.createDiv({ cls: 'week-panel-stats-alloc' });
            alloc.setText(t('weekPanel.allocated', {
                duration: this.formatDuration(allocated.get(cat.id) ?? 0),
            }));
        }
    }

    /** 将分钟数格式化为「Xh Ym」/「Ym」形式 */
    private formatDuration(minutes: number): string {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        if (h > 0 && m > 0) return `${h}h${m}m`;
        if (h > 0) return `${h}h`;
        return `${m}m`;
    }

    /** 将分钟数格式化为「HH:MM」时钟形式 */
    private formatClock(minutes: number): string {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    /**
     * 取事件来源任务的「习惯时间点」（分钟）。
     * 仅当来源任务存在且已启用习惯时间点时返回，否则返回 null。
     */
    private getEventHabitTime(ev: EventBlock): number | null {
        if (!ev.inboxId) return null;
        const item = this.inboxData.items.find(i => i.id === ev.inboxId && !i.removed);
        if (!item || !item.habitTimeEnabled) return null;
        return typeof item.habitTime === 'number' ? item.habitTime : null;
    }

    /** 渲染某天列内的任务清单（当天已排入的任务） */
    private renderDayColumn(col: HTMLElement, day: number) {
        const dayEvents = this.events.filter(
            ev => ev.day === day && ev.weekKey === this.currentWeekKey,
        );

        if (dayEvents.length === 0) {
            col.createDiv({ cls: 'week-panel-empty', text: t('weekPanel.empty') });
            return;
        }

        // 设置了习惯时间点的任务排在最前面（其余保持原有顺序）
        const ordered = dayEvents
            .map((ev, idx) => ({ ev, idx, habit: this.getEventHabitTime(ev) }))
            .sort((a, b) => {
                const ah = a.habit !== null ? 0 : 1;
                const bh = b.habit !== null ? 0 : 1;
                if (ah !== bh) return ah - bh;
                return a.idx - b.idx;
            });

        for (const { ev, habit } of ordered) {
            const chip = col.createDiv({ cls: 'week-panel-task' });
            const cat = ev.categoryId
                ? this.planCategoryData.categories.find(c => c.id === ev.categoryId)
                : undefined;
            chip.setCssProps({ '--chip-color': cat?.color ?? '#888888' });

            // 第一行：标题
            chip.createSpan({ cls: 'week-panel-task-title', text: ev.title });

            // 第二行：预估执行时长（未填写时显示占位提示）
            const estLine = chip.createDiv({ cls: 'week-panel-task-est' });
            if (typeof ev.estimatedMinutes === 'number' && ev.estimatedMinutes > 0) {
                estLine.setText(t('weekPanel.estimated', { duration: this.formatDuration(ev.estimatedMinutes) }));
            } else {
                estLine.addClass('is-empty');
                estLine.setText(t('weekPanel.estimatedEmpty'));
            }

            // 习惯时间点（来源任务已启用时显示）
            if (habit !== null) {
                const habitLine = chip.createDiv({ cls: 'week-panel-task-habit' });
                habitLine.setText(t('weekPanel.habitTime', { time: this.formatClock(habit) }));
            }

            // 点击卡片：在卡片旁弹出悬浮面板，填写预估执行时长
            chip.onclick = (e) => {
                e.stopPropagation();
                this.openEstimatePopover(chip, ev);
            };

            // 删除按钮（已制定周计划时计划固定，不允许删除）
            if (!this.plannedWeeks.includes(this.currentWeekKey)) {
                const delBtn = chip.createDiv({ cls: 'week-panel-task-del' });
                delBtn.setText('×');
                delBtn.onclick = async (e) => {
                    e.stopPropagation();
                    // 原地删除，保持数组引用不变（插件持有同一引用）
                    this.pdcaRepo().removeEvent(ev.id);
                    await this.save();
                    await this.onOpen();
                };
            }
        }
    }

    /**
     * 在卡片旁弹出悬浮面板，用于填写「预估执行时长」。
     * 面板挂在卡片内部（绝对定位），点击外部或按 Esc 关闭。
     */
    private openEstimatePopover(anchor: HTMLElement, ev: EventBlock) {
        // 同一时刻只保留一个面板
        this.closeEstimatePopover();

        const pop = anchor.createDiv({ cls: 'week-panel-est-popover' });
        this.estimatePopover = pop;

        pop.createDiv({ cls: 'week-panel-est-popover-title', text: t('weekPanel.estimatedLabel') });

        const input = pop.createEl('input', { cls: 'week-panel-est-input' });
        input.type = 'number';
        input.min = '0';
        input.step = '5';
        input.placeholder = t('weekPanel.estimatedPlaceholder');
        if (typeof ev.estimatedMinutes === 'number' && ev.estimatedMinutes > 0) {
            input.value = String(ev.estimatedMinutes);
        }

        const actions = pop.createDiv({ cls: 'week-panel-est-actions' });
        const saveBtn = actions.createEl('button', { text: t('common.save'), cls: 'mod-cta' });
        const cancelBtn = actions.createEl('button', { text: t('common.cancel') });

        const commit = async () => {
            const raw = input.value.trim();
            const minutes = raw === '' ? undefined : Math.max(0, Math.floor(Number(raw)));
            if (raw !== '' && (!Number.isFinite(minutes) || (minutes as number) < 0)) {
                new Notice(t('weekPanel.estimatedPlaceholder'));
                return;
            }
            // 原地修改，保持数组引用不变（插件持有同一引用）
            if (minutes === undefined || minutes === 0) {
                this.pdcaRepo().updateEvent(ev.id, { estimatedMinutes: undefined });
            } else {
                this.pdcaRepo().updateEvent(ev.id, { estimatedMinutes: minutes });
            }
            this.closeEstimatePopover();
            await this.save();
            await this.onOpen();
        };

        saveBtn.onclick = (e) => { e.stopPropagation(); void commit(); };
        cancelBtn.onclick = (e) => { e.stopPropagation(); this.closeEstimatePopover(); };
        // 阻止面板内点击冒泡到卡片（避免重复触发）
        pop.onclick = (e) => e.stopPropagation();
        input.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); void commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); this.closeEstimatePopover(); }
        };

        // 点击外部关闭
        this.estimateOutsideHandler = (e: MouseEvent) => {
            if (!pop.contains(e.target as Node)) this.closeEstimatePopover();
        };
        // 延迟注册，避免本次点击立即触发关闭
        window.setTimeout(() => {
            if (this.estimateOutsideHandler) {
                document.addEventListener('mousedown', this.estimateOutsideHandler);
            }
        }, 0);

        // 面板已挂载后，若右侧超出日历范围则向左偏移，避免被裁切
        this.adjustPopoverWithinCalendar(pop);

        input.focus();
        input.select();
    }

    /**
     * 校正悬浮面板的水平位置：默认左对齐卡片，若右侧超出日历容器则改为
     * 与卡片右缘对齐（面板右缘 = 卡片右缘），确保面板不会超出日历范围。
     */
    private adjustPopoverWithinCalendar(pop: HTMLElement) {
        // 先复位，避免基于上一次的偏移重复计算
        pop.style.left = '0';
        pop.style.right = 'auto';

        const boundary = pop.closest('.week-calendar') as HTMLElement | null;
        const popRect = pop.getBoundingClientRect();
        const boundaryRect = boundary
            ? boundary.getBoundingClientRect()
            : { left: 0, right: window.innerWidth } as DOMRect;

        const overflowRight = popRect.right - boundaryRect.right;
        if (overflowRight > 0) {
            // 与卡片右缘对齐：面板右缘贴齐卡片右缘
            const anchor = pop.parentElement as HTMLElement | null;
            if (anchor) {
                const anchorRect = anchor.getBoundingClientRect();
                const shift = popRect.right - anchorRect.right;
                pop.style.left = `calc(0px - ${shift}px)`;
            } else {
                pop.style.left = `calc(0px - ${overflowRight + 4}px)`;
            }
        }
    }

    /** 关闭预估时长悬浮面板 */
    private closeEstimatePopover() {
        if (this.estimateOutsideHandler) {
            document.removeEventListener('mousedown', this.estimateOutsideHandler);
            this.estimateOutsideHandler = null;
        }
        if (this.estimatePopover) {
            this.estimatePopover.remove();
            this.estimatePopover = null;
        }
    }

    /** 将左侧选中的任务添加到某一天（周面板点击列时调用） */
    private async addTaskToDay(day: number) {
        const selectedInboxItem = this.getSelectedInboxItem();
        if (!selectedInboxItem) {
            new Notice(t('allday.needSelect'));
            return;
        }
        // 已制定周计划时计划已固定，不允许再添加
        if (this.plannedWeeks.includes(this.currentWeekKey)) {
            new Notice(t('event.weekPlannedLocked'));
            return;
        }
        // 当天已有该任务的任何事件，则不再重复添加
        if (this.hasAnyEventForItem(selectedInboxItem, day)) {
            new Notice(t('event.alreadyScheduled', { title: selectedInboxItem.title }));
            return;
        }
        this.pdcaRepo().addEvent({
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
            // 继承任务的预估时长（未填写时不设置）
            ...(typeof selectedInboxItem.estimatedMinutes === 'number' && selectedInboxItem.estimatedMinutes > 0
                ? { estimatedMinutes: selectedInboxItem.estimatedMinutes }
                : {}),
        });
        // 加入某天时，同时成为该周的周目标
        this.assignItemToDay(selectedInboxItem, day);
        log('周面板添加任务', {
            weekKey: this.currentWeekKey,
            day,
            title: selectedInboxItem.title,
            inboxId: selectedInboxItem.id,
        });
        await this.save();
        await this.onOpen();
        new Notice(t('event.scheduled', { title: selectedInboxItem.title }));
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
            ? this.planCategoryData.categories.find(c => c.id === ev.categoryId)
            : undefined;
        square.setCssProps({ '--chip-color': cat?.color ?? '#888888' });
        // 方块内不显示文字，用 title 提示任务名
        square.setAttribute('title', ev.title);
    }

    /** 渲染单个全天事件条目（带文字的清单条目，用于展开面板） */
    private renderAllDayChip(cell: HTMLElement, ev: EventBlock) {
        const chip = cell.createDiv({ cls: 'all-day-chip' });
        const cat = ev.categoryId
            ? this.planCategoryData.categories.find(c => c.id === ev.categoryId)
            : undefined;
        chip.setCssProps({ '--chip-color': cat?.color ?? '#888888' });
        chip.setText(ev.title);

        // 可删除
        const delBtn = chip.createDiv({ cls: 'all-day-chip-del' });
        delBtn.setText('×');
        delBtn.onclick = async (e) => {
            e.stopPropagation();
            // 原地删除，保持数组引用不变（插件持有同一引用）
            this.pdcaRepo().removeEvent(ev.id);
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
        this.pdcaRepo().addEvent({
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
            // 继承任务的预估时长（未填写时不设置）
            ...(typeof selectedInboxItem.estimatedMinutes === 'number' && selectedInboxItem.estimatedMinutes > 0
                ? { estimatedMinutes: selectedInboxItem.estimatedMinutes }
                : {}),
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
            const dayData = this.getPlanSchemeDays().find(day => day.day === d);
            const dayRanges = dayData?.ranges ?? [];
            for (const range of dayRanges) {
                const bgBlock = col.createDiv({ cls: 'range-block range-bg' });
                const cat = this.planCategoryData.categories.find(c => c.id === range.sort);
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

            // 计划事件统一为全天事件（在顶部全天面板展示），日历列不再创建/渲染时间点事件

            // 已制定周计划：按背景网格 2 小时区间悬浮，显示该区间内的执行信息
            if (this.plannedWeeks.includes(this.currentWeekKey)) {
                this.attachRangeHover(col, d);
            }
        }

        // 当前时间红线（仅当天列）
        this.renderCurrentTimeLine(bodyRowInner);
    }

    /** 分钟数 → HH:MM */
    private formatMinutes(min: number): string {
        const h = Math.floor(min / 60);
        const m = min % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    /**
     * 已制定周计划时：按背景网格的 2 小时区间悬浮。
     * 鼠标在某天列的某个 2 小时区间内移动时，显示该区间内的所有执行记录。
     * （计划事件统一为全天事件，在顶部全天面板展示，不再按时间点出现在日历列）
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

            // 区间内所有执行记录（按开始时间排序）
            const execs = this.executions
                .filter(ex => ex.day === day && ex.weekKey === this.currentWeekKey
                    && ex.start < rangeEnd && ex.end > rangeStart)
                .sort((a, b) => a.start - b.start);

            // 单列容器：执行信息
            const cols = tip.createDiv({ cls: 'range-hover-cols' });
            const execCol = cols.createDiv({ cls: 'range-hover-col' });
            execCol.createDiv({ cls: 'range-hover-col-title', text: t('eventTooltip.execCol') });
            if (execs.length === 0) {
                execCol.createDiv({ cls: 'range-hover-empty', text: t('eventTooltip.none') });
            } else {
                for (const ex of execs) {
                    this.renderRangeHoverExecCard(execCol, ex);
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

    /**
     * 判定执行记录状态（仅两种）：
     * - 已执行：关联了计划事件，或来源任务当天有计划事件（习惯任务 / 当天任务）
     * - 新增：计划外任务被执行
     */
    private getExecStatus(ex: ExecutionRecord): EventStatus {
        if (ex.eventId) return 'executed';
        if (ex.inboxId) {
            const planned = this.events.some(ev =>
                ev.inboxId === ex.inboxId
                && ev.day === ex.day
                && ev.weekKey === ex.weekKey,
            );
            if (planned) return 'executed';
        }
        return 'added';
    }

    /** 渲染区间悬浮中的「执行记录」详细卡片 */
    private renderRangeHoverExecCard(parent: HTMLElement, ex: ExecutionRecord) {
        const card = parent.createDiv({ cls: 'range-hover-card' });

        // 状态：计划内任务（习惯任务 / 当天任务）→ 已执行；计划外任务 → 新增
        const status: EventStatus = this.getExecStatus(ex);

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
            ? this.planCategoryData.categories.find(c => c.id === item.categoryId)
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
            text: `${EVENT_STATUS_EMOJI[status]} ${t(EVENT_STATUS_LABEL_KEY[status] as Parameters<typeof t>[0])}`,
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
                this.pdcaRepo().togglePlannedWeek(this.currentWeekKey);
                await this.save();
                await this.onOpen();
            })();
        };

        // 时间计划方案按钮 + 当前方案下拉框
        const schemeBar = toolbar.createDiv({ cls: 'plan-scheme-bar' });

        // 当前时间计划方案下拉框（至少存在默认方案，无需「未选择方案」选项）
        const schemeSelect = schemeBar.createEl('select', { cls: 'plan-scheme-select' });
        for (const scheme of this.planSchemeData.schemes) {
            schemeSelect.createEl('option', { text: scheme.name, value: scheme.id });
        }
        // 未激活时默认选中默认方案
        const activeId = this.planSchemeData.activeSchemeId
            ?? this.planSchemeData.defaultSchemeId
            ?? this.planSchemeData.schemes[0]?.id
            ?? '';
        schemeSelect.value = activeId;
        schemeSelect.onchange = () => {
            this.planSchemeRepo().setActiveSchemeId(schemeSelect.value || undefined);
            void (async () => {
                await this.save();
                await this.onOpen();
            })();
        };

        // 图例（日历顶部：显示配置按钮）
        const legendContainer = toolbar.createDiv({ cls: 'legend-container' });
        renderPlanCategoryLegend(
            this.app,
            legendContainer,
            this.planCategoryData,
            () => {
                void this.onOpen();
            },
            undefined,
            undefined,
            true,
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

            // 时间计划方案
            const schemeBtn = panel.createEl('button', {
                text: t('planScheme.open'),
                cls: 'more-tools-item',
            });
            schemeBtn.onclick = () => {
                new PlanSchemeModal(
                    this.app,
                    this.planCategoryData,
                    this.planSchemeData,
                    this,
                    (templateId, targetDays) => this.applyTemplate(templateId, targetDays),
                    () => this.save(),
                    () => {
                        void this.save();
                        void this.onOpen();
                    },
                    this.categoryRepo(),
                    this.planSchemeRepo(),
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
    private getActivePlanScheme() {
        return this.planSchemeRepo().getActiveScheme();
    }

    /** 获取当前激活方案的日区间配置（周无关的模板数据） */
    getPlanSchemeDays(): DailyRange[] {
        return this.getActivePlanScheme()?.days ?? [];
    }

    /** 日模板领域仓库（作为 TemplateViewContext 提供给模板面板，保证跨视图一致） */
    get templateRepo(): TemplateRepo {
        return (this.plugin as Plugin & { templateRepo: TemplateRepo }).templateRepo;
    }

    /** 应用日模板到指定日期（写入当前激活方案） */
    private async applyTemplate(templateId: string, targetDays: number[]) {
        const tpl = this.dayTemplateData.dayTemplates.find(t => t.id === templateId);
        if (!tpl) { new Notice(t('template.notFound')); return; }
        const scheme = this.getActivePlanScheme();
        if (!scheme) { new Notice(t('planScheme.noActive')); return; }
        const repo = this.planSchemeRepo();
        for (const day of targetDays) {
            repo.setDayRanges(scheme.id, day, tpl.ranges.map(range => ({
                ...range,
                id: `r_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            })));
            this.templateRepo.setDayProperty(day, templateId);
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
                this.pdcaRepo().addEvent({
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
            this.pdcaRepo().addEvent({
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

    /** 判断某任务在当前周的某天是否已排入事件 */
    private hasAnyEventForItem(item: InboxItem, day: number): boolean {
        return this.events.some(ev =>
            ev.inboxId === item.id
            && ev.day === day
            && ev.weekKey === this.currentWeekKey,
        );
    }

    /**
     * 将任务标记为「已加入某天」，同时加入当前周目标。
     * 加入某天时，该任务也应成为这一周的周目标。
     */
    private assignItemToDay(item: InboxItem, day: number): void {
        const dayKey = makeDayKeyFromWeek(this.currentWeekKey, day);
        this.inboxRepo().assignToDay(item.id, dayKey);
        this.inboxRepo().assignToWeek(item.id, this.currentWeekKey);
    }

}

// 时间区块。
// 弹窗。
export class RangeEditModal extends Modal {
    private start: number;
    private end: number;
    private sort: PlanCategoryId;
    private onSubmit: (start: number, end: number, sort: PlanCategoryId) => void;
    private categoryData: PlanCategoryData;

    constructor(
        app: App,
        defaultStart: number,
        onSubmit: (start: number, end: number, sort: PlanCategoryId) => void,
        categoryData: PlanCategoryData,
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
            this.sort = (defaultSort as PlanCategoryId) ?? categoryData.categories[0]?.id ?? 'work';
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

