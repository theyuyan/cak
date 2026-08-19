/**
 * @cak-dev/sdk · 插件端宿主（M3）：把一个 CapabilityProvider 暴露成 subprocess 插件（stdio JSON-RPC）。
 * 插件作者写同一份 Provider，进程内直接注册；子进程里调用 servePlugin(provider) 即可 —— 接口不因传输而变。
 */
import { stdin, stdout } from 'node:process';
import type { CapabilityProvider, AuthorizedInvocation, ProviderCallContext, JsonObject, Json, Controller, ControllerContext } from './types.js';
import { LineSplitter, decode, encode, response, failure, RPC, CAK_ENVELOPE_VERSION, type Envelope } from './transport.js';

export interface HostOptions { pluginId: string; version: string; kernelCompat: string; write?: (s: string) => void; read?: (onChunk: (s: string) => void, onEnd: () => void) => void; exit?: () => void;
  /** N-48：控制器角色——给工厂就能当子进程控制器；decide 期间通过 ctx.* 反向请求内核 */ controller?: (config: JsonObject) => Controller }

export function servePlugin(provider: CapabilityProvider | null, opts: HostOptions): void {
  const write = opts.write ?? ((s: string) => { stdout.write(s); });
  const read = opts.read ?? ((onChunk, onEnd) => { stdin.setEncoding('utf8'); stdin.on('data', (c: string) => onChunk(c)); stdin.on('end', onEnd); });
  const exit = opts.exit ?? (() => process.exit(0));
  const splitter = new LineSplitter();
  const inflight = new Map<string | number, { cancelled: boolean }>();
  // 插件→内核的反向请求（ctx.*）：自己发 id，等内核回响应
  const waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>(); let rid = 1_000_000;
  const reverse = (method: string, params: JsonObject) => new Promise<Json>((resolve, reject) => { const id = rid++; waiting.set(id, { resolve, reject }); write(encode({ cak: '1', jsonrpc: '2.0', id, method, params } as Envelope)); });
  const handle = async (e: Envelope) => {
    const id = e.id ?? null;
    switch (e.method) {
      case 'plugin.hello': {
        const p = (e.params ?? {}) as { protocol?: string };
        if (p.protocol && p.protocol !== `cak/${CAK_ENVELOPE_VERSION}`) return write(encode(failure(id, RPC.INVALID_REQUEST, `protocol ${p.protocol} unsupported`)));
        return write(encode(response(id, { pluginId: opts.pluginId, pluginVersion: opts.version, protocol: `cak/${CAK_ENVELOPE_VERSION}`, kernelCompat: opts.kernelCompat, roles: [...(provider ? ['capability'] : []), ...(opts.controller ? ['controller'] : [])], implementations: (provider ? provider.listImplementations() : []) as unknown as Json })));
      }
      case 'plugin.health': { const h = provider?.health ? await provider.health() : { status: 'healthy' as const }; return write(encode(response(id, h as unknown as Json))); }
      case 'plugin.shutdown': { write(encode(response(id, {}))); return exit(); }
      case 'capability.execute': {
        const { call, ctx } = (e.params ?? {}) as unknown as { call: AuthorizedInvocation; ctx: ProviderCallContext };
        if (!provider) return write(encode(failure(id, RPC.METHOD_NOT_FOUND, 'no capability provider in this plugin')));
        if (!call || !ctx) return write(encode(failure(id, RPC.INVALID_PARAMS, 'call/ctx required')));
        const marker = { cancelled: false }; if (id !== null) inflight.set(id, marker);
        try {
          const frozen = Object.freeze({ ...call, args: Object.freeze({ ...(call.args as JsonObject) }) }) as AuthorizedInvocation;
          const r = await provider.execute(frozen, ctx);
          if (marker.cancelled) return;                          // 已取消：丢弃迟到结果
          write(encode(response(id, r as unknown as Json)));
        } catch (err) { write(encode(failure(id, RPC.INTERNAL, err instanceof Error ? err.message : String(err)))); }
        finally { if (id !== null) inflight.delete(id); }
        return;
      }
      case 'controller.decide': {
        if (!opts.controller) return write(encode(failure(id, RPC.METHOD_NOT_FOUND, 'no controller in this plugin')));
        const { decideId, view, config } = (e.params ?? {}) as unknown as { decideId: string; view: ControllerContext['view']; config?: JsonObject };
        const call = (method: string, params: JsonObject) => reverse(method, { decideId, ...params });
        const ctx: ControllerContext = { view, trace: { traceId: 'tr_sub', spanId: 'sp_' + decideId }, now: () => new Date().toISOString(),
          invoke: (handle, args, o) => call('ctx.invoke', { handle, args, ...(o ? { opts: o as unknown as Json } : {}) }) as any,
          compose: (spec) => call('ctx.compose', spec ? { spec: spec as unknown as Json } : {}) as any,
          preview: (_handle, _args) => { throw new Error('preview 在子进程控制器里请用 invokePreview（异步）'); },
          attenuate: (handle, addCaveats) => call('ctx.attenuate', { handle, addCaveats: addCaveats as unknown as Json }) as any,
          spawn: (goal, handles, budget, config2) => call('ctx.spawn', { goal, handles, budget: budget as unknown as Json, ...(config2 ? { config: config2 as unknown as Json } : {}) }) as any };
        (ctx as any).invokePreview = (handle: string, args: JsonObject) => call('ctx.preview', { handle, args });   // 异步版 preview（同步签名跨进程做不到）
        try { const out = await opts.controller(config ?? {}).decide(ctx); return write(encode(response(id, out as unknown as Json))); }
        catch (er) { return write(encode(failure(id, RPC.INTERNAL, er instanceof Error ? er.message : String(er)))); }
      }
      case 'cancel': {
        const { cancellationId, requestId } = (e.params ?? {}) as { cancellationId?: string; requestId?: string | number };
        if (requestId !== undefined) { const m = inflight.get(requestId); if (m) m.cancelled = true; }
        if (cancellationId && provider?.cancel) { try { await provider.cancel(cancellationId); } catch { /* best effort */ } }
        return write(encode(response(id, {})));
      }
      default: return write(encode(failure(id, RPC.METHOD_NOT_FOUND, `unknown method ${String(e.method)}`)));
    }
  };
  read(chunk => splitter.push(chunk, line => {
    const d = decode(line);
    if ('error' in d && !('cak' in d)) { write(encode(failure(d.id ?? null, d.error.code, d.error.message))); return; }
    const env = d as Envelope;
    if (!env.method && env.id !== undefined && env.id !== null && waiting.has(env.id as number)) { const w = waiting.get(env.id as number)!; waiting.delete(env.id as number); if (env.error) w.reject(new Error(env.error.message)); else w.resolve(env.result as Json); return; }   // 内核对反向请求的回应
    void handle(env);
  }), () => exit());
}
