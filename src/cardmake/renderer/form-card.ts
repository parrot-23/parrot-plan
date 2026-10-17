// form 渲染器：根据模板的 formType 渲染表单。
// - formType = 'periodic'：按周期反复填写，可翻历史记录。
// - formType = 'fixed'：填写一次后锁定，只读展示。
import type { CardRenderer, CardRenderContext } from '../../datatypes/renderer';
import type { CardTemplate } from '../../datatypes/form';
import type { CardInstance } from '../../datatypes/card';
import { makePeriodKey } from '../../datatypes/card';
import { renderForm, renderFormReadonly } from '../drawer/form-render-draw';

export const formCardRenderer: CardRenderer = {
    render(container, instance, template, ctx) {
        const formType = template.formType ?? 'fixed';
        if (formType === 'periodic') {
            renderPeriodic(container, instance, template, ctx);
        } else {
            renderFixed(container, instance, template, ctx);
        }
    },
};

/** 周期填写：按周期键存多条记录，可翻历史 */
function renderPeriodic(
    container: HTMLElement,
    instance: CardInstance,
    template: CardTemplate,
    ctx: CardRenderContext,
) {
    const period = template.period ?? 'day';
    const periodKey = makePeriodKey(period);
    const records = instance.records ?? [];
    const current = records.find((r) => r.periodKey === periodKey);

    if (current) {
        const body = container.createDiv({ cls: 'wb-card-body' });
        renderFormReadonly(body, template, current.values);
        const editBtn = container.createEl('button', { cls: 'wb-card-action', text: '重新填写' });
        editBtn.onclick = () => {
            renderFormArea(container, instance, template, ctx, current.values);
        };
    } else {
        renderFormArea(container, instance, template, ctx, {});
    }

    // 历史记录折叠展示
    const history = records.filter((r) => r.periodKey !== periodKey);
    if (history.length > 0) {
        const histWrap = container.createDiv({ cls: 'wb-card-history' });
        histWrap.createDiv({ cls: 'wb-card-history-title', text: '历史记录' });
        for (const r of history.slice(-5).reverse()) {
            const row = histWrap.createDiv({ cls: 'wb-card-history-item' });
            row.createSpan({ cls: 'wb-card-history-key', text: r.periodKey });
            const summary = (template.fields ?? [])
                .map((f) => `${f.label}: ${r.values[f.key] ?? '—'}`)
                .join('  ');
            row.createSpan({ cls: 'wb-card-history-val', text: summary });
        }
    }
}

/** 填写后固定：填一次锁定，之后只读 */
function renderFixed(
    container: HTMLElement,
    instance: CardInstance,
    template: CardTemplate,
    ctx: CardRenderContext,
) {
    if (instance.locked && instance.value) {
        const body = container.createDiv({ cls: 'wb-card-body' });
        renderFormReadonly(body, template, instance.value);
        return;
    }

    const body = container.createDiv({ cls: 'wb-card-body' });
    renderForm(body, template, instance.value ?? {}, (values) => {
        instance.value = values;
        instance.locked = true;
        void ctx.save().then(() => ctx.refresh());
    });
}

/** 渲染填写表单区域（新建或重新填写） */
function renderFormArea(
    container: HTMLElement,
    instance: CardInstance,
    template: CardTemplate,
    ctx: CardRenderContext,
    initial: Record<string, unknown>,
) {
    const body = container.createDiv({ cls: 'wb-card-body' });
    renderForm(body, template, initial, (values) => {
        const periodKey = makePeriodKey(template.period ?? 'day');
        const records = instance.records ?? (instance.records = []);
        const idx = records.findIndex((r) => r.periodKey === periodKey);
        if (idx >= 0) {
            records[idx].values = values;
            records[idx].createdAt = Date.now();
        } else {
            records.push({
                id: crypto.randomUUID(),
                periodKey,
                values,
                createdAt: Date.now(),
            });
        }
        void ctx.save().then(() => ctx.refresh());
    });
}
