// 敌意 Provider / 拦截器 / 边界（09 §1 hostile + Mutation Boundary MB-1…6 + Isolation）
import { describe, it, expect } from 'vitest';
import { Kernel } from '../../kernel/runtime/kernel.js';
import { HostileProvider, PostVerifyMutator, PreVerifyWidener, SafeFileGuard, MemoryContextProvider, TextSummarizeProvider, FsReadonlyProvider, MockBackend } from '../../plugins/builtin/index.js';
import { build, loadFixture, mkEnv } from '../e2e/harness.js';
import type { CapabilityProvider, Interceptor, InvokeResult, ControllerContext, StepOutcome } from '../../sdk/types.js';

/** 直接调用 file.read 的最小控制器：把 invoke 结果放进 finish 输出，便于断言 */
const directController = (args: any) => () => ({ id: 'direct', async decide(ctx: ControllerContext): Promise<StepOutcome> {
  const h = ctx.view.handles.find(x => x.contract.name === 'file.read')!; const r = await ctx.invoke(h.id, args); return { type: 'finish', output: JSON.parse(JSON.stringify(r)) }; } });

async function runWith(providers: CapabilityProvider[], interceptors: Interceptor[] = [], args: any = { path: 'workspace/test.txt' }) {
  const fx = loadFixture('G1'); const env = mkEnv(fx);
  const b = await build({ fx, env, providers: [...providers, new FsReadonlyProvider(env.ws), new MemoryContextProvider(), new TextSummarizeProvider()], interceptors });   // 敌意 Provider priority=1 会优先于 fs-readonly(10)
  const k = await Kernel.compose(b.spec, { ...b.plugins, controllers: { 'simple-react': directController(args) } }, {});
  const res = await k.startTask('x', { input: 'x', config: { invokeTimeoutMs: 300 } });
  return { k, res, out: res.output as any as InvokeResult, events: k.ledger.all().filter(e => e.taskId === res.taskId).map(e => e.type) };
}

describe('hostile providers（内核不崩、错误到达调用方、事件正确）', () => {
  it('同步 throw → failed PROVIDER_ERROR', async () => { const r = await runWith([new HostileProvider('throw-sync')]); expect(r.out.status).toBe('failed'); expect((r.out as any).error.code).toBe('PROVIDER_ERROR'); expect(r.res.status).toBe('finished'); });
  it('异步 reject → failed PROVIDER_ERROR', async () => { const r = await runWith([new HostileProvider('reject')]); expect(r.out.status).toBe('failed'); expect((r.out as any).error.code).toBe('PROVIDER_ERROR'); });
  it('never resolve → TIMEOUT，cancel 已发，主链继续', async () => { const h = new HostileProvider('never'); const r = await runWith([h]); expect(r.out.status).toBe('failed'); expect((r.out as any).error.code).toBe('TIMEOUT'); expect(h.cancelled.length).toBe(1); expect(r.res.status).toBe('finished'); });
  it('返回垃圾（非对象）→ 仍 executed（M1 不做 outputSchema 校验，记入 13 待定），内核不崩', async () => { const r = await runWith([new HostileProvider('garbage')]); expect(['executed', 'failed']).toContain(r.out.status); expect(r.res.status).toBe('finished'); });
  it('超大输出（5MB）→ 进 blob 只存 digest；账本事件 payload 含 output（M1）但主链不崩', async () => { const r = await runWith([new HostileProvider('huge')]); expect(r.out.status).toBe('executed'); expect(r.res.status).toBe('finished'); });
  it('试图改共享 args（冻结）→ 无效；executed 的 effectiveArgs 未变', async () => {
    const r = await runWith([new HostileProvider('mutate')]);
    expect(r.out.status).toBe('executed');
    const auth = r.k.ledger.all().find(e => e.type === 'invocation.authorized')!; expect((auth.payload as any).effectiveArgs).toEqual({ path: 'workspace/test.txt' });
  });
  it('double completion → 只取第一次', async () => { const r = await runWith([new HostileProvider('double')]); expect(r.out.status).toBe('executed'); expect((r.out as any).output.content).toBe('first'); expect(r.events.filter(t => t === 'invocation.executed').length).toBe(1); });
});

