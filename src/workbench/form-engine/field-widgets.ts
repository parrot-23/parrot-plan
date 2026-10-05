// 字段输入控件：根据字段类型渲染对应的输入元素，并读写值。
import type { FieldSchema, FormValues } from './types';

/**
 * 为单个字段创建输入控件，挂到指定容器。
 * 返回一个读写器：getValue 读取当前值，setValue 设置值。
 */
export function createFieldWidget(
    container: HTMLElement,
    field: FieldSchema,
    initialValue: unknown,
): { getValue: () => unknown; setValue: (v: unknown) => void } {
    const row = container.createDiv({ cls: 'wb-field' });
    row.createDiv({ cls: 'wb-field-label', text: field.label });

    const value = initialValue ?? field.default ?? '';

    switch (field.type) {
        case 'textarea': {
            const el = row.createEl('textarea', { cls: 'wb-field-input' });
            el.value = String(value ?? '');
            if (field.placeholder) el.placeholder = field.placeholder;
            return {
                getValue: () => el.value,
                setValue: (v) => { el.value = String(v ?? ''); },
            };
        }
        case 'select': {
            const el = row.createEl('select', { cls: 'wb-field-input' });
            for (const opt of field.options ?? []) {
                el.createEl('option', { text: opt, value: opt });
            }
            el.value = String(value ?? '');
            return {
                getValue: () => el.value,
                setValue: (v) => { el.value = String(v ?? ''); },
            };
        }
        case 'number': {
            const el = row.createEl('input', { cls: 'wb-field-input', type: 'number' });
            el.value = String(value ?? '');
            if (field.placeholder) el.placeholder = field.placeholder;
            return {
                getValue: () => (el.value === '' ? undefined : Number(el.value)),
                setValue: (v) => { el.value = String(v ?? ''); },
            };
        }
        case 'date': {
            const el = row.createEl('input', { cls: 'wb-field-input', type: 'date' });
            el.value = String(value ?? '');
            return {
                getValue: () => el.value,
                setValue: (v) => { el.value = String(v ?? ''); },
            };
        }
        case 'checkbox': {
            const el = row.createEl('input', { cls: 'wb-field-checkbox', type: 'checkbox' });
            el.checked = Boolean(value);
            return {
                getValue: () => el.checked,
                setValue: (v) => { el.checked = Boolean(v); },
            };
        }
        case 'text':
        default: {
            const el = row.createEl('input', { cls: 'wb-field-input', type: 'text' });
            el.value = String(value ?? '');
            if (field.placeholder) el.placeholder = field.placeholder;
            return {
                getValue: () => el.value,
                setValue: (v) => { el.value = String(v ?? ''); },
            };
        }
    }
}

/** 校验表单值，返回缺失的必填字段 key 列表 */
export function validateValues(fields: FieldSchema[], values: FormValues): string[] {
    const missing: string[] = [];
    for (const f of fields) {
        if (!f.required) continue;
        const v = values[f.key];
        if (v === undefined || v === null || v === '') {
            missing.push(f.key);
        }
    }
    return missing;
}
