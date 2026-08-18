/**
 * Ledger（05_LEDGER.md）：append-only hash 链、折叠投影、快照、回执。
 * 唯一事实源：运行时一切状态都由 fold(events) 得出；快照只是缓存。
 */
import canonicalize from 'canonicalize';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ID, Json, JsonObject, PrincipalChain, Digest, ISODateTime, InvocationRecord, ApprovalRequirement, TaskStatus, BudgetSlice, Caveat, ContractRef, TaskConfig, HandleView, LedgerEventView, Observer } from '../../sdk/types.js';
import { err } from '../errors.js';

export const jcs = (o: unknown): string => { const s = canonicalize(o); if (typeof s !== 'string') throw err('INTERNAL_ERROR', 'JCS failed'); return s; };
export const sha256 = (s: string): Digest => 'sha256:' + createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
export const digest = (o: unknown): Digest => sha256(jcs(o));
export const ZERO_HASH: Digest = 'sha256:' + '0'.repeat(64);
export const EVENT_SCHEMA_VERSION = '1.0.0';

export type LedgerEventType =
  | 'runtime.composed' | 'runtime.started' | 'runtime.stopped'
  | 'handle.minted' | 'handle.attenuated' | 'handle.revoked'
  | 'task.spawned' | 'task.step' | 'task.suspended' | 'task.resumed' | 'task.finished' | 'task.failed' | 'task.cancelled' | 'task.timeout'
  | 'invocation.requested' | 'invocation.revised' | 'invocation.authorized' | 'invocation.awaiting' | 'invocation.denied'
  | 'invocation.executed' | 'invocation.failed' | 'invocation.cancelled'
  | 'grant.issued' | 'grant.expired' | 'bundle.composed' | 'human.answered' | 'usage.recorded' | 'receipt.issued'
  | 'plugin.degraded' | 'error.raised' | 'contract.implicitly_defined';

export interface LedgerEvent { seq: number; prevHash: Digest; hash: Digest; ts: ISODateTime; taskId: ID; principal: PrincipalChain; type: LedgerEventType; schemaVersion: string; payload: JsonObject; sig?: { scheme: string; keyId: string; value: string } }
export type EventInput = { ts?: ISODateTime; taskId: ID; principal: PrincipalChain; type: LedgerEventType; payload: JsonObject };

export const eventHash = (e: Omit<LedgerEvent, 'hash' | 'sig'>): Digest =>
  digest({ seq: e.seq, prevHash: e.prevHash, ts: e.ts, taskId: e.taskId, principal: e.principal, type: e.type, payload: e.payload, schemaVersion: e.schemaVersion });

// ---------------------------------------------------------------- stores (Provider 角色的最小接口)
export interface LedgerStore { append(lines: LedgerEvent[]): void; readAll(): LedgerEvent[]; saveSnapshot?(s: LedgerSnapshot): void; loadSnapshot?(): LedgerSnapshot | undefined }
export interface BlobStore { put(bytes: string, mediaType?: string): Digest; get(d: Digest): { bytes: string; mediaType?: string } | undefined }

export class MemoryLedgerStore implements LedgerStore {
  private ev: LedgerEvent[] = []; private snap?: LedgerSnapshot;
  append(lines: LedgerEvent[]) { this.ev.push(...lines); }
  readAll() { return this.ev.slice(); }
  saveSnapshot(s: LedgerSnapshot) { this.snap = s; } loadSnapshot() { return this.snap; }
}
/** NDJSON 文件账本：每行一事件；启动时由 Ledger 验链 */
export class FileLedgerStore implements LedgerStore {
  constructor(private file: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  append(lines: LedgerEvent[]) { fs.appendFileSync(this.file, lines.map(e => JSON.stringify(e)).join('\n') + '\n'); }
  readAll(): LedgerEvent[] { if (!fs.existsSync(this.file)) return []; return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as LedgerEvent); }
  saveSnapshot(s: LedgerSnapshot) { fs.writeFileSync(this.file + '.snapshot.json', JSON.stringify(s)); }
  loadSnapshot() { const p = this.file + '.snapshot.json'; return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) as LedgerSnapshot : undefined; }
}
export class MemoryBlobStore implements BlobStore {
  private m = new Map<Digest, { bytes: string; mediaType?: string }>();
  put(bytes: string, mediaType?: string) { const d = sha256(bytes); this.m.set(d, { bytes, mediaType }); return d; }
  get(d: Digest) { return this.m.get(d); }
}

