/**
 * MCP Bridge（M3 / 15 §7 ②）：把一个 MCP Server（stdio，JSON-RPC 2.0，NDJSON）的 tools 映射成契约 x.mcp.<server>.<tool>@1.0.0 + 实现。
 * - 契约落 x.* 实验区（15 §2.1）；sideEffects 保守取 external，idempotent=false（不信任外部工具自述）。
 * - Kernel Capability 不由 MCP 反向定义：这里只是适配器；转正走 RFC。
 * - spawn 用 argv 数组，不经 shell。MCP 版本差异用 initialize.protocolVersion 协商，工具列表用 tools/list，调用用 tools/call。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { CapabilityProvider, CapabilityImplementation, CapabilityContract, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, Json, JsonObject } from '../../sdk/types.js';
import { LineSplitter } from '../../sdk/transport.js';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';

const digest = (o: unknown) => 'sha256:' + createHash('sha256').update(Buffer.from(canonicalize(o) as string, 'utf8')).digest('hex');
const contractDigest = (c: any) => digest({ name: c.name, version: c.version, inputSchema: c.inputSchema, outputSchema: c.outputSchema, sideEffects: c.sideEffects, idempotent: c.idempotent, permissions: c.permissions ?? [] });
const MCP_OUTPUT_SCHEMA = { type: 'object', required: ['content'], properties: { content: { type: 'array', items: { type: 'object' } }, isError: { type: 'boolean' }, structuredContent: {} } };

export interface McpBridgeSpec { serverName: string; command: string; args?: string[]; env?: Record<string, string>; protocolVersion?: string; startupTimeoutMs?: number }

export class McpBridge implements CapabilityProvider {
  readonly id: string;
  private child?: ChildProcess; private nextId = 1; private pending = new Map<number, (v: any) => void>(); private splitter = new LineSplitter();
  private tools: Array<{ name: string; description?: string; inputSchema: JsonObject }> = [];
  contracts: CapabilityContract[] = [];
  constructor(private spec: McpBridgeSpec) { this.id = `mcp-bridge:${spec.serverName}`; }
  private toolContractName = (t: string) => `x.mcp.${this.spec.serverName}.${t}`.replace(/[^a-z0-9._]/gi, '_').toLowerCase();

  async start(): Promise<void> {
    const c = spawn(this.spec.command, this.spec.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(this.spec.env ?? {}) } });
    this.child = c; c.stdout!.setEncoding('utf8'); c.stdout!.on('data', (chunk: string) => this.splitter.push(chunk, l => { let o: any; try { o = JSON.parse(l); } catch { return; } if (o && o.id !== undefined && this.pending.has(o.id)) { const r = this.pending.get(o.id)!; this.pending.delete(o.id); r(o); } }));
    const init = await this.rpc('initialize', { protocolVersion: this.spec.protocolVersion ?? '2025-06-18', capabilities: {}, clientInfo: { name: 'cak-mcp-bridge', version: '0.3.0' } }, this.spec.startupTimeoutMs ?? 30000);   // npx 首次拉包会慢
    if (init.error) throw new Error(`MCP initialize failed: ${init.error.message}`);
    this.notify('notifications/initialized', {});
    const list = await this.rpc('tools/list', {});
    if (list.error) throw new Error(`MCP tools/list failed: ${list.error.message}`);
    this.tools = ((list.result?.tools ?? []) as typeof this.tools).map(t => { const { $schema: _drop, ...schema } = (t.inputSchema ?? { type: 'object' }) as any; return { ...t, inputSchema: schema }; });   // 去掉 draft-07 的 $schema，ajv2020 不认
    this.contracts = this.tools.map(t => { const c: any = { name: this.toolContractName(t.name), version: '1.0.0', description: `[MCP ${this.spec.serverName}] ${t.description ?? t.name}`, inputSchema: t.inputSchema ?? { type: 'object' }, outputSchema: MCP_OUTPUT_SCHEMA, permissions: ['mcp.call'], sideEffects: 'external', idempotent: false, async: false }; c.schemaDigest = contractDigest(c); return c as CapabilityContract; });
  }
  listContracts(): CapabilityContract[] { return this.contracts; }
  listImplementations(): CapabilityImplementation[] { return this.contracts.map(c => ({ providerId: this.id, contract: { name: c.name, version: c.version, schemaDigest: c.schemaDigest }, priority: 50, tags: ['mcp'] })); }
  async execute(inv: AuthorizedInvocation, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const tool = this.tools.find(t => this.toolContractName(t.name) === inv.contract.name);
    if (!tool) return { error: { code: 'ROUTING_ERROR', message: `no MCP tool for ${inv.contract.name}`, retryable: false } };
    const timeout = ctx.deadlineAtMs ? Math.max(1, ctx.deadlineAtMs - Date.now()) + 1000 : 30000;
    const r = await this.rpc('tools/call', { name: tool.name, arguments: inv.args as JsonObject }, timeout);
    if (r.error) return { error: { code: 'PROVIDER_ERROR', message: `MCP error ${r.error.code}: ${r.error.message}`, retryable: false } };
    const res = r.result ?? {};
    if (res.isError) return { error: { code: 'CAPABILITY_ERROR', message: String(res.content?.[0]?.text ?? 'MCP tool error'), retryable: false } };
    return { output: { content: res.content ?? [], isError: false, ...(res.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}) } as unknown as Json, usage: { units: { calls: 1 } } };
  }
  async stop() { this.child?.kill(); }
  private notify(method: string, params: JsonObject) { this.child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  private rpc(method: string, params: JsonObject, timeoutMs = 8000): Promise<any> {
    const id = this.nextId++;
    return new Promise(res => { this.pending.set(id, res); this.child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); setTimeout(() => { if (this.pending.delete(id)) res({ error: { code: -32000, message: `timeout ${method}` } }); }, timeoutMs); });
  }
}
