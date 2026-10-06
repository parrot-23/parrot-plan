// 模板加载器：从插件根目录 templates/ 目录读取模板 JSON。
import type { App } from 'obsidian';
import type { CardTemplate } from '../form-engine/types';

/** 模板目录（相对 vault 根，插件根目录下；配置目录由用户自定义，需用 configDir） */
function getTemplateDir(app: App): string {
    return `${app.vault.configDir}/plugins/parrot-plan/templates`;
}

/** 模板缓存：id → 模板 */
const cache = new Map<string, CardTemplate>();

/**
 * 加载全部模板。
 * 读取 templates/ 目录下所有 .json 文件并解析。
 */
export async function loadAllTemplates(app: App): Promise<CardTemplate[]> {
    const adapter = app.vault.adapter;
    let files: string[];
    try {
        files = await adapter.list(getTemplateDir(app)).then((r) => r.files);
    } catch {
        return [];
    }

    const templates: CardTemplate[] = [];
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
            const raw = await adapter.read(file);
            const tpl = JSON.parse(raw) as CardTemplate;
            if (tpl && tpl.id && tpl.mode) {
                cache.set(tpl.id, tpl);
                templates.push(tpl);
            }
        } catch {
            // 忽略解析失败的模板
        }
    }
    return templates;
}

/** 按 id 获取模板（优先缓存） */
export async function getTemplate(app: App, id: string): Promise<CardTemplate | undefined> {
    if (cache.has(id)) return cache.get(id);
    await loadAllTemplates(app);
    return cache.get(id);
}
