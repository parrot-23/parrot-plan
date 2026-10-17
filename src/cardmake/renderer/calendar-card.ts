// calendar 模式渲染器：展示一个可翻月的日历，并标记有执行记录的日期。
// 既不属于图表（stats），也不属于表单（periodic / fixed），是独立的展示型卡片。
import type { CardRenderer } from '../../datatypes/renderer';
import { makeDayKeyFromWeek } from '../../shared/plan-data';

/** 星期表头（周一为起始） */
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

export const calendarCardRenderer: CardRenderer = {
    render(container, instance, template, ctx) {
        const body = container.createDiv({ cls: 'wb-card-body' });

        // 当前展示的月份（默认本月）
        const now = new Date();
        let year = now.getFullYear();
        let month = now.getMonth();

        // 有执行记录的日期集合（用于标记）
        const activeDays = new Set<string>();
        for (const ex of ctx.provider.getExecutions()) {
            if (ex.weekKey && ex.day) {
                activeDays.add(makeDayKeyFromWeek(ex.weekKey, ex.day));
            }
        }

        const render = () => {
            body.empty();

            // 顶部：上月 / 年月 / 下月
            const header = body.createDiv({ cls: 'wb-cal-header' });
            const prevBtn = header.createEl('button', { cls: 'wb-cal-nav', text: '‹' });
            header.createDiv({ cls: 'wb-cal-title', text: `${year}年${month + 1}月` });
            const nextBtn = header.createEl('button', { cls: 'wb-cal-nav', text: '›' });

            prevBtn.onclick = () => {
                month -= 1;
                if (month < 0) {
                    month = 11;
                    year -= 1;
                }
                render();
            };
            nextBtn.onclick = () => {
                month += 1;
                if (month > 11) {
                    month = 0;
                    year += 1;
                }
                render();
            };

            // 星期表头
            const grid = body.createDiv({ cls: 'wb-cal-grid' });
            for (const label of WEEKDAY_LABELS) {
                grid.createDiv({ cls: 'wb-cal-weekday', text: label });
            }

            // 计算当月第一天是周几（周一为 0）与当月天数
            const firstDay = new Date(year, month, 1);
            const startOffset = (firstDay.getDay() + 6) % 7;
            const daysInMonth = new Date(year, month + 1, 0).getDate();

            // 前置空白格
            for (let i = 0; i < startOffset; i++) {
                grid.createDiv({ cls: 'wb-cal-cell is-empty' });
            }

            // 日期格
            const todayKey = makeDayKeyLocal(now);
            for (let d = 1; d <= daysInMonth; d++) {
                const dateKey = makeDayKeyLocal(new Date(year, month, d));
                const cell = grid.createDiv({ cls: 'wb-cal-cell', text: String(d) });
                if (dateKey === todayKey) cell.addClass('is-today');
                if (activeDays.has(dateKey)) cell.addClass('is-active');
            }
        };

        render();
    },
};

/** 生成本地日期键（YYYY-MM-DD） */
function makeDayKeyLocal(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
