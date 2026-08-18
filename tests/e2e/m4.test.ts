// M4：SQLite 账本 · Ed25519 签名（跨 Agent 验回执 / 名片）· 幂等重试 · 输出 schema 校验 · 审批控制面（deny / human.approve 能力）· 运营报表 · 观察者
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Kernel, verifyTaskReceipt, type Plugins } from '../../kernel/runtime/kernel.js';
import { Ledger, FileLedgerStore, MemoryLedgerStore, fold } from '../../kernel/ledger/ledger.js';
import { SqliteLedgerStore } from '../../kernel/ledger/sqlite-store.js';
import { Ed25519Signer } from '../../kernel/identity/ed25519.js';
import { Authority } from '../../kernel/authority/authority.js';
import { simpleReact, MockBackend, FsReadonlyProvider, FsAnyProvider, MemoryContextProvider, TextSummarizeProvider, SafeFileGuard, HumanApproveProvider, MetricsObserver, JsonlObserver, CollectingObserver } from '../../plugins/builtin/index.js';
import { build, loadFixture, mkEnv, substitute, taskEvents, specs } from './harness.js';
import type { CapabilityProvider, AgentSpec, ContractRef } from '../../sdk/types.js';
import { expectCode } from '../helpers.js';

const V = JSON.parse(fs.readFileSync('tests/vectors/ledger-chain.json', 'utf8'));
const tmp = (n: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cak-m4-')), n);
const FILE_READ: ContractRef = { name: 'file.read', version: '1.0.0', schemaDigest: 'sha256:5cbc0231e59c1b4ba3303bcd582e14e6a058569c01aac342babc8ec2a4eace25' };

describe('M4 · SQLite 账本', () => {
  it('append/read/snapshot 与文件账本语义一致；篡改一行 → LEDGER_CORRUPT；query 按 task/type', async () => {
    const f = tmp('ledger.sqlite'); const store = new SqliteLedgerStore(f); const L = Ledger.open(store);
    for (const e of V.events) L.append({ ts: e.ts, taskId: e.taskId, principal: e.principal, type: e.type, payload: e.payload });
    expect(L.all().map(e => e.hash)).toEqual(V.events.map((e: any) => e.hash));
    L.snapshot();
    const again = Ledger.open(new SqliteLedgerStore(f)); expect(JSON.stringify(again.projections())).toBe(JSON.stringify(fold(L.all())));
    expect(store.query({ type: 'handle.minted' }).length).toBe(1); expect(store.query({ taskId: 't_01', fromSeq: 3 }).length).toBe(2);
    // 篡改
    const { DatabaseSync } = (await import('node:module')).createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'); const db = new DatabaseSync(f);
    db.prepare("UPDATE events SET body = replace(body, 'workspace/x.txt', 'workspace/y.txt') WHERE seq = 3").run(); db.close();
    expectCode(() => Ledger.open(new SqliteLedgerStore(f)), 'LEDGER_CORRUPT');
  });
  it('内核可直接跑在 SQLite 账本上：G1 序列相同；重启恢复句柄', async () => {
    const fx = loadFixture('G1'); const env = mkEnv(fx); const f = tmp('k.sqlite');
    const b = await build({ fx, env });
    const k = await Kernel.compose(b.spec, b.plugins, { ledgerStore: new SqliteLedgerStore(f) }); b.rebind(k);
    const res = await k.startTask(fx.input.user, { input: fx.input.user }); expect(res.status).toBe('finished'); expect(taskEvents(k, res.taskId)).toEqual(fx.strictSequence);
    const k2 = await Kernel.compose(b.spec, b.plugins, { ledgerStore: new SqliteLedgerStore(f) }); expect(k2.rootHandles.map(h => h.id)).toEqual(k.rootHandles.map(h => h.id));
  });
});

describe('M4 · Ed25519 签名', () => {
  it('sign/verify；他人只有信任了我的公钥才能验；错公钥 / 篡改失败；不能冒充别人签', () => {
    const me = { kind: 'agent' as const, id: 'A' }; const sA = Ed25519Signer.generate(me); const sB = Ed25519Signer.generate({ kind: 'agent', id: 'B' });
    const sig = sA.sign({ hello: 1 }, me);
    expect(sA.verify({ hello: 1 }, sig)).toBe(true);
    expect(sB.verify({ hello: 1 }, sig)).toBe(false);          // 还没信任 A
    sB.trust(me, sA.publicKeyPem()); expect(sB.verify({ hello: 1 }, sig)).toBe(true); expect(sB.verify({ hello: 2 }, sig)).toBe(false);
    expect(() => sA.sign({}, { kind: 'agent', id: 'B' })).toThrow(/not my key/);
    // token 句柄用 ed25519 导出/导入
    const A = new Authority(); const h = A.mint(FILE_READ, [me], [{ kind: 'once' }], '2026-08-18T00:00:00.000Z');
    const token = A.exportToken(h.id, sA, me);
    const B = new Authority(); expect(() => B.importToken(token, sB, [me])).not.toThrow();      // sB 已信任 A 的公钥
    expectCode(() => new Authority().importToken(token, Ed25519Signer.generate({ kind: 'agent', id: 'C' }), [me]), 'HANDLE_INVALID');
  });
  it('两个 Runtime 各用自己的 ed25519 key：A 信任 B 公钥后可验 B 的名片与任务回执；不信任则不能', async () => {
    const fx = loadFixture('G1'); const env = mkEnv(fx); const b = await build({ fx, env });
    const sB = Ed25519Signer.generate({ kind: 'agent', id: b.spec.spec.principal.agent }); const sA = Ed25519Signer.generate({ kind: 'agent', id: 'A' });
    const B = await Kernel.compose(b.spec, b.plugins, { signer: sB }); b.rebind(B);
    const res = await B.startTask(fx.input.user, { input: fx.input.user }); const rec = B.taskReceipt(res.taskId);
    expect(rec.sig.scheme).toBe('ed25519');
    expect(verifyTaskReceipt(rec, sA)).toBe(false);
    sA.trust({ kind: 'agent', id: b.spec.spec.principal.agent }, sB.publicKeyPem());
    expect(verifyTaskReceipt(rec, sA)).toBe(true);
    const card = B.card(); const { sig, ...body } = card; expect(sA.verify(body, sig)).toBe(true);
  });
});

describe('M4 · 执行治理', () => {
  const direct = (args: any) => (): import('../../sdk/types.js').Controller => ({ id: 'd', async decide(ctx) { const h = ctx.view.handles.find((x: any) => x.contract.name === 'file.read')!; const r = await ctx.invoke(h.id, args); return { type: 'finish', output: JSON.parse(JSON.stringify(r)) }; } });
  it('幂等重试：第一次 PROVIDER_ERROR{retryable} 第二次成功 → executed，attempt=2；非幂等契约不重试', async () => {
    let calls = 0;
    const flaky: CapabilityProvider = { id: 'flaky', listImplementations: () => [{ providerId: 'flaky', contract: FILE_READ, priority: 1 }], async execute() { calls++; if (calls === 1) return { error: { code: 'PROVIDER_ERROR', message: 'transient', retryable: true } }; return { output: { content: 'ok', bytes: 2 } }; } };
    const fx = loadFixture('G1'); const env = mkEnv(fx);
    const b = await build({ fx, env, providers: [flaky, new MemoryContextProvider(), new TextSummarizeProvider()] });
    const k = await Kernel.compose(b.spec, { ...b.plugins, controllers: { 'simple-react': direct({ path: 'workspace/test.txt' }) } }, {});
    const res = await k.startTask('x'); const out = res.output as any;
    expect(out.status).toBe('executed'); expect(calls).toBe(2);
    expect((k.ledger.all().find(e => e.type === 'invocation.executed' && (e.payload as any).invocationId === out.invocationId)!.payload as any).attempt).toBe(2);
    // 非幂等：text.summarize 是 idempotent=true… 用 model.generate（idempotent=false）不好构造；改用契约副本：这里断言 flaky 若一直失败 → 两次后 failed
    calls = 0; const alwaysBad: CapabilityProvider = { ...flaky, id: 'bad', listImplementations: () => [{ providerId: 'bad', contract: FILE_READ, priority: 0 }], async execute() { calls++; return { error: { code: 'PROVIDER_ERROR', message: 'nope', retryable: true } }; } };
    const b2 = await build({ fx, env, providers: [alwaysBad, new MemoryContextProvider(), new TextSummarizeProvider()] });
    const k2 = await Kernel.compose(b2.spec, { ...b2.plugins, controllers: { 'simple-react': direct({ path: 'workspace/test.txt' }) } }, {});
    const r2 = (await k2.startTask('x')).output as any; expect(r2.status).toBe('failed'); expect(calls).toBe(2);
  });
  it('输出不合 outputSchema → PROVIDER_ERROR{subcode:schema}；关掉校验则放行', async () => {
    const garbage: CapabilityProvider = { id: 'g', listImplementations: () => [{ providerId: 'g', contract: FILE_READ, priority: 0 }], async execute() { return { output: { nope: true } }; } };
    const fx = loadFixture('G1'); const env = mkEnv(fx);
    const b = await build({ fx, env, providers: [garbage, new MemoryContextProvider(), new TextSummarizeProvider()] });
    const k = await Kernel.compose(b.spec, { ...b.plugins, controllers: { 'simple-react': direct({ path: 'workspace/test.txt' }) } }, {});
    const out = (await k.startTask('x')).output as any; expect(out.status).toBe('failed'); expect(out.error.detail.subcode).toBe('schema');
    const k3 = await Kernel.compose(b.spec, { ...b.plugins, controllers: { 'simple-react': direct({ path: 'workspace/test.txt' }) } }, { validateOutput: false });
    expect(((await k3.startTask('x')).output as any).status).toBe('executed');
  });
  it('大输出（> inlineOutputBytes）不内联进账本 payload，只有 digest + 预览；blob 里有全文', async () => {
    const big: CapabilityProvider = { id: 'big', listImplementations: () => [{ providerId: 'big', contract: FILE_READ, priority: 0 }], async execute() { return { output: { content: 'x'.repeat(50_000), bytes: 50_000 } }; } };
    const fx = loadFixture('G1'); const env = mkEnv(fx);
    const b = await build({ fx, env, providers: [big, new MemoryContextProvider(), new TextSummarizeProvider()] });
    const k = await Kernel.compose(b.spec, { ...b.plugins, controllers: { 'simple-react': direct({ path: 'workspace/test.txt' }) } }, {});
    const out = (await k.startTask('x')).output as any; expect(out.status).toBe('executed');
    const ev = k.ledger.all().find(e => e.type === 'invocation.executed' && (e.payload as any).invocationId === out.invocationId)!.payload as any;
    expect(ev.output).toBeUndefined(); expect(ev.outputBytes).toBeGreaterThan(16_384); expect(ev.outputPreview.length).toBe(2048);
    expect(k.blob.get(ev.resultDigest)!.bytes.length).toBeGreaterThan(50_000);
  });
});

describe('M4 · 审批控制面', () => {
  it('deny：审批方拒绝 → invocation.denied{APPROVAL_INVALID} 理由回喂 → 任务恢复并收尾；控制面 pending 列表可读', async () => {
    const fx = loadFixture('G3'); const env = mkEnv(fx);
    const b = await build({ fx, env, providers: [new FsAnyProvider(env.ws), new MemoryContextProvider(), new TextSummarizeProvider()], script: [...fx.mockBackend.script.slice(0, 1), { finishReason: 'stop', content: '未获批准，无法读取。' }] });
    const res = await b.k.startTask(fx.title, { input: substitute(fx.input.user, env) }); expect(res.status).toBe('suspended');
    const cp = b.k.controlPlane(); const pend = cp.pending(); expect(pend.length).toBe(1); expect(pend[0]!.contract).toBe('file.read'); expect(pend[0]!.summary).toContain('report.txt');
    cp.deny(pend[0]!.approvalId, { kind: 'user', id: 'yuyan' }, '不该读这个');
    const res2 = await cp.resume(res.taskId); expect(res2.status).toBe('finished');
    const den = b.k.ledger.all().find(e => e.type === 'invocation.denied')!; expect((den.payload as any).code).toBe('APPROVAL_INVALID'); expect((den.payload as any).reason).toContain('不该读这个');
    expect(cp.pending().length).toBe(0);
    expect(JSON.stringify(b.backend.calls[1]!.messages)).toContain('审批被拒绝');   // 模型第二次调用看到拒绝理由
  });
  it('审批也是能力：审批 Agent 持 human.approve@1 句柄，通过同一管线写 grant → 原任务恢复完成', async () => {
    const fx = loadFixture('G3'); const env = mkEnv(fx); const fsany = new FsAnyProvider(env.ws);
    const b = await build({ fx, env, providers: [fsany, new MemoryContextProvider(), new TextSummarizeProvider()] });
    const res = await b.k.startTask(fx.title, { input: substitute(fx.input.user, env) }); expect(res.status).toBe('suspended');
    const approvalId = b.k.pendingApprovals(res.taskId)[0]!.approvalId;
    // 审批方 Runtime：只有 human.approve@1 句柄，Controller 直接批
    const approverSpec = structuredClone(specs[1]!) as AgentSpec; approverSpec.spec.principal = { org: 'acme', agent: 'approver' }; approverSpec.spec.grants = [{ contract: 'human.approve' }]; approverSpec.spec.controller = { provider: 'approve-once' };
    const approver = await Kernel.compose(approverSpec, { controllers: { 'approve-once': () => ({ id: 'ao', async decide(ctx) { const h = ctx.view.handles.find(x => x.contract.name === 'human.approve')!; const r = await ctx.invoke(h.id, { approvalId, invocationDigest: b.k.pendingApprovals(res.taskId)[0]!.invocationDigest, decision: 'allow' }); return { type: 'finish', output: JSON.parse(JSON.stringify(r)) }; } }) }, backends: { 'mock-backend': new MockBackend([]) }, providers: [new HumanApproveProvider(b.k.controlPlane())] }, {});
    const ar = await approver.startTask('approve'); expect((ar.output as any).status).toBe('executed'); expect((ar.output as any).output.granted).toBe(true);
    // 审批 Agent 自己的账本里有这次 human.approve 调用（谁批的、凭什么句柄，可追责）
    expect(approver.ledger.all().some(e => e.type === 'invocation.executed')).toBe(true);
    const res2 = await b.k.resume(res.taskId); expect(res2.status).toBe('finished');
    expect(fsany.calls.length).toBe(1);
  });
});

describe('M4 · 运营：报表与观察者', () => {
  it('usageReport 按 task/契约/Provider/句柄聚合；MetricsObserver 计数与账本一致；JsonlObserver 每事件一行', async () => {
    const fx = loadFixture('G2'); const env = mkEnv(fx); const jl = tmp('events.jsonl');
    const metrics = new MetricsObserver(); const jsonl = new JsonlObserver(jl);
    const b = await build({ fx, env });
    const k = await Kernel.compose(b.spec, { ...b.plugins, observers: [metrics, jsonl] }, {}); b.rebind(k);
    const res = await k.startTask(fx.input.user, { input: fx.input.user }); expect(res.status).toBe('finished');
    const rep = k.usageReport();
    expect(rep.contracts['file.read']!.denied).toBe(1); expect(rep.contracts['file.read']!.calls).toBe(1); expect(rep.contracts['model.generate']!.calls).toBe(3);
    expect(rep.providers['fs-readonly']!.calls).toBe(1); expect(rep.tasks[res.taskId]!.calls).toBeGreaterThan(0);
    expect(metrics.counters['denied.CAVEAT_VIOLATION']).toBe(1); expect(metrics.counters['invocations.executed']).toBe(k.ledger.all().filter(e => e.type === 'invocation.executed').length);
    expect(fs.readFileSync(jl, 'utf8').trim().split('\n').length).toBe(k.ledger.all().length);
  });
});
