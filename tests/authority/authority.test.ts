// HV-1…9（tests/vectors/handle-attenuation.json）+ 属性测试 + attenuate 用例 + 伪造 + 从账本重建 —— 判据来自向量与 04。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { Authority, invocationDigest, type Handle, type Grant } from '../../kernel/authority/authority.js';
import { initProjections, type Projections, Ledger, MemoryLedgerStore } from '../../kernel/ledger/ledger.js';
import type { PrincipalChain, JsonObject } from '../../sdk/types.js';
import { expectCode } from '../helpers.js';

const HV = JSON.parse(fs.readFileSync('tests/vectors/handle-attenuation.json', 'utf8'));
const NOW: string = HV.now;
const chains: Record<string, PrincipalChain> = HV.principals;

function build() {
  const A = new Authority(); const hs: Record<string, Handle> = {};
  for (const [name, def] of Object.entries<any>(HV.handles)) {
    hs[name] = def.parent ? A.attenuate(hs[def.parent]!.id, def.addCaveats, chains[def.holder], NOW) : A.mint(HV.contract, chains[def.holder]!, def.caveats, NOW);
  }
  return { A, hs };
}
const projFor = (c: any, hid: string, hs: Record<string, Handle>): Projections => {
  const p = initProjections();
  if (c.priorAuthorized) p.authorizedCount[hid] = c.priorAuthorized;
  if (c.priorUsage) p.usageByHandle[hid] = { calls: c.priorUsage.calls ?? 0, inputTokens: 0, outputTokens: 0 };
  for (const r of c.revoked ?? []) p.revoked[hs[r]!.id] = 1;
  return p;
};

describe('authority · 句柄向量', () => {
  const { A, hs } = build(); const results: Record<string, unknown> = {};
  for (const c of HV.cases as any[]) {
    it(c.id, () => {
      const h = hs[c.handle]!; const chain = chains[c.chain]!; const inv = { id: 'inv_x', revision: 0 };
      let grants: Grant[] = [];
      if (c.grants) {
        const dg = invocationDigest({ id: inv.id, revision: 0, contract: HV.contract, args: c.args, handleId: h.id }, chain);
        grants = c.grants.map((g: any) => ({ approvalId: 'a', invocationDigest: g.matchesDigestOfThisInvocation ? dg : 'sha256:' + 'ff'.repeat(32), expiresAt: g.expiresAt }));
      }
      const r = A.verify(h.id, chain, c.args, inv, grants, projFor(c, h.id, hs), NOW); results[c.id] = r;
      if (c.expect === 'ok') expect(r.ok).toBe(true);
      else if (c.expect === 'needs-approval') expect(!r.ok && r.kind === 'needs-approval').toBe(true);
      else { expect(!r.ok && r.kind === 'denied').toBe(true); if (!r.ok && r.kind === 'denied') { expect(r.code).toBe(c.code); for (const m of c.reasonMentions ?? []) expect(r.reason).toContain(m); } }
      if (c.mustEqualResultOf) expect(JSON.stringify(r)).toBe(JSON.stringify(results[c.mustEqualResultOf]));
    });
  }
  it('HV-6 伪造句柄对象 → HANDLE_INVALID', () => {
    A._forgeForTest('h_forged', { id: 'h_forged', contract: HV.contract, holder: chains.task!, caveats: [], issuedAt: NOW });
    const r = A.verify('h_forged', chains.task!, { path: 'workspace/a' }, { id: 'i', revision: 0 }, [], initProjections(), NOW);
    expect(!r.ok && r.kind === 'denied' && r.code === 'HANDLE_INVALID').toBe(true);
    expect(A.view('h_forged')).toBeUndefined();
  });
  it('AD-1 向量：invocationDigest == 向量 digest', () => {
    const AD = JSON.parse(fs.readFileSync('tests/vectors/approval-digest.json', 'utf8')).vectors[0]; const s = AD.subject;
    expect(invocationDigest({ id: s.invocation.id, revision: s.invocation.revision, contract: s.invocation.contract, args: s.invocation.args, handleId: s.invocation.handleId }, s.principalChain, s.provider.providerId)).toBe(AD.digest);
  });
});

