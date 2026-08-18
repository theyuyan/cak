// LG-1…6（05_LEDGER.md §8）+ 向量 tests/vectors/ledger-chain.json —— 判据来自设计包与向量，不来自实现。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { expectCode } from '../helpers.js';
import { Ledger, FileLedgerStore, MemoryLedgerStore, fold, eventHash, digest, ZERO_HASH, verifyReceipt, type LedgerEvent } from '../../kernel/ledger/ledger.js';

const V = JSON.parse(fs.readFileSync('tests/vectors/ledger-chain.json', 'utf8'));
const AD = JSON.parse(fs.readFileSync('tests/vectors/approval-digest.json', 'utf8'));
const chain = V.events[0].principal;

describe('ledger · 向量', () => {
  it('eventHash 与向量逐条一致，head 一致', () => {
    let prev = ZERO_HASH;
    for (const e of V.events) { expect(e.prevHash).toBe(prev); expect(eventHash(e)).toBe(e.hash); prev = e.hash; }
    expect(prev).toBe(V.headHash);
  });
  it('digest 与审批摘要向量 AD-1…AD-6 一致（含键序 / 省略键 / 浮点）', () => {
    for (const v of AD.vectors) expect(digest(v.subject)).toBe(v.digest);
  });
  it('append 产生与向量相同的链（同 ts / payload）', () => {
    const L = Ledger.open(new MemoryLedgerStore());
    for (const e of V.events) L.append({ ts: e.ts, taskId: e.taskId, principal: e.principal, type: e.type, payload: e.payload });
    expect(L.all().map(e => e.hash)).toEqual(V.events.map((e: LedgerEvent) => e.hash));
  });
});

