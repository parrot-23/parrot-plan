// 表单渲染器：根据模板的字段定义，渲染一个可填写的表单。
// 通用逻辑，与具体卡片模式无关。
import type { CardTemplate, FormValues } from './types';
import { createFieldWidget, validateValues } from './field-widgets';

/**
 * 渲染一个表单到容器，返回收集/校验的句柄。
 * @param container 挂载容器
 * @param template 表单模板
 * @param initialValues 初始值（编辑已有记录时传入）
 * @param onSubmit 提交回调（校验通过后触发）
 */
export function renderForm(
    container: HTMLElement,
    template: CardTemplate,
    initialValues: FormValues,
    onSubmit: (values: FormValues) => void,
): void {
    container.empty();
    const fields = template.fields ?? [];

    const widgets = new Map<string, { getValue: () => unknown }>();
    for (const field of fields) {
        const w = createFieldWidget(container, field, initialValues[field.key]);
        widgets.set(field.key, w);
    }

    const submitBtn = container.createEl('button', {
        cls: 'wb-form-submit',
        text: '保存',
    });
    submitBtn.onclick = () => {
        const values: FormValues = {};
        for (const field of fields) {
            values[field.key] = widgets.get(field.key)!.getValue();
        }
        const missing = validateValues(fields, values);
        if (missing.length > 0) {
            // 简单提示：高亮缺失字段（这里用 Notice 由调用方处理更合适，但保持引擎独立）
            container.querySelectorAll('.wb-field').forEach((el) => el.removeClass('is-error'));
            for (const key of missing) {
                const idx = fields.findIndex((f) => f.key === key);
                const row = container.querySelectorAll('.wb-field')[idx];
                row?.addClass('is-error');
            }
            return;
        }
        onSubmit(values);
    };
}

/** 只读展示表单值（fixed 模式锁定后 / periodic 历史记录展示） */
export function renderFormReadonly(
    container: HTMLElement,
    template: CardTemplate,
    values: FormValues,
): void {
    container.empty();
    for (const field of template.fields ?? []) {
        const row = container.createDiv({ cls: 'wb-field wb-field-readonly' });
        row.createDiv({ cls: 'wb-field-label', text: field.label });
        const v = values[field.key];
        row.createDiv({
            cls: 'wb-field-value',
            text: v === undefined || v === null || v === '' ? '—' : String(v),
        });
    }
}
