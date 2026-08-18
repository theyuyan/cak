// M2：G7 双 Agent 握手 · 子任务唤醒父任务 · AgentCard · 回执事件
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import path from 'node:path';
import { Kernel, verifyTaskReceipt, type Plugins } from '../../kernel/runtime/kernel.js';
import { MemoryLedgerStore } from '../../kernel/ledger/ledger.js';
import { simpleReact, planExecute, MockBackend, FsReadonlyProvider, MemoryContextProvider, TextSummarizeProvider, SafeFileGuard, AgentInvokeProvider, CollectingObserver } from '../../plugins/builtin/index.js';
import { specs, loadFixture, mkEnv, taskEvents } from './harness.js';
import type { AgentSpec, CapabilityContract, Controller } from '../../sdk/types.js';
import { contractDigest } from '../../kernel/contract/registry.js';

// doc.summarize@1：B 名片上发布的契约（测试里作为插件契约注册；生态里将来是 std/vendor 契约）
const DOC_SUMMARIZE_BASE = { name: 'doc.summarize', version: '1.0.0', description: '总结一份文档', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } }, outputSchema: { type: 'object' }, sideEffects: 'read', idempotent: true } as const;
const DOC_SUMMARIZE: CapabilityContract = { ...DOC_SUMMARIZE_BASE, permissions: [], schemaDigest: contractDigest({ ...DOC_SUMMARIZE_BASE, permissions: [] } as any) } as any;

async function buildPair(fx: any, env: ReturnType<typeof mkEnv>) {
  const specA = structuredClone(specs[1]!) as AgentSpec; const specB = structuredClone(specs[0]!) as AgentSpec;
  specB.spec.manifest = { ...(specB.spec.manifest ?? {}), provides: ['doc.summarize'] };
  const resolveB = { fn: (s: string) => s }; const resolveA = { fn: (s: string) => s };
  const backendB = new MockBackend(fx.mockBackend.B, s => resolveB.fn(s)); const backendA = new MockBackend(fx.mockBackend.A, s => resolveA.fn(s));
  const obsB = new CollectingObserver(); const obsA = new CollectingObserver();
  const pluginsB: Plugins = { controllers: { 'simple-react': cfg => simpleReact(cfg) }, backends: { 'mock-backend': backendB }, providers: [new FsReadonlyProvider(env.ws), new MemoryContextProvider([{ content: 'B 的记忆' }]), new TextSummarizeProvider()], interceptors: [new SafeFileGuard(4096)], observers: [obsB], contracts: [DOC_SUMMARIZE] };
  const B = await Kernel.compose(specB, pluginsB, { ledgerStore: new MemoryLedgerStore(), signKey: 'key-B' });
  resolveB.fn = s => ({ '$h.fileB': B.rootHandles[0]!.id }[s] ?? s);
  const pluginsA: Plugins = { controllers: { 'plan-execute': cfg => planExecute(cfg) }, backends: { 'mock-backend': backendA }, providers: [new AgentInvokeProvider({ 'minimal-file-agent': B }), new MemoryContextProvider(), new TextSummarizeProvider()], observers: [obsA], contracts: [DOC_SUMMARIZE] };
  const A = await Kernel.compose(specA, pluginsA, { ledgerStore: new MemoryLedgerStore(), signKey: 'key-A' });
  resolveA.fn = s => ({ '$h.agent': A.rootHandles[0]!.id }[s] ?? s);
  return { A, B, backendA, backendB };
}

