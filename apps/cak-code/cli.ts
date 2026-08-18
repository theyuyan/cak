#!/usr/bin/env tsx
/**
 * cak-code — 跑在 CAK 上的编程助手（极简终端 REPL）。
 *   npx tsx apps/cak-code/cli.ts [--workspace DIR] [--backend deepseek|anthropic] [--model NAME] [--session NAME] [--yes] [--reviewer http://127.0.0.1:8790] [--plugins-dir ~/.cak/plugins | --no-plugins] [--mcp "name=cmd args…"]…（另读 workspace/.mcp.json，与 Claude Code/Cursor 同格式）
 * 每条消息 = 一个 Task；写文件 / shell / commit 默认要审批（句柄 caveat），终端 y/N；账本落 ~/.cak/sessions/<session>.sqlite。
 */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import readline from 'node:readline';
import { Kernel } from '../../kernel/runtime/kernel.js';
import { SqliteLedgerStore, SqliteBlobStore } from '../../kernel/ledger/sqlite-store.js';
import { OpenAICompatBackend } from '../../plugins/builtin/openai-compat-backend.js';
import { AnthropicBackend } from '../../plugins/builtin/anthropic-backend.js';
import { WorkspaceProvider } from './workspace-provider.js';
import { codingController } from './controller.js';
import { buildSpec, type PluginGrant } from './spec.js';
import { loadOrCreateSigner } from './identity.js';
import { AgentInvokeProvider } from '../../plugins/builtin/index.js';
import { RemoteServeTarget, fetchCard, rpc } from '../../kernel/boundary/http.js';
import { verifyTaskReceipt } from '../../kernel/runtime/kernel.js';
import { loadInstalledPlugins } from '../../kernel/boundary/registry.js';
import { loadBuiltinContracts } from '../../kernel/contract/registry.js';
import { McpBridge } from '../../plugins/builtin/mcp-bridge.js';
import { loadMcpConfig, parseMcpFlag } from '../../plugins/builtin/mcp-config.js';
import { RegistryProvider, ensureRegistry, DEFAULT_REGISTRY_URL } from '../../kernel/boundary/registry-provider.js';
import type { LedgerEventView, Observer } from '../../sdk/types.js';

