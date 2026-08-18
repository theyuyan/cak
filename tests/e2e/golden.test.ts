// Golden E2E G1–G6, G8：判据 = tests/golden/*.yaml 的 strictSequence 与 expect（不来自实现）
import { describe, it, expect } from 'vitest';
import { Kernel } from '../../kernel/runtime/kernel.js';
import { FileLedgerStore, Ledger, verifyReceipt } from '../../kernel/ledger/ledger.js';
import { HostileProvider, PreVerifyWidener, SafeFileGuard, MemoryContextProvider, TextSummarizeProvider, FsAnyProvider } from '../../plugins/builtin/index.js';
import { build, loadFixture, mkEnv, taskEvents, substitute } from './harness.js';

async function runGolden(id: string, extra: Partial<Parameters<typeof build>[0]> = {}) {
  const fx = loadFixture(id); const env = mkEnv(fx);
  const b = await build({ fx, env, ...extra });
  const res = await b.k.startTask(fx.input?.user ?? fx.title, { input: substitute(fx.input?.user, env), config: { ...(fx['task.maxSteps'] ? { maxSteps: fx['task.maxSteps'] } : {}), ...(fx['task.invokeTimeoutMs'] ? { invokeTimeoutMs: fx['task.invokeTimeoutMs'] } : {}) } });
  return { fx, env, ...b, res, events: taskEvents(b.k, res.taskId) };
}

