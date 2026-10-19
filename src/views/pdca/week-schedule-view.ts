

import { ItemView, WorkspaceLeaf, Modal, Setting, Notice, App, setIcon } from 'obsidian';
import type { Plugin } from 'obsidian';
import type { CategorizedRange, PlanCategoryId, PlanSchemeData, DailyRange, WeekKey } from '../../shared/plan-data';
import { hexToTransparent, getCurrentWeekKey, makeWeekKey, parseWeekKey, shiftWeekKey, makeDayKeyFromWeek, DEFAULT_SCHEME_ID } from '../../shared/plan-data';
import type { PlanCategoryData } from '../../shared/plan-category-manager';
import type { DayTemplateData } from '../../shared/template-manager';
import { renderPlanCategoryLegend } from '../../shared/plan-category-manager';
import { renderTemplatePanel } from '../../shared/template-manager';
import { renderTaskPanel } from '../../shared/task-panel';
import { DEFAULT_INBOX_DATA, type InboxData, type InboxItem } from '../../datatypes/domain';
import { renderWeekPanel } from '../../shared/week-panel';
import { renderWeekGrid } from '../../shared/week-grid';
import { t } from '../../i18n';
import { log } from '../../shared/logger';
import { EVENT_STATUS_EMOJI, EVENT_STATUS_LABEL_KEY } from '../../datatypes/domain';
import type { EventBlock, ExecutionRecord, EventStatus } from '../../datatypes/domain';
import type { PdcaRepo } from '../../repos/pdca-repo';
import type { InboxRepo } from '../../repos/inbox-repo';
import type { CategoryRepo } from '../../repos/category-repo';
import type { TemplateRepo } from '../../repos/template-repo';
import type { PlanSchemeRepo } from '../../repos/plan-scheme-repo';
import type { BaseRepo } from '../../repos/base-repo';

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
    /** 全周习惯任务剪贴板：暂存「复制本周习惯任务」的任务模板（保留 day，不含 id/weekKey） */
    private clipboardWeekHabitEvents: Omit<EventBlock, 'id' | 'weekKey'>[] | null = null;
    /** 全周习惯任务剪贴板来源周键，用于粘贴弹窗提示 */
    private clipboardWeekHabitSource: WeekKey | null = null;
    /** 「更多工具」下拉面板是否展开 */
    private moreToolsOpen = false;
    /** 是否折叠习惯任务（折叠时列内隐藏习惯任务，改为显示一行统计；状态持久化在仓库数据中） */
    private get habitsCollapsed(): boolean {
        return this.baseRepo().data?.habitsCollapsed === true;
    }
    /** 是否激活「时间计划」模式（激活时隐藏下方日历，改为显示时间计划方案弹窗里的日历功能点；状态持久化在仓库数据中） */
    private get timePlanActive(): boolean {
        return this.baseRepo().data?.timePlanActive === true;
    }
    /** 时间计划模式下是否在日历上显示习惯任务（状态持久化在仓库数据中，默认显示） */
    private get timePlanShowHabits(): boolean {
        return this.baseRepo().data?.timePlanShowHabits !== false;
    }
    /** 时间计划模式下图例选中的分类（新建区间时的默认分类） */
    private timePlanSelectedCategoryId?: string;
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

    /** 从插件实例获取基础数据仓库（读取/写入随主数据持久化的视图状态） */
    private baseRepo(): BaseRepo {
        return (this.plugin as Plugin & { repo: BaseRepo }).repo;
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

        // ===== 左侧：任务面板 / 时间计划配置面板 =====
        if (this.timePlanActive) {
            // 时间计划模式：隐藏任务面板，配置面板占据原任务面板的位置
            const configPanel = root.createDiv({ cls: 'week-task-panel time-plan-side-panel' });
            this.renderTimePlanSidePanel(configPanel);
        } else {
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
                { inboxRepo: this.inboxRepo() },
            );
            // 恢复任务面板列表的滚动位置，实现无感刷新
            if (prevTaskListScrollTop > 0) {
                const listEl = taskPanel.querySelector<HTMLElement>('.inbox-list');
                if (listEl) listEl.scrollTop = prevTaskListScrollTop;
            }
        }

        // ===== 右侧：顶部工具栏 + 日历 =====
        const main = root.createDiv({ cls: 'week-main' });

        // 右上角工具栏（年周标签、时间计划方案、切换方案、图例）
        this.renderToolbar(main);

        // 日历区域
        const calendar = main.createDiv({ cls: 'week-calendar' });

        // 激活「时间计划」模式时：隐藏下方周面板日历，改为显示时间计划方案弹窗里的日历功能点
        if (this.timePlanActive) {
            this.renderTimePlanCalendar(calendar);
            return;
        }

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

        // 折叠习惯：在统计行下方插入一整行习惯统计（与统计行同结构，左右撑满）
        if (this.habitsCollapsed) {
            this.renderHabitSummaryRow(statsCells[0].parentElement as HTMLElement);
        }

        // 渲染每天列内的任务清单
        // 习惯任务按「时间点 + 任务」跨列对齐：先收集本周所有习惯任务行，作为各列共用的行顺序
        const habitRows = this.collectHabitRows();
        for (let d = 1; d <= 7; d++) {
            this.renderDayColumn(dayColumns[d - 1], d, habitRows);
        }
    }

    /**
     * 渲染「时间计划」模式下的左侧配置面板（占据原任务面板的位置）：
     * 行标题 + 配置 + 方案管理（黑色边框面板）+ 日模板。
     */
    private renderTimePlanSidePanel(container: HTMLElement) {
        // 行标题（最上方）
        container.createDiv({
            cls: 'time-plan-panel-title',
            text: t('weekPanel.timePlanConfigTitle'),
        });

        // 配置（方案管理上方）
        this.renderTimePlanConfigPanel(container);

        // 方案管理（黑色边框面板）
        this.renderTimePlanSchemePanel(container);

        // 日模板（方案管理下方）
        const templateContainer = container.createDiv({ cls: 'template-container' });
        renderTemplatePanel(this.app, templateContainer, this, async (templateId, targetDays) => {
            await this.applyTemplate(templateId, targetDays);
            // 应用后刷新日历
            void this.onOpen();
        }, () => {
            // 新增模板后刷新
            void this.onOpen();
        });
    }

    /**
     * 渲染「时间计划」模式下的日历：右侧时间轴日历。
     * 选中分类的功能集成到日历顶部的图例（工具栏），选中后点击日历分配时间区间，
     * 点击已有色块可编辑，× 可删除；数据写入当前激活方案。
     */
    private renderTimePlanCalendar(calendar: HTMLElement) {
        const body = calendar.createDiv({ cls: 'plan-scheme-body' });

        // 右侧：时间轴日历
        const calendarPanel = body.createDiv({ cls: 'plan-scheme-calendar' });
        const refs = renderWeekGrid(calendarPanel);
        this.renderTimePlanRangeLayer(refs.bodyRowInner);

        // 显示习惯任务时：在时间轴对应时间点渲染习惯任务标记
        if (this.timePlanShowHabits) {
            this.renderTimePlanHabitMarkers(refs.bodyRowInner);
        }
    }

    /**
     * 渲染「配置」面板（位于方案管理面板上方）：
     * 标题 + 一行「开关 + 显示习惯任务」。
     */
    private renderTimePlanConfigPanel(container: HTMLElement) {
        const panel = container.createDiv({ cls: 'time-plan-config-panel' });

        // 标题
        const header = panel.createDiv({ cls: 'tbcat-modal-header' });
        header.createEl('h3', { text: t('weekPanel.config') });

        // 第一行：开关 + 显示习惯任务
        const row = panel.createDiv({ cls: 'time-plan-config-row' });
        const toggle = row.createEl('input', { type: 'checkbox', cls: 'time-plan-config-toggle' });
        toggle.checked = this.timePlanShowHabits;
        toggle.onchange = () => {
            const data = this.baseRepo().data;
            if (!data) return;
            data.timePlanShowHabits = toggle.checked;
            void (async () => {
                await this.save();
                await this.onOpen();
            })();
        };
        row.createSpan({ text: t('weekPanel.showHabits'), cls: 'time-plan-config-label' });
    }

    /**
     * 渲染「方案管理」面板（黑色边框）：
     * 标题 + 新增按钮 + 方案列表（名称 / 删除 / 切换）。
     * 直接操作仓库并即时保存，无需草稿 + 确认/取消。
     */
    private renderTimePlanSchemePanel(container: HTMLElement) {
        const panel = container.createDiv({ cls: 'time-plan-scheme-panel' });

        // 标题 + 右上角 +
        const header = panel.createDiv({ cls: 'tbcat-modal-header' });
        header.createEl('h3', { text: t('planScheme.manageTitle') });
        const addBtn = header.createEl('button', { text: '+', cls: 'tbcat-add-btn' });
        addBtn.onclick = () => {
            this.planSchemeRepo().schemes.push({
                id: 'scheme_' + Date.now().toString(36),
                name: t('planScheme.new'),
                days: [],
            });
            void (async () => {
                await this.save();
                await this.onOpen();
            })();
        };

        // 方案列表
        const list = panel.createDiv({ cls: 'tbcat-list' });
        const schemes = this.planSchemeRepo().schemes;
        if (schemes.length === 0) {
            list.createDiv({ text: t('planScheme.empty'), cls: 'tbcat-empty' });
            return;
        }

        schemes.forEach((scheme, index) => {
            const row = list.createDiv({ cls: 'tbcat-row' });

            // 切换（设为当前方案，位于每行最前面）
            const switchBtn = row.createEl('button', {
                text: t('planScheme.switchTo'),
                cls: 'tbcat-action-btn',
            });
            if (scheme.id === this.planSchemeRepo().activeSchemeId) {
                switchBtn.addClass('is-active');
            }
            switchBtn.onclick = () => {
                this.planSchemeRepo().setActiveSchemeId(scheme.id);
                void (async () => {
                    await this.save();
                    await this.onOpen();
                })();
            };

            // 名称
            const name = row.createEl('input', {
                type: 'text',
                placeholder: t('planScheme.namePlaceholder'),
                cls: 'tbcat-name',
            });
            name.value = scheme.name;
            name.addEventListener('input', () => {
                scheme.name = name.value;
            });
            name.addEventListener('change', () => {
                void this.save();
            });

            // 删除（默认方案不可删除）
            if (scheme.id === DEFAULT_SCHEME_ID) {
                const lock = row.createSpan({ text: '🔒', cls: 'tbcat-lock' });
                lock.setAttribute('aria-label', t('planScheme.defaultLocked'));
            } else {
                const del = row.createEl('button', { text: '✕', cls: 'tbcat-del-btn' });
                del.onclick = () => {
                    this.planSchemeRepo().schemes.splice(index, 1);
                    void (async () => {
                        await this.save();
                        await this.onOpen();
                    })();
                };
            }
        });
    }

    /** 在时间计划日历网格上渲染当前激活方案的时间区间，并绑定添加/编辑/删除交互 */
    private renderTimePlanRangeLayer(bodyRowInner: HTMLElement) {
        const scheme = this.getActivePlanScheme();
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
                    this.planSchemeRepo().addRange(scheme.id, d, { id: `r_${Date.now()}`, start, end, sort });
                    void (async () => {
                        await this.save();
                        await this.onOpen();
                    })();
                }, this.planCategoryData, undefined, this.timePlanSelectedCategoryId).open();
            };

            // 已有色块
            const dayData = scheme?.days?.find(day => day.day === d);
            const dayRanges = dayData?.ranges ?? [];
            for (const range of dayRanges) {
                const block = col.createDiv({ cls: 'range-block range-block-fill' });
                const cat = this.planCategoryData.categories.find(c => c.id === range.sort);
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
                        this.planSchemeRepo().updateRange(scheme!.id, d, range.id, { start, end, sort });
                        void (async () => {
                            await this.save();
                            await this.onOpen();
                        })();
                    }, this.planCategoryData, range).open();
                };

                const delBtn = block.createDiv({ cls: 'range-delete-btn' });
                delBtn.setText('×');
                delBtn.onclick = async (e) => {
                    e.stopPropagation();
                    this.planSchemeRepo().removeRange(scheme!.id, d, range.id);
                    await this.save();
                    await this.onOpen();
                };
            }
        }
    }

    /**
     * 渲染「习惯任务」标记：本周已分配到各天、且启用了习惯时间点的任务，
     * 在时间轴对应时间点以透明化色块显示（不拦截点击）。
     * 与日执行视图时间轴上的习惯任务标记一致。
     */
    private renderTimePlanHabitMarkers(bodyRowInner: HTMLElement) {
        const cols = bodyRowInner.querySelectorAll('.day-column');

        for (let d = 1; d <= 7; d++) {
            const col = cols[d - 1] as HTMLElement;

            // 本周该天、且设置了习惯时间点的事件
            const habitEvents = this.events.filter(
                ev => ev.day === d
                    && ev.weekKey === this.currentWeekKey
                    && this.getEventHabitTime(ev) !== null,
            );

            for (const ev of habitEvents) {
                const minutes = this.getEventHabitTime(ev)!;
                const marker = col.createDiv({ cls: 'time-plan-habit-marker' });
                const cat = ev.categoryId
                    ? this.planCategoryData.categories.find(c => c.id === ev.categoryId)
                    : undefined;
                marker.setCssProps({
                    '--habit-color': cat?.color ?? '#888888',
                    '--habit-top': `${(minutes / 120) * 80}px`,
                });
                marker.setText(ev.title);
            }
        }
    }

    /**
     * 收集本周所有习惯任务行（升序），用于各列习惯任务按行对齐。
     * 同一时间点可能有多个不同任务：按「时间点 + 任务」拆成多行，
     * 这样相同任务能对齐到同一行；某列该行没有任务时留空白占位。
     * 行顺序按「时间点 → 该时间点内任务首次出现的先后」排列，
     * 保证同一时间点的任务在各列占用相同的行位置。
     */
    private collectHabitRows(): { time: number; key: string }[] {
        const rows = new Map<string, { time: number; key: string; order: number }>();
        let order = 0;
        for (const ev of this.events) {
            if (ev.weekKey !== this.currentWeekKey) continue;
            const time = this.getEventHabitTime(ev);
            if (time === null) continue;
            const key = this.getHabitRowKey(ev);
            if (!rows.has(key)) rows.set(key, { time, key, order: order++ });
        }
        return Array.from(rows.values())
            .sort((a, b) => (a.time !== b.time ? a.time - b.time : a.order - b.order))
            .map(({ time, key }) => ({ time, key }));
    }

    /** 习惯任务行的对齐键：优先按来源任务（同一任务跨列对齐），无来源任务时按标题 */
    private getHabitRowKey(ev: EventBlock): string {
        return ev.inboxId ? `item:${ev.inboxId}` : `title:${ev.title}`;
    }

    /**
     * 计算习惯任务行的统一高度（像素）。
     * 各列的习惯行必须等高，否则某列卡片换行（标题/时长占两行）时，
     * 后续行会被整体下推，导致相同任务在不同列错位。
     * 这里按「卡片最高可能高度」估算：标题一行 + 预估时长一行 + 习惯时间点一行 + 内边距。
     */
    private getHabitRowHeight(): number {
        return 52;
    }

    /**
     * 渲染折叠习惯后的统计行：7 个单元格，每列显示「习惯数 · 总时长」。
     * 结构与上方饼图统计行一致（整行撑满、单元格之间用分隔线连接）。
     */
    private renderHabitSummaryRow(statsRow: HTMLElement) {
        const row = statsRow.createDiv({ cls: 'week-panel-habit-summary' });
        statsRow.insertAdjacentElement('afterend', row);

        for (let d = 1; d <= 7; d++) {
            const habits = this.events.filter(
                ev => ev.day === d
                    && ev.weekKey === this.currentWeekKey
                    && this.getEventHabitTime(ev) !== null,
            );
            const totalMinutes = habits.reduce(
                (sum, ev) => sum + (ev.estimatedMinutes ?? 0), 0,
            );
            const cell = row.createDiv({ cls: 'week-panel-habit-summary-cell' });
            cell.createDiv({
                cls: 'week-panel-habit-summary-line',
                text: t('weekPanel.habitSummaryCount', { count: habits.length }),
            });
            cell.createDiv({
                cls: 'week-panel-habit-summary-line',
                text: t('weekPanel.habitSummaryDuration', { duration: this.formatDuration(totalMinutes) }),
            });
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
     * 每个分类一个饼图（从左到右排列），饼图用分类颜色表示
     * 「已分配预估时长 / 方案计划时长」的占比，悬停显示具体时长。
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
            const plannedMinutes = planned.get(cat.id) ?? 0;
            const allocatedMinutes = allocated.get(cat.id) ?? 0;
            // 占比：已分配 / 计划（计划为 0 时按 0 处理，避免除零）
            const ratio = plannedMinutes > 0
                ? Math.min(1, allocatedMinutes / plannedMinutes)
                : 0;

            const item = cell.createDiv({ cls: 'week-panel-stats-item' });
            item.setCssProps({ '--stats-color': cat.color });
            item.setAttribute('aria-label', t('weekPanel.statsTooltip', {
                label: cat.label,
                allocated: this.formatDuration(allocatedMinutes),
                planned: this.formatDuration(plannedMinutes),
                percent: String(Math.round(ratio * 100)),
            }));

            // 饼图：用分类颜色填充已分配占比，剩余部分为底色
            const pie = item.createDiv({ cls: 'week-panel-stats-pie' });
            pie.setCssProps({ '--stats-ratio': String(ratio) });
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
     * 未手动设置时间点时按默认 09:00 显示（与任务计划页面的默认值一致）。
     */
    private getEventHabitTime(ev: EventBlock): number | null {
        if (!ev.inboxId) return null;
        const item = this.inboxData.items.find(i => i.id === ev.inboxId && !i.removed);
        if (!item || !item.habitTimeEnabled) return null;
        return typeof item.habitTime === 'number' ? item.habitTime : 9 * 60;
    }

    /**
     * 渲染某天列内的任务清单（当天已排入的任务）。
     * 列内分为上下两部分：上方习惯任务、下方当天任务，中间用分割线区分；
     * 两部分各自在无任务时显示对应提示文字。
     * 折叠习惯时不再显示习惯任务区（统计行已展示习惯数量与总时长）。
     * 习惯任务按「时间点 + 任务」分行，各列共用同一组行顺序，
     * 保证相同任务（同一时间点）的卡片在同一高度；该行没有任务的列留空白占位。
     */
    private renderDayColumn(col: HTMLElement, day: number, habitRows: { time: number; key: string }[]) {
        const dayEvents = this.events.filter(
            ev => ev.day === day && ev.weekKey === this.currentWeekKey,
        );

        // 按是否设置习惯时间点拆分：习惯任务在上，当天任务在下（各自保持原有顺序）
        const habitEvents = dayEvents
            .filter(ev => this.getEventHabitTime(ev) !== null)
            // 习惯任务按时间点先后顺序从上往下排列
            .sort((a, b) => (this.getEventHabitTime(a) ?? 0) - (this.getEventHabitTime(b) ?? 0));
        const normalEvents = dayEvents.filter(ev => this.getEventHabitTime(ev) === null);

        // ===== 上半部分：习惯任务（折叠习惯时整块隐藏，由统计行代替）=====
        if (!this.habitsCollapsed) {
            const habitSection = col.createDiv({ cls: 'week-panel-section week-panel-section-habit' });
            if (habitEvents.length === 0) {
                habitSection.createDiv({ cls: 'week-panel-empty', text: t('weekPanel.emptyHabit') });
            } else {
                // 按本周所有习惯任务行逐行渲染：该行没有任务的列留出等高空白占位
                const rowHeight = this.getHabitRowHeight();
                for (const row of habitRows) {
                    const slot = habitSection.createDiv({ cls: 'week-panel-habit-slot' });
                    // 固定行高：保证各列同一行高度一致，避免卡片内容换行导致后续行错位
                    slot.setCssProps({ height: `${rowHeight}px` });
                    const evs = habitEvents.filter(ev => this.getHabitRowKey(ev) === row.key);
                    if (evs.length === 0) {
                        slot.addClass('is-empty');
                        continue;
                    }
                    for (const ev of evs) {
                        this.renderDayEventChip(slot, ev, this.getEventHabitTime(ev));
                    }
                }
            }

            // 分割线
            col.createDiv({ cls: 'week-panel-section-divider' });
        }

        // ===== 下半部分：当天任务 =====
        const taskSection = col.createDiv({ cls: 'week-panel-section week-panel-section-task' });
        if (normalEvents.length === 0) {
            taskSection.createDiv({ cls: 'week-panel-empty', text: t('weekPanel.emptyTask') });
        } else {
            for (const ev of normalEvents) {
                this.renderDayEventChip(taskSection, ev, null);
            }
        }

        // 列底部留白（约一张卡片高度），保证卡片较多时仍有可点击的空白区域
        col.createDiv({ cls: 'week-panel-column-spacer' });
    }

    /** 渲染列内单个任务卡片（标题 + 预估时长 + 习惯时间点 + 删除按钮） */
    private renderDayEventChip(container: HTMLElement, ev: EventBlock, habit: number | null) {
        const chip = container.createDiv({ cls: 'week-panel-task' });
        const cat = ev.categoryId
            ? this.planCategoryData.categories.find(c => c.id === ev.categoryId)
            : undefined;
        chip.setCssProps({ '--chip-color': cat?.color ?? '#888888' });

        // 第一行：标题
        chip.createSpan({ cls: 'week-panel-task-title', text: ev.title });

        // 第二行：预估执行时长（未填写时显示占位提示）
        const estLine = chip.createDiv({ cls: 'week-panel-task-est' });
        if (typeof ev.estimatedMinutes === 'number' && ev.estimatedMinutes >= 0) {
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

        // 右上角标记：当天已完成时显示完成标识，否则显示删除按钮
        if (this.isEventDayDone(ev)) {
            const doneIcon = chip.createSpan({ cls: 'week-panel-task-done' });
            setIcon(doneIcon, 'check-circle');
        } else if (!this.plannedWeeks.includes(this.currentWeekKey)) {
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

    /**
     * 判断某个计划事件在其对应「当天」是否已完成。
     * 判定规则与二级视图（日执行）左侧当天事件卡片一致：
     * 优先读取手动标记的完成 / 未完成日期，其次比较已执行时长与预估时长，
     * 无预估时长时只要有执行记录即视为完成。
     */
    private isEventDayDone(ev: EventBlock): boolean {
        const item = ev.inboxId
            ? this.inboxData.items.find(i => i.id === ev.inboxId && !i.removed)
            : undefined;
        const dayKey = makeDayKeyFromWeek(ev.weekKey, ev.day);

        // 手动标记优先：标记为未完成时不显示完成标识
        if (item && (item.undoneDayKeys ?? []).includes(dayKey)) return false;
        if (item && (item.doneDayKeys ?? []).includes(dayKey)) return true;

        const estMinutes = typeof ev.estimatedMinutes === 'number' && ev.estimatedMinutes >= 0
            ? ev.estimatedMinutes
            : undefined;
        const execMinutes = this.executions
            .filter(ex => !ex.replaced
                && ex.weekKey === ev.weekKey
                && ex.day === ev.day
                && (ex.eventId === ev.id || (ev.inboxId && ex.inboxId === ev.inboxId)))
            .reduce((sum, ex) => sum + Math.max(0, ex.end - ex.start), 0);

        if (estMinutes === undefined || estMinutes === 0) return execMinutes > 0;
        return execMinutes >= estMinutes;
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
        if (typeof ev.estimatedMinutes === 'number' && ev.estimatedMinutes >= 0) {
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
            // 允许设置为 0（0 表示预估时长为零，与「未填写」区分）
            if (minutes === undefined) {
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
        pop.setCssProps({ left: '0', right: 'auto' });

        const boundary = pop.closest('.week-calendar');
        const popRect = pop.getBoundingClientRect();
        const boundaryRect = boundary
            ? boundary.getBoundingClientRect()
            : { left: 0, right: window.innerWidth } as DOMRect;

        const overflowRight = popRect.right - boundaryRect.right;
        if (overflowRight > 0) {
            // 与卡片右缘对齐：面板右缘贴齐卡片右缘
            const anchor = pop.parentElement;
            if (anchor) {
                const anchorRect = anchor.getBoundingClientRect();
                const shift = popRect.right - anchorRect.right;
                pop.setCssProps({ left: `calc(0px - ${shift}px)` });
            } else {
                pop.setCssProps({ left: `calc(0px - ${overflowRight + 4}px)` });
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
            // 继承任务的预估时长（未填写时不设置；0 为有效值）
            ...(typeof selectedInboxItem.estimatedMinutes === 'number' && selectedInboxItem.estimatedMinutes >= 0
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
            // 继承任务的预估时长（未填写时不设置；0 为有效值）
            ...(typeof selectedInboxItem.estimatedMinutes === 'number' && selectedInboxItem.estimatedMinutes >= 0
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

        // 时间计划按钮：激活后隐藏下方日历，改为显示时间计划方案弹窗里的日历功能点
        const timePlanBtn = toolbar.createEl('button', {
            text: t('weekPanel.timePlan'),
            cls: 'week-time-plan-btn',
        });
        timePlanBtn.toggleClass('is-active', this.timePlanActive);
        timePlanBtn.onclick = () => {
            const data = this.baseRepo().data;
            if (!data) return;
            data.timePlanActive = !this.timePlanActive;
            void (async () => {
                await this.save();
                await this.onOpen();
            })();
        };

        // 折叠习惯按钮（位于图例左侧）：折叠后列内隐藏习惯任务，改为显示一行统计
        const habitToggleBtn = toolbar.createEl('button', {
            text: t('weekPanel.collapseHabits'),
            cls: 'week-habit-toggle-btn',
        });
        habitToggleBtn.toggleClass('is-active', this.habitsCollapsed);
        // 时间计划激活时：折叠习惯按钮不可点击
        habitToggleBtn.disabled = this.timePlanActive;
        habitToggleBtn.onclick = () => {
            if (this.timePlanActive) return;
            const data = this.baseRepo().data;
            if (!data) return;
            data.habitsCollapsed = !this.habitsCollapsed;
            void (async () => {
                await this.save();
                await this.onOpen();
            })();
        };

        // 图例（日历顶部：显示配置按钮；时间计划模式下支持选中分类）
        const legendContainer = toolbar.createDiv({ cls: 'legend-container' });
        renderPlanCategoryLegend(
            this.app,
            legendContainer,
            this.planCategoryData,
            () => {
                void this.onOpen();
            },
            this.timePlanActive ? this.timePlanSelectedCategoryId : undefined,
            this.timePlanActive
                ? (id) => {
                    // 时间计划模式下：点击图例选中/取消选中分类
                    this.timePlanSelectedCategoryId = this.timePlanSelectedCategoryId === id ? undefined : id;
                    void this.onOpen();
                }
                : undefined,
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

            // 复制本周习惯任务
            const copyWeekBtn = panel.createEl('button', {
                text: t('eventCopy.copyWeek'),
                cls: 'more-tools-item',
            });
            copyWeekBtn.onclick = () => {
                this.copyWeekHabitEvents();
            };

            // 粘贴一周事件
            const pasteWeekBtn = panel.createEl('button', {
                text: t('eventCopy.pasteWeek'),
                cls: 'more-tools-item',
            });
            pasteWeekBtn.onclick = () => {
                if (!this.clipboardWeekHabitEvents || this.clipboardWeekHabitEvents.length === 0) {
                    new Notice(t('eventCopy.emptyClipboard'));
                    return;
                }
                new PasteWeekHabitEventsModal(
                    this.app,
                    this.clipboardWeekHabitSource,
                    this.currentWeekKey,
                    () => {
                        void this.pasteWeekHabitEvents();
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

    /** 复制当前周的全部习惯任务到全周剪贴板（保留 day，粘贴时按原星期几还原） */
    private copyWeekHabitEvents() {
        // 仅复制习惯任务（来源任务已启用习惯时间点）
        const weekHabitEvents = this.events.filter(
            ev => ev.weekKey === this.currentWeekKey && this.getEventHabitTime(ev) !== null,
        );
        if (weekHabitEvents.length === 0) {
            new Notice(t('eventCopy.nothingHabitToCopy'));
            return;
        }
        // 暂存任务模板（去掉 id / weekKey，保留 day）
        this.clipboardWeekHabitEvents = weekHabitEvents.map(({ id, weekKey: _w, ...rest }) => rest);
        this.clipboardWeekHabitSource = this.currentWeekKey;
        new Notice(t('eventCopy.habitCopied', { count: weekHabitEvents.length }));
    }

    /** 将全周习惯任务剪贴板粘贴到当前周（按原星期几还原，保留源任务，可多次粘贴） */
    private async pasteWeekHabitEvents() {
        if (!this.clipboardWeekHabitEvents || this.clipboardWeekHabitEvents.length === 0) {
            new Notice(t('eventCopy.emptyClipboard'));
            return;
        }
        let added = 0;
        for (const tpl of this.clipboardWeekHabitEvents) {
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

/** 粘贴全周习惯任务弹窗：显示「来源周 → 复制到 → 当前周」，确认后生效 */
class PasteWeekHabitEventsModal extends Modal {
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

