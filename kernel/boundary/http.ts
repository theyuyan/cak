/**
 * Boundary · remote 传输（M5）：HTTP 上的 JSON-RPC 2.0（信封 cak/1）。
 * 服务端 serveKernelHttp(kernel)：暴露 agent.card / agent.serve / agent.receipt / handle.mint / handle.status；也可挂载本地 Provider（capability.execute）。
 * 客户端 RemoteServeTarget(url) / RemoteProvider(url)：给 AgentInvokeProvider / Kernel 用；越界只有 DTO。
 * 只监听 127.0.0.1 除非显式指定 host；没有鉴权层（M5 只做协议与信任模型；TLS/鉴权在部署层）。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Kernel } from '../runtime/kernel.js';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, Json, JsonObject, Principal } from '../../sdk/types.js';
import { decode, encode, response, failure, RPC, CAK_ENVELOPE_VERSION, type Envelope } from '../../sdk/transport.js';
import { err } from '../errors.js';

export interface HttpServerOptions { host?: string; port?: number; provider?: CapabilityProvider }
export interface KernelHttpServer { url: string; close(): Promise<void>; port: number }

export async function serveKernelHttp(k: Kernel, opts: HttpServerOptions = {}): Promise<KernelHttpServer> {
  const handle = async (e: Envelope): Promise<Envelope> => {
    const id = e.id ?? null; const p = (e.params ?? {}) as any;
    try {
      switch (e.method) {
        case 'plugin.hello': return response(id, { protocol: `cak/${CAK_ENVELOPE_VERSION}`, roles: ['agent', ...(opts.provider ? ['capability'] : [])], implementations: (opts.provider?.listImplementations() ?? []) as unknown as Json, agent: k.spec.metadata.name });
        case 'agent.card': return response(id, k.card() as unknown as Json);
        case 'agent.publicKey': return response(id, { principal: k.agentChain[0]!, publicKeyPem: (k.signer as any).publicKeyPem?.() ?? null } as unknown as Json);
        case 'handle.mint': {                                    // 对方为我铸窄句柄（跨组织授权入口）：契约必须在名片 provides 里
          const caller = p.caller as { agentId: string }; const contract = p.contract as { name: string; version?: string };
          const provides = k.spec.spec.manifest?.provides ?? [];
          if (!provides.includes(contract.name)) return failure(id, RPC.INVALID_PARAMS, `not provided: ${contract.name}`);
          const c = k.registry.resolve(contract.name, contract.version)?.contract; if (!c) return failure(id, RPC.INVALID_PARAMS, `unknown contract ${contract.name}`);
          const callerP: Principal = { kind: 'agent', id: caller.agentId };
          const caveats = Array.isArray(p.caveats) ? p.caveats : [{ kind: 'once' }];
          const h = k.authority.mint({ name: c.name, version: c.version, schemaDigest: c.schemaDigest }, [callerP, ...k.agentChain], caveats, new Date().toISOString(), p.expiresAt ? { expiresAt: p.expiresAt } : {});
          k.ledger.append({ taskId: 'runtime', principal: [callerP, ...k.agentChain], type: 'handle.minted', payload: { handleId: h.id, contract: h.contract as any, holder: h.holder as any, caveats: [...h.caveats] as any, ...(h.expiresAt ? { expiresAt: h.expiresAt } : {}) } });
          return response(id, { handleId: h.id, token: k.authority.exportToken(h.id, k.signer, k.agentChain[0]!) });
        }
        case 'handle.status': { const hv = k.authority.view(String(p.handleId)); const revoked = k.ledger.projections().revoked[String(p.handleId)] !== undefined; return response(id, { exists: !!hv, revoked } as unknown as Json); }
        case 'agent.serve': {
          const caller = p.caller as { agentId: string }; const contract = p.contract as { name: string; version?: string }; const args = (p.args ?? {}) as JsonObject;
          const r = await k.serve({ agentId: caller.agentId }, contract, args, { ...(p.budget ? { budget: p.budget } : {}), ...(p.handleToken ? { handleToken: String(p.handleToken) } : {}) });
          if ('error' in r) return failure(id, RPC.INTERNAL, r.error.message, { code: r.error.code });
          return response(id, { output: r.output, usage: r.usage, receipt: { root: r.receipt.root, sig: r.receipt.sig, taskId: r.taskId } } as unknown as Json);
        }
        case 'agent.receipt': { const rc = k.taskReceipt(String(p.taskId)); return response(id, { taskId: rc.taskId, root: rc.root, sig: rc.sig, events: rc.events } as unknown as Json); }
        case 'capability.execute': {
          if (!opts.provider) return failure(id, RPC.METHOD_NOT_FOUND, 'no provider mounted');
          const r = await opts.provider.execute(p.call as AuthorizedInvocation, p.ctx as ProviderCallContext); return response(id, r as unknown as Json);
        }
        default: return failure(id, RPC.METHOD_NOT_FOUND, `unknown method ${String(e.method)}`);
      }
    } catch (ex) { return failure(id, RPC.INTERNAL, ex instanceof Error ? ex.message : String(ex)); }
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/card') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(k.card())); return; }
    if (req.method !== 'POST' || req.url !== '/rpc') { res.statusCode = 404; res.end(); return; }
    let body = ''; req.setEncoding('utf8'); req.on('data', c => { body += c; if (body.length > 4_000_000) req.destroy(); });
    req.on('end', async () => {
      const d = decode(body.trim());
      let out: Envelope;
      if ('error' in d && !('cak' in d)) out = failure(d.id ?? null, d.error.code, d.error.message);
      else out = await handle(d as Envelope);
      res.setHeader('content-type', 'application/json'); res.end(encode(out));
    });
  });
  await new Promise<void>(r => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://${opts.host ?? '127.0.0.1'}:${port}`, port, close: () => new Promise<void>(r => server.close(() => r())) };
}

/** 客户端：一次 JSON-RPC 往返 */
export async function rpc(url: string, method: string, params: JsonObject, timeoutMs = 15000): Promise<Envelope> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: encode({ cak: '1', jsonrpc: '2.0', id: 1, method, params }), signal: ctrl.signal });
    const d = decode((await res.text()).trim());
    if ('error' in d && !('cak' in d)) return { cak: '1', jsonrpc: '2.0', id: 1, error: d.error };
    return d as Envelope;
  } catch (e) { throw err('TRANSPORT_ERROR', `${method} → ${url}: ${e instanceof Error ? e.message : String(e)}`); }
  finally { clearTimeout(t); }
}
export const fetchCard = async (url: string) => { const r = await rpc(url, 'agent.card', {}); if (r.error) throw err('TRANSPORT_ERROR', r.error.message); return r.result as any; };

