import { requestUrl, type App } from 'obsidian';

/**
 * 账号模块：封装登录相关的服务器请求与账号数据结构。
 * 服务器基于腾讯云开发（CloudBase），接口地址由 envId 决定。
 */

/** 云开发环境 ID（如需切换环境，只改这里） */
export const CLOUD_ENV_ID = 'cloud1-d1g6azon61dd44c4e';

/** 账号数据文件（相对 vault 根目录），与主数据隔离，避免被主数据保存覆盖 */
const ACCOUNT_FILE = '.obsidian/plugins/parrot-plan/account.json';

/** 接口基础地址 */
function baseUrl(): string {
    return `https://${CLOUD_ENV_ID}.service.tcloudbase.com`;
}

/** 账号信息（持久化在独立文件中） */
export interface AccountData {
    /** 登录令牌 */
    token?: string;
    /** 账号名称（登录成功后由服务器返回，暂存） */
    name?: string;
    /** 令牌过期时间（毫秒时间戳） */
    expireTime?: number;
}

/** 读取账号数据（文件不存在或解析失败时返回空对象） */
export async function loadAccount(app: App): Promise<AccountData> {
    try {
        const raw = await app.vault.adapter.read(ACCOUNT_FILE);
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed as AccountData : {};
    } catch {
        return {};
    }
}

/** 保存账号数据 */
export async function saveAccount(app: App, account: AccountData): Promise<void> {
    await app.vault.adapter.write(ACCOUNT_FILE, JSON.stringify(account, null, 2));
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
    /** 登录是否已完成 */
    loggedIn?: boolean;
    /** 账号名称（不同后端字段名可能不同，做兼容） */
    name?: string;
    nickname?: string;
    userName?: string;
    [key: string]: unknown;
}

/** 创建登录令牌：返回 token 与过期时间 */
export async function createLoginToken(): Promise<{ token: string; expireTime?: number }> {
    const res = await requestUrl({
        url: `${baseUrl()}/login/create`,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ type: 'createLoginToken' }),
    });
    const data = res.json as CreateLoginTokenResponse;
    if (!data || !data.token) {
        throw new Error('createLoginToken: 服务器未返回 token');
    }
    return { token: data.token, expireTime: data.expireTime };
}

/** 检查登录令牌：返回是否已登录及账号名称 */
export async function checkLoginToken(token: string): Promise<{ loggedIn: boolean; name?: string }> {
    const res = await requestUrl({
        url: `${baseUrl()}/login/check`,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ type: 'checkLoginToken', token }),
    });
    const data = res.json as CheckLoginTokenResponse;
    if (!data) return { loggedIn: false };
    const name = data.name ?? data.nickname ?? data.userName;
    // 兼容多种成功标识：success / loggedIn 任一为真即视为登录成功
    const loggedIn = data.loggedIn === true || data.success === true;
    return { loggedIn, name };
}
