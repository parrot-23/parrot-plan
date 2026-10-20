// 记录卡片填写结果的数据存储层：基于 sql.js（SQLite 编译为 WASM）读写 .db 文件。
// .db 文件落在 vault 内的隐藏目录 .parrot-plan/db/parrot-plan.db，随 Obsidian Sync / git 同步。
import type { App } from 'obsidian';
// 使用浏览器构建（无 node:fs/node:crypto 顶层 require，避免插件加载时报错）
import initSqlJs from 'sql.js/dist/sql-wasm-browser.js';
// .wasm 由 @rollup/plugin-url 构建期内联为 base64 data URL
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm';

import type { OkrRecordEntry } from '../datatypes/domain';

/** .db 文件在 vault 内的相对路径（隐藏目录，随 vault 同步） */
const DB_PATH = '.parrot-plan/db/parrot-plan.db';
/** .db 文件所在目录（Obsidian 的 writeBinary 不会自动建目录，需先 mkdir） */
const DB_DIR = '.parrot-plan/db';

/** 建表语句：记录卡片填写结果表 + 按任务/日期索引（为后续聚合查询预留） */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS record_entries (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  inbox_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  values_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_record_entries_inbox ON record_entries(inbox_id);
CREATE INDEX IF NOT EXISTS idx_record_entries_day ON record_entries(day_key);
`;

/** sql.js 的 Database 实例类型（避免依赖 export = 的具名类型导入） */
type SqlDatabase = InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>;

/** 把内联的 base64 data URL 解码为 ArrayBuffer（作为 wasmBinary 传入 initSqlJs） */
function decodeWasm(dataUrl: string): ArrayBuffer {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const binary = atob(base64);
    const buf = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return buf;
}

let storeInstance: RecordStore | null = null;

/** 获取进程内唯一的记录存储实例（懒加载，首次使用时初始化） */
export function getRecordStore(app: App): RecordStore {
    if (!storeInstance) storeInstance = new RecordStore(app);
    return storeInstance;
}

/**
 * 记录存储：负责 sql.js 数据库的加载/建表、记录的写入与落盘。
 * 写入采用「内存数据库 → export → 整库写回 .db」的快照式落盘，与 decks 等插件一致。
 */
export class RecordStore {
    private db: SqlDatabase | null = null;
    private initPromise: Promise<void> | null = null;

    constructor(private app: App) {}

    /** 初始化（幂等）：加载 wasm、读入或新建 .db、确保表结构存在 */
    init(): Promise<void> {
        if (this.db) return Promise.resolve();
        if (!this.initPromise) this.initPromise = this.doInit();
        return this.initPromise;
    }

    private async doInit(): Promise<void> {
        const SQL = await initSqlJs({ wasmBinary: decodeWasm(wasmUrl) });
        const adapter = this.app.vault.adapter;
        let db: SqlDatabase;
        if (await adapter.exists(DB_PATH)) {
            const buf = await adapter.readBinary(DB_PATH);
            db = new SQL.Database(new Uint8Array(buf));
        } else {
            db = new SQL.Database();
        }
        db.run(SCHEMA);
        this.db = db;
    }

    /** 写入一条记录（INSERT OR REPLACE 幂等），并立即持久化到 .db 文件 */
    async insertEntry(entry: OkrRecordEntry): Promise<void> {
        await this.init();
        this.db!.run(
            'INSERT OR REPLACE INTO record_entries (id, record_id, inbox_id, day_key, created_at, values_json) VALUES (?, ?, ?, ?, ?, ?)',
            [entry.id, entry.recordId, entry.inboxId, entry.dayKey, entry.createdAt, JSON.stringify(entry.values)],
        );
        await this.persist();
    }

    /**
     * 按任务 id 查询该任务的全部填写记录（按日期倒序、创建时间倒序，最新在前）。
     * values_json 解析回 fieldId -> value 映射。
     */
    async listEntriesByInbox(inboxId: string): Promise<OkrRecordEntry[]> {
        await this.init();
        const stmt = this.db!.prepare(
            'SELECT id, record_id, inbox_id, day_key, created_at, values_json FROM record_entries WHERE inbox_id = ? ORDER BY day_key DESC, created_at DESC',
        );
        const results: OkrRecordEntry[] = [];
        try {
            stmt.bind([inboxId]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, unknown>;
                let values: Record<string, string | number | boolean> = {};
                try {
                    const parsed = JSON.parse(String(row.values_json));
                    if (parsed && typeof parsed === 'object') values = parsed as Record<string, string | number | boolean>;
                } catch {
                    // 非法 JSON 忽略，保留空 values
                }
                results.push({
                    id: String(row.id),
                    recordId: String(row.record_id),
                    inboxId: String(row.inbox_id),
                    dayKey: String(row.day_key),
                    createdAt: Number(row.created_at),
                    values,
                });
            }
        } finally {
            stmt.free();
        }
        return results;
    }

    /** 将当前内存数据库整库导出并写回 .db 文件 */
    private async persist(): Promise<void> {
        const adapter = this.app.vault.adapter;
        // Obsidian 的 writeBinary 不会自动创建父目录，需先确保目录存在
        if (!(await adapter.exists(DB_DIR))) {
            await adapter.mkdir(DB_DIR);
        }
        const bytes = this.db!.export();
        await adapter.writeBinary(DB_PATH, bytes);
    }
}