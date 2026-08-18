/**
 * @cak/sdk · 插件端宿主（M3）：把一个 CapabilityProvider 暴露成 subprocess 插件（stdio JSON-RPC）。
 * 插件作者写同一份 Provider，进程内直接注册；子进程里调用 servePlugin(provider) 即可 —— 接口不因传输而变。
 */
import { stdin, stdout } from 'node:process';
import type { CapabilityProvider, AuthorizedInvocation, ProviderCallContext, JsonObject, Json } from './types.js';
import { LineSplitter, decode, encode, response, failure, RPC, CAK_ENVELOPE_VERSION, type Envelope } from './transport.js';

export interface HostOptions { pluginId: string; version: string; kernelCompat: string; write?: (s: string) => void; read?: (onChunk: (s: string) => void, onEnd: () => void) => void; exit?: () => void }

export function servePlugin(provider: CapabilityProvider, opts: HostOptions): void {
  const write = opts.write ?? ((s: string) => { stdout.write(s); });
  const read = opts.read ?? ((onChunk, onEnd) => { stdin.setEncoding('utf8'); stdin.on('data', (c: string) => onChunk(c)); stdin.on('end', onEnd); });
  const exit = opts.exit ?? (() => process.exit(0));
  const splitter = new LineSplitter();
  const inflight = new Map<string | number, { cancelled: boolean }>();
  const handle = async (e: Envelope) => {
    const id = e.id ?? null;
    switch (e.method) {
      case 'plugin.hello': {
        const p = (e.params ?? {}) as { protocol?: string };
        if (p.protocol && p.protocol !== `cak/${CAK_ENVELOPE_VERSION}`) return write(encode(failure(id, RPC.INVALID_REQUEST, `protocol ${p.protocol} unsupported`)));
        return write(encode(response(id, { pluginId: opts.pluginId, pluginVersion: opts.version, protocol: `cak/${CAK_ENVELOPE_VERSION}`, kernelCompat: opts.kernelCompat, roles: ['capability'], implementations: provider.listImplementations() as unknown as Json })));
      }
      case 'plugin.health': { const h = provider.health ? await provider.health() : { status: 'healthy' as const }; return write(encode(response(id, h as unknown as Json))); }
      case 'plugin.shutdown': { write(encode(response(id, {}))); return exit(); }
      case 'capability.execute': {
        const { call, ctx } = (e.params ?? {}) as unknown as { call: AuthorizedInvocation; ctx: ProviderCallContext };
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
      case 'cancel': {
        const { cancellationId, requestId } = (e.params ?? {}) as { cancellationId?: string; requestId?: string | number };
        if (requestId !== undefined) { const m = inflight.get(requestId); if (m) m.cancelled = true; }
        if (cancellationId && provider.cancel) { try { await provider.cancel(cancellationId); } catch { /* best effort */ } }
        return write(encode(response(id, {})));
      }
      default: return write(encode(failure(id, RPC.METHOD_NOT_FOUND, `unknown method ${String(e.method)}`)));
    }
  };
  read(chunk => splitter.push(chunk, line => {
    const d = decode(line);
    if ('error' in d && !('cak' in d)) { write(encode(failure(d.id ?? null, d.error.code, d.error.message))); return; }
    void handle(d as Envelope);
  }), () => exit());
}
