/** SQLite 账本存储（M4）：node:sqlite 内置，无外部依赖。接口与 FileLedgerStore 相同；链校验仍由 Ledger.open 做。 */
import { createRequire } from 'node:module';
import type { LedgerStore, LedgerEvent, LedgerSnapshot } from './ledger.js';
// node:sqlite 是 Node 内置模块（≥22.5）；用 createRequire 加载，避开打包器 / vitest 对 'node:sqlite' 的静态解析问题
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;

export class SqliteLedgerStore implements LedgerStore {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, hash TEXT NOT NULL, prev_hash TEXT NOT NULL, ts TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL);
                  CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
                  CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);`);
  }
  append(lines: LedgerEvent[]) {
    const ins = this.db.prepare('INSERT INTO events (seq, hash, prev_hash, ts, task_id, type, body) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try { for (const e of lines) ins.run(e.seq, e.hash, e.prevHash, e.ts, e.taskId, e.type, JSON.stringify(e)); this.db.exec('COMMIT'); } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  readAll(): LedgerEvent[] { return (this.db.prepare('SELECT body FROM events ORDER BY seq').all() as Array<{ body: string }>).map(r => JSON.parse(r.body) as LedgerEvent); }
  saveSnapshot(s: LedgerSnapshot) { this.db.prepare('INSERT INTO snapshot (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(JSON.stringify(s)); }
  loadSnapshot(): LedgerSnapshot | undefined { const r = this.db.prepare('SELECT body FROM snapshot WHERE id = 1').get() as { body: string } | undefined; return r ? JSON.parse(r.body) as LedgerSnapshot : undefined; }
  /** 运营查询：按 task / type 直接走 SQL（Observer/报表用；不参与折叠） */
  query(where: { taskId?: string; type?: string; fromSeq?: number; limit?: number }): LedgerEvent[] {
    const conds: string[] = []; const params: unknown[] = [];
    if (where.taskId) { conds.push('task_id = ?'); params.push(where.taskId); }
    if (where.type) { conds.push('type = ?'); params.push(where.type); }
    if (where.fromSeq) { conds.push('seq >= ?'); params.push(where.fromSeq); }
    const sql = `SELECT body FROM events${conds.length ? ' WHERE ' + conds.join(' AND ') : ''} ORDER BY seq${where.limit ? ' LIMIT ' + Number(where.limit) : ''}`;
    return (this.db.prepare(sql).all(...(params as any[])) as Array<{ body: string }>).map(r => JSON.parse(r.body) as LedgerEvent);
  }
  close() { this.db.close(); }
}