// ---------------------------------------------------------------- projections（纯函数折叠）
export interface HandleRecord { id: ID; contract: ContractRef; holder: PrincipalChain; parent?: ID; caveats: Caveat[]; expiresAt?: ISODateTime; issuedAt: ISODateTime }
export interface TaskRecord { id: ID; parent?: ID; goal: Json; status: TaskStatus; handles: ID[]; budget: BudgetSlice; config: TaskConfig; principal: PrincipalChain; steps: number; lastStepOutcome?: string; suspendedReason?: string; input?: Json; lastBundleRef?: Digest; outputRef?: Digest; mustFinalize?: boolean }
export interface Projections {
  handles: Record<ID, HandleRecord>;
  revoked: Record<ID, number>;
  authorizedCount: Record<ID, number>;
  usageByHandle: Record<ID, { calls: number; inputTokens: number; outputTokens: number }>;
  usageByTask: Record<ID, { calls: number; inputTokens: number; outputTokens: number }>;
  invocations: Record<ID, InvocationRecord>;
  pendingApprovals: Record<ID, ApprovalRequirement>;   // by invocationId
  grants: Record<string, { approvalId: string; invocationDigest: Digest; expiresAt?: ISODateTime; grantedBy: JsonObject }>; // by approvalId
  tasks: Record<ID, TaskRecord>;
  installedPlugins: Record<ID, JsonObject>;
}
export const initProjections = (): Projections => ({ handles: {}, revoked: {}, authorizedCount: {}, usageByHandle: {}, usageByTask: {}, invocations: {}, pendingApprovals: {}, grants: {}, tasks: {}, installedPlugins: {} });

const bump = (m: Record<ID, { calls: number; inputTokens: number; outputTokens: number }>, k: ID, u?: JsonObject) => {
  const cur = m[k] ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
  const units = (u?.['units'] as JsonObject | undefined) ?? {};
  cur.calls += 1; cur.inputTokens += Number(units['inputTokens'] ?? 0); cur.outputTokens += Number(units['outputTokens'] ?? 0);
  m[k] = cur;
};

