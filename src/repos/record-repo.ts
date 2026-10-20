// 记录数据仓库：封装记录卡片填写结果的读写入口。
// 视图不再直接 import getRecordStore，改调本仓库方法；底层仍委托 sql.js 的 RecordStore 读写 .db 文件，
// 存储介质与生命周期不变（append-only 日志型数据走 SQLite，不并入 base-repo 的 data.json 全量快照体系）。
import type { App } from 'obsidian';

import type { OkrRecordEntry } from '../datatypes/domain';
import { getRecordStore } from '../db/record-store';

/**
 * 记录数据仓库：统一记录卡片填写结果的写入与查询入口，
 * 便于后续「数据」视图等按任务/日期做聚合统计时复用同一语义。
 */
export class RecordRepo {
    private app: App;

    constructor(app: App) {
        this.app = app;
    }

    /** 写入一条填写记录（INSERT OR REPLACE 幂等），并立即持久化到 .db 文件 */
    async insert(entry: OkrRecordEntry): Promise<void> {
        await getRecordStore(this.app).insertEntry(entry);
    }

    /** 按任务 id 查询该任务的全部填写记录（日期 / 创建时间倒序，最新在前） */
    async listByInbox(inboxId: string): Promise<OkrRecordEntry[]> {
        return getRecordStore(this.app).listEntriesByInbox(inboxId);
    }
}