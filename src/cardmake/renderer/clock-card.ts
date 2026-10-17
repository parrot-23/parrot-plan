// clock 模式渲染器：实时显示当前的时、分、秒。
// 既不属于图表（stats），也不属于表单（periodic / fixed），是独立的展示型卡片。
import type { CardRenderer } from '../../datatypes/renderer';

export const clockCardRenderer: CardRenderer = {
    render(container, instance, template) {
        const body = container.createDiv({ cls: 'wb-card-body' });
        const clock = body.createDiv({ cls: 'wb-clock' });
        const timeEl = clock.createDiv({ cls: 'wb-clock-time' });
        const dateEl = clock.createDiv({ cls: 'wb-clock-date' });

        const pad = (n: number) => String(n).padStart(2, '0');

        const tick = () => {
            const now = new Date();
            timeEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
            dateEl.textContent = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        };

        tick();
        // 每秒刷新；容器被移除时自动停止，避免泄漏
        const timer = window.setInterval(() => {
            if (!container.isConnected) {
                window.clearInterval(timer);
                return;
            }
            tick();
        }, 1000);
    },
};