describe('ledger · LG-1…6', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cak-ledger-')), 'ledger.ndjson');
  it('LG-1 篡改任一 payload → 重开 LEDGER_CORRUPT', () => {
    const f = tmp(); const L = Ledger.open(new FileLedgerStore(f));
    for (const e of V.events) L.append({ ts: e.ts, taskId: e.taskId, principal: chain, type: e.type, payload: e.payload });
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); const bad = JSON.parse(lines[2]!); bad.payload.args.path = 'workspace/y.txt'; lines[2] = JSON.stringify(bad);
    fs.writeFileSync(f, lines.join('\n') + '\n');
    expectCode(() => Ledger.open(new FileLedgerStore(f)), 'LEDGER_CORRUPT');
  });
  it('LG-2 同一事件序列两次折叠 → 投影字节级相同', () => {
    const a = fold(V.events), b = fold(V.events);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a.handles)).toEqual(['h_00', 'h_01']);
    expect(a.handles['h_01']!.caveats).toHaveLength(2);      // 父 1 + 子 1
    expect(a.invocations['inv_01']!.status).toBe('authorized');
    expect(a.authorizedCount['h_01']).toBe(1);
  });
  it('LG-3 快照 + 重放 = 全量重放（深比较），且快照可丢', () => {
    const f = tmp(); let L = Ledger.open(new FileLedgerStore(f));
    L.append({ ts: V.events[0].ts, taskId: 't_01', principal: chain, type: 'handle.minted', payload: V.events[0].payload });
    L.snapshot();
    L.append({ ts: V.events[1].ts, taskId: 't_01', principal: chain, type: 'handle.attenuated', payload: V.events[1].payload });
    const withSnap = Ledger.open(new FileLedgerStore(f)).projections();
    fs.unlinkSync(f + '.snapshot.json');
    const noSnap = Ledger.open(new FileLedgerStore(f)).projections();
    expect(JSON.stringify(withSnap)).toBe(JSON.stringify(noSnap));
    expect(JSON.stringify(withSnap)).toBe(JSON.stringify(fold(Ledger.open(new FileLedgerStore(f)).all())));
  });
  it('LG-3b 快照 atHash 不符 → 忽略快照全量重放（不崩）', () => {
    const f = tmp(); const store = new FileLedgerStore(f); const L = Ledger.open(store);
    L.append({ taskId: 't', principal: chain, type: 'task.spawned', payload: { taskId: 't', goal: 'g', handles: [] } });
    const s = L.snapshot(); s.atHash = 'sha256:' + 'ee'.repeat(32); store.saveSnapshot(s);
    expect(Ledger.open(new FileLedgerStore(f)).projections().tasks['t']?.status).toBe('running');
  });
  it('LG-4 崩溃恢复：awaiting 状态重开 → pending 仍在；grant → authorized 后 executed 恰好一次', () => {
    const f = tmp(); let L = Ledger.open(new FileLedgerStore(f));
    L.append(
      { taskId: 't', principal: chain, type: 'handle.minted', payload: V.events[0].payload },
      { taskId: 't', principal: chain, type: 'task.spawned', payload: { taskId: 't', goal: 'g', handles: ['h_00'] } },
      { taskId: 't', principal: chain, type: 'invocation.requested', payload: { invocationId: 'i1', handleId: 'h_00', contract: V.events[0].payload.contract, args: { path: 'workspace/a' }, revision: 0 } },
      { taskId: 't', principal: chain, type: 'invocation.awaiting', payload: { invocationId: 'i1', revision: 0, digest: 'sha256:' + 'aa'.repeat(32), approvalId: 'ap1' } },
      { taskId: 't', principal: chain, type: 'task.suspended', payload: { reason: 'approval' } });
    L = Ledger.open(new FileLedgerStore(f)); // "重启"
    expect(L.projections().tasks['t']?.status).toBe('suspended');
    expect(L.projections().pendingApprovals['i1']?.approvalId).toBe('ap1');
    L.append(
      { taskId: 't', principal: chain, type: 'grant.issued', payload: { approvalId: 'ap1', invocationDigest: 'sha256:' + 'aa'.repeat(32), grantedBy: { kind: 'user', id: 'u' } } },
      { taskId: 't', principal: chain, type: 'invocation.authorized', payload: { invocationId: 'i1', revision: 0, digest: 'sha256:' + 'aa'.repeat(32), effectiveArgs: { path: 'workspace/a' }, providerId: 'p', approvalId: 'ap1' } },
      { taskId: 't', principal: chain, type: 'invocation.executed', payload: { invocationId: 'i1', resultDigest: digest({ ok: 1 }), usage: { units: { calls: 1 } } } });
    const p = L.projections();
    expect(p.pendingApprovals['i1']).toBeUndefined();
    expect(p.invocations['i1']?.status).toBe('executed');
    expect(L.all().filter(e => e.type === 'invocation.executed').length).toBe(1);
  });
  it('LG-5 回执：验证通过；篡改任一事件 → 失败', () => {
    const L = Ledger.open(new MemoryLedgerStore());
    for (const e of V.events) L.append({ ts: e.ts, taskId: e.taskId, principal: chain, type: e.type, payload: e.payload });
    const r = L.receipt('inv_01', 'k');
    expect(r.events.length).toBe(2);
    expect(verifyReceipt(r, 'k')).toBe(true);
    expect(verifyReceipt(r, 'wrong')).toBe(false);
    const t = structuredClone(r); (t.events[0]!.payload as any).args = { path: 'x' };
    expect(verifyReceipt(t, 'k')).toBe(false);
  });
  it('LG-6 usage 求和 = 预算扣减量（按句柄与按 task）', () => {
    const L = Ledger.open(new MemoryLedgerStore());
    L.append({ taskId: 't', principal: chain, type: 'handle.minted', payload: V.events[0].payload },
      { taskId: 't', principal: chain, type: 'invocation.requested', payload: { invocationId: 'a', handleId: 'h_00', contract: V.events[0].payload.contract, args: {}, revision: 0 } },
      { taskId: 't', principal: chain, type: 'invocation.executed', payload: { invocationId: 'a', resultDigest: ZERO_HASH, usage: { units: { inputTokens: 10, outputTokens: 5 } } } },
      { taskId: 't', principal: chain, type: 'invocation.requested', payload: { invocationId: 'b', handleId: 'h_00', contract: V.events[0].payload.contract, args: {}, revision: 0 } },
      { taskId: 't', principal: chain, type: 'invocation.executed', payload: { invocationId: 'b', resultDigest: ZERO_HASH, usage: { units: { inputTokens: 1, outputTokens: 1 } } } });
    expect(L.projections().usageByHandle['h_00']).toEqual({ calls: 2, inputTokens: 11, outputTokens: 6 });
    expect(L.projections().usageByTask['t']).toEqual({ calls: 2, inputTokens: 11, outputTokens: 6 });
  });
  it('观察者抛错不影响主链', () => {
    const L = Ledger.open(new MemoryLedgerStore());
    L.subscribe({ id: 'bad', onEvent() { throw new Error('boom'); } });
    expect(() => L.append({ taskId: 't', principal: chain, type: 'runtime.started', payload: {} })).not.toThrow();
    expect(L.head().seq).toBe(1);
  });
});
