import { requestUrl } from 'obsidian';
import { log } from './logger';

/**
 * 账号模块：封装登录相关的服务器请求与账号数据结构。
 * 服务器基于腾讯云开发（CloudBase）。
 */

/** 接口基础地址（如需切换环境，只改这里） */
export const CLOUD_BASE_URL = 'https://cloud1-d1g6azon61dd44c4e-1500284813.ap-shanghai.app.tcloudbase.com';

/** 接口基础地址 */
function baseUrl(): string {
    return CLOUD_BASE_URL;
}

/** 账号信息（随主数据一起持久化） */
export interface AccountData {
    /** 登录令牌 */
    token?: string;
    /** 用户 ID（登录成功后由服务器返回） */
    userId?: string;
    /** 令牌过期时间（毫秒时间戳） */
    expireTime?: number;
}

/** create 接口返回 */
interface CreateLoginTokenResponse {
    success?: boolean;
    token?: string;
    expireTime?: number;
}

/** check 接口返回 */
interface CheckLoginTokenResponse {
    success?: boolean;
    /** 登录状态：pending（待扫码）/ confirmed（已确认登录） */
    status?: string;
    /** 登录成功后的用户 ID */
    userId?: string;
    [key: string]: unknown;
}

/** 创建登录令牌：返回 token 与过期时间 */
export async function createLoginToken(): Promise<{ token: string; expireTime?: number }> {
    const url = `${baseUrl()}/login/create`;
    const body = { type: 'createLoginToken' };
    log('请求 createLoginToken', { url, body });
    const res = await requestUrl({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        throw: false,
    });
    log('createLoginToken 响应', {
        status: res.status,
        text: res.text,
        json: res.json as unknown,
    });
    const data = res.json as CreateLoginTokenResponse;
    if (!data || !data.token) {
        throw new Error('createLoginToken: 服务器未返回 token');
    }
    return { token: data.token, expireTime: data.expireTime };
}

/** 检查登录令牌：返回是否已登录及用户 ID */
export async function checkLoginToken(token: string): Promise<{ loggedIn: boolean; userId?: string }> {
    const url = `${baseUrl()}/login/check`;
    const body = { type: 'checkLoginToken', token };
    const res = await requestUrl({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        throw: false,
    });
    log('checkLoginToken 响应', {
        status: res.status,
        text: res.text,
        json: res.json as unknown,
    });
    const data = res.json as CheckLoginTokenResponse;
    if (!data) return { loggedIn: false };
    // 登录成功：status 为 confirmed，且返回了 userId
    const loggedIn = data.status === 'confirmed' && !!data.userId;
    return { loggedIn, userId: data.userId };
}