describe('M2 · G7 双 Agent 握手（同进程）', () => {
  it('A 收窄 agent.invoke 句柄 → 调 B 的 doc.summarize → B 为来访者铸窄句柄、以来访者名义开任务、按自己账本处理、出回执；A 可验回执；预算 20→19；once', async () => {
    const fx = loadFixture('G7'); const env = mkEnv(fx);
    const { A, B } = await buildPair(fx, env);
    const res = await A.startTask(fx.input.user, { input: fx.input.user });
    expect(res.status).toBe('finished');
    // A 序列
    expect(taskEvents(A, res.taskId)).toEqual(fx.strictSequenceA);
    // B 序列（B 只有一个任务）
    const bTask = Object.keys(B.ledger.projections().tasks)[0]!;
    expect(taskEvents(B, bTask)).toEqual(fx.strictSequenceB);
    // B 的任务主体链含 agent:coordinator
    expect(B.ledger.projections().tasks[bTask]!.principal).toContainEqual({ kind: 'agent', id: 'coordinator' });
    // A 账本里 agent.invoke 的输出含 receiptRef；用 B 的 key 可验，用 A 的 key 不可验
    const inv = Object.values(A.ledger.projections().invocations).find(i => i.contract.name === 'agent.invoke')!;
    expect(inv.status).toBe('executed');
    const out = inv.output as any; expect(out.receipt.root).toMatch(/^sha256:/);
    // 回执覆盖的是 B 该任务在 receipt.issued 之前的全部事件：从 B 账本重建并用 A 拿到的 root/sig 验证
    const bAll = B.ledger.all().filter(e => e.taskId === bTask); const cut = bAll.findIndex(e => e.type === 'receipt.issued');
    const covered = bAll.slice(0, cut);
    const receipt = { taskId: out.receipt.taskId as string, events: covered, root: out.receipt.root as string, sig: out.receipt.sig };
    expect(verifyTaskReceipt(receipt, B.signer)).toBe(true);        // 用 B 的签名者（key-B）验
    expect(verifyTaskReceipt(receipt, A.signer)).toBe(false);       // A 的 key 验不过
    expect(verifyTaskReceipt({ ...receipt, events: covered.slice(1) }, B.signer)).toBe(false);   // 少一条事件 → 根不符
    // usage 一致：A 记的 agent.invoke usage == B 该任务 usage
    const bUsage = B.ledger.projections().usageByTask[bTask]!;
    expect(inv.usage!.units).toEqual({ calls: bUsage.calls, inputTokens: bUsage.inputTokens, outputTokens: bUsage.outputTokens });
    // A 的 agent.invoke 根句柄 budget calls 20 → 用掉 1（收窄子句柄的调用计入父？—— usage 按句柄记在子句柄；根句柄剩余按 task 用量：这里断言 task 级 calls）
    const rootAgent = A.rootHandles[0]!; const child = Object.values(A.ledger.projections().handles).find(h => h.parent === rootAgent.id)!;
    expect(child.caveats.some(c => c.kind === 'budget' && (c as any).slice.calls === 1)).toBe(true);
    expect(A.ledger.projections().usageByHandle[child.id]!.calls).toBe(1);
    // once：B 为来访者铸的句柄只用一次 —— 同一句柄再验必拒
    const visitor = Object.values(B.ledger.projections().handles).find(h => h.contract.name === 'doc.summarize')!;
    const v2 = B.authority.verify(visitor.id, B.ledger.projections().tasks[bTask]!.principal, { path: 'x' }, { id: 'again', revision: 0 }, [], B.ledger.projections(), new Date().toISOString());
    expect(!v2.ok && v2.kind === 'denied' && v2.code === 'CAVEAT_VIOLATION').toBe(true);
    // 名片
    const card = B.card(); expect(card.provides.map(c => c.name)).toEqual(['doc.summarize']); expect(card.principal).toEqual({ kind: 'agent', id: 'minimal-file-agent' });     const { sig, ...body } = card; expect(B.signer.verify(body, sig)).toBe(true); expect(B.signer.verify({ ...body, displayName: 'tampered' }, sig)).toBe(false);
    // repeatable
    const env2 = mkEnv(fx); const { A: A2 } = await buildPair(fx, env2); const r2 = await A2.startTask(fx.input.user, { input: fx.input.user });
    expect(taskEvents(A2, r2.taskId)).toEqual(taskEvents(A, res.taskId));
  });
  it('B 不提供的契约 → agent.invoke 失败 CAPABILITY_ERROR/ROUTING_ERROR，A 任务继续', async () => {
    const fx = loadFixture('G7'); const env = mkEnv(fx); const { A } = await buildPair(fx, env);
    (A as any).controller = { id: 'x', async decide(ctx: any) { const h = ctx.view.handles.find((x: any) => x.contract.name === 'agent.invoke'); const r = await ctx.invoke(h.id, { target: 'minimal-file-agent', contract: { name: 'not.provided', version: '1.0.0' }, args: {} }); return { type: 'finish', output: JSON.parse(JSON.stringify(r)) }; } };
    const res = await A.startTask('x'); const out = res.output as any;
    expect(out.status).toBe('failed'); expect(out.error.code).toBe('ROUTING_ERROR');
  });
});

