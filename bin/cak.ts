#!/usr/bin/env tsx
/**
 * cak — 用户入口（M1）：从命令行跑一个 Agent Spec。
 *   npx tsx bin/cak.ts run <spec.yaml> --input "…" [--workspace DIR] [--mock-script FILE] [--ledger FILE] [--verbose] [--auto-approve]
 * 只用内置插件；模型后端为 mock（--mock-script）——M1 的目的是证明内核链路，不是接真模型（M3/M4）。
 */
import fs from 'node:fs'; import path from 'node:path'; import YAML from 'yaml';
import { Kernel } from '../kernel/runtime/kernel.js';
import { FileLedgerStore, MemoryLedgerStore } from '../kernel/ledger/ledger.js';
import { simpleReact, MockBackend, FsReadonlyProvider, FsAnyProvider, MemoryContextProvider, TextSummarizeProvider, SafeFileGuard, ConsoleObserver, type MockScriptEntry } from '../plugins/builtin/index.js';
import type { AgentSpec } from '../sdk/types.js';

const argv = process.argv.slice(2);
const cmd = argv[0]; const specPath = argv[1];
const flag = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n: string) => argv.includes('--' + n);
const USAGE = `用法:
  cak run <spec.yaml> --input "…" [--workspace DIR] [--mock-script FILE] [--ledger FILE] [--verbose] [--auto-approve] [--allow-outside]
  cak front [tty|<前端插件id>] [--session NAME]                          # 启动前端（连 daemon 的控制面；先起 apps/cak-code/daemon.ts）
  cak doctor                                                              # 环境体检（只读）
  cak conformance --subprocess "<cmd> [args…]" --contract <name> --args '<json>' [--bad-args '<json>']   # trust-but-verify：本机跑一致性测试
  cak approvals <spec.yaml> --ledger FILE                                   # 列出待审批（FILE 以 .sqlite 结尾则用 SQLite 账本）
  cak approve   <spec.yaml> --ledger FILE --id <approvalId> [--by user:yuyan] [--deny "理由"] [--mock-script FILE] [--allow-outside]
  cak report    <spec.yaml> --ledger FILE                                   # usage 报表（按 task / 契约 / Provider / 句柄）
  cak serve     <spec.yaml> [--port N] [--ledger FILE] [--key-dir DIR] [--publish REGISTRY_DIR] [--plugins-dir DIR]   # 常驻：暴露名片 / 服务 / 回执 / 句柄铸造
  cak card      <spec.yaml> [--key-dir DIR]                                # 打印名片（含公钥）
  cak add       <pluginId> --registry DIR [--install-dir DIR]              # trust-but-verify：本机 conformance 全过才装
  cak statement <spec.yaml> --ledger FILE                                  # 对账单（usage × pricing）`;