const argv = process.argv.slice(2); const flag = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; }; const has = (n: string) => argv.includes('--' + n);
const workspace = path.resolve(flag('workspace') ?? '.');
const backendName = flag('backend') ?? 'deepseek';
const modelName = flag('model') ?? (backendName === 'anthropic' ? 'claude-sonnet-5' : 'deepseek-chat');
const sessionName = flag('session') ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const home = path.join(os.homedir(), '.cak'); fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
const sessionFile = path.join(home, 'sessions', sessionName + '.history.jsonl');
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`; const bold = (s: string) => `\x1b[1m${s}\x1b[0m`; const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`; const red = (s: string) => `\x1b[31m${s}\x1b[0m`; const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

/** 终端观察者：把账本里的工具调用实时打出来（一行一件事，不画框） */
class TtyObserver implements Observer {
  readonly id = 'tty'; enabled = true; onReceipt?: (r: { root: string; sig: any; taskId: string }) => void;
  onEvent(e: LedgerEventView) {
    if (!this.enabled) return; const p = e.payload as any;
    if (e.type === 'invocation.requested' && !['model.generate', 'session.history'].includes(p.contract?.name)) process.stdout.write(dim(`  → ${p.contract.name} ${short(p.contract.name === 'file.edit' ? { path: p.args.path } : p.args)}`) + '\n');
    if (e.type === 'invocation.denied') process.stdout.write(red(`  ✗ ${p.code}: ${p.reason}`) + '\n');
    if (e.type === 'invocation.failed') process.stdout.write(red(`  ✗ ${p.error?.code}: ${String(p.error?.message).slice(0, 200)}`) + '\n');
    if (e.type === 'invocation.executed' && p.output && typeof p.output === 'object' && 'exitCode' in p.output) process.stdout.write(dim(`  ← exit ${p.output.exitCode}${p.output.stdout ? '\n' + indent(String(p.output.stdout).slice(0, 1200)) : ''}${p.output.stderr ? '\n' + indent(red(String(p.output.stderr).slice(0, 600))) : ''}`) + '\n');
    if (e.type === 'invocation.executed' && p.output && typeof p.output === 'object' && 'receipt' in p.output && p.output.output && typeof p.output.output === 'object' && 'verdict' in p.output.output) { const o = p.output.output; const col = o.verdict === 'approve' ? green : o.verdict === 'request_changes' ? red : yellow; process.stdout.write(col(`  ⚖ 审查 ${o.verdict}：${o.summary}`) + '\n' + (o.findings ?? []).map((f: any) => dim(`     · [${f.severity}] ${f.file ?? ''}${f.line ? ':' + f.line : ''} ${f.message}`)).join('\n') + ((o.findings ?? []).length ? '\n' : '')); this.onReceipt?.(p.output.receipt); }
    if (e.type === 'invocation.executed' && p.output && typeof p.output === 'object' && 'elements' in p.output && 'title' in p.output) process.stdout.write(dim(`  ← 浏览器「${String(p.output.title).slice(0, 60)}」 ${String(p.output.url).slice(0, 80)} · ${p.output.elements.length} 个可交互元素 · 正文 ${String(p.output.text).length} 字`) + '\n');
    if (e.type === 'invocation.executed' && p.output && typeof p.output === 'object' && 'status' in p.output && 'body' in p.output) process.stdout.write(dim(`  ← HTTP ${p.output.status} ${p.output.title ? '「' + String(p.output.title).slice(0, 60) + '」' : ''} ${p.output.bytes} B${p.output.truncated ? '（截断）' : ''}`) + '\n');
    if (e.type === 'invocation.executed' && p.output && typeof p.output === 'object' && Array.isArray(p.output.content) && 'isError' in p.output) process.stdout.write(dim(`  ← MCP ${String(p.output.content?.[0]?.text ?? JSON.stringify(p.output.structuredContent ?? '')).replace(/\s+/g, ' ').slice(0, 160)}`) + '\n');
    if (e.type === 'invocation.executed' && p.output && typeof p.output === 'object' && 'installed' in p.output && 'passed' in p.output) process.stdout.write((p.output.installed ? green : red)(`  ${p.output.installed ? '✔' : '✗'} 插件 ${p.output.id}：${p.output.message ?? ''}`) + '\n');
    if (e.type === 'invocation.executed' && p.output && typeof p.output === 'object' && 'replacements' in p.output) process.stdout.write(green(`  ✔ 编辑 ${p.output.path}（替换 ${p.output.replacements} 处）`) + '\n');
    if (e.type === 'invocation.executed' && p.output && typeof p.output === 'object' && 'created' in p.output) process.stdout.write(green(`  ✔ 写入 ${p.output.path}（${p.output.bytes} B）`) + '\n');
  }
}
const short = (a: unknown) => { const s = JSON.stringify(a); return s.length > 140 ? s.slice(0, 140) + '…' : s; };
const indent = (s: string) => s.split('\n').map(l => '    ' + l).join('\n');

/** 「始终允许这类」的收窄规则：由本次调用推导，打给用户看再铸（N-28）。shell 只放行同样的前两个 argv 词；文件只放行同目录；commit 全放行 */
function standingRule(contract: string, args: Record<string, unknown>): { caveats: import('../../sdk/types.js').Caveat[]; human: string } | undefined {
  if (contract === 'shell.exec') { const argv = Array.isArray(args['argv']) ? (args['argv'] as string[]) : []; if (!argv.length) return undefined; const head = argv.slice(0, Math.min(2, argv.length)); return { caveats: [{ kind: 'args.match', schema: { type: 'object', required: ['argv'], properties: { argv: { type: 'array', minItems: head.length, prefixItems: head.map(x => ({ const: x })) } } } }], human: `shell.exec 以「${head.join(' ')}」开头的命令` }; }
  if (contract === 'file.edit' || contract === 'file.write') { const pth = String(args['path'] ?? ''); if (!pth) return undefined; const dir = path.posix.dirname(pth.replace(/\\/g, '/')); const prefix = dir === '.' ? pth : dir + '/'; return { caveats: [{ kind: 'args.prefix', path: 'path', prefix }], human: `${contract} 路径以「${prefix}」开头` }; }
  if (contract === 'http.fetch') { let origin = ''; try { origin = new URL(String(args['url'])).origin + '/'; } catch { return undefined; } return { caveats: [{ kind: 'args.prefix', path: 'url', prefix: origin }], human: `http.fetch 地址以「${origin}」开头` }; }
  if (contract.startsWith('x.mcp.')) return { caveats: [], human: `MCP 工具 ${contract}（任何参数）` };
  if (contract === 'browser.open') { let origin = ''; try { origin = new URL(String(args['url'])).origin + '/'; } catch { return undefined; } return { caveats: [{ kind: 'args.prefix', path: 'url', prefix: origin }], human: `browser.open 地址以「${origin}」开头` }; }
  if (contract === 'browser.act' || contract === 'browser.snapshot') return { caveats: [], human: `${contract}（当前页面内任何操作）` };
  if (contract === 'web.search') return { caveats: [], human: 'web.search（任何搜索）' };
  if (contract === 'git.commit') return { caveats: [], human: 'git.commit（任何提交）' };
  return undefined;
}
const STANDING_TTL_MS = 12 * 3600 * 1000;
const backend = backendName === 'anthropic' ? new AnthropicBackend({ apiKeyRef: 'ANTHROPIC_API_KEY', model: modelName }) : new OpenAICompatBackend('deepseek', { baseUrl: 'https://api.deepseek.com', model: modelName, apiKeyRef: 'file:~/.cak/secrets/deepseek.key' });
const reviewerUrl = flag('reviewer');
const reviewerCard = reviewerUrl ? await fetchCard(reviewerUrl).catch(e => { console.error(red(`  ✗ 取不到审查 agent 名片 ${reviewerUrl}: ${(e as Error).message}`)); process.exit(2); }) : undefined;
if (reviewerCard && !(reviewerCard as any).provides?.some((c: any) => c.name === 'code.review')) { console.error(red(`  ✗ ${reviewerUrl} 的名片不提供 code.review`)); process.exit(2); }
// 已安装插件（cak add 装到 ~/.cak/plugins，全部子进程）：默认装载；--no-plugins 关闭
const pluginsDir = has('no-plugins') ? undefined : path.resolve(flag('plugins-dir') ?? path.join(home, 'plugins'));
// MCP servers：workspace/.mcp.json + --mcp 参数（可重复）；每个起一座桥，工具映射为 x.mcp.<server>.<tool> 契约（默认要审批，s 可常设放行某个工具）
const mcpSpecs = [...(has('no-mcp') ? { specs: [], skipped: [] } : loadMcpConfig(workspace)).specs, ...argv.map((a, i) => a === '--mcp' ? argv[i + 1] : undefined).filter((x): x is string => !!x).map(parseMcpFlag).filter((x): x is NonNullable<typeof x> => !!x)];
const bridges: McpBridge[] = [];
for (const m of mcpSpecs) { const b = new McpBridge(m); try { await b.start(); bridges.push(b); } catch (e) { console.error(red(`  ✗ MCP ${m.serverName} 启动失败：${(e as Error).message}`)); } }
// 注册表 Provider（plugin.search 免审批 / plugin.install 审批）：默认 ~/.cak/registry，自动 clone/拉取；--registry DIR 指定本地目录；--no-registry 关闭
const registryDir = has('no-registry') ? undefined : path.resolve(flag('registry') ?? path.join(home, 'registry'));
let registryNote: string | undefined;
if (registryDir && !flag('registry')) { const r = await ensureRegistry(registryDir, DEFAULT_REGISTRY_URL); registryNote = r.note; }
const registryReady = !!registryDir && fs.existsSync(path.join(registryDir, 'index.json'));
if (registryDir && !registryReady) console.error(yellow(`  △ 注册表不可用（${registryNote ?? '没有 index.json'}）：本次不提供 plugin.search / plugin.install。可 --registry <本地目录> 指定，或先 git clone ${DEFAULT_REGISTRY_URL} ${registryDir}`));
let pluginsChanged = false;
const registryProvider = registryReady && pluginsDir ? new RegistryProvider({ registryDir: registryDir!, installDir: pluginsDir, onInstalled: () => { pluginsChanged = true; } }) : undefined;
const builtinBySide = new Map(loadBuiltinContracts().map(c => [`${c.name}@${c.version}`, c.sideEffects]));
const provider = new WorkspaceProvider(workspace, { sessionFile });
const tty = new TtyObserver();
const signer = loadOrCreateSigner(path.join(home, 'identity', 'cak-code'), { kind: 'agent', id: 'cak-code' });
const ledgerStore = new SqliteLedgerStore(path.join(home, 'sessions', sessionName + '.sqlite'));
const blobStore = new SqliteBlobStore(path.join(home, 'sessions', sessionName + '.sqlite'));   // 大结果落盘：同一文件的 blobs 表
let installed: Awaited<ReturnType<typeof loadInstalledPlugins>> = [];
/** 装载插件 → 算 grants → 建 spec → compose。装了新插件后再调一次：同一账本重开，N-37 会给新契约补铸根句柄 = 热加载 */
async function composeKernel() {
  for (const p of installed) await p.stop().catch(() => {});
  installed = pluginsDir && fs.existsSync(pluginsDir) ? await loadInstalledPlugins(pluginsDir, { env: { CAK_WORKSPACE: workspace } }) : [];   // 插件拿到工作区根：带路径的能力只在其内解析（第一道墙）
  const pathy = new Set(loadBuiltinContracts().filter(c => (c.inputSchema as any)?.properties?.path).map(c => `${c.name}@${c.version}`));
  const pluginGrants: PluginGrant[] = installed.flatMap(p => p.listImplementations().map(i => ({ contract: i.contract.name, version: i.contract.version, sideEffects: builtinBySide.get(`${i.contract.name}@${i.contract.version}`) ?? 'external', pathArg: pathy.has(`${i.contract.name}@${i.contract.version}`) })));
  for (const b of bridges) for (const c of b.listContracts()) pluginGrants.push({ contract: c.name, version: c.version, sideEffects: c.sideEffects });
  if (registryProvider) pluginGrants.push({ contract: 'plugin.search', version: '1.0.0', sideEffects: 'read' }, { contract: 'plugin.install', version: '1.0.0', sideEffects: 'write' });
  const hasMemory = pluginGrants.some(g => g.contract === 'memory.search');
  const spec = buildSpec({ backend: backendName === 'anthropic' ? 'anthropic' : 'deepseek', model: modelName, workspaceName: path.basename(workspace), reviewer: !!reviewerCard, pluginGrants, memory: hasMemory, registry: !!registryProvider });
  const providers = [provider, ...installed, ...bridges, ...(registryProvider ? [registryProvider] : []), ...(reviewerUrl ? [new AgentInvokeProvider({ 'cak-review': new RemoteServeTarget(reviewerUrl) })] : [])];
  const kk = await Kernel.compose(spec, { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: backend, anthropic: backend }, providers, observers: [tty] }, { ledgerStore, blobStore, signer });
  if (reviewerCard) kk.trustPeer(reviewerCard as any);   // 信任审查方公钥：以后它签的回执才验得过
  return kk;
}
let k = await composeKernel();
if (reviewerCard) {
  // 回执核验：跨进程拉审查方该 task 的事件，Merkle 根 + 签名都对上才算"这份结论确实出自 cak-review 且未被改"
  tty.onReceipt = async r => { try { const ev = await rpc(reviewerUrl!, 'agent.receipt', { taskId: r.taskId }); const events = ((ev.result as any)?.events ?? []) as Array<{ hash: string; type: string }>; const idx = events.findIndex(e => e.type === 'receipt.issued'); const covered = idx >= 0 ? events.slice(0, idx) : events; const ok = verifyTaskReceipt({ taskId: r.taskId, events: covered, root: r.root, sig: r.sig }, k.signer as any); process.stdout.write((ok ? green : red)(`  ${ok ? '✔' : '✗'} 回执${ok ? '已验' : '验证失败'}：cak-review task ${r.taskId}，${covered.length} 事件，root ${r.root.slice(0, 23)}…`) + '\n'); } catch (e) { process.stdout.write(red(`  ✗ 回执核验出错：${(e as Error).message}`) + '\n'); } };
}

console.log(`${bold('cak-code')} ${dim(`· ${backendName}/${modelName} · workspace ${workspace} · session ${sessionName}${reviewerUrl ? ` · 审查 ${reviewerUrl}（${(reviewerCard as any).principal?.id}）` : ''}${installed.length ? ` · 插件 ${installed.map(p => p.id).join(',')}` : ''}${bridges.length ? ` · MCP ${bridges.map(b => `${b.id.replace('mcp-bridge:', '')}(${b.listContracts().length} 工具)`).join(',')}` : ''}${registryProvider ? ' · 注册表 ✓' : registryDir ? ' · 注册表 ✗' : ''}`)}`);
console.log(dim('  读类工具直接执行；写文件 / 执行命令 / 提交默认要你审批。输入 /quit 退出，/status 看状态，/report 看用量，/handles 看常设授权，/revoke <id> 撤销。'));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>(res => rl.question(q, res));
const oneShot = flag('task');   // --task "…"：非交互跑一条（配合 --yes 全批 / 不带 --yes 则拒绝需审批的操作）

for (;;) {
  const line = oneShot ?? (await ask(bold('\n› '))).trim(); if (!line) continue;
  if (line === '/quit' || line === '/exit') break;
  if (line === '/status') { const standing = k.controlPlane().handles().filter(h => h.expiresAt && h.contract.name !== 'model.generate' && !h.caveats.some(c => c.kind === 'requires-approval')); console.log(`  session   ${sessionName}\n  workspace ${workspace}\n  模型      ${backendName}/${modelName}\n  插件      ${installed.map(p => p.id).join(', ') || '（无）'}\n  MCP       ${bridges.map(b => b.id.replace('mcp-bridge:', '')).join(', ') || '（无）'}\n  账本事件  ${k.ledger.head().seq} 条 · ${path.join(home, 'sessions', sessionName + '.sqlite')}\n  常设句柄  ${standing.length} 个（/handles 看明细）`); continue; }
  if (line === '/handles') { const hs = k.controlPlane().handles(); for (const h of hs) console.log(`  ${h.id}  ${h.contract.name}  ${h.caveats.map(c => c.kind === 'requires-approval' ? '需审批' : c.kind === 'args.prefix' ? `${c.path}以${c.prefix}开头` : c.kind === 'args.match' ? `argv 前缀 ${JSON.stringify(((c.schema as any).properties?.argv?.prefixItems ?? []).map((x: any) => x.const))}` : c.kind).join('；') || '无限制'}${h.expiresAt ? '  到期 ' + h.expiresAt : ''}`); continue; }
  if (line.startsWith('/revoke ')) { const id = line.slice(8).trim(); try { k.controlPlane().revoke(id, 'cak-code: 用户撤销'); console.log(dim(`  ✔ 已撤销 ${id}`)); } catch (e) { console.log(red(`  ✗ ${(e as Error).message}`)); } continue; }
  if (line === '/report') { const r = k.usageReport(); console.log(JSON.stringify({ contracts: r.contracts, events: r.events }, null, 1)); continue; }
  fs.appendFileSync(sessionFile, JSON.stringify({ role: 'user', content: line }) + '\n');
  let res = await k.startTask(line, { input: line });
  while (res.status === 'suspended') {
    const pend = k.pendingApprovals(res.taskId);
    if (!pend.length) break;
    for (const p of pend) {
      const inv = k.ledger.projections().invocations[p.invocationId]!;
      console.log(yellow(`\n  需要审批：${p.contract.name} ${short(inv.args)}`));
      if (inv.contract.name === 'file.edit') console.log(dim(indent(String(inv.args['oldText']).split('\n').map(l => red('- ' + l)).concat(String(inv.args['newText']).split('\n').map(l => green('+ ' + l))).join('\n'))));
      if (inv.contract.name === 'file.write') { const cur = fs.existsSync(path.join(workspace, String(inv.args['path']))) ? fs.readFileSync(path.join(workspace, String(inv.args['path'])), 'utf8') : ''; console.log(dim(indent(miniDiff(cur, String(inv.args['content']))))); }
      const rule = standingRule(inv.contract.name, inv.args as Record<string, unknown>);
      const ans = has('yes') ? 'y' : oneShot ? 'n' : (await ask(yellow(`  允许？[y/N/a=本轮全批${rule ? '/s=本会话始终允许这类' : ''}] `))).trim().toLowerCase();
      if (ans === 'a') { for (const q of pend) k.grant(q.approvalId, { kind: 'user', id: os.userInfo().username }); break; }
      if (ans === 's' && rule) { const h = k.controlPlane().standing({ name: inv.contract.name }, rule.caveats, { by: { kind: 'user', id: os.userInfo().username }, reason: 'cak-code: 用户选择「本会话始终允许这类」', expiresAt: new Date(Date.now() + STANDING_TTL_MS).toISOString() }); console.log(dim(`  ✔ 已铸常设句柄 ${h.id}：${rule.human}，12 小时内不再问；/handles 查看，/revoke ${h.id} 撤销`)); k.grant(p.approvalId, { kind: 'user', id: os.userInfo().username }); continue; }
      if (ans === 'y') k.grant(p.approvalId, { kind: 'user', id: os.userInfo().username }); else k.deny(p.approvalId, { kind: 'user', id: os.userInfo().username }, '用户拒绝');
    }
    res = await k.resume(res.taskId);
  }
  const answer = typeof res.output === 'string' ? res.output : JSON.stringify(res.output ?? res.status);
  console.log('\n' + answer);
  fs.appendFileSync(sessionFile, JSON.stringify({ role: 'assistant', content: answer }) + '\n');
  const u = k.ledger.projections().usageByTask[res.taskId];
  const cached = Object.values(k.ledger.projections().invocations).filter(i => i.taskId === res.taskId).reduce((n, i) => n + Number((i.usage?.units?.custom as any)?.cachedInputTokens ?? 0), 0);
  if (u) console.log(dim(`  · ${res.status} · calls ${u.calls} · tokens ${u.inputTokens}/${u.outputTokens}${cached ? `（缓存命中 ${Math.round(cached / Math.max(1, u.inputTokens) * 100)}%）` : ''} · 账本 ${k.ledger.head().seq} 条`));
  if (pluginsChanged) { pluginsChanged = false; k = await composeKernel(); console.log(green(`  ✔ 已热加载插件：${installed.map(p => p.id).join(', ') || '（无）'}`)); }
  if (oneShot) break;
}
rl.close(); for (const b of bridges) await b.stop().catch(() => {});
console.log(dim(`账本：${path.join(home, 'sessions', sessionName + '.sqlite')}`));
process.exit(0);

function miniDiff(a: string, b: string): string {
  const A = a.split('\n'), B = b.split('\n'); const out: string[] = []; const n = Math.max(A.length, B.length); let shown = 0;
  for (let i = 0; i < n && shown < 40; i++) { if (A[i] === B[i]) continue; if (A[i] !== undefined) out.push(red('- ' + A[i])); if (B[i] !== undefined) out.push(green('+ ' + B[i])); shown++; }
  return out.length ? out.join('\n') : green(`+ (新文件 ${B.length} 行)`);
}
