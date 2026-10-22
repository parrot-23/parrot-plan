// list 渲染器：自定义列表卡片。
// 标题可编辑 + 列表，每行开头下拉选择「手写 / 任务时长」。
// - 手写：行内文本输入框，自由填写内容。
// - 任务时长：行内搜索已有任务，选中后末尾显示该任务的实际执行时长（xh）。
import type { CardRenderer, CardRenderContext } from '../../datatypes/renderer';
import type { TimelogRow, TimelogRowKind } from '../../datatypes/card';
import { executionDuration } from '../../datatypes/domain';
import { t } from '../../i18n';

/** 把分钟数格式化为小时（如 90 → 1.5h，60 → 1h） */
function formatHours(minutes: number): string {
    const hours = minutes / 60;
    const text = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
    return `${text}h`;
}

/** 计算某任务的实际执行总时长（分钟）：累加该任务所有执行记录的时长（含跨天） */
function taskDurationMinutes(taskId: string, ctx: CardRenderContext): number {
    let total = 0;
    for (const ex of ctx.provider.getExecutions()) {
        if (ex.inboxId !== taskId) continue;
        total += executionDuration(ex);
    }
    return total;
}

export const listCardRenderer: CardRenderer = {
    render(container, instance, template, ctx) {
        const body = container.createDiv({ cls: 'wb-card-body' });
        const rows = instance.timelogRows ?? (instance.timelogRows = []);

        const list = body.createDiv({ cls: 'wb-timelog-list' });

        const persist = () => {
            void ctx.save().then(() => ctx.refresh());
        };

        const renderRow = (row: TimelogRow) => {
            const rowEl = list.createDiv({ cls: 'wb-timelog-row' });

            // 行首下拉：手写 / 任务时长
            const kindSelect = rowEl.createEl('select', { cls: 'wb-timelog-kind' });
            kindSelect.createEl('option', { text: t('workbench.timelogManual'), value: 'manual' });
            kindSelect.createEl('option', { text: t('workbench.timelogTask'), value: 'task' });
            kindSelect.value = row.kind;
            kindSelect.onchange = () => {
                row.kind = kindSelect.value as TimelogRowKind;
                if (row.kind === 'manual') row.taskId = undefined;
                else row.text = undefined;
                persist();
            };

            const contentEl = rowEl.createDiv({ cls: 'wb-timelog-content' });

            if (row.kind === 'manual') {
                const input = contentEl.createEl('input', {
                    cls: 'wb-timelog-input',
                    attr: { type: 'text', placeholder: t('workbench.timelogManualPlaceholder') },
                });
                input.value = row.text ?? '';
                input.onchange = () => {
                    row.text = input.value;
                    persist();
                };
            } else {
                const searchWrap = contentEl.createDiv({ cls: 'wb-timelog-search' });
                const searchInput = searchWrap.createEl('input', {
                    cls: 'wb-timelog-input',
                    attr: { type: 'text', placeholder: t('workbench.timelogTaskPlaceholder') },
                });

                const selected = row.taskId
                    ? ctx.provider.getTasks().find((task) => task.id === row.taskId)
                    : undefined;
                if (selected) searchInput.value = selected.title;

                const durationEl = rowEl.createDiv({ cls: 'wb-timelog-duration' });
                if (selected) {
                    durationEl.setText(formatHours(taskDurationMinutes(selected.id, ctx)));
                }

                const resultList = searchWrap.createDiv({ cls: 'wb-timelog-results is-hidden' });

                const showResults = () => {
                    const keyword = searchInput.value.trim().toLowerCase();
                    resultList.empty();
                    const tasks = ctx.provider.getTasks().filter((task) => !task.removed);
                    const matched = keyword
                        ? tasks.filter((task) => task.title.toLowerCase().includes(keyword))
                        : tasks;
                    if (matched.length === 0) {
                        resultList.createDiv({ cls: 'wb-timelog-result-empty', text: t('workbench.timelogNoTask') });
                    } else {
                        for (const task of matched.slice(0, 20)) {
                            const item = resultList.createDiv({ cls: 'wb-timelog-result-item', text: task.title });
                            item.onmousedown = (e) => {
                                e.preventDefault();
                                row.taskId = task.id;
                                persist();
                            };
                        }
                    }
                    resultList.removeClass('is-hidden');
                };

                searchInput.onfocus = showResults;
                searchInput.oninput = showResults;
                searchInput.onblur = () => {
                    window.setTimeout(() => {
                        resultList.addClass('is-hidden');
                    }, 150);
                };
            }

            const delBtn = rowEl.createEl('button', { cls: 'wb-timelog-delete', text: '×' });
            delBtn.onclick = () => {
                const idx = rows.findIndex((r) => r.id === row.id);
                if (idx >= 0) rows.splice(idx, 1);
                persist();
            };
        };

        for (const row of rows) {
            renderRow(row);
        }

        const addBtn = body.createEl('button', {
            cls: 'wb-card-action wb-timelog-add',
            text: t('workbench.timelogAddRow'),
        });
        addBtn.onclick = () => {
            rows.push({ id: crypto.randomUUID(), kind: 'manual' });
            persist();
        };
    },
};
