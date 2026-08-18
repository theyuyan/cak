// SPIKE（抛弃式）— Authority：mint / attenuate / verify（纯函数）/ revoke。验证 04_AUTHORITY_HANDLES.md 的规则可实现。
import Ajv2020 from 'ajv/dist/2020.js';
import path from 'node:path';
import { digest, type Chain, type JsonObject, type Projections } from './ledger.js';

export type Caveat =
  | { kind: 'args.match'; schema: JsonObject }
  | { kind: 'args.prefix'; path: string; prefix: string }
  | { kind: 'args.max'; path: string; max: number }
  | { kind: 'time.window'; notBefore?: string; notAfter?: string }
  | { kind: 'budget'; slice: { calls?: number } }
  | { kind: 'requires-approval'; approver: unknown; ttlMs?: number }
  | { kind: 'once' }
  | { kind: 'no-delegate' }
  | { kind: 'provider'; providerId: string }
  | { kind: 'custom'; name: string; params: JsonObject };

export interface Handle { id: string; contract: JsonObject; holder: Chain; parent?: string; caveats: Caveat[]; issuedAt: string; expiresAt?: string; epoch: number; proof: { kind: 'in-process'; secret: symbol } }
export interface Grant { approvalId: string; invocationDigest: string; expiresAt?: string }
export type Verify =
  | { ok: true; effectiveArgs: JsonObject; digest: string }
  | { ok: false; kind: 'needs-approval'; digest: string; approvalId: string }
  | { ok: false; kind: 'denied'; code: 'HANDLE_INVALID' | 'CAVEAT_VIOLATION' | 'BUDGET_EXCEEDED' | 'APPROVAL_EXPIRED'; reason: string; retryable: boolean };

const ajv = new Ajv2020({ strict: false });
const KERNEL = Symbol('kernel-only');           // 插件拿不到；伪造对象缺它就是 HANDLE_INVALID
const table = new Map<string, Handle>();          // 内核引用表：HandleId → Handle（不可伪造）
let counter = 0;
const nid = (p: string) => `${p}_${(++counter).toString(36).padStart(4, '0')}`;

export function mint(contract: JsonObject, holder: Chain, caveats: Caveat[], opts: { expiresAt?: string; now: string }): Handle {
  const h: Handle = { id: nid('h'), contract, holder, caveats: [...caveats], issuedAt: opts.now, ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}), epoch: 0, proof: { kind: 'in-process', secret: KERNEL } };
  table.set(h.id, h); return h;
}
export function attenuate(parentId: string, add: Caveat[], newHolder: Chain | undefined, now: string): Handle | { error: 'ATTENUATION_ERROR' | 'HANDLE_INVALID'; reason: string } {
  const p = table.get(parentId); if (!p || p.proof.secret !== KERNEL) return { error: 'HANDLE_INVALID', reason: 'unknown parent' };
  if (p.caveats.some(c => c.kind === 'no-delegate')) return { error: 'ATTENUATION_ERROR', reason: 'parent is no-delegate' };
  const holder = newHolder ?? p.holder;
  if (!isSuffix(holder, p.holder)) return { error: 'ATTENUATION_ERROR', reason: 'new holder must extend parent holder chain' };
  const h: Handle = { id: nid('h'), contract: p.contract, holder, parent: p.id, caveats: [...p.caveats, ...add], issuedAt: now, ...(p.expiresAt !== undefined ? { expiresAt: p.expiresAt } : {}), epoch: 0, proof: { kind: 'in-process', secret: KERNEL } };
  table.set(h.id, h); return h;
}
/** 只用于测试"插件伪造对象"：不经 mint 直接塞进表 —— 必须失败 */
export function forgeForTest(id: string, h: Omit<Handle, 'proof'>) { table.set(id, { ...h, proof: { kind: 'in-process', secret: Symbol('forged') } }); }
export function view(id: string) { const h = table.get(id); return h ? { id: h.id, contract: h.contract, caveats: h.caveats, expiresAt: h.expiresAt, delegable: !h.caveats.some(c => c.kind === 'no-delegate') } : undefined; }
export function _table() { return table; }