/** 远端 Agent 作为 ServeTarget（给 AgentInvokeProvider 用） */
export class RemoteServeTarget {
  constructor(private url: string, private opts: { handleToken?: string } = {}) {}
  async serve(caller: { agentId: string }, contract: { name: string; version?: string }, args: JsonObject, opts?: { budget?: JsonObject; handleToken?: string }) {
    const r = await rpc(this.url, 'agent.serve', { caller, contract, args, ...(opts?.budget ? { budget: opts.budget } : {}), ...((opts?.handleToken ?? this.opts.handleToken) ? { handleToken: opts?.handleToken ?? this.opts.handleToken! } : {}) } as unknown as JsonObject, 60000);
    if (r.error) return { error: { code: String((r.error.data as any)?.code ?? 'PROVIDER_ERROR'), message: r.error.message, retryable: false } };
    return r.result as any;
  }
}
/** 远端 CapabilityProvider（HTTP 上的插件） */
export class RemoteProvider implements CapabilityProvider {
  readonly id: string; private impls: CapabilityImplementation[] = [];
  constructor(id: string, private url: string) { this.id = id; }
  async start() { const r = await rpc(this.url, 'plugin.hello', { protocol: `cak/${CAK_ENVELOPE_VERSION}` }); if (r.error) throw err('COMPATIBILITY_ERROR', r.error.message); this.impls = ((r.result as any).implementations ?? []).map((i: CapabilityImplementation) => ({ ...i, providerId: this.id })); }
  listImplementations() { return this.impls; }
  async execute(inv: AuthorizedInvocation, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    try { const r = await rpc(this.url, 'capability.execute', { call: JSON.parse(JSON.stringify(inv)), ctx: JSON.parse(JSON.stringify(ctx)) }, ctx.deadlineAtMs ? Math.max(1, ctx.deadlineAtMs - Date.now()) + 1000 : 30000); if (r.error) return { error: { code: 'PROVIDER_ERROR', message: r.error.message, retryable: false } }; return r.result as unknown as ProviderExecuteResult; }
    catch (e) { return { error: { code: 'TRANSPORT_ERROR', message: e instanceof Error ? e.message : String(e), retryable: false } }; }
  }
}
