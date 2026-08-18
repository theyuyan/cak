/**
 * Authority（04_AUTHORITY_HANDLES.md）：句柄 mint / attenuate / verify（纯函数）/ revoke。
 * - 句柄表是内核私有引用表；HandleId 越界只是不透明键；插件不能构造句柄（proof secret 不导出）。
 * - 句柄表内容可从账本折叠重建（04 §4.1）：rebuildFromProjections()。
 * - 策略只在 mint / attenuate 运行；verify 是纯函数，输入 (handle, chain, args, grants, projections, now)。
 */
import Ajv2020 from 'ajv/dist/2020.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Caveat, ContractRef, HandleId, HandleView, ID, ISODateTime, JsonObject, PrincipalChain, BudgetSlice, ApprovalRequirement } from '../../sdk/types.js';
import type { Projections } from '../ledger/ledger.js';
import { digest } from '../ledger/ledger.js';
import { isSuffix } from '../identity/identity.js';
import { err } from '../errors.js';

const KERNEL = Symbol('cak.kernel.proof');
export interface Handle { readonly id: HandleId; readonly contract: ContractRef; readonly holder: PrincipalChain; readonly parent?: HandleId; readonly caveats: readonly Caveat[]; readonly issuedAt: ISODateTime; readonly expiresAt?: ISODateTime; readonly proof: symbol }
export interface Grant { approvalId: string; invocationDigest: string; expiresAt?: ISODateTime }
export type VerifyResult =
  | { ok: true; effectiveArgs: JsonObject; digest: string; budgetCharge?: BudgetSlice }
  | { ok: false; kind: 'needs-approval'; digest: string; approvalId: string; caveat: Extract<Caveat, { kind: 'requires-approval' }> }
  | { ok: false; kind: 'denied'; code: 'HANDLE_INVALID' | 'CAVEAT_VIOLATION' | 'BUDGET_EXCEEDED' | 'APPROVAL_EXPIRED'; reason: string; retryable: boolean };

