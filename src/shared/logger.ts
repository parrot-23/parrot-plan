import type { App } from 'obsidian';

/**
 * 日志工具：把运行信息写入插件目录下的日志文件。
 * - 每次插件启动时调用 initLogger()，会清空上一次的日志内容。
 * - 之后调用 log() 追加写入。
 */

/** 日志文件相对 vault 根目录的路径 */
const LOG_FILE = '.obsidian/plugins/parrot-plan/parrot-plan.log';

let appRef: App | null = null;

/** 把任意值格式化为可读字符串 */
function formatArg(arg: unknown): string {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}

/**
 * 初始化日志：清空旧日志文件内容。
 * 应在插件 onload 时调用一次。
 */
export async function initLogger(app: App): Promise<void> {
    appRef = app;
    try {
        await app.vault.adapter.write(LOG_FILE, '');
    } catch {
        // 写入失败时静默降级，不影响插件运行
        appRef = null;
    }
}

/**
 * 写入一条日志（追加到日志文件末尾）。
 * 自动附加时间戳。
 */
export function log(...args: unknown[]): void {
    if (!appRef) return;
    const time = new Date().toISOString();
    const line = `[${time}] ${args.map(formatArg).join(' ')}\n`;
    // 异步追加，不阻塞调用方
    void (async () => {
        try {
            await appRef!.vault.adapter.append(LOG_FILE, line);
        } catch {
            // 忽略写入错误
        }
    })();
}