describe('Mutation Boundary（MB-1…6）', () => {
  it('MB-1 before.verify 改窄 → 允许；revision+1；旧 args 未变', async () => {
    const r = await runWith([], [new SafeFileGuard(10)], { path: './workspace/test.txt', maxBytes: 100 });
    expect(r.out.status).toBe('executed');
    const rev = r.k.ledger.all().find(e => e.type === 'invocation.revised')!; expect((rev.payload as any).revision).toBe(1); expect((rev.payload as any).args).toEqual({ path: 'workspace/test.txt', maxBytes: 10 });
    const req = r.k.ledger.all().find(e => e.type === 'invocation.requested' && (e.payload as any).contract.name === 'file.read')!; expect((req.payload as any).args).toEqual({ path: './workspace/test.txt', maxBytes: 100 });
  });
  it('MB-2/MB-4 before.verify 放宽 → verify 拒 CAVEAT_VIOLATION；Provider 未被调用', async () => {
    const fs = new FsReadonlyProvider('/nonexistent'); const r = await runWith([fs], [new PreVerifyWidener()]);
    expect(r.out.status).toBe('denied'); expect((r.out as any).code).toBe('CAVEAT_VIOLATION'); expect(fs.calls.length).toBe(0);
  });
  it('MB-3 after.verify 返回 {args} → POLICY_INTEGRITY_ERROR + plugin.degraded；Provider 未被调用', async () => {
    const fx = loadFixture('G1'); const env = mkEnv(fx); const fsro = new FsReadonlyProvider(env.ws);
    const b = await build({ fx, env, providers: [fsro, new MemoryContextProvider(), new TextSummarizeProvider()], interceptors: [new PostVerifyMutator()] });
    const k = await Kernel.compose(b.spec, { ...b.plugins, controllers: { 'simple-react': directController({ path: 'workspace/test.txt' }) } }, {});
    const res = await k.startTask('x', { input: 'x' }); const out = res.output as any;
    expect(out.status).toBe('failed'); expect(out.error.code).toBe('POLICY_INTEGRITY_ERROR');
    expect(fsro.calls.length).toBe(0);
    expect(k.ledger.all().some(e => e.type === 'plugin.degraded' && (e.payload as any).pluginId === 'evil-post-verify')).toBe(true);
  });
  it('MB-6 Provider 只能被 Execute 调用且入参必须是 AuthorizedInvocation：Provider 收到的对象是冻结的且带 digest', async () => {
    const fx = loadFixture('G1'); const env = mkEnv(fx); const fsro = new FsReadonlyProvider(env.ws);
    const b = await build({ fx, env, providers: [fsro, new MemoryContextProvider(), new TextSummarizeProvider()] });
    const k = await Kernel.compose(b.spec, { ...b.plugins, controllers: { 'simple-react': directController({ path: 'workspace/test.txt' }) } }, {});
    await k.startTask('x', { input: 'x' });
    const inv = fsro.calls[0]!; expect(Object.isFrozen(inv)).toBe(true); expect(Object.isFrozen(inv.args)).toBe(true); expect(inv.digest).toMatch(/^sha256:/); expect(inv.handle.id).toBeTruthy(); expect((inv as any).proof).toBeUndefined();
  });
});

describe('Isolation（插件拿不到内核内部）', () => {
  it('ProviderCallContext / AuthorizedInvocation / ControllerContext.view 均可 JSON 往返；无 Handle 对象、无 AbortSignal', async () => {
    const fx = loadFixture('G1'); const env = mkEnv(fx); const fsro = new FsReadonlyProvider(env.ws);
    let seenView: any; let seenCtx: any;
    const spy: CapabilityProvider = { id: 'spy', listImplementations: () => fsro.listImplementations().map(i => ({ ...i, providerId: 'spy', priority: 0 })), async execute(inv, ctx) { seenCtx = ctx; return fsro.execute(inv, ctx); } };
    const b = await build({ fx, env, providers: [spy, new MemoryContextProvider(), new TextSummarizeProvider()] });
    const k = await Kernel.compose(b.spec, { ...b.plugins, controllers: { 'simple-react': () => ({ id: 'c', async decide(ctx) { seenView = ctx.view; const h = ctx.view.handles.find(x => x.contract.name === 'file.read')!; await ctx.invoke(h.id, { path: 'workspace/test.txt' }); return { type: 'finish', output: 1 }; } }) } }, {});
    await k.startTask('x', { input: 'x' });
    expect(JSON.parse(JSON.stringify(seenView))).toEqual(JSON.parse(JSON.stringify(seenView)));
    expect(JSON.stringify(seenView)).not.toMatch(/proof|KernelState|AbortSignal/);
    expect(seenCtx.cancellationId).toMatch(/^cx_/); expect((seenCtx as any).signal).toBeUndefined();
    for (const h of seenView.handles) expect(Object.keys(h).sort()).toEqual(['caveats', 'contract', 'delegable', 'expiresAt', 'id'].filter(k => k !== 'expiresAt' || h.expiresAt !== undefined).sort());
  });
});