export function apply(s: Projections, e: LedgerEvent): Projections {
  const p = e.payload as any;
  switch (e.type) {
    case 'handle.minted': s.handles[p.handleId] = { id: p.handleId, contract: p.contract, holder: p.holder, caveats: p.caveats, expiresAt: p.expiresAt, issuedAt: e.ts }; break;
    case 'handle.attenuated': { const par = s.handles[p.parent]; if (!par) throw err('LEDGER_CORRUPT', `fold: parent handle ${p.parent} missing`); s.handles[p.handleId] = { id: p.handleId, contract: par.contract, holder: p.holder, parent: p.parent, caveats: [...par.caveats, ...p.addCaveats], expiresAt: p.expiresAt ?? par.expiresAt, issuedAt: e.ts }; break; }
    case 'handle.revoked': s.revoked[p.handleId] = p.epoch; break;
    case 'task.spawned': s.tasks[p.taskId] = { id: p.taskId, parent: p.parent, goal: p.goal, status: 'running', handles: p.handles, budget: p.budget ?? {}, config: p.config, principal: e.principal, steps: 0, input: p.input }; break;
    case 'task.step': { const t = s.tasks[e.taskId]; if (t) { t.steps = p.index + 1; t.lastStepOutcome = p.outcome; } break; }
    case 'task.suspended': { const t = s.tasks[e.taskId]; if (t) { t.status = 'suspended'; t.suspendedReason = p.reason; } break; }
    case 'task.resumed': { const t = s.tasks[e.taskId]; if (t) t.status = 'running'; break; }
    case 'task.finished': { const t = s.tasks[e.taskId]; if (t) { t.status = 'finished'; t.outputRef = p.outputRef; } break; }
    case 'task.failed': { const t = s.tasks[e.taskId]; if (t) t.status = 'failed'; break; }
    case 'task.cancelled': { const t = s.tasks[e.taskId]; if (t) t.status = 'cancelled'; break; }
    case 'task.timeout': { const t = s.tasks[e.taskId]; if (t) t.status = 'timeout'; break; }
    case 'bundle.composed': { const t = s.tasks[e.taskId]; if (t) t.lastBundleRef = p.bundleRef; break; }
    case 'invocation.requested': s.invocations[p.invocationId] = { id: p.invocationId, taskId: e.taskId, handleId: p.handleId, contract: p.contract, revision: 0, args: p.args, status: 'requested' }; break;
    case 'invocation.revised': { const i = s.invocations[p.invocationId]; if (i) { i.args = p.args; i.revision = p.revision; i.status = 'revised'; } break; }
    case 'invocation.authorized': { const i = s.invocations[p.invocationId]; if (i) { i.status = 'authorized'; i.digest = p.digest; i.revision = p.revision; i.providerId = p.providerId; i.args = p.effectiveArgs; i.approvalId = p.approvalId; s.authorizedCount[i.handleId] = (s.authorizedCount[i.handleId] ?? 0) + 1; delete s.pendingApprovals[p.invocationId]; } break; }
    case 'invocation.awaiting': { const i = s.invocations[p.invocationId]; if (i) { i.status = 'awaiting'; i.digest = p.digest; i.approvalId = p.approvalId; s.pendingApprovals[p.invocationId] = { approvalId: p.approvalId, invocationId: p.invocationId, revision: p.revision, invocationDigest: p.digest, contract: i.contract, handleId: i.handleId, expiresAt: p.expiresAt, summary: p.summary }; } break; }
    case 'invocation.denied': { const i = s.invocations[p.invocationId]; if (i) { i.status = 'denied'; i.denyCode = p.code; i.denyReason = p.reason; i.retryable = p.retryable; } delete s.pendingApprovals[p.invocationId]; break; }
    case 'invocation.executed': { const i = s.invocations[p.invocationId]; if (i) { i.status = 'executed'; i.resultDigest = p.resultDigest; i.usage = p.usage; i.output = p.output; bump(s.usageByHandle, i.handleId, p.usage); bump(s.usageByTask, e.taskId, p.usage); } break; }
    case 'invocation.failed': { const i = s.invocations[p.invocationId]; if (i) { i.status = 'failed'; i.error = p.error; } break; }
    case 'invocation.cancelled': { const i = s.invocations[p.invocationId]; if (i) i.status = 'cancelled'; break; }
    case 'grant.issued': s.grants[p.approvalId] = { approvalId: p.approvalId, invocationDigest: p.invocationDigest, expiresAt: p.expiresAt, grantedBy: p.grantedBy }; break;
    case 'grant.expired': delete s.grants[p.approvalId]; break;
    default: break;
  }
  return s;
}
export function fold(events: Iterable<LedgerEvent>, from: Projections = initProjections()): Projections { let s = from; for (const e of events) s = apply(s, e); return s; }

export interface LedgerSnapshot { schemaVersion: string; atSeq: number; atHash: Digest; projections: Projections }

// ---------------------------------------------------------------- Ledger（append + 验链 + 投影缓存 + 观察者）
export class Ledger {
  private events: LedgerEvent[] = [];
  private proj: Projections = initProjections();
  private observers: Observer[] = [];
  private constructor(private store: LedgerStore, private now: () => ISODateTime) {}

