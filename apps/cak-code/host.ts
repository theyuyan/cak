/**
 * cak-code · 宿主（Host）：把「组装内核 + 已装插件 + MCP + 注册表 + 审查方 + 会话账本」从任何前端里抽出来。
 * 前端（REPL / daemon+TUI / 桌面）只做两件事：喂输入、处理审批；其余全在这里。同一套 Host 被 cli.ts（内嵌形态）与 daemon.ts（常驻形态）共用。
 */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Kernel, verifyTaskReceipt } from '../../kernel/runtime/kernel.js';
import { SqliteLedgerStore, SqliteBlobStore } from '../../kernel/ledger/sqlite-store.js';
import { OpenAICompatBackend } from '../../plugins/builtin/openai-compat-backend.js';
import { AnthropicBackend } from '../../plugins/builtin/anthropic-backend.js';
import { WorkspaceProvider } from './workspace-provider.js';
import { codingController } from './controller.js';
import { buildSpec, type PluginGrant } from './spec.js';
import { loadOrCreateSigner } from './identity.js';
import { AgentInvokeProvider } from '../../plugins/builtin/index.js';
import { RemoteServeTarget, fetchCard, rpc } from '../../kernel/boundary/http.js';
import { loadInstalledPlugins } from '../../kernel/boundary/registry.js';
import { loadBuiltinContracts } from '../../kernel/contract/registry.js';
import { McpBridge, type McpBridgeSpec } from '../../plugins/builtin/mcp-bridge.js';
import { loadMcpConfig } from '../../plugins/builtin/mcp-config.js';
import { RegistryProvider, ensureRegistry, DEFAULT_REGISTRY_URL } from '../../kernel/boundary/registry-provider.js';
import type { Observer, Caveat, Principal, ModelBackend } from '../../sdk/types.js';

export const STANDING_TTL_MS = 12 * 3600 * 1000;

/** 「始终允许这类」的收窄规则：由本次调用推导，打给用户看再铸（N-28）。shell 只放行同样的前两个 argv 词；文件只放行同目录；commit 全放行 */
export function standingRule(contract: string, args: Record<string, unknown>): { caveats: Caveat[]; human: string } | undefined {
  if (contract === 'shell.exec') { const argv = Array.isArray(args['argv']) ? (args['argv'] as string[]) : []; if (!argv.length) return undefined; const head = argv.slice(0, Math.min(2, argv.length)); return { caveats: [{ kind: 'args.match', schema: { type: 'object', required: ['argv'], properties: { argv: { type: 'array', minItems: head.length, prefixItems: head.map(x => ({ const: x })) } } } }], human: `shell.exec 以「${head.join(' ')}」开头的命令` }; }
  if (contract === 'file.edit' || contract === 'file.write') { const pth = String(args['path'] ?? ''); if (!pth) return undefined; const dir = path.posix.dirname(pth.replace(/\\/g, '/')); const prefix = dir === '.' ? pth : dir + '/'; return { caveats: [{ kind: 'args.prefix', path: 'path', prefix }], human: `${contract} 路径以「${prefix}」开头` }; }
  if (contract === 'http.fetch' || contract === 'browser.open') { let origin = ''; try { origin = new URL(String(args['url'])).origin + '/'; } catch { return undefined; } return { caveats: [{ kind: 'args.prefix', path: 'url', prefix: origin }], human: `${contract} 地址以「${origin}」开头` }; }
  if (contract.startsWith('x.mcp.')) return { caveats: [], human: `MCP 工具 ${contract}（任何参数）` };
  if (contract === 'browser.act' || contract === 'browser.snapshot') return { caveats: [], human: `${contract}（当前页面内任何操作）` };
  if (contract === 'github.issue.create') { const repo = String(args['repo'] ?? ''); if (!repo) return undefined; return { caveats: [{ kind: 'args.match', schema: { type: 'object', required: ['repo'], properties: { repo: { const: repo } } } }], human: `github.issue.create 仓库「${repo}」` }; }
  if (contract === 'notify.send') { const ch = String(args['channel'] ?? ''); if (!ch) return undefined; return { caveats: [{ kind: 'args.match', schema: { type: 'object', required: ['channel'], properties: { channel: { const: ch } } } }], human: `notify.send 渠道「${ch}」` }; }
  if (contract === 'web.search') return { caveats: [], human: 'web.search（任何搜索）' };
  if (contract === 'git.commit') return { caveats: [], human: 'git.commit（任何提交）' };
  return undefined;
}

