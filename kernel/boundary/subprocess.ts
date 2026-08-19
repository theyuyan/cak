/**
 * Boundary · subprocess 传输（M3）：内核侧代理，把子进程插件当作普通 CapabilityProvider。
 * - spawn 用 argv 数组，永不经 shell（命令注入面为零）。
 * - 握手 plugin.hello：校验协议版本与 kernelCompat；实现声明（含 digest）由 Registry 照常校验。
 * - 越界只有 DTO：AuthorizedInvocation / ProviderCallContext；取消 = cancel 消息（cancellationId + requestId）。
 * - 子进程死亡 / 断连 → TRANSPORT_ERROR；未知信封版本 → 拒绝。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, Json, JsonObject } from '../../sdk/types.js';
import { LineSplitter, decode, encode, request, response, failure, RPC, CAK_ENVELOPE_VERSION, type Envelope } from '../../sdk/transport.js';
import { err } from '../errors.js';

export interface SubprocessSpec { id: string; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; kernelVersion?: string; startupTimeoutMs?: number }

export class SubprocessProvider implements CapabilityProvider {
  readonly id: string;
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Envelope) => void; reject: (e: Error) => void }>();
  private impls: CapabilityImplementation[] = [];
  private splitter = new LineSplitter();
  private alive = false;
  hello?: JsonObject;

  constructor(private spec: SubprocessSpec) { this.id = spec.id; }

  /** 启动 + 握手（Composition 期调用；失败 fail-fast） */
  async start(): Promise<void> {
    const cmd = process.platform === 'win32' && /^(npm|npx|pnpm|yarn|tsx)$/.test(this.spec.command) ? this.spec.command + '.cmd' : this.spec.command;   // Windows .cmd 垫片（未实测）
    const c = spawn(cmd, this.spec.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(this.spec.env ?? {}) }, ...(this.spec.cwd ? { cwd: this.spec.cwd } : {}) });
    this.child = c; this.alive = true;
    c.stdout!.setEncoding('utf8'); c.stdout!.on('data', (chunk: string) => this.splitter.push(chunk, l => this.onLine(l)));
    c.on('exit', () => { this.alive = false; for (const [, p] of this.pending) p.reject(err('TRANSPORT_ERROR', `plugin ${this.id} exited`)); this.pending.clear(); });
    c.on('error', e => { this.alive = false; for (const [, p] of this.pending) p.reject(err('TRANSPORT_ERROR', `plugin ${this.id}: ${e.message}`)); this.pending.clear(); });
    const r = await this.rpc('plugin.hello', { kernelVersion: this.spec.kernelVersion ?? '0.3.0', protocol: `cak/${CAK_ENVELOPE_VERSION}` }, this.spec.startupTimeoutMs ?? 8000);
    if (r.error) throw err('COMPATIBILITY_ERROR', `plugin ${this.id} hello failed: ${r.error.message}`);
    const res = r.result as any;
    if (res?.protocol !== `cak/${CAK_ENVELOPE_VERSION}`) throw err('COMPATIBILITY_ERROR', `plugin ${this.id} speaks ${res?.protocol}`);
    this.hello = res; this.impls = (res.implementations ?? []) as CapabilityImplementation[];
  }
  listImplementations(): CapabilityImplementation[] { return this.impls.map(i => ({ ...i, providerId: this.id })); }
  async execute(inv: AuthorizedInvocation, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    if (!this.alive) return { error: { code: 'TRANSPORT_ERROR', message: `plugin ${this.id} not running`, retryable: false } };
    const id = this.nextId++;
    // 越界只传 DTO：JSON 往返一次，确保没有引用泄漏
    const call = JSON.parse(JSON.stringify(inv)) as JsonObject; const pctx = JSON.parse(JSON.stringify(ctx)) as JsonObject;
    const timeout = (ctx.deadlineAtMs ? Math.max(1, ctx.deadlineAtMs - Date.now()) : 60000) + 1000;   // 内核 Guard 先超时（TIMEOUT），这里只兜底
    let r: Envelope;
    try { r = await this.rpc('capability.execute', { call, ctx: pctx }, timeout, id); }
    catch (e) { const code = (e as any)?.code === 'TIMEOUT' ? 'TIMEOUT' : 'TRANSPORT_ERROR'; return { error: { code, message: e instanceof Error ? e.message : String(e), retryable: false } }; }
    if (r.error) return { error: { code: r.error.code === RPC.CANCELLED ? 'CANCELLED' : 'PROVIDER_ERROR', message: r.error.message, retryable: false } };
    return r.result as unknown as ProviderExecuteResult;
  }
  async cancel(cancellationId: string): Promise<void> {
    if (!this.alive) return;
    // 通知（不等结果）：requestId 让插件端丢弃迟到结果
    const lastId = this.nextId - 1;
    this.child?.stdin?.write(encode(request(this.nextId++, 'cancel', { cancellationId, requestId: lastId })));
  }
  async health() { if (!this.alive) return { status: 'failed' as const, detail: 'not running' }; try { const r = await this.rpc('plugin.health', {}, 3000); return (r.result as any) ?? { status: 'healthy' as const }; } catch { return { status: 'failed' as const }; } }
  async stop() { if (!this.alive) return; try { await this.rpc('plugin.shutdown', {}, 1000); } catch { /* ignore */ } this.child?.kill(); this.alive = false; }
  /** 测试用：故意发一条坏信封 / 未知方法，看插件端怎么答 */
  async _rawRpc(method: string, params: JsonObject, opts: { cak?: string } = {}): Promise<Envelope> {
    const id = this.nextId++;
    return new Promise<Envelope>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const env: any = { cak: opts.cak ?? '1', jsonrpc: '2.0', id, method, params };
      this.child!.stdin!.write(JSON.stringify(env) + '\n');
      setTimeout(() => { if (this.pending.delete(id)) reject(err('TIMEOUT', 'raw rpc timeout')); }, 3000);
    });
  }
  /** 插件发来的反向请求（如 ctx.*）由此处理；不设则回 -32601 */
  onRequest?: (e: Envelope) => Promise<Json>;
  rpc(method: Parameters<typeof request>[1], params: JsonObject, timeoutMs: number, id = this.nextId++): Promise<Envelope> {
    return new Promise<Envelope>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin!.write(encode(request(id, method, params)));
      const t = setTimeout(() => { if (this.pending.delete(id)) reject(err('TIMEOUT', `rpc ${method} timeout`)); }, timeoutMs);
      const orig = this.pending.get(id)!; this.pending.set(id, { resolve: v => { clearTimeout(t); orig.resolve(v); }, reject: e => { clearTimeout(t); orig.reject(e); } });
    });
  }
  private onLine(line: string) {
    const d = decode(line);
    if ('error' in d && !('cak' in d)) { if (d.id !== undefined && d.id !== null) { const p = this.pending.get(d.id as number); if (p) { this.pending.delete(d.id as number); p.resolve({ cak: '1', jsonrpc: '2.0', id: d.id, error: d.error }); } } return; }   // 坏行：有 id 就按错误回应，否则忽略（不崩）
    const e = d as Envelope;
    if (e.method) {   // 插件→内核的请求（子进程控制器的 ctx.*）：有 id 就要回
      const id = e.id ?? null; if (id === null) return;
      const h = this.onRequest; (h ? h(e).then(result => response(id, result), er => failure(id, RPC.INTERNAL, er instanceof Error ? er.message : String(er))) : Promise.resolve(failure(id, RPC.METHOD_NOT_FOUND, `unknown method ${e.method}`))).then(env => { try { this.child?.stdin?.write(encode(env)); } catch { /* */ } });
      return;
    }
    if (e.id === undefined || e.id === null) return;                             // 通知（event.publish 等）：M3 忽略
    const p = this.pending.get(e.id as number); if (!p) return; this.pending.delete(e.id as number); p.resolve(e);
  }
}
