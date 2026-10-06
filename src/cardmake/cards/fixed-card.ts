// fixed 模式渲染器：用户填写一次后完全固定展示。
import type { CardRenderer } from '../../datatypes/renderer';
import { renderForm, renderFormReadonly } from '../engine/form-renderer';

export const fixedCardRenderer: CardRenderer = {
    render(container, instance, template, ctx) {
        container.createDiv({ cls: 'wb-card-title', text: instance.title ?? template.name });

        if (instance.locked && instance.value) {
            // 已锁定：只读展示
            const body = container.createDiv({ cls: 'wb-card-body' });
            renderFormReadonly(body, template, instance.value);
            return;
        }

        // 未填写：渲染表单
        const body = container.createDiv({ cls: 'wb-card-body' });
        renderForm(body, template, instance.value ?? {}, (values) => {
            instance.value = values;
            instance.locked = true;
            void ctx.save().then(() => ctx.refresh());
        });
    },
};