  /** 打开账本：验链；有快照且 atHash 匹配 → 从快照续折叠，否则全量重放 */
  static open(store: LedgerStore, now: () => ISODateTime = () => new Date().toISOString()): Ledger {
    const l = new Ledger(store, now);
    const all = store.readAll();
    let prev = ZERO_HASH;
    for (const e of all) {
      if (e.prevHash !== prev) throw err('LEDGER_CORRUPT', `prevHash mismatch at seq ${e.seq}`);
      if (eventHash(e) !== e.hash) throw err('LEDGER_CORRUPT', `hash mismatch at seq ${e.seq}`);
      if (e.schemaVersion !== EVENT_SCHEMA_VERSION) throw err('LEDGER_INCOMPATIBLE', `event schemaVersion ${e.schemaVersion} at seq ${e.seq}`);
      prev = e.hash;
    }
    l.events = all;
    const snap = store.loadSnapshot?.();
    if (snap && snap.schemaVersion === EVENT_SCHEMA_VERSION && all[snap.atSeq - 1]?.hash === snap.atHash) {
      l.proj = fold(all.slice(snap.atSeq), structuredClone(snap.projections));
    } else l.proj = fold(all);
    return l;
  }
  subscribe(o: Observer) { this.observers.push(o); return () => { this.observers = this.observers.filter(x => x !== o); }; }
  head() { const last = this.events[this.events.length - 1]; return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: ZERO_HASH }; }
  all(): readonly LedgerEvent[] { return this.events; }
  projections(): Projections { return this.proj; }
  /** 唯一写入口：追加 → 落盘 → 折叠 → 通知观察者（观察者异常不影响主链） */
  append(...inputs: EventInput[]): LedgerEvent[] {
    const out: LedgerEvent[] = [];
    for (const i of inputs) {
      const h = this.head();
      const partial = { seq: h.seq + 1, prevHash: h.hash, ts: i.ts ?? this.now(), taskId: i.taskId, principal: i.principal, type: i.type, schemaVersion: EVENT_SCHEMA_VERSION, payload: i.payload };
      const e: LedgerEvent = { ...partial, hash: eventHash(partial) };
      this.store.append([e]); this.events.push(e); this.proj = apply(this.proj, e); out.push(e);
    }
    for (const e of out) for (const o of this.observers) { try { void Promise.resolve(o.onEvent(e as LedgerEventView)).catch(() => {}); } catch { /* observers never break the chain */ } }
    return out;
  }
  snapshot(): LedgerSnapshot { const s: LedgerSnapshot = { schemaVersion: EVENT_SCHEMA_VERSION, atSeq: this.head().seq, atHash: this.head().hash, projections: structuredClone(this.proj) }; this.store.saveSnapshot?.(s); return s; }

  /** 回执：某调用相关事件 + Merkle 根 + HMAC 签名（M1 占位签名，接口不变） */
  receipt(invocationId: ID, signKey: string): { invocationId: ID; events: LedgerEvent[]; root: Digest; sig: { scheme: string; keyId: string; value: string } } {
    const evs = this.events.filter(e => (e.payload as any).invocationId === invocationId || (e.type === 'grant.issued' && this.proj.invocations[invocationId]?.digest === (e.payload as any).invocationDigest));
    const root = merkleRoot(evs.map(e => e.hash));
    const value = createHmac('sha256', signKey).update(root).digest('hex');
    return { invocationId, events: evs, root, sig: { scheme: 'hmac-sha256', keyId: 'runtime', value } };
  }
}
export function merkleRoot(hashes: Digest[]): Digest {
  if (hashes.length === 0) return ZERO_HASH;
  let layer = hashes.slice();
  while (layer.length > 1) {
    const next: Digest[] = [];
    for (let i = 0; i < layer.length; i += 2) next.push(sha256(layer[i]! + (layer[i + 1] ?? layer[i]!)));
    layer = next;
  }
  return layer[0]!;
}
export function verifyReceipt(r: { events: LedgerEvent[]; root: Digest; sig: { value: string } }, signKey: string): boolean {
  for (const e of r.events) if (eventHash(e) !== e.hash) return false;
  if (merkleRoot(r.events.map(e => e.hash)) !== r.root) return false;
  return createHmac('sha256', signKey).update(r.root).digest('hex') === r.sig.value;
}
export function taskUsageSum(p: Projections, taskId: ID) { return p.usageByTask[taskId] ?? { calls: 0, inputTokens: 0, outputTokens: 0 }; }
