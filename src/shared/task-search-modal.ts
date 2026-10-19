// 公共组件：任务搜索弹窗。输入关键词实时过滤候选任务并选择，供各视图「关联任务」等场景复用。
import { App, Modal } from 'obsidian';

/** 候选项：任务 id + 显示名称 */
export interface TaskSearchOption {
    id: string;
    title: string;
}

/** 弹窗文案（由调用方注入，便于复用与国际化） */
export interface TaskSearchModalTexts {
    /** 弹窗标题 */
    title: string;
    /** 搜索框占位文字 */
    placeholder: string;
    /** 无匹配结果时的提示文字 */
    empty: string;
}

/**
 * 任务搜索弹窗：顶部为搜索框，下方为候选任务列表。
 * 输入关键词即时过滤（不区分大小写），点击条目即选中并回调。
 */
export class TaskSearchModal extends Modal {
    constructor(
        app: App,
        private options: TaskSearchOption[],
        private texts: TaskSearchModalTexts,
        private onSelect: (id: string) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('task-search-modal');
        contentEl.createEl('h3', { text: this.texts.title });

        const input = contentEl.createEl('input', {
            type: 'text',
            cls: 'task-search-modal-input',
            attr: { placeholder: this.texts.placeholder },
        });

        const list = contentEl.createDiv({ cls: 'task-search-modal-list' });

        const renderList = (keyword: string): void => {
            list.empty();
            const kw = keyword.trim().toLowerCase();
            const matched = this.options.filter(o => !kw || o.title.toLowerCase().includes(kw));
            if (matched.length === 0) {
                list.createDiv({ cls: 'task-search-modal-empty', text: this.texts.empty });
                return;
            }
            for (const opt of matched) {
                const row = list.createDiv({ cls: 'task-search-modal-item', text: opt.title });
                row.onclick = () => {
                    this.onSelect(opt.id);
                    this.close();
                };
            }
        };

        input.oninput = () => renderList(input.value);
        renderList('');
        input.focus();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
