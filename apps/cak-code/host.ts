/**
 * cak-code · 宿主（Host）：把「组装内核 + 已装插件 + MCP + 注册表 + 审查方 + 会话账本」从任何前端里抽出来。
 * 前端（REPL / daemon+TUI / 桌面）只做两件事：喂输入、处理审批；其余全在这里。同一套 Host 被 cli.ts（内嵌形态）与 daemon.ts（常驻形态）共用。
 */
import fs from 'node:fs'; import { spawnSync } from 'node:child_process'; import os from 'node:os'; import path from 'node:path';
import { Kernel, verifyTaskReceipt } from '../../kernel/runtime/kernel.js';
import { SqliteLedgerStore, SqliteBlobStore } from '../../kernel/ledger/sqlite-store.js';
import { OpenAICompatBackend } from '../../plugins/builtin/openai-compat-backend.js';
import { AnthropicBackend } from '../../plugins/builtin/anthropic-backend.js';
import { WorkspaceProvider } from './workspace-provider.js';
import { codingController } from './controller.js';
import { mergeDynamic, type PluginGrant } from './spec.js';
import { loadProfile, ensureProfiles } from './profiles.js';
import { reviewController } from '../cak-review/controller.js';
import { simpleReact, planExecute } from '../../plugins/builtin/index.js';
import { loadOrCreateSigner } from './identity.js';
import { AgentInvokeProvider, type ServeTarget } from '../../plugins/builtin/index.js';
import { RemoteServeTarget, fetchCard, rpc } from '../../kernel/boundary/http.js';
import { loadInstalledPlugins, loadInstalledModules, subprocessControllers, FileRegistry, mergeContracts, loadInstalledContracts, backfillInstalledContracts } from '../../kernel/boundary/registry.js';
import { loadBuiltinContracts, contractDigest } from '../../kernel/contract/registry.js';
import { McpBridge, type McpBridgeSpec } from '../../plugins/builtin/mcp-bridge.js';
import { loadMcpConfig } from '../../plugins/builtin/mcp-config.js';
import { RegistryProvider, ensureRegistry, DEFAULT_REGISTRY_URL } from '../../kernel/boundary/registry-provider.js';
import type { CapabilityContract, Observer, Caveat, Principal, ModelBackend } from '../../sdk/types.js';

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
  workspace: string; backend?: 'deepseek' | 'anthropic'; model?: string; session?: string;
  /** agent 配置：内置 bare / coding / review，或 ~/.cak/agents/<name>.yaml，或 yaml 路径；缺省 coding */ agent?: string;
  reviewerUrl?: string; pluginsDir?: string | null; mcp?: { fromWorkspace?: boolean; extra?: McpBridgeSpec[] } | null; registryDir?: string | null;
  observers?: Observer[]; note?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** 测试/嵌入用：直接给模型后端实例（不读 key 文件） */ backendImpl?: ModelBackend;
  /** 模型正文流式增量（前端显示用） */ onModelDelta?: (e: { taskId: string; invocationId: string; text: string }) => void;
  /** 同进程兄弟 agent 的委派路由（daemon 注入；键=agent 名，值=ServeTarget；实现见 daemon.ts SiblingRouter，N-51） */ agentTargets?: Record<string, ServeTarget>;
}
export interface ApprovalView { approvalId: string; invocationId: string; contract: string; args: Record<string, unknown>; diff?: string; rule?: { human: string; caveats: Caveat[] } }

