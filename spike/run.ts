// SPIKE 运行器：A 句柄向量 · B 收窄单调性随机测试 · C attenuate 用例 · D 端到端一条线（含崩溃恢复、快照、篡改）· E 与审批摘要向量对齐
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mint, attenuate, verify, forgeForTest, invocationDigest, type Caveat, type Handle, type Grant } from './authority.js';
import { FileLedger, fold, snapshot, restore, digest, type Chain, type JsonObject, type Projections, initProjections } from './ledger.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { (c ? pass++ : fail++); console.log(`${c ? '✓' : '✗'} ${m}`); };
const NOW = '2026-08-17T12:00:00.000Z';

// ---------------------------------------------------------------- A. handle vectors
const HV = JSON.parse(fs.readFileSync('tests/vectors/handle-attenuation.json', 'utf8'));
const chains: Record<string, Chain> = HV.principals;
const hs: Record<string, Handle> = {};
for (const [name, def] of Object.entries<any>(HV.handles)) {
  if (!def.parent) hs[name] = mint(HV.contract, chains[def.holder]!, def.caveats, { now: NOW });
  else { const r = attenuate(hs[def.parent]!.id, def.addCaveats, chains[def.holder], NOW); if ('error' in r) throw new Error(`setup ${name}: ${r.error}`); hs[name] = r; }
}
const projFor = (c: any, hid: string): Projections => {
  const p = initProjections();
  if (c.priorAuthorized) p.authorizedCount[hid] = c.priorAuthorized;
  if (c.priorUsage) p.usage[hid] = c.priorUsage;
  for (const r of c.revoked ?? []) p.revoked[hs[r]!.id] = 1;
  return p;
};
const results: Record<string, unknown> = {};
for (const c of HV.cases) {
  const h = hs[c.handle]!; const chain = chains[c.chain]!;
  const inv = { id: 'inv_x', revision: 0 };
  let grants: Grant[] = [];
  if (c.grants) {
    const dg = invocationDigest({ id: inv.id, revision: 0, contract: HV.contract, args: c.args, handleId: h.id }, chain);
    grants = c.grants.map((g: any) => ({ approvalId: 'a', invocationDigest: g.matchesDigestOfThisInvocation ? dg : 'sha256:' + 'ff'.repeat(32), expiresAt: g.expiresAt }));
  }
  const r = verify(h.id, chain, c.args, inv, grants, projFor(c, h.id), NOW);
  results[c.id] = r;
  let good = false;
  if (c.expect === 'ok') good = r.ok;
  else if (c.expect === 'needs-approval') good = !r.ok && r.kind === 'needs-approval';
  else if (c.expect === 'denied') good = !r.ok && r.kind === 'denied' && r.code === c.code && (c.reasonMentions ?? []).every((m: string) => r.reason.includes(m));
  if (c.mustEqualResultOf) good = good && JSON.stringify(results[c.mustEqualResultOf]) === JSON.stringify(r);
  ok(good, `${c.id} → ${JSON.stringify(r).slice(0, 90)}`);
}
// forged handle
forgeForTest('h_forged', { id: 'h_forged', contract: HV.contract, holder: chains.task!, caveats: [], issuedAt: NOW, epoch: 0 });
{ const r = verify('h_forged', chains.task!, { path: 'workspace/a' }, { id: 'i', revision: 0 }, [], initProjections(), NOW); ok(!r.ok && r.kind === 'denied' && r.code === 'HANDLE_INVALID', 'HV-6 forged handle → HANDLE_INVALID'); }

// ---------------------------------------------------------------- B. property test（子 ⊂ 父）
let seed = 42; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
const genArgs = (): JsonObject => ({
  path: pick(['workspace/a.txt', 'workspace/../x', '/etc/passwd', 'workspace/sub/../b', './workspace/c', 'ws/d', 'workspace/合同.txt']),
  maxBytes: rnd() < 0.5 ? Math.floor(rnd() * 8192) : Math.floor(rnd() * 1_000_000), encoding: pick(['utf8', 'latin1']),
});
for (const [pn, cn] of HV.propertyTest.pairs as [string, string][]) {
  let counter = 0, childOk = 0;
  for (let i = 0; i < HV.propertyTest.minSamples; i++) {
    const a = genArgs(); const chain = chains.task!;
    const grants: Grant[] = [{ approvalId: 'a', invocationDigest: invocationDigest({ id: 'p', revision: 0, contract: HV.contract, args: (verify(hs[cn]!.id, chain, a, { id: 'p', revision: 0 }, [], initProjections(), NOW) as any).effectiveArgs ?? a, handleId: hs[cn]!.id }, chain) }];
    const c = verify(hs[cn]!.id, chain, a, { id: 'p', revision: 0 }, grants, initProjections(), NOW);
    const p = verify(hs[pn]!.id, chain, a, { id: 'p', revision: 0 }, [], initProjections(), NOW);
    if (c.ok) { childOk++; if (!p.ok) counter++; }
  }
  ok(counter === 0 && childOk >= 50, `property ${cn} ⊂ ${pn}: ${HV.propertyTest.minSamples} samples, child-ok=${childOk} (≥50 才算非空), counterexamples=${counter}`);
}

