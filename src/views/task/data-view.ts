// 数据视图：左侧任务面板（与 OKR 视图一致）+ 右侧记录方框（与 OKR 视图一致）。
import type { App } from 'obsidian';
import { setIcon } from 'obsidian';

import type { PlanCategoryData } from '../../shared/plan-category-manager';
import type { InboxData, InboxItem, OkrRecordCard, OkrRecordFieldType } from '../../datatypes/domain';
import { OKR_RECORD_FIELD_META } from '../../datatypes/domain';
import type { InboxRepo } from '../../repos/inbox-repo';
import { renderTaskPanel } from '../../shared/task-panel';
import { getRecordStore } from '../../db/record-store';
import { t } from '../../i18n';

/** 生成条目 id */
function makeItemId(): string {
    return `okr_item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 生成记录卡片（自定义表单设计，默认带一行字段） */
function makeRecordCard(): OkrRecordCard {
    return {
        id: `okr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        fields: [{ id: makeItemId(), type: 'text', name: '' }],
    };
}

/**
 * 数据视图：与 OKR 视图一致，通过 renderInto 渲染到指定容器。
 * 左侧复用任务面板，右侧为当前选中任务的记录方框。
 */
export class DataView {
    private app: App;
    private inboxData: InboxData;
    private categoryData: PlanCategoryData;
    private save: () => Promise<void>;
    private inboxRepo?: InboxRepo;
    /** 当前渲染容器（用于自刷新） */
    private container?: HTMLElement;
    /** 处于编辑模式的记录卡片对应的条目 id（本次会话内保留，可来回切换） */
    private recordEditIds = new Set<string>();
    /** 右侧垂直选项卡：执行记录 / 记录卡（默认记录卡） */
    private rightTab: 'executionRecords' | 'recordCard' = 'recordCard';

    constructor(
        app: App,
        inboxData: InboxData,
        categoryData: PlanCategoryData,
        save: () => Promise<void>,
        inboxRepo?: InboxRepo,
    ) {
        this.app = app;
        this.inboxData = inboxData;
        this.categoryData = categoryData;
        this.save = save;
        this.inboxRepo = inboxRepo;
    }

    async renderInto(container: HTMLElement): Promise<void> {
        this.container = container;
        // 刷新前记录任务面板列表的滚动位置，渲染后恢复，避免选中任务时滚动条跳回顶部
        const prevListScrollTop = container
            .querySelector<HTMLElement>('.task-plan-task-panel .inbox-list')?.scrollTop ?? 0;
        container.empty();
        container.addClass('task-plan-view');

        // 左侧：任务面板（与 OKR 视图一致）
        const taskPanel = container.createDiv({ cls: 'task-plan-task-panel' });
        renderTaskPanel(
            this.app,
            taskPanel,
            this.inboxData,
            this.categoryData,
            async () => {
                await this.save();
            },
            () => {
                // 任务面板选中变化：只重绘右侧记录方框，避免重建左侧面板
                void this.refresh();
            },
            undefined,
            async () => {
                await this.save();
            },
            { enableProjectFocus: true, inboxRepo: this.inboxRepo },
        );

        // 中间：垂直选项卡（切换右侧内容区）
        const tabStrip = container.createDiv({ cls: 'task-plan-right-tabs' });
        const tabs: { id: 'executionRecords' | 'recordCard'; labelKey: 'data.tabExecutionRecords' | 'data.tabRecordCard' }[] = [
            { id: 'executionRecords', labelKey: 'data.tabExecutionRecords' },
            { id: 'recordCard', labelKey: 'data.tabRecordCard' },
        ];
        for (const tab of tabs) {
            const tabEl = tabStrip.createDiv({ cls: 'task-plan-right-tab', text: t(tab.labelKey) });
            tabEl.toggleClass('is-active', this.rightTab === tab.id);
            tabEl.onclick = () => {
                if (this.rightTab === tab.id) return;
                this.rightTab = tab.id;
                void this.refreshRight();
            };
        }

        // 右侧：内容区（随选项卡切换）
        const contentPanel = container.createDiv({ cls: 'task-plan-content-panel' });
        await this.renderRightContent(contentPanel);

        // 恢复任务面板列表的滚动位置，实现无感刷新
        if (prevListScrollTop > 0) {
            const listEl = taskPanel.querySelector<HTMLElement>('.inbox-list');
            if (listEl) listEl.scrollTop = prevListScrollTop;
        }
    }

    /** 当前选中任务（未选中或已移除时返回 undefined） */
    private getSelectedItem(): InboxItem | undefined {
        const selectedId = this.inboxData.selectedId;
        return selectedId
            ? this.inboxData.items.find(i => i.id === selectedId && !i.removed)
            : undefined;
    }

    /** 只重绘右侧内容区，避免重建左侧任务面板导致点击事件丢失 */
    private async refresh(): Promise<void> {
        const panel = this.container?.querySelector<HTMLElement>('.task-plan-content-panel');
        if (!panel) return;
        await this.renderRightContent(panel);
    }

    /** 切换右侧选项卡后重绘内容区，并刷新选项卡高亮 */
    private async refreshRight(): Promise<void> {
        this.container?.querySelectorAll('.task-plan-right-tab').forEach((el, i) => {
            const ids: ('executionRecords' | 'recordCard')[] = ['executionRecords', 'recordCard'];
            el.toggleClass('is-active', ids[i] === this.rightTab);
        });
        const panel = this.container?.querySelector<HTMLElement>('.task-plan-content-panel');
        if (!panel) return;
        await this.renderRightContent(panel);
    }

