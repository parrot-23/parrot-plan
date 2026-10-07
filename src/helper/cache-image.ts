import { requestUrl, type App } from 'obsidian';

import { log } from '../shared/logger';

/** 说明图片的下载地址 */
const IMAGE_URL = 'https://636c-cloud1-d1g6azon61dd44c4e-1500284813.tcb.qcloud.la/%E8%AF%B4%E6%98%8E.png?sign=99a6d42d1f1e162aa9c8d49137459055&t=1791376719';

/** 缓存目录中保存的文件名 */
const IMAGE_FILE_NAME = '说明.png';

/**
 * 把说明图片下载到缓存目录。
 * 仅在缓存启用时执行下载；缓存关闭时直接跳过。
 *
 * @param app Obsidian App 实例
 * @param cacheDirName 缓存目录名称（相对 vault 根目录）
 * @param enabled 是否启用缓存
 * @returns 下载成功返回文件路径，跳过或失败返回 null
 */
export async function downloadImageToCache(
    app: App,
    cacheDirName: string,
    enabled: boolean,
): Promise<string | null> {
    // 缓存未启用：不下载
    if (!enabled) {
        log('缓存未启用，跳过图片下载');
        return null;
    }

    const dir = cacheDirName;
    const filePath = `${dir}/${IMAGE_FILE_NAME}`;

    try {
        // 确保缓存目录存在
        const adapter = app.vault.adapter;
        if (!(await adapter.exists(dir))) {
            await adapter.mkdir(dir);
        }

        // 下载图片（用 requestUrl 规避 CORS 限制）
        const res = await requestUrl({ url: IMAGE_URL, throw: false });
        if (res.status !== 200) {
            log('下载说明图片失败：状态码', res.status);
            return null;
        }

        // 写入缓存目录
        await adapter.writeBinary(filePath, res.arrayBuffer);
        log('说明图片已缓存到', filePath);
        return filePath;
    } catch (err) {
        log('下载说明图片异常', err);
        return null;
    }
}