if (cmd === 'front') {
  // 启动一个前端：内置 tty（默认）或已安装的前端插件（roles: frontend）；前端只连 daemon 的控制面
  const os = await import('node:os'); const { spawn } = await import('node:child_process');
  const id = specPath && !specPath.startsWith('--') ? specPath : 'tty'; const rest = argv.slice(id === 'tty' && specPath !== 'tty' ? 1 : 2);
  if (id === 'tty') { const c = spawn(process.execPath, [path.resolve(path.dirname(new URL(import.meta.url).pathname), '../node_modules/.bin/tsx'), path.resolve(path.dirname(new URL(import.meta.url).pathname), '../apps/cak-front/tty.ts'), ...rest], { stdio: 'inherit' }); c.on('close', code => process.exit(code ?? 0)); }
  else { const mp = path.join(os.homedir(), '.cak', 'plugins', id, 'manifest.json'); if (!fs.existsSync(mp)) { console.error(`未安装前端 ${id}（cak add ${id} --registry …）`); process.exit(1); } const m = JSON.parse(fs.readFileSync(mp, 'utf8')); if (!(m.roles ?? []).includes('frontend')) { console.error(`${id} 不是前端插件`); process.exit(1); } const c = spawn(m.entrypoint.command, [...(m.entrypoint.args ?? []), ...rest], { stdio: 'inherit', ...(m.cwd ? { cwd: m.cwd } : {}) }); c.on('close', code => process.exit(code ?? 0)); }
  await new Promise(() => {});
}
if (cmd === 'doctor') {
  // 环境体检：只读、不改任何东西、不打印任何密钥内容
  const os = await import('node:os'); const { spawnSync } = await import('node:child_process');
  const home = path.join(os.homedir(), '.cak'); const rows: Array<[string, boolean | 'warn', string]> = [];
  const ver = (cmdline: string[]) => { const r = spawnSync(cmdline[0]!, cmdline.slice(1), { encoding: 'utf8' }); return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0]! : ''; };
  const nodeMajor = Number(process.versions.node.split('.')[0]); rows.push(['Node.js ≥ 22', nodeMajor >= 22, process.version]);
  let sqliteOk = false; try { const { createRequire } = await import('node:module'); createRequire(import.meta.url)('node:sqlite'); sqliteOk = true; } catch { /* no */ } rows.push(['node:sqlite（账本）', sqliteOk, sqliteOk ? 'ok' : '缺失：升级 Node']);
  const g = ver(['git', '--version']); rows.push(['git（拉代码 / 装插件）', !!g, g || '未找到']);
  const py = ver(['python3', '--version']); rows.push(['python3 ≥ 3.9（可选，Python 插件）', py ? true : 'warn', py || '未找到（只影响 Python 插件）']);
  const keys = fs.existsSync(path.join(home, 'secrets')) ? fs.readdirSync(path.join(home, 'secrets')).filter(f => f.endsWith('.key')) : [];
  rows.push(['模型 key（~/.cak/secrets/*.key）', keys.length ? true : 'warn', keys.length ? keys.map(k => { const st = fs.statSync(path.join(home, 'secrets', k)); return `${k}${(st.mode & 0o077) ? '（权限过宽，建议 chmod 600）' : ''}`; }).join(', ') : '没有；ANTHROPIC_API_KEY ' + (process.env['ANTHROPIC_API_KEY'] ? '已设' : '未设')]);
  const ids = fs.existsSync(path.join(home, 'identity')) ? fs.readdirSync(path.join(home, 'identity')) : []; rows.push(['agent 身份（~/.cak/identity）', ids.length ? true : 'warn', ids.length ? ids.join(', ') : '还没有（首次运行自动生成）']);
  const reg = path.join(home, 'registry', 'index.json'); let regInfo = '未克隆（首次运行 cak-code 自动拉取）'; if (fs.existsSync(reg)) { try { const i = JSON.parse(fs.readFileSync(reg, 'utf8')); regInfo = `${i.plugins.length} 个插件条目`; } catch { regInfo = 'index.json 解析失败'; } } rows.push(['注册表（~/.cak/registry）', fs.existsSync(reg) ? true : 'warn', regInfo]);
  const pdir = path.join(home, 'plugins'); const plugins = fs.existsSync(pdir) ? fs.readdirSync(pdir).filter(d => fs.existsSync(path.join(pdir, d, 'manifest.json'))) : [];
  for (const id of plugins) { try { const m = JSON.parse(fs.readFileSync(path.join(pdir, id, 'manifest.json'), 'utf8')); const entry = m.cwd ? path.join(m.cwd, ...(m.entrypoint.args?.slice(-1) ?? [])) : (m.entrypoint.args?.[0] ?? ''); const ok = !entry || fs.existsSync(entry); rows.push([`插件 ${id}`, ok, `${m.tier ?? '?'} · 装于 ${String(m.installedAt).slice(0, 10)} · conformance ${m.conformance?.passed ?? '?'}/${(m.conformance?.passed ?? 0) + (m.conformance?.failed ?? 0)}${ok ? '' : ' · 入口文件缺失，重装：cak add ' + id}`]); } catch { rows.push([`插件 ${id}`, false, 'manifest 损坏']); } }
  if (!plugins.length) rows.push(['插件（~/.cak/plugins）', 'warn', '一个都没装（对 cak-code 说"我想让你能…"或 cak add）']);
  const sdir = path.join(home, 'sessions'); if (fs.existsSync(sdir)) { const fl = fs.readdirSync(sdir).filter(f => f.endsWith('.sqlite')); const bytes = fl.reduce((n, f) => n + fs.statSync(path.join(sdir, f)).size, 0); rows.push(['会话账本', true, `${fl.length} 个 · ${(bytes / 1e6).toFixed(1)} MB（备份 = 备份 ~/.cak/）`]); }
  const width = Math.max(...rows.map(r => r[0].length));
  for (const [k, ok, v] of rows) console.log(`${ok === true ? '✔' : ok === 'warn' ? '△' : '✗'} ${k.padEnd(width + 2)} ${v}`);
  const bad = rows.filter(r => r[1] === false).length; console.log(bad ? `\n${bad} 项不通过` : '\n环境正常'); process.exit(bad ? 1 : 0);
}
if (cmd === 'conformance') {
  const { SubprocessProvider } = await import('../kernel/boundary/subprocess.js');
  const { runConformance, summarize } = await import('../sdk/conformance.js');
  const { loadBuiltinContracts } = await import('../kernel/contract/registry.js');
  const cmdline = (flag('subprocess') ?? '').split(' ').filter(Boolean); if (!cmdline.length || !flag('contract')) { console.log(USAGE); process.exit(1); }
  const contract = loadBuiltinContracts().find(c => c.name === flag('contract')); if (!contract) { console.log(`未知契约 ${flag('contract')}（M3 只查内置契约）`); process.exit(1); }
  const sub = new SubprocessProvider({ id: 'candidate', command: cmdline[0]!, args: cmdline.slice(1) });
  await sub.start();
  const rep = await runConformance(sub, [{ contract, sampleArgs: JSON.parse(flag('args') ?? '{}'), ...(flag('bad-args') ? { badArgs: JSON.parse(flag('bad-args')!) } : {}) }]);
  console.log(summarize(rep)); await sub.stop(); process.exit(rep.ok ? 0 : 1);
}
if (cmd === 'add') {
  const { FileRegistry, installPlugin } = await import('../kernel/boundary/registry.js');
  const id = specPath; const regDir = flag('registry'); const installDir = flag('install-dir') ?? path.join((await import('node:os')).homedir(), '.cak', 'plugins');   // Windows 没有 HOME，用 os.homedir()
  if (!id || !regDir) { console.log(USAGE); process.exit(1); }
  const r = await installPlugin(new FileRegistry(regDir), id, installDir);
  console.log(`${r.installed ? '✔ 已安装' : '✗ 未安装'} ${id}：本机一致性测试 ${r.report.passed} passed, ${r.report.failed} failed${r.installed ? `  → ${r.manifestPath}（tier ${r.tier}）` : ''}`);
  for (const c of r.report.checks.filter(c => !c.ok)) console.log(`   ✗ ${c.id}${c.detail ? ' — ' + c.detail : ''}`);
  process.exit(r.installed ? 0 : 1);
}
if (cmd === 'serve' || cmd === 'card' || cmd === 'statement') {
  if (!specPath) { console.log(USAGE); process.exit(1); }
  const { serveKernelHttp } = await import('../kernel/boundary/http.js'); const { Ed25519Signer } = await import('../kernel/identity/ed25519.js'); const { SqliteLedgerStore } = await import('../kernel/ledger/sqlite-store.js'); const { statement } = await import('../kernel/runtime/settlement.js'); const { loadInstalledPlugins } = await import('../kernel/boundary/registry.js');
  const spec2 = YAML.parseAllDocuments(fs.readFileSync(specPath, 'utf8')).map(d => d.toJS())[0] as AgentSpec;
  const lf = flag('ledger'); const store = lf ? (lf.endsWith('.sqlite') ? new SqliteLedgerStore(path.resolve(lf)) : new FileLedgerStore(path.resolve(lf))) : new MemoryLedgerStore();
  const keyDir = flag('key-dir'); let signer: any;
  if (keyDir) { fs.mkdirSync(keyDir, { recursive: true }); const priv = path.join(keyDir, 'ed25519.key'), pub = path.join(keyDir, 'ed25519.pub'); const me = { kind: 'agent' as const, id: spec2.spec.principal.agent }; if (fs.existsSync(priv)) signer = Ed25519Signer.fromPem(me, fs.readFileSync(priv, 'utf8'), fs.readFileSync(pub, 'utf8')); else { signer = Ed25519Signer.generate(me); fs.writeFileSync(priv, signer.privateKeyPem(), { mode: 0o600 }); fs.writeFileSync(pub, signer.publicKeyPem()); console.log(`✔ 生成 ed25519 密钥 → ${keyDir}`); } }
  const installed = flag('plugins-dir') ? await loadInstalledPlugins(path.resolve(flag('plugins-dir')!)) : [];
  const script2: MockScriptEntry[] = flag('mock-script') ? JSON.parse(fs.readFileSync(flag('mock-script')!, 'utf8')) : [{ finishReason: 'stop', content: '（mock）' }];
  const k = await Kernel.compose(spec2, { controllers: { 'simple-react': cfg => simpleReact(cfg) }, backends: { 'mock-backend': new MockBackend(script2), anthropic: new (await import('../plugins/builtin/anthropic-backend.js')).AnthropicBackend() }, providers: [new FsReadonlyProvider(path.resolve(flag('workspace') ?? '.')), new MemoryContextProvider(), new TextSummarizeProvider(), ...installed], interceptors: [new SafeFileGuard(4096)] }, { ledgerStore: store, ...(signer ? { signer } : {}) });
  if (cmd === 'card') { console.log(JSON.stringify(k.card(), null, 2)); process.exit(0); }
  if (cmd === 'statement') { console.log(JSON.stringify(statement(k), null, 2)); process.exit(0); }
  const srv = await serveKernelHttp(k, { port: Number(flag('port') ?? 0), host: flag('host') ?? '127.0.0.1' });
  console.log(`✔ ${spec2.metadata.name} 在 ${srv.url}  （GET /card · POST /rpc: agent.card / agent.serve / agent.receipt / handle.mint / handle.status）`);
  if (flag('publish')) { const { FileRegistry } = await import('../kernel/boundary/registry.js'); new FileRegistry(flag('publish')!).publishCard({ ...k.card(), endpoints: [{ type: 'remote', address: srv.url }] } as any); console.log(`✔ 名片已发布到注册表 ${flag('publish')}`); }
  await new Promise(() => {});   // 常驻
}
if (cmd === 'approvals' || cmd === 'approve' || cmd === 'report') {
  if (!specPath || !flag('ledger')) { console.log(USAGE); process.exit(1); }
  const { SqliteLedgerStore } = await import('../kernel/ledger/sqlite-store.js');
  const spec2 = YAML.parseAllDocuments(fs.readFileSync(specPath, 'utf8')).map(d => d.toJS())[0] as AgentSpec;
  const lf = path.resolve(flag('ledger')!); const store = lf.endsWith('.sqlite') ? new SqliteLedgerStore(lf) : new FileLedgerStore(lf);
  const script2: MockScriptEntry[] = flag('mock-script') ? JSON.parse(fs.readFileSync(flag('mock-script')!, 'utf8')) : [{ finishReason: 'stop', content: '（恢复后 mock 直接结束）' }];
  const k = await Kernel.compose(spec2, { controllers: { 'simple-react': cfg => simpleReact(cfg) }, backends: { 'mock-backend': new MockBackend(script2) }, providers: [has('allow-outside') ? new FsAnyProvider(path.resolve(flag('workspace') ?? '.')) : new FsReadonlyProvider(path.resolve(flag('workspace') ?? '.')), new MemoryContextProvider(), new TextSummarizeProvider()], interceptors: [new SafeFileGuard(4096)] }, { ledgerStore: store });
  const cp = k.controlPlane();
  if (cmd === 'approvals') { const p = cp.pending(); console.log(p.length ? p.map(x => `${x.approvalId}  task=${x.taskId}  ${x.contract}  ${x.summary}${x.expiresAt ? '  expires ' + x.expiresAt : ''}`).join('\n') : '（无待审批）'); process.exit(0); }
  if (cmd === 'report') { const r = k.usageReport(); console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  const id = flag('id'); const by = (flag('by') ?? 'user:cli').split(':'); if (!id) { console.log(USAGE); process.exit(1); }
  const who = { kind: (by[0] as any) ?? 'user', id: by[1] ?? by[0]! };
  const target = flag('deny') !== undefined ? cp.deny(id, who, flag('deny')) : cp.grant(id, who);
  console.log(`${flag('deny') !== undefined ? '✗ 已拒绝' : '✔ 已批准'} ${id} → 恢复任务 ${target.taskId} …`);
  const r = await cp.resume(target.taskId); console.log(`status: ${r.status}\noutput: ${typeof r.output === 'string' ? r.output : JSON.stringify(r.output)}`); process.exit(r.status === 'finished' ? 0 : 2);
}
if (cmd !== 'run' || !specPath) { console.log(USAGE); process.exit(1); }

const spec = YAML.parseAllDocuments(fs.readFileSync(specPath, 'utf8')).map(d => d.toJS())[0] as AgentSpec;
const workspace = path.resolve(flag('workspace') ?? '.');
const script: MockScriptEntry[] = flag('mock-script') ? JSON.parse(fs.readFileSync(flag('mock-script')!, 'utf8')) : [{ finishReason: 'stop', content: '（mock 后端：没有脚本，直接结束）' }];
const backend = new MockBackend(script);
const observers = has('verbose') ? [new ConsoleObserver()] : [];
const ledgerStore = flag('ledger') ? (flag('ledger')!.endsWith('.sqlite') ? new (await import('../kernel/ledger/sqlite-store.js')).SqliteLedgerStore(path.resolve(flag('ledger')!)) : new FileLedgerStore(path.resolve(flag('ledger')!))) : new MemoryLedgerStore();

const t0 = Date.now();
const { OpenAICompatBackend } = await import('../plugins/builtin/openai-compat-backend.js');
const { AnthropicBackend } = await import('../plugins/builtin/anthropic-backend.js');
const k = await Kernel.compose(spec, {
  controllers: { 'simple-react': cfg => simpleReact(cfg) },
  backends: { 'mock-backend': backend, deepseek: new OpenAICompatBackend('deepseek', { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKeyRef: 'file:~/.cak/secrets/deepseek.key' }), anthropic: new AnthropicBackend({ apiKeyRef: 'ANTHROPIC_API_KEY' }) },
  providers: [has('allow-outside') ? new FsAnyProvider(workspace) : new FsReadonlyProvider(workspace), new MemoryContextProvider([{ content: 'CAK：不变的进内核，会变的做插件' }]), new TextSummarizeProvider()],   // --allow-outside：Provider 放行 workspace 外（治理仍在句柄：需审批）
  interceptors: [new SafeFileGuard(4096)], observers,
}, { ledgerStore });
console.log(`✔ 装配完成 ${spec.metadata.name}@${spec.metadata.version} · 句柄 ${k.rootHandles.length} 个 · 账本 seq=${k.ledger.head().seq}`);
for (const h of k.rootHandles) console.log(`   ${h.id}  ${h.contract.name}@${h.contract.version}  caveats=${h.caveats.map(c => c.kind).join(',') || '-'}`);

let res = await k.startTask(flag('input') ?? '', { input: flag('input') ?? '' });
if (res.status === 'suspended') {
  const pend = k.pendingApprovals(res.taskId);
  console.log(`⏸ 任务挂起，等待审批 ${pend.length} 项：`); for (const p of pend) console.log(`   approvalId=${p.approvalId}  ${p.summary}`);
  if (has('auto-approve')) { for (const p of pend) k.grant(p.approvalId, { kind: 'user', id: process.env['USER'] ?? 'user' }); console.log('   --auto-approve：已写入 grant.issued，恢复…'); res = await k.resume(res.taskId); }
}
console.log(`\n== 结果 ==\nstatus: ${res.status}\noutput: ${typeof res.output === 'string' ? res.output : JSON.stringify(res.output)}`);
const proj = k.ledger.projections(); const invs = Object.values(proj.invocations).filter(i => i.taskId === res.taskId);
console.log(`\n== 账本 ==  事件 ${k.ledger.all().length} 条 · head ${k.ledger.head().hash.slice(0, 23)}… · 用时 ${Date.now() - t0}ms`);
console.log('调用: ' + invs.map(i => `${i.contract.name}[${i.status}${i.denyCode ? ':' + i.denyCode : ''}]`).join(' → '));
const u = proj.usageByTask[res.taskId]; if (u) console.log(`usage: calls=${u.calls} inputTokens=${u.inputTokens} outputTokens=${u.outputTokens}`);
if (flag('ledger')) console.log(`账本文件: ${path.resolve(flag('ledger')!)}`);
process.exit(res.status === 'finished' ? 0 : res.status === 'suspended' ? 2 : 1);
