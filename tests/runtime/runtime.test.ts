// Runtime：Task 状态机、mustFinalize/onLimit、预算 caveat、spawn 子任务 + attenuate、step 超时、Controller 抛错
import { describe, it, expect } from 'vitest';
import { Kernel } from '../../kernel/runtime/kernel.js';
import { FsReadonlyProvider, MemoryContextProvider, TextSummarizeProvider } from '../../plugins/builtin/index.js';
import { build, loadFixture, mkEnv } from '../e2e/harness.js';
import type { Controller, StepOutcome } from '../../sdk/types.js';

async function kernelWith(mk: () => Controller, specPatch?: (s: any) => void) {
  const fx = loadFixture('G1'); const env = mkEnv(fx);
  const b = await build({ fx, env, providers: [new FsReadonlyProvider(env.ws), new MemoryContextProvider(), new TextSummarizeProvider()], specPatch });
  return { k: await Kernel.compose(b.spec, { ...b.plugins, controllers: { 'simple-react': mk } }, {}), env };
}
const ev = (k: Kernel, t: string) => k.ledger.all().filter(e => e.taskId === t).map(e => e.type);

describe('runtime', () => {
  it('onLimit=fail：到 maxSteps 直接 task.failed(STEP_LIMIT)，不给收尾轮', async () => {
    const { k } = await kernelWith(() => ({ id: 'c', async decide() { return { type: 'continue' }; } }));
    const r = await k.startTask('x', { config: { maxSteps: 2, onLimit: 'fail' } });
    expect(r.status).toBe('failed'); expect(ev(k, r.taskId).filter(t => t === 'task.step').length).toBe(2);
    expect((k.ledger.all().find(e => e.taskId === r.taskId && e.type === 'task.failed')!.payload as any).error.code).toBe('STEP_LIMIT');
  });
  it('Controller 抛错 → task.failed（PROVIDER_ERROR 封装），内核不崩', async () => {
    const { k } = await kernelWith(() => ({ id: 'c', async decide() { throw new Error('controller bug'); } }));
    const r = await k.startTask('x'); expect(r.status).toBe('failed');
  });
  it('step 超时 → task.timeout', async () => {
    const { k } = await kernelWith(() => ({ id: 'c', async decide() { await new Promise(res => setTimeout(res, 300)); return { type: 'finish', output: 1 }; } }));
    const r = await k.startTask('x', { config: { stepTimeoutMs: 50 } }); expect(r.status).toBe('timeout');
    expect(ev(k, r.taskId)).toContain('task.timeout');
  });
  it('句柄 budget caveat（calls=1）：第二次调用 BUDGET_EXCEEDED；任务继续', async () => {
    const outs: any[] = [];
    const { k } = await kernelWith(() => ({ id: 'c', async decide(ctx) { const h = ctx.view.handles.find(x => x.contract.name === 'file.read')!; outs.push(await ctx.invoke(h.id, { path: 'workspace/test.txt' })); outs.push(await ctx.invoke(h.id, { path: 'workspace/test.txt' })); return { type: 'finish', output: 1 }; } }),
      s => { s.spec.grants[0].caveats.push({ kind: 'budget', slice: { calls: 1 } }); });
    const r = await k.startTask('x'); expect(r.status).toBe('finished');
    expect(outs[0].status).toBe('executed'); expect(outs[1].status).toBe('denied'); expect(outs[1].code).toBe('BUDGET_EXCEEDED');
  });
  it('spawn 子任务：attenuate 收窄后交给子任务；子任务持有集来自账本折叠；父不持有的句柄不能交出', async () => {
    let childId = '';
    const parent: Controller = { id: 'p', async decide(ctx) {
      if (ctx.view.task.parent) return { type: 'finish', output: 'child-done' };   // 子任务用同一控制器：直接结束，避免无限 spawn
      const h = ctx.view.handles.find(x => x.contract.name === 'file.read')!;
      const narrow = await ctx.attenuate(h.id, [{ kind: 'args.max', path: 'maxBytes', max: 5 }]);
      await expect(ctx.spawn('child', ['h_not_mine'], {})).rejects.toMatchObject({ code: 'HANDLE_INVALID' });
      const model = ctx.view.handles.find(x => x.contract.name === 'model.generate')!;
      const c = await ctx.spawn('child goal', [narrow, model.id], { calls: 5 }); childId = c.taskId;
      return { type: 'finish', output: c.taskId };
    } };
    const { k } = await kernelWith(() => parent);
    const r = await k.startTask('x'); expect(r.status).toBe('finished');
    await new Promise(res => setTimeout(res, 50));
    const child = k.ledger.projections().tasks[childId]!;
    expect(child.parent).toBe(r.taskId); expect(child.handles.length).toBe(2);
    expect(k.ledger.projections().handles[child.handles[0]!]!.caveats.some(c => c.kind === 'args.max')).toBe(true);
    // 子任务的持有集含收窄句柄（由 handle.attenuated 折叠 + task.spawned）
    expect(k.taskView(childId).handles.map(h => h.id)).toEqual(child.handles);
  });
  it('无 model.generate 句柄的任务 → Controller 报 CONFIGURATION_ERROR fail', async () => {
    const { k } = await kernelWith(() => ({ id: 'c', async decide(ctx) { return ctx.view.handles.some(h => h.contract.name === 'model.generate') ? { type: 'finish', output: 'has-model' } : { type: 'fail', error: { code: 'CONFIGURATION_ERROR', message: 'no model' } }; } }));
    const fileOnly = k.rootHandles.filter(h => h.contract.name === 'file.read').map(h => h.id);
    const r = await k.startTask('x', { handles: fileOnly }); expect(r.status).toBe('failed');
  });
});