export interface HostOptions {
  workspace: string; backend: 'deepseek' | 'anthropic'; model?: string; session?: string;
  reviewerUrl?: string; pluginsDir?: string | null; mcp?: { fromWorkspace?: boolean; extra?: McpBridgeSpec[] } | null; registryDir?: string | null;
  observers?: Observer[]; note?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** 测试/嵌入用：直接给模型后端实例（不读 key 文件） */ backendImpl?: ModelBackend;
  /** 模型正文流式增量（前端显示用） */ onModelDelta?: (e: { taskId: string; invocationId: string; text: string }) => void;
}
export interface ApprovalView { approvalId: string; invocationId: string; contract: string; args: Record<string, unknown>; diff?: string; rule?: { human: string; caveats: Caveat[] } }

export async function createHost(o: HostOptions) {
  const note = o.note ?? (() => {});
  const home = path.join(os.homedir(), '.cak'); fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const workspace = path.resolve(o.workspace); const backendName = o.backend; const modelName = o.model ?? (backendName === 'anthropic' ? 'claude-sonnet-5' : 'deepseek-chat');
  const sessionName = o.session ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const sessionFile = path.join(home, 'sessions', sessionName + '.history.jsonl');
  const backend: ModelBackend = o.backendImpl ?? (backendName === 'anthropic' ? new AnthropicBackend({ apiKeyRef: 'ANTHROPIC_API_KEY', model: modelName }) : new OpenAICompatBackend('deepseek', { baseUrl: 'https://api.deepseek.com', model: modelName, apiKeyRef: 'file:~/.cak/secrets/deepseek.key' }));
  // 审查方
  const reviewerUrl = o.reviewerUrl; let reviewerCard: any;
  if (reviewerUrl) { reviewerCard = await fetchCard(reviewerUrl); if (!reviewerCard?.provides?.some((c: any) => c.name === 'code.review')) throw new Error(`${reviewerUrl} 的名片不提供 code.review`); }
  // 插件目录 / MCP / 注册表
  const pluginsDir = o.pluginsDir === null ? undefined : path.resolve(o.pluginsDir ?? path.join(home, 'plugins'));
  const mcpSpecs = o.mcp === null ? [] : [...(o.mcp?.fromWorkspace === false ? [] : loadMcpConfig(workspace).specs), ...(o.mcp?.extra ?? [])];
  const bridges: McpBridge[] = [];
  for (const m of mcpSpecs) { const b = new McpBridge(m); try { await b.start(); bridges.push(b); } catch (e) { note('error', `MCP ${m.serverName} 启动失败：${(e as Error).message}`); } }
  const registryDir = o.registryDir === null ? undefined : path.resolve(o.registryDir ?? path.join(home, 'registry'));
  let registryNote: string | undefined; if (registryDir && !o.registryDir) { const r = await ensureRegistry(registryDir, DEFAULT_REGISTRY_URL); registryNote = r.note; }
  const registryReady = !!registryDir && fs.existsSync(path.join(registryDir, 'index.json'));
  if (registryDir && !registryReady) note('warn', `注册表不可用（${registryNote ?? '没有 index.json'}）：本次不提供 plugin.search / plugin.install。可指定本地目录，或先 git clone ${DEFAULT_REGISTRY_URL} ${registryDir}`);
  let pluginsChanged = false;
  const registryProvider = registryReady && pluginsDir ? new RegistryProvider({ registryDir: registryDir!, installDir: pluginsDir, onInstalled: () => { pluginsChanged = true; } }) : undefined;
  const builtin = loadBuiltinContracts(); const builtinBySide = new Map(builtin.map(c => [`${c.name}@${c.version}`, c.sideEffects]));
  const pathy = new Set(builtin.filter(c => (c.inputSchema as any)?.properties?.path && (c.permissions ?? []).some(p => String(p).startsWith('fs.'))).map(c => `${c.name}@${c.version}`));   // 只有 fs.* 权限的 path 才是文件路径
  const provider = new WorkspaceProvider(workspace, { sessionFile });
  const signer = loadOrCreateSigner(path.join(home, 'identity', 'cak-code'), { kind: 'agent', id: 'cak-code' });
  const ledgerFile = path.join(home, 'sessions', sessionName + '.sqlite');
  const ledgerStore = new SqliteLedgerStore(ledgerFile); const blobStore = new SqliteBlobStore(ledgerFile);
  let installed: Awaited<ReturnType<typeof loadInstalledPlugins>> = [];
  async function composeKernel() {
    for (const p of installed) await p.stop().catch(() => {});
    installed = pluginsDir && fs.existsSync(pluginsDir) ? await loadInstalledPlugins(pluginsDir, { env: { CAK_WORKSPACE: workspace } }) : [];
    const pluginGrants: PluginGrant[] = installed.flatMap(p => p.listImplementations().map(i => ({ contract: i.contract.name, version: i.contract.version, sideEffects: builtinBySide.get(`${i.contract.name}@${i.contract.version}`) ?? 'external', pathArg: pathy.has(`${i.contract.name}@${i.contract.version}`) })));
    for (const b of bridges) for (const c of b.listContracts()) pluginGrants.push({ contract: c.name, version: c.version, sideEffects: c.sideEffects });
    if (registryProvider) pluginGrants.push({ contract: 'plugin.search', version: '1.0.0', sideEffects: 'read' }, { contract: 'plugin.install', version: '1.0.0', sideEffects: 'write' });
    const spec = buildSpec({ backend: backendName, model: modelName, workspaceName: path.basename(workspace), reviewer: !!reviewerCard, pluginGrants, memory: pluginGrants.some(g => g.contract === 'memory.search'), registry: !!registryProvider });
    const providers = [provider, ...installed, ...bridges, ...(registryProvider ? [registryProvider] : []), ...(reviewerUrl ? [new AgentInvokeProvider({ 'cak-review': new RemoteServeTarget(reviewerUrl) })] : [])];
    const kk = await Kernel.compose(spec, { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: backend, anthropic: backend }, providers, observers: o.observers ?? [] }, { ledgerStore, blobStore, signer, ...(o.onModelDelta ? { onModelDelta: o.onModelDelta } : {}) });
    if (reviewerCard) kk.trustPeer(reviewerCard);
    return kk;
  }
  let k = await composeKernel();
  const by = (): Principal => ({ kind: 'user', id: os.userInfo().username });
  const host = {
    get k() { return k; }, workspace, home, sessionName, sessionFile, ledgerFile, backendName, modelName, reviewerUrl, reviewerCard,
    get installed() { return installed; }, bridges, registryProvider, registryDir,
    banner() { return `${backendName}/${modelName} · workspace ${workspace} · session ${sessionName}${reviewerUrl ? ` · 审查 ${reviewerUrl}（${reviewerCard?.principal?.id}）` : ''}${installed.length ? ` · 插件 ${installed.map(p => p.id).join(',')}` : ''}${bridges.length ? ` · MCP ${bridges.map(b => `${b.id.replace('mcp-bridge:', '')}(${b.listContracts().length} 工具)`).join(',')}` : ''}${registryProvider ? ' · 注册表 ✓' : registryDir ? ' · 注册表 ✗' : ''}`; },
    /** 装了新插件就同账本重组（N-37 补铸新契约句柄 = 热加载）；返回是否重组过 */
    async recomposeIfNeeded() { if (!pluginsChanged) return false; pluginsChanged = false; k = await composeKernel(); return true; },
    /** 待审批视图（给任何前端）：契约、参数、diff 文本、可推导的常设规则 */
    pending(taskId?: string): ApprovalView[] {
      return k.pendingApprovals(taskId).map(p => { const inv = k.ledger.projections().invocations[p.invocationId]!; const args = inv.args as Record<string, unknown>; let diff: string | undefined;
        if (inv.contract.name === 'file.edit') diff = String(args['oldText']).split('\n').map(l => '- ' + l).concat(String(args['newText']).split('\n').map(l => '+ ' + l)).join('\n');
        if (inv.contract.name === 'file.write') { const f = path.join(workspace, String(args['path'])); const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; diff = miniDiff(cur, String(args['content'])); }
        const rule = standingRule(inv.contract.name, args); return { approvalId: p.approvalId, invocationId: p.invocationId, contract: inv.contract.name, args, ...(diff ? { diff } : {}), ...(rule ? { rule } : {}) }; });
    },
    /** 审批决定：grant / deny / standing（新铸窄常设句柄 + grant 本次） */
    decide(approvalId: string, decision: 'grant' | 'deny' | 'standing', reason?: string) {
      const p = k.pendingApprovals().find(x => x.approvalId === approvalId); if (!p) throw new Error(`no pending approval ${approvalId}`);
      if (decision === 'deny') { k.deny(approvalId, by(), reason ?? '用户拒绝'); return { ok: true as const }; }
      if (decision === 'standing') { const inv = k.ledger.projections().invocations[p.invocationId]!; const rule = standingRule(inv.contract.name, inv.args as Record<string, unknown>); if (!rule) throw new Error('该调用无法推导常设规则'); const h = k.controlPlane().standing({ name: inv.contract.name }, rule.caveats, { by: by(), reason: 'cak-code: 用户选择「本会话始终允许这类」', expiresAt: new Date(Date.now() + STANDING_TTL_MS).toISOString() }); k.grant(approvalId, by()); return { ok: true as const, standing: { handleId: h.id, human: rule.human } }; }
      k.grant(approvalId, by()); return { ok: true as const };
    },
    /** 一条用户输入 = 一个 task；返回首个结果（可能 suspended，等前端 decide 后 resume） */
    async submit(text: string) { fs.appendFileSync(sessionFile, JSON.stringify({ role: 'user', content: text }) + '\n'); return k.startTask(text, { input: text }); },
    async resume(taskId: string) { return k.resume(taskId); },
    recordAnswer(text: string) { fs.appendFileSync(sessionFile, JSON.stringify({ role: 'assistant', content: text }) + '\n'); },
    usageOf(taskId: string) { const u = k.ledger.projections().usageByTask[taskId]; const cached = Object.values(k.ledger.projections().invocations).filter(i => i.taskId === taskId).reduce((n, i) => n + Number((i.usage?.units?.custom as any)?.cachedInputTokens ?? 0), 0); return u ? { ...u, cachedInputTokens: cached, cacheHitPct: Math.round(cached / Math.max(1, u.inputTokens) * 100), ledgerSeq: k.ledger.head().seq } : undefined; },
    /** 审查回执核验：跨进程拉审查方该 task 的事件，Merkle 根 + 签名都对上才算 */
    async verifyReviewReceipt(r: { root: string; sig: any; taskId: string }) { if (!reviewerUrl) return { ok: false, events: 0 }; const ev = await rpc(reviewerUrl, 'agent.receipt', { taskId: r.taskId }); const events = ((ev.result as any)?.events ?? []) as Array<{ hash: string; type: string }>; const idx = events.findIndex(e => e.type === 'receipt.issued'); const covered = idx >= 0 ? events.slice(0, idx) : events; return { ok: verifyTaskReceipt({ taskId: r.taskId, events: covered, root: r.root, sig: r.sig }, k.signer as any), events: covered.length }; },
    status() { const standing = k.controlPlane().handles().filter(h => h.expiresAt && h.contract.name !== 'model.generate' && !h.caveats.some(c => c.kind === 'requires-approval')); return { session: sessionName, workspace, backend: backendName, model: modelName, plugins: installed.map(p => p.id), mcp: bridges.map(b => b.id.replace('mcp-bridge:', '')), registry: !!registryProvider, reviewer: reviewerUrl ?? null, ledgerSeq: k.ledger.head().seq, ledgerFile, standingHandles: standing.length }; },
    async close() { for (const b of bridges) await b.stop().catch(() => {}); for (const p of installed) await p.stop().catch(() => {}); },
  };
  return host;
}
export type Host = Awaited<ReturnType<typeof createHost>>;

export function miniDiff(a: string, b: string): string {
  const A = a.split('\n'), B = b.split('\n'); const out: string[] = []; const n = Math.max(A.length, B.length); let shown = 0;
  for (let i = 0; i < n && shown < 40; i++) { if (A[i] === B[i]) continue; if (A[i] !== undefined) out.push('- ' + A[i]); if (B[i] !== undefined) out.push('+ ' + B[i]); shown++; }
  return out.length ? out.join('\n') : `+ (新文件 ${B.length} 行)`;
}