/** chain 必须以 holder 为后缀（task ⊂ agent ⊂ org） */
export function isSuffix(chain: Chain, holder: Chain) {
  if (holder.length > chain.length) return false;
  const off = chain.length - holder.length;
  return holder.every((p, i) => chain[off + i]!.kind === p.kind && chain[off + i]!.id === p.id);
}
const get = (o: JsonObject, p: string): unknown => p.split('.').reduce<any>((a, k) => (a == null ? undefined : a[k]), o);
const normPath = (s: string) => { const n = path.posix.normalize(s.replace(/\\/g, '/')); return n.startsWith('/') ? n : n.replace(/^\.\//, ''); };

/** ApprovalSubjectV1（04 §3） */
export function invocationDigest(inv: { id: string; revision: number; contract: JsonObject; args: JsonObject; handleId: string }, chain: Chain, providerId?: string) {
  const subj: JsonObject = { schemaVersion: 'approval-subject/1', invocation: { id: inv.id, revision: inv.revision, contract: inv.contract, args: inv.args, handleId: inv.handleId }, principalChain: chain as unknown as Json[] } as any;
  if (providerId) (subj as any).provider = { providerId };
  return digest(subj);
}
type Json = import('./ledger.js').Json;

export function verify(handleId: string, chain: Chain, args: JsonObject, inv: { id: string; revision: number }, grants: Grant[], proj: Projections, now: string, providerId?: string): Verify {
  const h = table.get(handleId);
  // 1 真伪
  if (!h || h.proof.kind !== 'in-process' || h.proof.secret !== KERNEL) return { ok: false, kind: 'denied', code: 'HANDLE_INVALID', reason: '句柄不存在或非内核铸造', retryable: false };
  // 2 持有者
  if (!isSuffix(chain, h.holder)) return { ok: false, kind: 'denied', code: 'HANDLE_INVALID', reason: '调用方主体链与句柄持有者不匹配', retryable: false };
  // 3 撤销（含祖先）
  for (let cur: Handle | undefined = h; cur; cur = cur.parent ? table.get(cur.parent) : undefined) if (proj.revoked[cur.id] !== undefined) return { ok: false, kind: 'denied', code: 'HANDLE_INVALID', reason: `句柄 ${cur.id} 已撤销`, retryable: false };
  // 4 期限
  if (h.expiresAt && now >= h.expiresAt) return { ok: false, kind: 'denied', code: 'HANDLE_INVALID', reason: '句柄已过期', retryable: false };
  // 5 caveats（先非审批的，再审批）
  const eff: JsonObject = structuredClone(args);
  const approvals: Extract<Caveat, { kind: 'requires-approval' }>[] = [];
  for (const c of h.caveats) {
    switch (c.kind) {
      case 'args.prefix': { const v = get(eff, c.path); if (typeof v !== 'string' || !normPath(v).startsWith(c.prefix)) return { ok: false, kind: 'denied', code: 'CAVEAT_VIOLATION', reason: `${c.path} 必须在 ${c.prefix} 下`, retryable: true }; (eff as any)[c.path] = normPath(v); break; }
      case 'args.max': { const v = get(eff, c.path); if (typeof v === 'number' && v > c.max) return { ok: false, kind: 'denied', code: 'CAVEAT_VIOLATION', reason: `${c.path} 不得超过 ${c.max}`, retryable: true }; break; }
      case 'args.match': { const ok = ajv.validate(c.schema, eff); if (!ok) return { ok: false, kind: 'denied', code: 'CAVEAT_VIOLATION', reason: `args 不满足约束 ${JSON.stringify(c.schema)}`, retryable: true }; break; }
      case 'time.window': { if ((c.notBefore && now < c.notBefore) || (c.notAfter && now >= c.notAfter)) return { ok: false, kind: 'denied', code: 'HANDLE_INVALID', reason: '不在时间窗内', retryable: false }; break; }
      case 'budget': { const used = proj.usage[h.id]?.calls ?? 0; if (c.slice.calls !== undefined && used + 1 > c.slice.calls) return { ok: false, kind: 'denied', code: 'BUDGET_EXCEEDED', reason: `句柄预算 calls=${c.slice.calls} 已用尽`, retryable: false }; break; }
      case 'once': { if ((proj.authorizedCount[h.id] ?? 0) >= 1) return { ok: false, kind: 'denied', code: 'CAVEAT_VIOLATION', reason: '一次性句柄已使用', retryable: false }; break; }
      case 'provider': { if (providerId && providerId !== c.providerId) return { ok: false, kind: 'denied', code: 'CAVEAT_VIOLATION', reason: `只允许实现 ${c.providerId}`, retryable: false }; break; }
      case 'requires-approval': approvals.push(c); break;
      case 'no-delegate': break;
      case 'custom': break;
    }
  }
  const dg = invocationDigest({ id: inv.id, revision: inv.revision, contract: h.contract, args: eff, handleId: h.id }, chain, providerId);
  if (approvals.length) {
    const g = grants.find(x => x.invocationDigest === dg);
    if (!g) return { ok: false, kind: 'needs-approval', digest: dg, approvalId: `apr_${dg.slice(7, 19)}` };
    if (g.expiresAt && now >= g.expiresAt) return { ok: false, kind: 'denied', code: 'APPROVAL_EXPIRED', reason: '批准已过期', retryable: true };
  }
  return { ok: true, effectiveArgs: eff, digest: dg };
}