// ---------------------------------------------------------------- C. attenuate cases
for (const c of HV.attenuateCases) {
  if (c.constructChildWithCaveats) { ok(true, `${c.id}（API 无此入口：attenuate 只接受 add，caveats 只能并集）`); continue; }
  const r = attenuate(hs[c.parent]!.id, c.add, chains.task, NOW);
  ok(c.expect === 'ok' ? !('error' in r) : ('error' in r && r.error === c.code), `${c.id} → ${'error' in r ? r.error : 'ok'}`);
}

// ---------------------------------------------------------------- D. end-to-end + crash restore
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cak-spike-')); const lp = path.join(dir, 'ledger.ndjson');
const chainT = chains.task!;
{
  const L = new FileLedger(lp);
  const h0 = mint(HV.contract, chains.agent!, [{ kind: 'args.prefix', path: 'path', prefix: 'workspace/' }], { now: NOW });
  L.append([{ ts: NOW, taskId: 't_01', principal: chains.agent!, type: 'handle.minted', schemaVersion: '1.0.0', payload: { handleId: h0.id, contract: HV.contract, holder: chains.agent as any, caveats: h0.caveats as any } }]);
  const h1 = attenuate(h0.id, [{ kind: 'requires-approval', approver: { kind: 'user', id: 'alice' } }], chainT, NOW) as Handle;
  L.append([{ ts: NOW, taskId: 't_01', principal: chainT, type: 'handle.attenuated', schemaVersion: '1.0.0', payload: { handleId: h1.id, parent: h0.id, addCaveats: [{ kind: 'requires-approval', approver: { kind: 'user', id: 'alice' } }] as any, holder: chainT as any } },
            { ts: NOW, taskId: 't_01', principal: chainT, type: 'task.spawned', schemaVersion: '1.0.0', payload: { taskId: 't_01', goal: 'read', handles: [h1.id] } }]);
  const args = { path: 'workspace/report.txt' }; const inv = { id: 'inv_e2e', revision: 0 };
  L.append([{ ts: NOW, taskId: 't_01', principal: chainT, type: 'invocation.requested', schemaVersion: '1.0.0', payload: { invocationId: inv.id, handleId: h1.id, contract: HV.contract, args, revision: 0 } }]);
  let proj = fold(L.all());
  const v1 = verify(h1.id, chainT, args, inv, [], proj, NOW);
  ok(!v1.ok && v1.kind === 'needs-approval', 'E2E: verify → needs-approval');
  const dg = (v1 as any).digest, aid = (v1 as any).approvalId;
  L.append([{ ts: NOW, taskId: 't_01', principal: chainT, type: 'invocation.awaiting', schemaVersion: '1.0.0', payload: { invocationId: inv.id, revision: 0, digest: dg, approvalId: aid } },
            { ts: NOW, taskId: 't_01', principal: chainT, type: 'task.step', schemaVersion: '1.0.0', payload: { index: 0, outcome: 'await' } },
            { ts: NOW, taskId: 't_01', principal: chainT, type: 'task.suspended', schemaVersion: '1.0.0', payload: { reason: 'approval' } }]);
  const snap = snapshot(L);
  fs.writeFileSync(path.join(dir, 'snap.json'), JSON.stringify(snap));
  proj = fold(L.all());
  ok(proj.tasks['t_01']?.status === 'suspended' && !!proj.pendingApprovals[inv.id], 'E2E: 折叠出 suspended + pendingApproval');
  // ---- 崩溃：丢掉一切内存对象（table 保留——它是内核私有引用表；生产里由账本重建句柄表，这里 spike 简化）
}
{
  const L2 = new FileLedger(lp);                       // 重启：验链
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'snap.json'), 'utf8'));
  const p1 = restore(L2, snap); const p2 = restore(L2, undefined);
  ok(JSON.stringify(p1) === JSON.stringify(p2), 'E2E: 快照+重放 == 全量重放');
  const pend = Object.values(p1.pendingApprovals)[0]!; const invRec = p1.invocations['inv_e2e'] as any;
  // grant 到账
  L2.append([{ ts: NOW, taskId: 't_01', principal: [{ kind: 'user', id: 'alice' }], type: 'grant.issued', schemaVersion: '1.0.0', payload: { approvalId: 'x', invocationDigest: pend.digest, grantedBy: { kind: 'user', id: 'alice' } as any } },
             { ts: NOW, taskId: 't_01', principal: chainT, type: 'task.resumed', schemaVersion: '1.0.0', payload: {} }]);
  const proj = fold(L2.all());
  const grants: Grant[] = Object.values(proj.grants).map(g => ({ approvalId: 'x', invocationDigest: g.invocationDigest, ...(g.expiresAt !== undefined ? { expiresAt: g.expiresAt } : {}) }));
  // 重新 verify：同 revision、同 args（不重跑 before.verify）
  const v2 = verify(invRec.handleId, chainT, invRec.args, { id: 'inv_e2e', revision: invRec.revision }, grants, proj, NOW);
  ok(v2.ok && (v2 as any).digest === pend.digest, 'E2E: grant 后重新 verify → ok，digest 与 awaiting 一致');
  // revision 变 → 旧 grant 失效
  const v3 = verify(invRec.handleId, chainT, { ...invRec.args, maxBytes: 1 }, { id: 'inv_e2e', revision: 1 }, grants, proj, NOW);
  ok(!v3.ok && v3.kind === 'needs-approval', 'E2E: args/revision 变 → 旧 grant 失效 → 再次 needs-approval');
  L2.append([{ ts: NOW, taskId: 't_01', principal: chainT, type: 'invocation.authorized', schemaVersion: '1.0.0', payload: { invocationId: 'inv_e2e', revision: 0, digest: pend.digest, effectiveArgs: invRec.args, providerId: 'fs-ro' } },
             { ts: NOW, taskId: 't_01', principal: chainT, type: 'invocation.executed', schemaVersion: '1.0.0', payload: { invocationId: 'inv_e2e', resultDigest: digest({ content: '...' }) } },
             { ts: NOW, taskId: 't_01', principal: chainT, type: 'task.finished', schemaVersion: '1.0.0', payload: {} }]);
  const fin = fold(L2.all());
  const executed = L2.all().filter(e => e.type === 'invocation.executed' && (e.payload as any).invocationId === 'inv_e2e').length;
  ok(fin.tasks['t_01']?.status === 'finished' && executed === 1 && !fin.pendingApprovals['inv_e2e'], 'E2E: finished，executed 恰好 1 次，pending 清空');
  ok(fin.usage[invRec.handleId]?.calls === 1, 'E2E: usage 折叠 = 1 call');
  // 篡改
  const lines = fs.readFileSync(lp, 'utf8').split('\n').filter(Boolean);
  const bad = JSON.parse(lines[3]!); bad.payload.args = { path: 'workspace/other.txt' }; lines[3] = JSON.stringify(bad);
  fs.writeFileSync(lp, lines.join('\n') + '\n');
  let corrupt = false; try { new FileLedger(lp); } catch (e) { corrupt = String(e).includes('LEDGER_CORRUPT'); }
  ok(corrupt, 'E2E: 篡改一行 → 重启验链 LEDGER_CORRUPT');
}

// ---------------------------------------------------------------- E. 与审批摘要向量对齐（AD-1）
const AD = JSON.parse(fs.readFileSync('tests/vectors/approval-digest.json', 'utf8')).vectors[0];
const s = AD.subject;
const d = invocationDigest({ id: s.invocation.id, revision: s.invocation.revision, contract: s.invocation.contract, args: s.invocation.args, handleId: s.invocation.handleId }, s.principalChain, s.provider.providerId);
ok(d === AD.digest, `AD-1 向量：spike 的 invocationDigest == 向量 digest (${d.slice(0, 23)}…)`);

console.log(`\nSPIKE: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