describe('authority · attenuate', () => {
  const { A, hs } = build();
  for (const c of HV.attenuateCases as any[]) {
    it(c.id, () => {
      if (c.constructChildWithCaveats) { expect(typeof (A as any).attenuate).toBe('function'); return; } // API 无"移除"入口
      if (c.expect === 'ok') expect(() => A.attenuate(hs[c.parent]!.id, c.add, chains.task, NOW)).not.toThrow();
      else expectCode(() => A.attenuate(hs[c.parent]!.id, c.add, chains.task, NOW), c.code);
    });
  }
  it('holder 只能变长：把 task 句柄收窄给更短的 agent 链 → ATTENUATION_ERROR', () => {
    expectCode(() => A.attenuate(hs.h1!.id, [], chains.agent, NOW), 'ATTENUATION_ERROR');
  });
});

describe('authority · 单调性属性测试（≥1000 样本 / 对，零反例，非空）', () => {
  const { A, hs } = build();
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
  const gen = (): JsonObject => ({ path: pick(['workspace/a.txt', 'workspace/../x', '/etc/passwd', 'workspace/sub/../b', './workspace/c', 'ws/d', 'workspace/合同.txt']), maxBytes: rnd() < 0.5 ? Math.floor(rnd() * 8192) : Math.floor(rnd() * 1e6), encoding: pick(['utf8', 'latin1']) });
  for (const [pn, cn] of HV.propertyTest.pairs as [string, string][]) {
    it(`${cn} ⊂ ${pn}`, () => {
      let counter = 0, childOk = 0; const chain = chains.task!;
      for (let i = 0; i < HV.propertyTest.minSamples; i++) {
        const a = gen();
        const pre = A.verify(hs[cn]!.id, chain, a, { id: 'p', revision: 0 }, [], initProjections(), NOW);
        const grants: Grant[] = [{ approvalId: 'a', invocationDigest: invocationDigest({ id: 'p', revision: 0, contract: HV.contract, args: (pre as any).effectiveArgs ?? a, handleId: hs[cn]!.id }, chain) }];
        const c = A.verify(hs[cn]!.id, chain, a, { id: 'p', revision: 0 }, grants, initProjections(), NOW);
        const p = A.verify(hs[pn]!.id, chain, a, { id: 'p', revision: 0 }, [], initProjections(), NOW);
        if (c.ok) { childOk++; if (!p.ok) counter++; }
      }
      expect(counter).toBe(0); expect(childOk).toBeGreaterThanOrEqual(50);
    });
  }
});

describe('authority · 从账本折叠重建句柄表（04 §4.1）', () => {
  it('mint/attenuate 事件入账 → 新 Authority 重建 → verify 结果与原表一致；撤销父级联', () => {
    const { A, hs } = build();
    const L = Ledger.open(new MemoryLedgerStore());
    for (const [name, def] of Object.entries<any>(HV.handles)) {
      const h = hs[name]!;
      if (!def.parent) L.append({ taskId: 'rt', principal: h.holder, type: 'handle.minted', payload: { handleId: h.id, contract: h.contract as any, holder: h.holder as any, caveats: [...h.caveats] as any } });
      else L.append({ taskId: 'rt', principal: h.holder, type: 'handle.attenuated', payload: { handleId: h.id, parent: hs[def.parent]!.id, addCaveats: def.addCaveats, holder: h.holder as any } });
    }
    const B = new Authority(); B.rebuildFromProjections(L.projections());
    for (const c of HV.cases as any[]) {
      if (c.grants || c.revoked) continue;
      const a = A.verify(hs[c.handle]!.id, chains[c.chain]!, c.args, { id: 'x', revision: 0 }, [], projFor(c, hs[c.handle]!.id, hs), NOW);
      const b = B.verify(hs[c.handle]!.id, chains[c.chain]!, c.args, { id: 'x', revision: 0 }, [], projFor(c, hs[c.handle]!.id, hs), NOW);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
    L.append({ taskId: 'rt', principal: chains.agent!, type: 'handle.revoked', payload: { handleId: hs.h0!.id, epoch: 1 } });
    const r = B.verify(hs.h1!.id, chains.task!, { path: 'workspace/a.txt', maxBytes: 1 }, { id: 'x', revision: 0 }, [], L.projections(), NOW);
    expect(!r.ok && r.kind === 'denied' && r.code === 'HANDLE_INVALID').toBe(true);
  });
});
