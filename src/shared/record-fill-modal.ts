// 记录卡片填写表单弹窗：任务完成且带记录卡片时弹出，按字段类型渲染输入控件。
// 提交返回字段值映射（供调用方写入 DB），取消/跳过返回 null。
import { App, Modal, Setting } from 'obsidian';

import type { OkrRecordCard, OkrRecordField } from '../datatypes/domain';
import { t } from '../i18n';

type FieldValue = string | number | boolean;

export class RecordFillModal extends Modal {
    private taskTitle: string;
    private fields: OkrRecordField[];
    private widgets: Record<string, { getValue: () => FieldValue }> = {};
    private resolve!: (values: Record<string, FieldValue> | null) => void;
    private settled = false;

    constructor(app: App, card: OkrRecordCard, taskTitle: string) {
        super(app);
        this.taskTitle = taskTitle;
        // 仅渲染已命名的字段（忽略默认生成的空占位字段）
        this.fields = card.fields.filter((f) => f.name && f.name.trim().length > 0);
    }

    /** 在 open() 之前调用：返回一个在用户提交/跳过时 resolve 的 Promise */
    waitForResult(): Promise<Record<string, FieldValue> | null> {
        return new Promise((res) => {
            this.resolve = res;
        });
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: t('okr.recordFormTitle', { name: this.taskTitle }) });

        for (const field of this.fields) {
            this.renderField(contentEl, field);
        }

        new Setting(contentEl)
            .addButton((b) =>
                b.setButtonText(t('okr.recordFormSubmit')).setCta().onClick(() => this.confirm()),
            )
            .addButton((b) =>
                b.setButtonText(t('okr.recordFormSkip')).onClick(() => this.skip()),
            );
    }

    onClose(): void {
        if (!this.settled) {
            this.settled = true;
            this.resolve(null);
        }
    }

    /** 按字段类型渲染输入控件并登记读取器 */
    private renderField(container: HTMLElement, field: OkrRecordField): void {
        const setting = new Setting(container).setName(field.name || t('okr.recordFieldNamePlaceholder'));
        switch (field.type) {
            case 'number':
                setting.addText((tx) => {
                    tx.inputEl.type = 'number';
                    this.widgets[field.id] = { getValue: () => (tx.inputEl.value === '' ? 0 : Number(tx.inputEl.value)) };
                });
                break;
            case 'date':
                setting.addText((tx) => {
                    tx.inputEl.type = 'date';
                    this.widgets[field.id] = { getValue: () => tx.inputEl.value };
                });
                break;
            case 'duration':
                setting.addText((tx) => {
                    tx.inputEl.type = 'number';
                    this.widgets[field.id] = { getValue: () => (tx.inputEl.value === '' ? 0 : Number(tx.inputEl.value)) };
                });
                break;
            case 'boolean':
                setting.addToggle((tg) => {
                    this.widgets[field.id] = { getValue: () => tg.getValue() };
                });
                break;
            case 'select':
            case 'text':
            default:
                setting.addText((tx) => {
                    this.widgets[field.id] = { getValue: () => tx.inputEl.value };
                });
                break;
        }
    }

    /** 收集字段值并提交 */
    private confirm(): void {
        const values: Record<string, FieldValue> = {};
        for (const field of this.fields) {
            const widget = this.widgets[field.id];
            const raw = widget ? widget.getValue() : '';
            if (field.type === 'boolean') values[field.id] = Boolean(raw);
            else if (field.type === 'number' || field.type === 'duration') values[field.id] = Number(raw);
            else values[field.id] = String(raw ?? '');
        }
        this.settled = true;
        this.resolve(values);
        this.close();
    }

    /** 跳过本次填写，不生成记录 */
    private skip(): void {
        this.settled = true;
        this.resolve(null);
        this.close();
    }
}