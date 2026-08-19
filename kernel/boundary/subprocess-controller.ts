/**
 * 子进程控制器（N-48）：控制器插件跑在自己的进程里（任何语言），不进内核进程 —— 补上 in-process 控制器（T2）的信任缺口。
 * 内核→插件：controller.decide{decideId, view, config}；决策期间插件→内核反向请求 ctx.invoke / ctx.compose / ctx.preview / ctx.attenuate / ctx.spawn{decideId,…}。
 * 内核不变：这里只是把 ControllerContext 的方法搬到线上；插件拿不到任何句柄以外的东西（view 是内核给的视图，invoke 仍走 verify）。
 */
import type { Controller, ControllerContext, StepOutcome, JsonObject, Json } from '../../sdk/types.js';
import { SubprocessProvider } from './subprocess.js';
import { err } from '../errors.js';

export class SubprocessController {
  private inflight = new Map<string, ControllerContext>(); private n = 0;
  constructor(readonly sub: SubprocessProvider, readonly id: string, private opts: { decideTimeoutMs?: number } = {}) {
    sub.onRequest = async (e) => {
      const p = (e.params ?? {}) as any; const ctx = this.inflight.get(String(p.decideId)); if (!ctx) throw new Error(`no in-flight decide ${p.decideId}`);
      switch (e.method) {
        case 'ctx.invoke': return await ctx.invoke(String(p.handle), (p.args ?? {}) as JsonObject, p.opts) as unknown as Json;
        case 'ctx.compose': return await ctx.compose(p.spec) as unknown as Json;
        case 'ctx.preview': return ctx.preview(String(p.handle), (p.args ?? {}) as JsonObject) as unknown as Json;
        case 'ctx.attenuate': return await ctx.attenuate(String(p.handle), p.addCaveats ?? []) as unknown as Json;
        case 'ctx.spawn': return await ctx.spawn(p.goal, p.handles ?? [], p.budget ?? {}, p.config) as unknown as Json;
        default: throw new Error(`unknown method ${e.method}`);
      }
    };
  }
  controller(config: JsonObject = {}): Controller {
    const self = this;
    return {
      id: this.id,
      async decide(ctx: ControllerContext): Promise<StepOutcome> {
        const decideId = `d_${++self.n}`; self.inflight.set(decideId, ctx);
        try {
          const timeout = self.opts.decideTimeoutMs ?? Math.max(5000, (ctx.view.task.config.stepTimeoutMs ?? 180_000) - 2000);
          const r = await self.sub.rpc('controller.decide', { decideId, view: ctx.view as unknown as JsonObject, config }, timeout);
          if (r.error) return { type: 'fail', error: { code: 'PROVIDER_ERROR', message: `controller ${self.id}: ${r.error.message}` } };
          const out = r.result as any; if (!out || typeof out.type !== 'string') return { type: 'fail', error: { code: 'PROVIDER_ERROR', message: `controller ${self.id}: bad outcome` } };
          return out as StepOutcome;
        } catch (e) { const init = e instanceof Error && 'code' in e ? (e as any) : err('TRANSPORT_ERROR', String(e)); return { type: 'fail', error: { code: init.code ?? 'TRANSPORT_ERROR', message: init.message } }; }
        finally { self.inflight.delete(decideId); }
      },
    };
  }
}