    /** 按当前选项卡渲染右侧内容区 */
    private async renderRightContent(panel: HTMLElement): Promise<void> {
        panel.empty();
        // 「执行记录」选项卡：暂无内容
        if (this.rightTab === 'executionRecords') return;

        // 「记录卡」选项卡：记录方框
        await this.renderRecordBox(panel);
    }

    /** 记录卡片：独立方框，标题「记录」+ 右上角编辑按钮（切换字段编辑） */
    private async renderRecordBox(panel: HTMLElement): Promise<void> {
        const area = panel.createDiv({ cls: 'swimlane-section-area okr-record-area' });
        const header = area.createDiv({ cls: 'swimlane-section-area-header' });
        header.createDiv({ cls: 'swimlane-section-area-title', text: t('okr.typeRecord') });

        const editBtn = header.createEl('button', {
            cls: 'okr-record-edit-btn',
            attr: { title: t('okr.toggleRecordEdit') },
        });
        setIcon(editBtn, 'pencil');

        const body = area.createDiv({ cls: 'okr-entry-list' });
        const item = this.getSelectedItem();
        if (!item) {
            editBtn.disabled = true;
            body.createDiv({ cls: 'swimlane-sections-empty', text: t('okr.noSelection') });
            return;
        }

        // 记录方框即一张记录卡：无则自动初始化一张默认空卡片
        if (!item.records || item.records.length === 0) {
            item.records = [makeRecordCard()];
        }
        const recordCard = item.records[0];
        const editing = this.recordEditIds.has(recordCard.id);

        editBtn.toggleClass('is-active', editing);
        editBtn.onclick = (e) => {
            e.stopPropagation();
            if (editing) this.recordEditIds.delete(recordCard.id);
            else this.recordEditIds.add(recordCard.id);
            void this.refresh();
        };

        await this.renderRecordCard(body, recordCard, item);
    }

    /**
     * 记录卡片内容：正常模式以表格展示当前任务的填写记录（日期 + 各字段值）；
     * 编辑模式显示表单（字段类型 + 名称 + 删除）。
     * 右上角编辑图标改由记录方框标题栏统一承载，此方法只渲染卡片主体，不再包裹卡片外框。
     */
    private async renderRecordCard(container: HTMLElement, recordCard: OkrRecordCard, item: InboxItem): Promise<void> {
        const editing = this.recordEditIds.has(recordCard.id);

        if (!editing) {
            // 正常模式：表格展示填写记录（按 inbox_id 过滤，按日期倒序）
            const namedFields = recordCard.fields.filter(f => f.name && f.name.trim().length > 0);
            const entries = await getRecordStore(this.app).listEntriesByInbox(item.id);

            if (entries.length === 0) {
                container.createDiv({ cls: 'okr-record-empty', text: t('okr.recordNoData') });
                return;
            }

            const table = container.createEl('table', { cls: 'okr-record-table' });
            const headRow = table.createEl('thead').createEl('tr');
            headRow.createEl('th', { cls: 'okr-record-th-date', text: t('okr.recordDate') });
            for (const field of namedFields) {
                headRow.createEl('th', { text: field.name });
            }

            const tbody = table.createEl('tbody');
            for (const entry of entries) {
                const row = tbody.createEl('tr');
                row.createEl('td', { cls: 'okr-record-cell-date', text: entry.dayKey });
                for (const field of namedFields) {
                    row.createEl('td', { text: this.formatRecordValue(field.type, entry.values[field.id]) });
                }
            }
            return;
        }

        // 编辑模式：顶部「+」新增字段 + 表单设计，每行 = 字段类型 + 字段名称 + 删除
        const addBtn = container.createEl('button', { cls: 'okr-record-add-btn', text: '+' });
        addBtn.onclick = (e) => {
            e.stopPropagation();
            recordCard.fields.push({ id: makeItemId(), type: 'text', name: '' });
            void this.save().then(() => this.refresh());
        };

        const form = container.createDiv({ cls: 'okr-record-form' });
        for (const field of recordCard.fields) {
            const row = form.createDiv({ cls: 'okr-record-field-row' });

            const typeSelect = row.createEl('select', { cls: 'okr-record-field-type' });
            for (const fieldType of Object.keys(OKR_RECORD_FIELD_META) as OkrRecordFieldType[]) {
                const opt = typeSelect.createEl('option', {
                    text: t(OKR_RECORD_FIELD_META[fieldType].labelKey as Parameters<typeof t>[0]),
                    value: fieldType,
                });
                if (fieldType === field.type) opt.selected = true;
            }
            typeSelect.onchange = () => {
                field.type = typeSelect.value as OkrRecordFieldType;
                void this.save();
            };

            const nameInput = row.createEl('input', {
                type: 'text',
                cls: 'okr-record-field-name',
                attr: { placeholder: t('okr.recordFieldNamePlaceholder') },
            });
            nameInput.value = field.name;
            nameInput.onchange = () => {
                field.name = nameInput.value.trim();
                void this.save();
            };

            const delBtn = row.createEl('button', { cls: 'okr-entry-del', text: '✕' });
            delBtn.onclick = (e) => {
                e.stopPropagation();
                recordCard.fields = recordCard.fields.filter(f => f.id !== field.id);
                void this.save().then(() => this.refresh());
            };
        }
    }

    /** 把记录值格式化为表格单元格文本：空值显示占位符，布尔值显示打勾/叉 */
    private formatRecordValue(type: OkrRecordFieldType, value: string | number | boolean | undefined): string {
        if (value === undefined || value === null || value === '') return '-';
        if (type === 'boolean') return value ? '✓' : '✗';
        return String(value);
    }
}