// collect 模式渲染器：顶部输入框记录信息，下方列出已收集的记录。
// 既不属于图表（stats），也不属于表单（periodic / fixed），是独立的收集型卡片。
import type { CardRenderer } from '../../datatypes/renderer';
import { t } from '../../i18n';

/** 时间戳格式化为 YYYY-MM-DD HH:MM */
function formatTime(ts: number): string {
    const d = new Date(ts);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${mo}-${da} ${h}:${mi}`;
}

export const collectCardRenderer: CardRenderer = {
    render(container, instance, template, ctx) {
        container.createDiv({ cls: 'wb-card-title', text: instance.title ?? template.name });

        const body = container.createDiv({ cls: 'wb-card-body' });

        // 顶部输入区：输入框 + 添加按钮
        const inputRow = body.createDiv({ cls: 'wb-collect-input-row' });
        const input = inputRow.createEl('input', {
            cls: 'wb-collect-input',
            attr: { type: 'text', placeholder: t('workbench.collectPlaceholder') },
        });
        const addBtn = inputRow.createEl('button', {
            cls: 'wb-collect-add-btn',
            text: t('common.add'),
        });

        const submit = () => {
            const content = input.value.trim();
            if (!content) return;
            const entries = instance.entries ?? (instance.entries = []);
            entries.push({
                id: crypto.randomUUID(),
                content,
                createdAt: Date.now(),
            });
            // 同步写入 GTD 收集箱，使其出现在 GTD「收集」视图，供后续梳理流程处理
            const gtdWrite = ctx.addGtdItem ? ctx.addGtdItem(content) : Promise.resolve();
            void gtdWrite.then(() => ctx.save()).then(() => ctx.refresh());
        };
        addBtn.onclick = submit;
        input.onkeydown = (e) => {
            if (e.key === 'Enter') submit();
        };

        // 已收集记录列表（最新的在最上面）
        const list = body.createDiv({ cls: 'wb-collect-list' });
        const entries = instance.entries ?? [];
        if (entries.length === 0) {
            list.createDiv({ cls: 'wb-collect-empty', text: t('workbench.collectEmpty') });
            return;
        }

        for (const entry of [...entries].reverse()) {
            const row = list.createDiv({ cls: 'wb-collect-item' });
            row.createDiv({ cls: 'wb-collect-item-time', text: formatTime(entry.createdAt) });
            row.createDiv({ cls: 'wb-collect-item-content', text: entry.content });

            const delBtn = row.createEl('button', {
                cls: 'wb-collect-item-delete',
                text: '×',
            });
            delBtn.onclick = () => {
                instance.entries = (instance.entries ?? []).filter((it) => it.id !== entry.id);
                void ctx.save().then(() => ctx.refresh());
            };
        }
    },
};