describe('Golden E2E', () => {
  it('G1 读文件并总结：事件序列 == fixture.strictSequence；输出含"摘要"；模型 2 次；usage 330', async () => {
    const r = await runGolden('G1');
    expect(r.events).toEqual(r.fx.strictSequence);
    expect(r.res.status).toBe('finished'); expect(String(r.res.output)).toContain('摘要');
    expect(r.backend.calls.length).toBe(2);
    expect(r.fsro.calls[0]!.args).toEqual({ path: 'workspace/test.txt' });
    expect(r.k.ledger.projections().usageByTask[r.res.taskId]!.inputTokens).toBe(330);
    // repeatable：再跑一次，事件类型序列相同
    const r2 = await runGolden('G1'); expect(r2.events).toEqual(r.events);
  });
  it('G2 读 /etc/passwd 被句柄拒 → 理由回喂 → 改路径成功；Provider 从未收到 /etc/passwd', async () => {
    const r = await runGolden('G2');
    expect(r.events).toEqual(r.fx.strictSequence);
    const denied = r.k.ledger.all().filter(e => e.type === 'invocation.denied');
    expect(denied.length).toBe(1); expect((denied[0]!.payload as any).code).toBe('CAVEAT_VIOLATION'); expect((denied[0]!.payload as any).reason).toContain('workspace/'); expect((denied[0]!.payload as any).retryable).toBe(true);
    expect(r.fsro.calls.map(c => c.args)).toEqual([{ path: 'workspace/passwd.txt' }]);
    // 模型第二次调用的消息里能看到拒绝理由（TaskView 回喂）
    expect(JSON.stringify(r.backend.calls[1]!.messages)).toContain('workspace/');
    expect(r.res.status).toBe('finished');
  });
  it('G3 workspace 外文件 → requires-approval → 挂起 → grant → 重验（不重跑前置）→ 执行；once 使第二次拒绝', async () => {
    const fx = loadFixture('G3'); const env = mkEnv(fx);
    const b = await build({ fx, env, providers: [new FsAnyProvider(env.ws), new MemoryContextProvider(), new TextSummarizeProvider()] });
    const res = await b.k.startTask(fx.title, { input: substitute(fx.input.user, env) });
    expect(res.status).toBe('suspended');
    const pend = b.k.pendingApprovals(res.taskId); expect(pend.length).toBe(1);
    expect(b.fsany.calls.length).toBe(0);                                  // providerCalledBeforeGrant: false
    b.k.grant(pend[0]!.approvalId, { kind: 'user', id: 'yuyan' });
    const bvBefore = b.k.stats.beforeVerifyFor(pend[0]!.invocationId);
    const res2 = await b.k.resume(res.taskId);
    expect(b.k.stats.beforeVerifyFor(pend[0]!.invocationId)).toBe(bvBefore);   // 恢复重验不重跑 before.verify（该调用计数不变）
    expect(res2.status).toBe('finished');
    expect(taskEvents(b.k, res.taskId)).toEqual(fx.strictSequence);
    const auth = b.k.ledger.all().find(e => e.type === 'invocation.authorized' && (e.payload as any).approvalId)!;
    expect((auth.payload as any).approvalId).toBe(pend[0]!.approvalId); expect((auth.payload as any).revision).toBe(pend[0]!.revision);
    // once：第二个任务再用同一句柄 → denied CAVEAT_VIOLATION
    const b2script = [{ finishReason: 'tool_calls' as const, toolCalls: [{ id: 'c9', handle: '$h.fileAny', args: { path: `${env.outside}/report.txt` } }] }, { finishReason: 'stop' as const, content: 'done' }];
    (b.backend as any).script = b2script; (b.backend as any).i = 0;
    const res3 = await b.k.startTask('again', { input: 'again' });
    const den = b.k.ledger.all().filter(e => e.taskId === res3.taskId && e.type === 'invocation.denied');
    expect(den.length).toBe(1); expect((den[0]!.payload as any).code).toBe('CAVEAT_VIOLATION');
  });
  it('G4 before.verify 改窄 maxBytes → revision 1 → Provider 收到 4096；放宽变体被 verify 拒', async () => {
    const r = await runGolden('G4');
    expect(r.events).toEqual(r.fx.strictSequence);
    expect(r.fsro.calls[0]!.args).toEqual({ path: 'workspace/big.txt', maxBytes: 4096 });
    const auth = r.k.ledger.all().find(e => e.type === 'invocation.authorized' && (e.payload as any).providerId === 'fs-readonly')!;
    expect((auth.payload as any).revision).toBe(1);
    // 变体：敌意拦截器放宽 → CAVEAT_VIOLATION
    const w = await runGolden('G4', { interceptors: [new PreVerifyWidener()] });
    const den = w.k.ledger.all().filter(e => e.taskId === w.res.taskId && e.type === 'invocation.denied');
    expect(den.length).toBeGreaterThanOrEqual(1); expect((den[0]!.payload as any).code).toBe('CAVEAT_VIOLATION');
    expect(w.fsro.calls.length).toBe(0);
  });
  it('G5 敌意 Provider never resolve → TIMEOUT + cancel 已发 → 任务继续并收尾', async () => {
    const hostile = new HostileProvider('never');
    const r = await runGolden('G5', { providers: [hostile, new MemoryContextProvider(), new TextSummarizeProvider()] });
    expect(r.events).toEqual(r.fx.strictSequence);
    const failed = r.k.ledger.all().find(e => e.type === 'invocation.failed')!;
    expect((failed.payload as any).error.code).toBe('TIMEOUT');
    expect(hostile.cancelled.length).toBe(1);
    expect(r.res.status).toBe('finished');
  });
  it('G6 maxSteps=2 → step#1 mustFinalize；工具调用 STEP_LIMIT；Controller finish', async () => {
    const r = await runGolden('G6');
    expect(r.events).toEqual(r.fx.strictSequence);
    const steps = r.k.ledger.all().filter(e => e.taskId === r.res.taskId && e.type === 'task.step');
    expect((steps[1]!.payload as any).mustFinalize).toBe(true);
    const den = r.k.ledger.all().filter(e => e.type === 'invocation.denied'); expect((den[0]!.payload as any).code).toBe('STEP_LIMIT');
    expect(r.res.status).toBe('finished');
  });
  it('G6 变体：Controller 在收尾轮返回 continue → task.failed STEP_LIMIT', async () => {
    const fx = loadFixture('G6'); const env = mkEnv(fx);
    const b = await build({ fx, env, script: [{ finishReason: 'tool_calls', toolCalls: [{ id: 'a', handle: '$h.file', args: { path: 'workspace/test.txt' } }] }, { finishReason: 'tool_calls', toolCalls: [{ id: 'b', handle: '$h.file', args: { path: 'workspace/test.txt' } }] }, { finishReason: 'tool_calls', toolCalls: [{ id: 'c', handle: '$h.file', args: { path: 'workspace/test.txt' } }] }] });
    // 用一个"永远 continue"的控制器替身：改写 plugins 需要重新装配；这里用 simple-react 的行为：收尾轮模型仍给 toolCalls 且第二次也给 toolCalls → simple-react 会 finish(空)；因此直接构造控制器
    const k2 = await Kernel.compose(b.spec, { ...b.plugins, controllers: { 'simple-react': () => ({ id: 'stubborn', async decide() { return { type: 'continue' }; } }) } }, {});
    const res = await k2.startTask('x', { config: { maxSteps: 2 } });
    expect(res.status).toBe('failed');
    const failed = k2.ledger.all().find(e => e.taskId === res.taskId && e.type === 'task.failed')!;
    expect((failed.payload as any).error.code).toBe('STEP_LIMIT');
  });
  it('G8 崩溃恢复：awaiting 时"杀进程"→ 同账本重启（句柄表由折叠重建）→ grant → 完成；链完整；executed 恰好 1', async () => {
    const fx = loadFixture('G8'); const g3 = loadFixture('G3'); const env = mkEnv(g3);
    const b = await build({ fx: g3, env, persistent: true, providers: [new FsAnyProvider(env.ws), new MemoryContextProvider(), new TextSummarizeProvider()] });
    const res = await b.k.startTask(g3.title, { input: substitute(g3.input.user, env) });
    expect(res.status).toBe('suspended');
    const approvalId = b.k.pendingApprovals(res.taskId)[0]!.approvalId;
    // ---- 杀进程：丢弃 b.k；同一账本文件重新装配（rootHandles 从账本恢复，不重新铸造）
    const k2 = await Kernel.compose(b.spec, { ...b.plugins, backends: { 'mock-backend': new (await import('../../plugins/builtin/index.js')).MockBackend([{ finishReason: 'stop', content: '报告已读取。' }]) } }, { ledgerStore: new FileLedgerStore(env.ledgerFile), signKey: 'e2e' });
    expect(k2.rootHandles.map(h => h.id)).toEqual(b.k.rootHandles.map(h => h.id));
    expect(k2.ledger.all().filter(e => e.type === 'handle.minted').length).toBe(b.k.rootHandles.length);   // 没有重复铸造
    k2.grant(approvalId, { kind: 'user', id: 'yuyan' });
    const pendingInv = b.k.pendingApprovals(res.taskId)[0]!.invocationId;
    const res2 = await k2.resume(res.taskId);
    expect(res2.status).toBe('finished');
    expect(k2.stats.beforeVerifyFor(pendingInv)).toBe(0);   // 新进程里该调用从未跑过 before.verify（只重验）
    const after = k2.ledger.all().filter(e => e.taskId === res.taskId).map(e => e.type);
    const idx = after.indexOf('task.resumed');
    expect(after.slice(idx)).toEqual(fx.strictSequenceAfterRestart);
    expect(k2.ledger.all().filter(e => e.type === 'invocation.executed' && (e.payload as any).invocationId === b.k.pendingApprovals(res.taskId)[0]!.invocationId).length).toBe(1);
    // 链完整：再开一次不抛
    expect(() => Ledger.open(new FileLedgerStore(env.ledgerFile))).not.toThrow();
    const r = k2.receipt(b.k.pendingApprovals(res.taskId)[0]!.invocationId);
    expect(verifyReceipt(r, 'e2e')).toBe(true);
  });
});
