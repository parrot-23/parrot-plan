// periodic 模式渲染器：用户按周期反复填写。
import type { CardRenderer, CardRenderContext } from './card-types';
import type { CardTemplate } from '../form-engine/types';
import type { CardInstance } from '../data/card-data';
import { makePeriodKey } from '../data/card-data';
import { renderForm, renderFormReadonly } from '../form-engine/form-renderer';

export const periodicCardRenderer: CardRenderer = {
    render(container, instance, template, ctx) {
        const period = template.period ?? 'day';
        const periodKey = makePeriodKey(period);
        const records = instance.records ?? [];
        const current = records.find((r) => r.periodKey === periodKey);

        // 标题
        container.createDiv({ cls: 'wb-card-title', text: instance.title ?? template.name });

        if (current) {
            // 已填写：只读展示 + 可重新填写
            const body = container.createDiv({ cls: 'wb-card-body' });
            renderFormReadonly(body, template, current.values);
            const editBtn = container.createEl('button', {
                cls: 'wb-card-action',
                text: '重新填写',
            });
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
    },
};

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
