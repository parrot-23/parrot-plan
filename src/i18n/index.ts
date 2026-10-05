// i18n 入口：语言检测 + t() 函数
import { moment } from 'obsidian';
import { zh, type I18nMessages } from './zh';
import { en } from './en';

type Lang = 'zh' | 'en';

let currentLang: Lang = 'en';

/** 语言检测的原始信息（用于调试日志） */
export interface LangDebugInfo {
    momentLocale: string;
    localStorageLanguage: string | null;
    navigatorLanguage: string;
    detected: Lang;
}

let lastDebugInfo: LangDebugInfo = {
    momentLocale: '',
    localStorageLanguage: null,
    navigatorLanguage: '',
    detected: 'en',
};

/** 检测 Obsidian 界面语言 */
function detectLang(): Lang {
    let momentLocale = '';
    let localStorageLanguage: string | null = null;
    const navigatorLanguage = typeof navigator !== 'undefined' ? navigator.language : '';

    // 优先用 Obsidian 内置 moment 的 locale（跟随界面语言，最可靠）
    try {
        momentLocale = moment.locale();
    } catch {
        // 忽略
    }
    // 兜底：读取 localStorage 的 language 键
    try {
        localStorageLanguage = localStorage.getItem('language');
    } catch {
        // 忽略
    }

    let detected: Lang = 'en';
    const candidates = [momentLocale, localStorageLanguage ?? '', navigatorLanguage];
    for (const c of candidates) {
        const v = c.toLowerCase();
        if (v.startsWith('zh')) { detected = 'zh'; break; }
        if (v.startsWith('en')) { detected = 'en'; break; }
    }

    lastDebugInfo = { momentLocale, localStorageLanguage, navigatorLanguage, detected };
    return detected;
}

/** 获取最近一次语言检测的原始信息（用于调试） */
export function getLangDebugInfo(): LangDebugInfo {
    return lastDebugInfo;
}

/** 初始化语言（在插件 onload 时调用一次） */
export function initI18n(): void {
    currentLang = detectLang();
}

/** 获取当前语言 */
export function getLang(): Lang {
    return currentLang;
}

const messages: Record<Lang, I18nMessages> = { zh, en };

/**
 * 翻译函数，支持 {name} 占位符插值
 * 例：t('template.applyTo', { name: '深度工作' })
 */
export function t(key: keyof I18nMessages, params?: Record<string, string | number>): string {
    let text: string = messages[currentLang][key] ?? messages.en[key] ?? key;
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
    }
    return text;
}

/** 星期数组（按当前语言） */
export function getWeekDays(): string[] {
    return [
        t('week.monday'),
        t('week.tuesday'),
        t('week.wednesday'),
        t('week.thursday'),
        t('week.friday'),
        t('week.saturday'),
        t('week.sunday'),
    ];
}