describe('M2 · 子任务生命周期', () => {
  it('父 spawn 子并 await(child-task) → 子完成 → 父被唤醒继续 → waitFor 拿到父的最终结果；子输出可在父视图看到', async () => {
    const fx = loadFixture('G1'); const env = mkEnv(fx);
    const { build } = await import('./harness.js');
    const b = await build({ fx, env });
    let phase = 0;
    const ctrl: Controller = { id: 'p', async decide(ctx): Promise<import('../../sdk/types.js').StepOutcome> {
      if (ctx.view.task.parent) return { type: 'finish', output: { childSays: 'done:' + JSON.stringify(ctx.view.task.goal) } as any };
      if (phase === 0) { phase = 1; const model = ctx.view.handles.find(h => h.contract.name === 'model.generate')!; await ctx.spawn('sub-goal', [model.id], { calls: 3 }); return { type: 'await', reason: 'child-task' }; }
      const child = ctx.view.children[0]!; expect(child.status).toBe('finished');
      return { type: 'finish', output: { parentSaw: child.status } as any };
    } };
    const k = await Kernel.compose(b.spec, { ...b.plugins, controllers: { 'simple-react': () => ctrl } }, {});
    const first = await k.startTask('parent');
    expect(['suspended', 'finished']).toContain(first.status);   // 子任务可能在父挂起前就结束（内核处理了该竞态）
    const final = await k.waitFor(first.taskId);
    expect(final.status).toBe('finished'); expect(final.output).toEqual({ parentSaw: 'finished' });
    const seq = taskEvents(k, first.taskId);
    expect(seq).toContain('task.suspended'); expect(seq).toContain('task.resumed'); expect(seq[seq.length - 1]).toBe('task.finished');
  });
});

describe('M2 · 子任务生命周期（慢子任务：真正的挂起→唤醒路径）', () => {
  it('子任务 200ms 后完成 → 父先 suspended → 子结束唤醒父 → waitFor finished', async () => {
    const fx = loadFixture('G1'); const env = mkEnv(fx);
    const { build } = await import('./harness.js'); const b = await build({ fx, env });
    let phase = 0;
    const ctrl: Controller = { id: 'p', async decide(ctx): Promise<import('../../sdk/types.js').StepOutcome> {
      if (ctx.view.task.parent) { await new Promise(r => setTimeout(r, 200)); return { type: 'finish', output: 'slow-child-done' }; }
      if (phase === 0) { phase = 1; const model = ctx.view.handles.find(h => h.contract.name === 'model.generate')!; await ctx.spawn('sub', [model.id], { calls: 3 }); return { type: 'await', reason: 'child-task' }; }
      return { type: 'finish', output: { childStatus: ctx.view.children[0]!.status } as any };
    } };
    const k = await Kernel.compose(b.spec, { ...b.plugins, controllers: { 'simple-react': () => ctrl } }, {});
    const first = await k.startTask('parent');
    expect(first.status).toBe('suspended');
    const final = await k.waitFor(first.taskId);
    expect(final.status).toBe('finished'); expect(final.output).toEqual({ childStatus: 'finished' });
    const seq = taskEvents(k, first.taskId); expect(seq.filter(t => t === 'task.suspended').length).toBe(1); expect(seq.filter(t => t === 'task.resumed').length).toBe(1);
  });
});