export async function createHost(o: HostOptions) {
  const note = o.note ?? (() => {});
  const home = path.join(os.homedir(), '.cak'); fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  ensureProfiles();
  const profile = loadProfile(o.agent ?? 'coding'); const agentName = o.agent ?? 'coding';
  const workspace = path.resolve(o.workspace); const backendName = (o.backend ?? profile.spec.model.backend) as 'deepseek' | 'anthropic' | string; const modelName = o.model ?? (o.backend ? (backendName === 'anthropic' ? 'claude-sonnet-5' : 'deepseek-chat') : profile.spec.model.model);
  const sessionName = o.session ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const sessionFile = path.join(home, 'sessions', sessionName + '.history.jsonl');
  // 模型后端：内置 deepseek / anthropic，或已装的 model-backend 插件（进程内，T2）
  const pluginsDir0 = o.pluginsDir === null ? undefined : path.resolve(o.pluginsDir ?? path.join(home, 'plugins'));
  const modules = pluginsDir0 && fs.existsSync(pluginsDir0) ? await loadInstalledModules(pluginsDir0) : { controllers: {}, backends: {}, interceptors: [], observers: [], minters: {}, loaded: [] };
  const builtinBackend = () => backendName === 'anthropic' ? new AnthropicBackend({ apiKeyRef: 'ANTHROPIC_API_KEY', model: modelName }) : backendName === 'deepseek' ? new OpenAICompatBackend('deepseek', { baseUrl: 'https://api.deepseek.com', model: modelName, apiKeyRef: 'file:~/.cak/secrets/deepseek.key' }) : undefined;
  const backend: ModelBackend = o.backendImpl ?? builtinBackend() ?? (modules.backends[backendName] ? (modules.backends[backendName]!({ model: modelName }) as ModelBackend) : (() => { throw new Error(`没有模型后端「${backendName}」（内置 deepseek / anthropic；或 cak add 一个 model-backend 插件）`); })());
  // 审查方
  const reviewerUrl = o.reviewerUrl; let reviewerCard: any;
  if (reviewerUrl) { reviewerCard = await fetchCard(reviewerUrl); if (!reviewerCard?.provides?.some((c: any) => c.name === 'code.review')) throw new Error(`${reviewerUrl} 的名片不提供 code.review`); }
  // 插件目录 / MCP / 注册表
  const pluginsDir = pluginsDir0;
  const mcpSpecs = o.mcp === null ? [] : [...(o.mcp?.fromWorkspace === false ? [] : loadMcpConfig(workspace).specs), ...(o.mcp?.extra ?? [])];
  const bridges: McpBridge[] = [];
  for (const m of mcpSpecs) { const b = new McpBridge(m); try { await b.start(); bridges.push(b); } catch (e) { note('error', `MCP ${m.serverName} 启动失败：${(e as Error).message}`); } }
  const registryDir = o.registryDir === null ? undefined : path.resolve(o.registryDir ?? path.join(home, 'registry'));
  let registryNote: string | undefined; if (registryDir && !o.registryDir) { const r = await ensureRegistry(registryDir, DEFAULT_REGISTRY_URL); registryNote = r.note; }
  const registryReady = !!registryDir && fs.existsSync(path.join(registryDir, 'index.json'));
  if (registryDir && !registryReady) note('warn', `注册表不可用（${registryNote ?? '没有 index.json'}）：本次不提供 plugin.search / plugin.install。可指定本地目录，或先 git clone ${DEFAULT_REGISTRY_URL} ${registryDir}`);
  let pluginsChanged = false;
  const pluginsSnapshot = () => { if (!pluginsDir || !fs.existsSync(pluginsDir)) return ''; try { return fs.readdirSync(pluginsDir).sort().map(id => { const mp = path.join(pluginsDir, id, 'manifest.json'); try { return `${id}:${fs.statSync(mp).mtimeMs}`; } catch { return id; } }).join('|'); } catch { return ''; } };
  let pluginsSnap = pluginsSnapshot();
  const registryProvider = registryReady && pluginsDir ? new RegistryProvider({ registryDir: registryDir!, installDir: pluginsDir, onInstalled: () => { pluginsChanged = true; } }) : undefined;
  // 契约集合 = 内核内置 + 注册表随带（<registry>/contracts/**）：社区插件的新契约从注册表来，不等内核发版（N-50）；冲突（同 name@version 不同 digest）直接抛
  // 每次组装都重新收集（运行中 cak add 装了带新契约的插件也要跟上——作者测试员抓到热加载后句柄没铸）；坏契约文件（digest 对不上）只跳过并提示，不拖死整个内核
  const collectContracts = () => {
    const registryContracts = registryReady ? new FileRegistry(registryDir!).contracts() : [];
    const installedContracts = pluginsDir ? loadInstalledContracts(pluginsDir) : [];   // 没注册表也能组装：装插件时抄下来的契约定义
    const good: CapabilityContract[] = []; for (const c of [...registryContracts, ...installedContracts]) { const d = contractDigest(c); if (c.schemaDigest && c.schemaDigest !== d) { note('warn', `契约 ${c.name}@${c.version} 的 schemaDigest 与内容不符（声明 ${c.schemaDigest.slice(0, 19)}… ≠ 算出 ${d.slice(0, 19)}…），已忽略；提供它的插件会装不上句柄`); continue; } good.push(c); }
    const all = mergeContracts(loadBuiltinContracts(), good);
    if (pluginsDir && registryContracts.length) backfillInstalledContracts(pluginsDir, all);
    return { all, extra: all.filter(c => !loadBuiltinContracts().some(b => b.name === c.name && b.version === c.version)) };
  };
  let { all: builtin, extra: extraContracts } = collectContracts();
  let builtinBySide = new Map(builtin.map(c => [`${c.name}@${c.version}`, c.sideEffects]));
  // 路径墙：fs.* 权限的契约里，叫 path / target / outPath / localPath 的字符串入参都加「相对路径、不含 ..」caveat（越界调用连审批都不进）；paths[] 这类数组由插件自己判
  const PATH_ARGS = ['path', 'target', 'outPath', 'localPath']; let pathyArgs = new Map(builtin.filter(c => (c.permissions ?? []).some(p => String(p).startsWith('fs.'))).map(c => [`${c.name}@${c.version}`, PATH_ARGS.filter(k => (c.inputSchema as any)?.properties?.[k]?.type === 'string')] as const).filter(([, ks]) => ks.length));
  const pathy = new Set([...pathyArgs.keys()]);
  const provider = new WorkspaceProvider(workspace, { sessionFile });
  const signer = loadOrCreateSigner(path.join(home, 'identity', 'cak-code'), { kind: 'agent', id: 'cak-code' });
  const ledgerFile = path.join(home, 'sessions', sessionName + '.sqlite');
  const ledgerStore = new SqliteLedgerStore(ledgerFile); const blobStore = new SqliteBlobStore(ledgerFile);
  try { fs.chmodSync(ledgerFile, 0o600); } catch { /* 账本是明文（含对话）：只给本用户 */ }
  let installed: Awaited<ReturnType<typeof loadInstalledPlugins>> = [];
  async function composeKernel() {
    for (const p of installed) await p.stop().catch(() => {});
    ({ all: builtin, extra: extraContracts } = collectContracts()); builtinBySide = new Map(builtin.map(c => [`${c.name}@${c.version}`, c.sideEffects])); pathyArgs = new Map(builtin.filter(c => (c.permissions ?? []).some(p => String(p).startsWith('fs.'))).map(c => [`${c.name}@${c.version}`, PATH_ARGS.filter(k => (c.inputSchema as any)?.properties?.[k]?.type === 'string')] as const).filter(([, ks]) => ks.length));
    installed = pluginsDir && fs.existsSync(pluginsDir) ? await loadInstalledPlugins(pluginsDir, { env: { CAK_WORKSPACE: workspace, CAK_PLUGINS_DIR: pluginsDir }, onExit: ({ id, code, signal }) => note('warn', `插件 ${id} 进程退出（${signal ?? code}）；下次调用会自动重拉一次`) }) : [];
    // 一个插件的实现若引用内核不认识（或 digest 冲突）的契约，只摘掉它并提示，别让整个内核起不来（作者测试员：一个坏 digest 的第三方插件让 cak up 直接崩）
    const known = new Map(builtin.map(c => [`${c.name}@${c.version}`, c.schemaDigest]));
    const broken = installed.filter(p => p.listImplementations().some(i => { const d = known.get(`${i.contract.name}@${i.contract.version}`); return !d || d !== i.contract.schemaDigest; }));
    for (const p of broken) { const bad = p.listImplementations().filter(i => known.get(`${i.contract.name}@${i.contract.version}`) !== i.contract.schemaDigest).map(i => `${i.contract.name}@${i.contract.version}`); note('error', `插件 ${p.id} 的契约 ${bad.join(', ')} 内核不认识或 digest 不一致——已跳过这个插件（重装：cak add ${p.id}；或删掉 ~/.cak/plugins/${p.id}）`); await p.stop().catch(() => {}); }
    installed = installed.filter(p => !broken.includes(p));
    // 按 agent 配置挑插件（profile YAML 顶层 `plugins: { include?: [id], exclude?: [id], approveReads?: bool }`，内核不认识这个键、只有宿主看）：编程助手不必带邮件/日历/ssh；
    // 再按注册表条目的 sensitiveReads（读的是用户个人数据：邮件/日历/剪贴板/远端机器/容器）——read 类契约也走审批（dev/redteam：编程助手零审批读走了剪贴板）
    const pf = ((profile as any).plugins ?? {}) as { include?: string[]; exclude?: string[]; approveReads?: boolean };
    const dropped = installed.filter(p => (pf.include && !pf.include.includes(p.id)) || (pf.exclude ?? []).includes(p.id)); for (const p of dropped) await p.stop().catch(() => {});
    installed = installed.filter(p => !dropped.includes(p));
    const regEntries = registryReady ? new Map(new FileRegistry(registryDir!).read().plugins.map(e => [e.id, e])) : new Map();
    const sensitive = new Set(installed.filter(p => { try { const m = JSON.parse(fs.readFileSync(path.join(pluginsDir!, p.id, 'manifest.json'), 'utf8')); if (m.sensitiveReads !== undefined) return !!m.sensitiveReads; return !!(regEntries.get(p.id) as any)?.sensitiveReads; } catch { return !!(regEntries.get(p.id) as any)?.sensitiveReads; } }).map(p => p.id));   // 老 manifest 没这个字段 → 看注册表条目
    const pluginGrants: PluginGrant[] = installed.flatMap(p => p.listImplementations().map(i => { const side = builtinBySide.get(`${i.contract.name}@${i.contract.version}`) ?? 'external'; const needsApproval = (side === 'read' || side === 'none') && (pf.approveReads || sensitive.has(p.id)); return { contract: i.contract.name, version: i.contract.version, sideEffects: needsApproval ? 'write' : side, pathArg: pathyArgs.get(`${i.contract.name}@${i.contract.version}`) as string[] | undefined }; }));
    for (const b of bridges) for (const c of b.listContracts()) pluginGrants.push({ contract: c.name, version: c.version, sideEffects: c.sideEffects });
    if (registryProvider) pluginGrants.push({ contract: 'plugin.search', version: '1.0.0', sideEffects: 'read' }, { contract: 'plugin.install', version: '1.0.0', sideEffects: 'write' });
    const spec = mergeDynamic(profile, { backend: backendName as any, model: modelName, workspaceName: path.basename(workspace), reviewer: !!reviewerCard, siblings: !!o.agentTargets, pluginGrants, memory: pluginGrants.some(g => g.contract === 'memory.search'), registry: !!registryProvider });
    const providers = [provider, ...installed, ...bridges, ...(registryProvider ? [registryProvider] : []), ...((reviewerUrl || o.agentTargets) ? [new AgentInvokeProvider(mergeTargets(o.agentTargets, reviewerUrl ? { 'cak-review': new RemoteServeTarget(reviewerUrl) } : undefined))] : [])];
    // 控制器：内置四个 + 已装 controller 插件（id 即 provider 名）；profile 里 controller.provider 选谁
    const controllers: Record<string, (cfg: any) => any> = { 'cak-code': cfg => codingController(cfg), 'cak-review': cfg => reviewController(cfg), 'simple-react': cfg => simpleReact(cfg), 'plan-execute': cfg => planExecute(cfg), ...Object.fromEntries(Object.entries(modules.controllers).map(([id, f]) => [id, (cfg: any) => f(cfg)])), ...subprocessControllers(installed) };   // 内置 + 进程内插件(T2) + 子进程插件(T1)
    if (!controllers[spec.spec.controller.provider]) throw new Error(`没有控制器「${spec.spec.controller.provider}」（内置 cak-code / cak-review / simple-react / plan-execute；已装：${[...Object.keys(modules.controllers), ...Object.keys(subprocessControllers(installed))].join(', ') || '无'}）`);
    const kk = await Kernel.compose(spec, { controllers, backends: { [spec.spec.model.backend]: backend, deepseek: backend, anthropic: backend }, providers, contracts: extraContracts, observers: [...(o.observers ?? []), ...(modules.observers as any[])], interceptors: modules.interceptors as any[], minters: modules.minters as any }, { ledgerStore, blobStore, signer, ...(o.onModelDelta ? { onModelDelta: o.onModelDelta } : {}) });
    if (reviewerCard) kk.trustPeer(reviewerCard);
    return kk;
  }
  let k = await composeKernel();
  const by = (): Principal => ({ kind: 'user', id: os.userInfo().username });
  const host = {
    get k() { return k; }, workspace, home, sessionName, sessionFile, ledgerFile, backendName, modelName, reviewerUrl, reviewerCard, agentName, profile,
    get installed() { return installed; }, bridges, registryProvider, registryDir,
    banner() { return `agent ${agentName} · ${backendName}/${modelName} · workspace ${workspace} · session ${sessionName}${reviewerUrl ? ` · 审查 ${reviewerUrl}（${reviewerCard?.principal?.id}）` : ''}${installed.length ? ` · 插件 ${installed.map(p => p.id).join(',')}` : ''}${bridges.length ? ` · MCP ${bridges.map(b => `${b.id.replace('mcp-bridge:', '')}(${b.listContracts().length} 工具)`).join(',')}` : ''}${registryProvider ? ' · 注册表 ✓' : registryDir ? ' · 注册表 ✗' : ''}`; },
    /** 装了新插件就同账本重组（N-37 补铸新契约句柄 = 热加载）；返回是否重组过 */
    async recomposeIfNeeded() {
      // 两个触发：① 本进程装的（RegistryProvider/控制面）置了旗标；② 别的进程（cak add 命令行）改了 ~/.cak/plugins —— 比 manifest 快照（回归测试员抓到：CLI 装完运行中的内核不重铸句柄）
      const snap = pluginsSnapshot(); if (snap !== pluginsSnap) { pluginsSnap = snap; pluginsChanged = true; }
      if (!pluginsChanged) return false; pluginsChanged = false; k = await composeKernel(); return true;
    },
    /** 内核进程的插件管理服务装了插件后调用：标记需重组 */
    markPluginsChanged() { pluginsChanged = true; },
    /** 待审批视图（给任何前端）：契约、参数、diff 文本、可推导的常设规则 */
    pending(taskId?: string): ApprovalView[] {
      return k.pendingApprovals(taskId).map(p => { const inv = k.ledger.projections().invocations[p.invocationId]!; const args = inv.args as Record<string, unknown>; let diff: string | undefined;
        if (inv.contract.name === 'file.edit') { const strip = (t: string) => t.replace(/\n$/, '').split('\n'); diff = strip(String(args['oldText'])).map(l => '- ' + l).concat(strip(String(args['newText'])).map(l => '+ ' + l)).join('\n'); }   // 尾随换行不显示成空的 -/+ 行
        if (inv.contract.name === 'file.write') { const f = path.join(workspace, String(args['path'])); const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; diff = miniDiff(cur, String(args['content'])); }
        if (inv.contract.name === 'git.commit') { try { const paths = Array.isArray(args['paths']) ? (args['paths'] as string[]) : []; const stat = spawnSync('git', ['diff', '--stat', 'HEAD', '--', ...paths], { cwd: workspace, encoding: 'utf8' }).stdout; const st = spawnSync('git', ['status', '--short', '--', ...paths], { cwd: workspace, encoding: 'utf8' }).stdout; diff = `${st.trim()}\n${stat.trim()}`.trim().slice(0, 4000); } catch { /* 没 git 就不给 */ } }
        if (inv.contract.name === 'test.run') { const cwd = args['cwd'] ? String(args['cwd']) : '.'; const fw = args['framework'] ? String(args['framework']) : 'auto'; diff = `在 ${cwd} 跑测试（框架 ${fw}${args['argv'] ? '：' + (args['argv'] as string[]).join(' ') : ''}${args['filter'] ? '，只跑 ' + String(args['filter']) : ''}）`; }
        // 提前预警：路径类入参若经符号链接指向工作区外，句柄墙拦不住（只看字面），工具层必拒——审批面板上先说清，别让人批一个注定失败的（regress-5）
        for (const key of ['path', 'target', 'outPath', 'localPath']) { const v = args[key]; if (typeof v !== 'string' || /^[a-z]+:\/\//i.test(v)) continue; const abs = path.resolve(workspace, v); let probe = abs; while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe); try { const real = fs.realpathSync(probe); const rootReal = fs.realpathSync(workspace); const rel = path.relative(rootReal, real); if (rel.startsWith('..') || path.isAbsolute(rel)) diff = `⚠ ${key}=${v} 经符号链接指向工作区外（${real}）——批了也会被工具层拒绝\n${diff ?? ''}`.trimEnd(); } catch { /* ignore */ } }
        const rule = standingRule(inv.contract.name, args); return { approvalId: p.approvalId, invocationId: p.invocationId, contract: inv.contract.name, args, ...(diff ? { diff } : {}), ...(rule ? { rule } : {}) }; });
    },
    /** 审批决定：grant / deny / standing（新铸窄常设句柄 + grant 本次） */
    decide(approvalId: string, decision: 'grant' | 'deny' | 'standing', reason?: string) {
      // fail-closed：只认这三个词（'approve' 当 grant 的别名）；其他/缺省一律报错，绝不当作批准（redteam/dev 测试员各自抓到的 P1）
      const d = (decision as unknown) === 'approve' ? 'grant' : decision;
      if (d !== 'grant' && d !== 'deny' && d !== 'standing') throw new Error(`decision 必须是 grant | deny | standing（收到 ${JSON.stringify(decision)}）`);
      decision = d;
      const p = k.pendingApprovals().find(x => x.approvalId === approvalId); if (!p) throw new Error(`no pending approval ${approvalId}`);
      if (decision === 'deny') { k.deny(approvalId, by(), reason ?? '用户拒绝'); return { ok: true as const }; }
      if (decision === 'standing') { const inv = k.ledger.projections().invocations[p.invocationId]!; const rule = standingRule(inv.contract.name, inv.args as Record<string, unknown>); if (!rule) throw new Error('该调用无法推导常设规则'); const h = k.controlPlane().standing({ name: inv.contract.name }, rule.caveats, { by: by(), reason: 'cak-code: 用户选择「本会话始终允许这类」', expiresAt: new Date(Date.now() + STANDING_TTL_MS).toISOString() }); k.grant(approvalId, by()); return { ok: true as const, standing: { handleId: h.id, human: rule.human } }; }
      k.grant(approvalId, by()); return { ok: true as const };
    },
    /** 一条用户输入 = 一个 task；返回首个结果（可能 suspended，等前端 decide 后 resume） */
    async submit(text: string) { fs.appendFileSync(sessionFile, JSON.stringify({ role: 'user', content: text }) + '\n', { mode: 0o600 }); return k.startTask(text, { input: text }); },
    async resume(taskId: string) { return k.resume(taskId); },
    recordAnswer(text: string) { fs.appendFileSync(sessionFile, JSON.stringify({ role: 'assistant', content: text }) + '\n', { mode: 0o600 }); },
    usageOf(taskId: string) { const u = k.ledger.projections().usageByTask[taskId]; const cached = Object.values(k.ledger.projections().invocations).filter(i => i.taskId === taskId).reduce((n, i) => n + Number((i.usage?.units?.custom as any)?.cachedInputTokens ?? 0), 0); return u ? { ...u, cachedInputTokens: cached, cacheHitPct: Math.round(cached / Math.max(1, u.inputTokens) * 100), ledgerSeq: k.ledger.head().seq } : undefined; },
    /** 审查回执核验：跨进程拉审查方该 task 的事件，Merkle 根 + 签名都对上才算 */
    async verifyReviewReceipt(r: { root: string; sig: any; taskId: string }) { if (!reviewerUrl) return { ok: false, events: 0 }; const ev = await rpc(reviewerUrl, 'agent.receipt', { taskId: r.taskId }); const events = ((ev.result as any)?.events ?? []) as Array<{ hash: string; type: string }>; const idx = events.findIndex(e => e.type === 'receipt.issued'); const covered = idx >= 0 ? events.slice(0, idx) : events; return { ok: verifyTaskReceipt({ taskId: r.taskId, events: covered, root: r.root, sig: r.sig }, k.signer as any), events: covered.length }; },
    status() { const standing = k.controlPlane().handles().filter(h => h.expiresAt && h.contract.name !== 'model.generate' && !h.caveats.some(c => c.kind === 'requires-approval')); return { agent: agentName, controller: profile.spec.controller.provider, modules: modules.loaded, session: sessionName, workspace, backend: backendName, model: modelName, plugins: installed.map(p => p.id), mcp: bridges.map(b => b.id.replace('mcp-bridge:', '')), registry: !!registryProvider, reviewer: reviewerUrl ?? null, ledgerSeq: k.ledger.head().seq, ledgerFile, standingHandles: standing.length }; },
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

/** 合并两组委派目标：兄弟 agent（可能是 Proxy，动态成员）优先，其次远端审查方；都用 get 动态取，别展开成静态对象 */
function mergeTargets(a?: Record<string, ServeTarget>, b?: Record<string, ServeTarget>): Record<string, ServeTarget> {
  const keys = () => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
  return new Proxy({}, {
    get: (_t, k) => (typeof k === 'string' ? (a?.[k] ?? b?.[k]) : undefined) as ServeTarget | undefined,
    has: (_t, k) => typeof k === 'string' && (!!a?.[k] || !!b?.[k]),
    ownKeys: () => keys(),
    getOwnPropertyDescriptor: (_t, k) => (typeof k === 'string' && (a?.[k] ?? b?.[k])) ? { enumerable: true, configurable: true, value: a?.[k] ?? b?.[k] } : undefined,
  }) as Record<string, ServeTarget>;
}