const ajv = new Ajv2020({ strict: false });
const getPath = (o: JsonObject, p: string): unknown => p.split('.').reduce<any>((a, k) => (a == null ? undefined : a[k]), o);
const setPath = (o: JsonObject, p: string, v: unknown) => { const ks = p.split('.'); let cur: any = o; for (const k of ks.slice(0, -1)) { if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}; cur = cur[k]; } cur[ks[ks.length - 1]!] = v; };
export const normalizePath = (s: string) => { const n = path.posix.normalize(s.replace(/\\/g, '/')); return n.startsWith('/') ? n : n.replace(/^\.\//, ''); };

/** ApprovalSubjectV1（04 §3）：范围写死；缺省键省略 */
export function invocationDigest(inv: { id: ID; revision: number; contract: ContractRef; args: JsonObject; handleId: HandleId }, chain: PrincipalChain, providerId?: ID): string {
  const subj: Record<string, unknown> = { schemaVersion: 'approval-subject/1', invocation: { id: inv.id, revision: inv.revision, contract: inv.contract, args: inv.args, handleId: inv.handleId }, principalChain: chain };
  if (providerId) subj['provider'] = { providerId };
  return digest(subj);
}

export class Authority {
  private table = new Map<HandleId, Handle>();
  private customCaveats = new Map<string, (params: JsonObject, args: JsonObject, proj: Projections) => { ok: true } | { ok: false; reason: string }>();

  registerCustomCaveat(name: string, fn: (params: JsonObject, args: JsonObject, proj: Projections) => { ok: true } | { ok: false; reason: string }) { this.customCaveats.set(name, fn); }

  /** 从账本折叠重建句柄表（重启用）；内核重新附加 proof */
  rebuildFromProjections(p: Projections) {
    this.table.clear();
    for (const h of Object.values(p.handles)) this.table.set(h.id, { id: h.id, contract: h.contract, holder: h.holder, parent: h.parent, caveats: h.caveats, issuedAt: h.issuedAt, expiresAt: h.expiresAt, proof: KERNEL });
  }
  mint(contract: ContractRef, holder: PrincipalChain, caveats: Caveat[], now: ISODateTime, opts: { expiresAt?: ISODateTime; id?: HandleId } = {}): Handle {
    if (holder.length === 0) throw err('CONFIGURATION_ERROR', 'mint: holder chain must not be empty');
    const h: Handle = { id: opts.id ?? 'h_' + randomUUID().slice(0, 12), contract, holder, caveats: Object.freeze([...caveats]), issuedAt: now, expiresAt: opts.expiresAt, proof: KERNEL };
    this.table.set(h.id, h); return h;
  }
  /** 只能加 caveat；holder 只能变长（更具体）；no-delegate 的父不可再收窄 */
  attenuate(parentId: HandleId, add: Caveat[], newHolder: PrincipalChain | undefined, now: ISODateTime, opts: { id?: HandleId } = {}): Handle {
    const p = this.table.get(parentId);
    if (!p || p.proof !== KERNEL) throw err('HANDLE_INVALID', `attenuate: unknown parent ${parentId}`);
    if (p.caveats.some(c => c.kind === 'no-delegate')) throw err('ATTENUATION_ERROR', 'parent handle is no-delegate');
    const holder = newHolder ?? p.holder;
    if (!isSuffix(holder, p.holder)) throw err('ATTENUATION_ERROR', 'new holder must extend parent holder chain');
    const h: Handle = { id: opts.id ?? 'h_' + randomUUID().slice(0, 12), contract: p.contract, holder, parent: p.id, caveats: Object.freeze([...p.caveats, ...add]), issuedAt: now, expiresAt: p.expiresAt, proof: KERNEL };
    this.table.set(h.id, h); return h;
  }
  has(id: HandleId) { return this.table.has(id); }
  get(id: HandleId): Handle | undefined { const h = this.table.get(id); return h && h.proof === KERNEL ? h : undefined; }
  view(id: HandleId): HandleView | undefined { const h = this.get(id); return h ? { id: h.id, contract: h.contract, caveats: [...h.caveats], ...(h.expiresAt ? { expiresAt: h.expiresAt } : {}), delegable: !h.caveats.some(c => c.kind === 'no-delegate') } : undefined; }
  // ---------------- 跨进程 token 句柄（04 §6，M3）：export = 签名 JCS 载荷；import = 验签后入表（信任决定在 import）
  /** 导出为签名 token：payload = JCS({id,contract,holder,parent?,caveats,issuedAt,expiresAt?,epoch}) ；sig 由 signer 用发行者身份签 */
  exportToken(handleId: HandleId, signer: { sign(payload: unknown, as: import('../../sdk/types.js').Principal): import('../../sdk/types.js').Signature }, issuer: import('../../sdk/types.js').Principal): string {
    const h = this.get(handleId); if (!h) throw err('HANDLE_INVALID', `exportToken: unknown ${handleId}`);
    const payload = { id: h.id, contract: h.contract, holder: h.holder, ...(h.parent ? { parent: h.parent } : {}), caveats: [...h.caveats], issuedAt: h.issuedAt, ...(h.expiresAt ? { expiresAt: h.expiresAt } : {}), epoch: 0, issuer };
    const sig = signer.sign(payload, issuer);
    return Buffer.from(JSON.stringify({ payload, sig }), 'utf8').toString('base64url');
  }
  /** 导入：验签（用可信发行者的 verify）→ 入表（proof=KERNEL；从此本地 verify 照常）；任何不符 → HANDLE_INVALID */
  importToken(token: string, verifier: { verify(payload: unknown, sig: import('../../sdk/types.js').Signature): boolean }, trustedIssuers: Array<import('../../sdk/types.js').Principal>): Handle {
    let parsed: any; try { parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch { throw err('HANDLE_INVALID', 'token: not decodable'); }
    const p = parsed?.payload; const sig = parsed?.sig;
    if (!p || !sig || typeof p.id !== 'string' || !Array.isArray(p.caveats) || !Array.isArray(p.holder) || !p.contract || !p.issuer) throw err('HANDLE_INVALID', 'token: malformed');
    if (!trustedIssuers.some(t => t.kind === p.issuer.kind && t.id === p.issuer.id)) throw err('HANDLE_INVALID', `token: issuer ${p.issuer.kind}:${p.issuer.id} not trusted`);
    if (!verifier.verify(p, sig)) throw err('HANDLE_INVALID', 'token: signature invalid');
    const h: Handle = { id: p.id, contract: p.contract, holder: p.holder, ...(p.parent ? { parent: p.parent } : {}), caveats: Object.freeze([...p.caveats]), issuedAt: p.issuedAt, ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}), proof: KERNEL };
    this.table.set(h.id, h); return h;
  }
  /** 仅测试：模拟插件伪造对象塞进表 —— 必须被 verify 拒绝 */
  _forgeForTest(id: HandleId, h: Omit<Handle, 'proof'>) { this.table.set(id, { ...h, proof: Symbol('forged') }); }

  verify(handleId: HandleId, chain: PrincipalChain, args: JsonObject, inv: { id: ID; revision: number }, grants: Grant[], proj: Projections, now: ISODateTime, providerId?: ID): VerifyResult {
    const h = this.table.get(handleId);
    // 1 真伪
    if (!h || h.proof !== KERNEL) return { ok: false, kind: 'denied', code: 'HANDLE_INVALID', reason: '句柄不存在或非内核铸造', retryable: false };
    // 2 持有者
    if (!isSuffix(chain, h.holder)) return { ok: false, kind: 'denied', code: 'HANDLE_INVALID', reason: '调用方主体链与句柄持有者不匹配', retryable: false };
    // 3 撤销（含祖先）
    for (let cur: Handle | undefined = h; cur; cur = cur.parent ? this.table.get(cur.parent) : undefined) if (proj.revoked[cur.id] !== undefined) return { ok: false, kind: 'denied', code: 'HANDLE_INVALID', reason: `句柄 ${cur.id} 已撤销`, retryable: false };
    // 4 期限
    if (h.expiresAt && now >= h.expiresAt) return { ok: false, kind: 'denied', code: 'HANDLE_INVALID', reason: '句柄已过期', retryable: false };
    // 5 caveats：先全部非审批，再审批
    const eff: JsonObject = structuredClone(args);
    const approvals: Extract<Caveat, { kind: 'requires-approval' }>[] = [];
    let budgetCharge: BudgetSlice | undefined;
    for (const c of h.caveats) {
      switch (c.kind) {
        case 'args.prefix': { const v = getPath(eff, c.path); if (typeof v !== 'string' || !normalizePath(v).startsWith(c.prefix)) return { ok: false, kind: 'denied', code: 'CAVEAT_VIOLATION', reason: `${c.path} 必须在 ${c.prefix} 下（当前 ${typeof v === 'string' ? v : '未提供'}）`, retryable: true }; setPath(eff, c.path, normalizePath(v)); break; }
        case 'args.max': { const v = getPath(eff, c.path); if (typeof v === 'number' && v > c.max) return { ok: false, kind: 'denied', code: 'CAVEAT_VIOLATION', reason: `${c.path} 不得超过 ${c.max}（当前 ${v}）`, retryable: true }; break; }
        case 'args.match': { if (!ajv.validate(c.schema, eff)) return { ok: false, kind: 'denied', code: 'CAVEAT_VIOLATION', reason: `args 不满足约束 ${JSON.stringify(c.schema)}`, retryable: true }; break; }
        case 'time.window': { if ((c.notBefore && now < c.notBefore) || (c.notAfter && now >= c.notAfter)) return { ok: false, kind: 'denied', code: 'HANDLE_INVALID', reason: '不在句柄允许的时间窗内', retryable: false }; break; }
        case 'budget': { const used = proj.usageByHandle[h.id] ?? { calls: 0, inputTokens: 0, outputTokens: 0 }; if (c.slice.calls !== undefined && used.calls + 1 > c.slice.calls) return { ok: false, kind: 'denied', code: 'BUDGET_EXCEEDED', reason: `句柄预算 calls=${c.slice.calls} 已用尽`, retryable: false }; if (c.slice.inputTokens !== undefined && used.inputTokens >= c.slice.inputTokens) return { ok: false, kind: 'denied', code: 'BUDGET_EXCEEDED', reason: `句柄预算 inputTokens=${c.slice.inputTokens} 已用尽`, retryable: false }; budgetCharge = { calls: 1 }; break; }
        case 'once': { if ((proj.authorizedCount[h.id] ?? 0) >= 1) return { ok: false, kind: 'denied', code: 'CAVEAT_VIOLATION', reason: '一次性句柄已使用', retryable: false }; break; }
        case 'provider': { if (providerId && providerId !== c.providerId) return { ok: false, kind: 'denied', code: 'CAVEAT_VIOLATION', reason: `只允许实现 ${c.providerId}`, retryable: false }; break; }
        case 'custom': { const fn = this.customCaveats.get(c.name); if (!fn) return { ok: false, kind: 'denied', code: 'CAVEAT_VIOLATION', reason: `未知自定义 caveat ${c.name}`, retryable: false }; const r = fn(c.params, eff, proj); if (!r.ok) return { ok: false, kind: 'denied', code: 'CAVEAT_VIOLATION', reason: r.reason, retryable: true }; break; }
        case 'requires-approval': approvals.push(c); break;
        case 'no-delegate': break;
      }
    }
    const dg = invocationDigest({ id: inv.id, revision: inv.revision, contract: h.contract, args: eff, handleId: h.id }, chain, providerId);
    if (approvals.length) {
      const g = grants.find(x => x.invocationDigest === dg);
      if (!g) return { ok: false, kind: 'needs-approval', digest: dg, approvalId: 'apr_' + dg.slice(7, 23), caveat: approvals[0]! };
      if (g.expiresAt && now >= g.expiresAt) return { ok: false, kind: 'denied', code: 'APPROVAL_EXPIRED', reason: '批准已过期', retryable: true };
    }
    return { ok: true, effectiveArgs: eff, digest: dg, budgetCharge };
  }
}
export type { ApprovalRequirement };
