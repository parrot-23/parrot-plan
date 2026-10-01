// i18n 入口：语言检测 + t() 函数
import { zh, type I18nMessages } from './zh';
import { en } from './en';

type Lang = 'zh' | 'en';

let currentLang: Lang = 'en';

/** 检测 Obsidian 界面语言 */
function detectLang(): Lang {
    try {
        const lang = localStorage.getItem('language');
        if (lang === 'zh' || lang === 'zh-cn' || lang === 'zh-CN') return 'zh';
        if (lang === 'en' || lang === 'en-US' || lang === 'en-us') return 'en';
    } catch (e) {
        // 忽略，使用默认英文
    }
    return 'en';
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
