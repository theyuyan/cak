// SPIKE（抛弃式）— Ledger：append-only hash 链 + 折叠投影 + 快照。目的：验证 05_LEDGER.md 的机制可行，不是正式代码。
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };
export type Principal = { kind: 'org' | 'user' | 'agent' | 'runtime' | 'task'; id: string };
export type Chain = Principal[];

export const jcs = (o: unknown) => { const s = canonicalize(o); if (typeof s !== 'string') throw new Error('jcs'); return s; };
export const sha = (s: string) => 'sha256:' + createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
export const digest = (o: unknown) => sha(jcs(o));
export const ZERO = 'sha256:' + '0'.repeat(64);

export interface Ev { seq: number; prevHash: string; hash: string; ts: string; taskId: string; principal: Chain; type: string; schemaVersion: string; payload: JsonObject }
export type EvIn = Omit<Ev, 'seq' | 'prevHash' | 'hash'>;
export const eventHash = (e: Omit<Ev, 'hash'>) => digest({ seq: e.seq, prevHash: e.prevHash, ts: e.ts, taskId: e.taskId, principal: e.principal, type: e.type, payload: e.payload, schemaVersion: e.schemaVersion });

/** 文件账本：NDJSON，每行一事件；启动时验链。 */
export class FileLedger {
  private events: Ev[] = [];
  constructor(private path: string) {
    if (fs.existsSync(path)) {
      const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean);
      let prev = ZERO;
      for (const l of lines) {
        const e = JSON.parse(l) as Ev;
        if (e.prevHash !== prev || eventHash(e) !== e.hash) throw new Error(`LEDGER_CORRUPT at seq ${e.seq}`);
        this.events.push(e); prev = e.hash;
      }
    }
  }
  head() { const last = this.events[this.events.length - 1]; return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: ZERO }; }
  append(ins: EvIn[]): Ev[] {
    const out: Ev[] = [];
    for (const i of ins) {
      const h = this.head();
      const partial = { seq: h.seq + 1, prevHash: h.hash, ...i };
      const e: Ev = { ...partial, hash: eventHash(partial) };
      this.events.push(e); out.push(e);
      fs.appendFileSync(this.path, JSON.stringify(e) + '\n');
    }
    return out;
  }
  read(from = 1, to?: number) { return this.events.filter(e => e.seq >= from && (to === undefined || e.seq <= to)); }
  all() { return this.events.slice(); }
}

// ---------------- projections（纯函数折叠）----------------
export interface Projections {
  revoked: Record<string, number>;                     // handleId → epoch
  handles: Record<string, { parent?: string; caveats: JsonObject[]; holder: Chain; contract: JsonObject; expiresAt?: string }>;
  authorizedCount: Record<string, number>;             // handleId → 已授权次数（once）
  usage: Record<string, { calls: number }>;            // handleId → 累计
  invocations: Record<string, JsonObject>;             // id → 最新状态
  pendingApprovals: Record<string, { invocationId: string; digest: string; revision: number }>;
  grants: Record<string, { invocationDigest: string; expiresAt?: string }>;
  tasks: Record<string, { status: string }>;
}
export const initProjections = (): Projections => ({ revoked: {}, handles: {}, authorizedCount: {}, usage: {}, invocations: {}, pendingApprovals: {}, grants: {}, tasks: {} });

export function apply(s: Projections, e: Ev): Projections {
  const p = e.payload as any;
  switch (e.type) {
    case 'handle.minted': s.handles[p.handleId] = { caveats: p.caveats, holder: p.holder, contract: p.contract, expiresAt: p.expiresAt }; break;
    case 'handle.attenuated': { const par = s.handles[p.parent]; if (!par) throw new Error('fold: parent missing'); s.handles[p.handleId] = { parent: p.parent, caveats: [...par.caveats, ...p.addCaveats], holder: p.holder, contract: par.contract, expiresAt: p.expiresAt ?? par.expiresAt }; break; }
    case 'handle.revoked': s.revoked[p.handleId] = p.epoch; break;
    case 'task.spawned': s.tasks[p.taskId] = { status: 'running' }; break;
    case 'task.suspended': s.tasks[e.taskId] = { status: 'suspended' }; break;
    case 'task.resumed': s.tasks[e.taskId] = { status: 'running' }; break;
    case 'task.finished': s.tasks[e.taskId] = { status: 'finished' }; break;
    case 'task.failed': s.tasks[e.taskId] = { status: 'failed' }; break;
    case 'invocation.requested': s.invocations[p.invocationId] = { ...p, status: 'requested' }; break;
    case 'invocation.revised': s.invocations[p.invocationId] = { ...s.invocations[p.invocationId], args: p.args, revision: p.revision, status: 'revised' }; break;
    case 'invocation.authorized': { const inv = s.invocations[p.invocationId] as any; s.invocations[p.invocationId] = { ...inv, status: 'authorized', digest: p.digest, revision: p.revision }; s.authorizedCount[inv.handleId] = (s.authorizedCount[inv.handleId] ?? 0) + 1; delete s.pendingApprovals[p.invocationId]; break; }
    case 'invocation.awaiting': s.invocations[p.invocationId] = { ...s.invocations[p.invocationId], status: 'awaiting', digest: p.digest, approvalId: p.approvalId }; s.pendingApprovals[p.invocationId] = { invocationId: p.invocationId, digest: p.digest, revision: p.revision }; break;
    case 'invocation.denied': s.invocations[p.invocationId] = { ...s.invocations[p.invocationId], status: 'denied', code: p.code, reason: p.reason }; break;
    case 'invocation.executed': { const inv = s.invocations[p.invocationId] as any; s.invocations[p.invocationId] = { ...inv, status: 'executed', resultDigest: p.resultDigest }; const u = s.usage[inv.handleId] ?? { calls: 0 }; u.calls += 1; s.usage[inv.handleId] = u; break; }
    case 'invocation.failed': s.invocations[p.invocationId] = { ...s.invocations[p.invocationId], status: 'failed' }; break;
    case 'grant.issued': s.grants[p.approvalId] = { invocationDigest: p.invocationDigest, expiresAt: p.expiresAt }; break;
    default: break;
  }
  return s;
}
export function fold(events: Ev[], from = initProjections()): Projections { let s = from; for (const e of events) s = apply(s, e); return s; }

export interface Snapshot { schemaVersion: '1.0.0'; atSeq: number; atHash: string; projections: Projections }
export const snapshot = (l: FileLedger): Snapshot => ({ schemaVersion: '1.0.0', atSeq: l.head().seq, atHash: l.head().hash, projections: fold(l.all()) });
/** 恢复：快照校验 atHash；不符或缺失 → 全量重放 */
export function restore(l: FileLedger, snap?: Snapshot): Projections {
  if (snap) {
    const at = l.read(snap.atSeq, snap.atSeq)[0];
    if (at && at.hash === snap.atHash) return fold(l.read(snap.atSeq + 1), structuredClone(snap.projections));
  }
  return fold(l.all());
}
