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
  cak                      # 就这一个词：在当前目录起内核（已在跑就复用）+ 打开界面；第一次会问你要模型 key
  cak stop                 # 停掉当前目录的内核
  cak up [--agent <profile>]… [--no-agent] [--workspace DIR] [--name NAME] [--reviewer URL] [--port N]   # 起内核进程：0..N 个 agent（默认挂一个 bare）；纯内核也能装插件/管配置；--reviewer 接独立进程审查方
  cak agent list | show | init <name> [--from …] | loaded | add <profile> | remove <name>   # 配置文件在 ~/.cak/agents/；add/remove 对着运行中的内核
  cak run <spec.yaml> --input "…" [--workspace DIR] [--mock-script FILE] [--ledger FILE] [--verbose] [--auto-approve] [--allow-outside]
  cak front [tui|tty|web|<前端插件id>] [--session NAME] | --list | --default <id>   # 前端：默认 TUI；web 打开浏览器界面；--list 看装了哪些、--default 切默认
  cak doctor                                                              # 环境体检（只读）
  cak conformance --subprocess "<cmd> [args…]" --contract <name> [--contracts DIR|FILE]… --args '<json>' [--bad-args '<json>']   # trust-but-verify：本机跑一致性测试
  cak approvals <spec.yaml> --ledger FILE                                   # 列出待审批（FILE 以 .sqlite 结尾则用 SQLite 账本）
  cak approve   <spec.yaml> --ledger FILE --id <approvalId> [--by user:alice] [--deny "理由"] [--mock-script FILE] [--allow-outside]
  cak report    <spec.yaml> --ledger FILE                                   # usage 报表（按 task / 契约 / Provider / 句柄）
  cak serve     <spec.yaml> [--port N] [--ledger FILE] [--key-dir DIR] [--publish REGISTRY_DIR] [--plugins-dir DIR]   # 常驻：暴露名片 / 服务 / 回执 / 句柄铸造
  cak card      <spec.yaml> [--key-dir DIR]                                # 打印名片（含公钥）
  cak add       <pluginId> --registry DIR [--install-dir DIR]              # trust-but-verify：本机 conformance 全过才装
  cak statement <spec.yaml> --ledger FILE                                  # 对账单（usage × pricing）`;
if (cmd === '--version' || cmd === '-v') { const pj = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')); console.log(`cak ${pj.version}`); process.exit(0); }
if (cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(USAGE); process.exit(0); }
// ---- 零参数：cak = 在当前目录起内核（已在跑就复用）+ 打开界面；cak stop = 停掉当前目录的内核 ----
if (!cmd || cmd.startsWith('--') || cmd === 'stop' || cmd === 'here') {
  const os2 = await import('node:os'); const { spawn } = await import('node:child_process'); const { createHash } = await import('node:crypto');
  const here = path.dirname(new URL(import.meta.url).pathname); const tsxBin = path.resolve(here, '../node_modules/.bin/tsx');
  const home = path.join(os2.homedir(), '.cak'); const ws = path.resolve(flag('workspace') ?? process.cwd());
  const samePath = (a: string, b: string) => { const r = (x: string) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } }; return r(a) === r(b); };   // macOS /var → /private/var 这类符号链接
  const session = flag('session') ?? `${path.basename(ws)}-${createHash('sha256').update(ws).digest('hex').slice(0, 6)}`;   // 目录 → 固定会话名：下次同目录自动续上
  const dfile = path.join(home, 'daemon', session + '.json');
  const alive = () => { try { const j = JSON.parse(fs.readFileSync(dfile, 'utf8')); process.kill(j.pid, 0); return j; } catch { return undefined; } };
  if (cmd === 'stop') {
    // 停：--session 指定的 / 本目录零参数起的（会话名=目录 hash）/ 任何 workspace=本目录的（cak up --name X 起的）
    const ddir = path.join(home, 'daemon'); const all = fs.existsSync(ddir) ? fs.readdirSync(ddir).filter(f => f.endsWith('.json')).map(f => { try { const j = JSON.parse(fs.readFileSync(path.join(ddir, f), 'utf8')); process.kill(j.pid, 0); return j; } catch { fs.rmSync(path.join(ddir, f), { force: true }); return undefined; } }).filter(Boolean) as any[] : [];
    const targets = flag('session') ? all.filter(j => j.session === flag('session')) : all.filter(j => j.session === session || (j.workspace && samePath(j.workspace, ws)));
    if (!targets.length) { console.log(all.length ? `这个目录没有在跑的内核。在跑的：${all.map(j => `${j.session}（${j.workspace ?? '纯内核'}）`).join('、')}——用 cak stop --session <名字>` : '没有在跑的内核'); process.exit(0); }
    for (const j of targets) { process.kill(j.pid, 'SIGTERM'); console.log(`已停止 ${j.session}（pid ${j.pid}）`); } process.exit(0);
  }
  // 首次：没有模型 key 就当场要（隐藏输入，直接写文件，不经任何对话/日志）
  const keyFile = path.join(home, 'secrets', 'deepseek.key');
  if (!fs.existsSync(keyFile) && !process.env['ANTHROPIC_API_KEY']) {
    if (!process.stdin.isTTY) { console.error(`还没有模型 key，而当前不是交互终端没法向你要。请把 DeepSeek key 写到 ${keyFile}（chmod 600），或在终端里跑一次 cak。`); process.exit(2); }
    const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
    console.log('第一次运行：需要一个模型 API key（DeepSeek）。输入不会显示，也不会出现在任何日志里；只写到 ~/.cak/secrets/deepseek.key（0600）。');
    const key: string = await new Promise(res => { (rl as any).stdoutMuted = true; rl.question('DeepSeek key: ', a => { console.log(); res(a.trim()); }); (rl as any)._writeToOutput = function (str: string) { if ((rl as any).stdoutMuted && !str.includes('DeepSeek key')) (rl as any).output.write('*'); else (rl as any).output.write(str); }; });
    rl.close(); if (!key) { console.log('没有 key，退出。'); process.exit(1); }
    fs.mkdirSync(path.dirname(keyFile), { recursive: true }); fs.writeFileSync(keyFile, key, { mode: 0o600 }); console.log('✔ 已保存。');
  }
  let info = alive();
  if (!info) {
    const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { return {}; } })();
    const agent = flag('agent') ?? cfg.agent ?? (fs.existsSync(path.join(ws, '.git')) ? 'coding' : 'bare');   // git 仓库默认编程助手，否则空内核
    fs.mkdirSync(path.join(home, 'daemon'), { recursive: true }); const log = fs.openSync(path.join(home, 'daemon', session + '.log'), 'a');
    const d = spawn(process.execPath, [tsxBin, path.resolve(here, '../apps/cak-code/daemon.ts'), '--workspace', ws, '--name', session, '--agent', agent, ...argv.filter((a, i) => !['--workspace', '--session', '--agent', argv[i - 1] === '--workspace' ? a : '', argv[i - 1] === '--session' ? a : '', argv[i - 1] === '--agent' ? a : ''].includes(a))], { detached: true, stdio: ['ignore', log, log] }); d.unref();
    process.stdout.write(`起内核（agent ${agent}，会话 ${session}）`); for (let i = 0; i < 120 && !(info = alive()); i++) { await new Promise(r => setTimeout(r, 500)); process.stdout.write('.'); }
    console.log(); if (!info) { console.error(`内核没起来，看日志：${path.join(home, 'daemon', session + '.log')}`); process.exit(1); }
  } else console.log(`复用在跑的内核（会话 ${session}，pid ${info.pid}）`);
  const front = flag('front') ?? ((() => { try { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).front; } catch { return undefined; } })()) ?? (process.stdin.isTTY ? 'tui' : 'tty');   // 非交互终端（管道/脚本）用一行式 tty 前端，Ink 起不来
  if (front === 'tui' && !process.stdin.isTTY) { console.log('当前不是交互终端，TUI 起不来；改用 tty 前端（或 --front web）。'); }
  const frontUse = front === 'tui' && !process.stdin.isTTY ? 'tty' : front;
  if (front === 'web') { const url = `${info.url}/ui#token=${info.token}`; console.log(`浏览器：${url}`); const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'; spawn(opener, process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { stdio: 'ignore', detached: true }).unref(); process.exit(0); }
  const c = spawn(process.execPath, [tsxBin, path.resolve(here, `../apps/cak-front/${frontUse === 'tty' ? 'tty.ts' : 'tui.tsx'}`), '--session', session], { stdio: 'inherit' }); c.on('close', code => { console.log(`（内核还在后台跑；停：cak stop）`); process.exit(code ?? 0); }); await new Promise(() => {});
}
if (cmd === 'up') {
  // 起一个 agent（默认 bare = 空内核：只带对话 + 插件管理）；就是 daemon
  const here = path.dirname(new URL(import.meta.url).pathname); const { spawn } = await import('node:child_process');
  const rest = argv.slice(1);
  const c = spawn(process.execPath, [path.resolve(here, '../node_modules/.bin/tsx'), path.resolve(here, '../apps/cak-code/daemon.ts'), ...rest], { stdio: 'inherit' }); c.on('close', code => process.exit(code ?? 0)); await new Promise(() => {});
}
if (cmd === 'agent') {
  const { listProfiles, ensureProfiles, loadProfile, AGENTS_DIR, builtinProfiles } = await import('../apps/cak-code/profiles.js'); const YAML2 = (await import('yaml')).default; ensureProfiles();
  const sub = specPath;
  if (!sub || sub === 'list') { for (const p of listProfiles()) console.log(`${p.builtin ? '内置' : '自定'}  ${p.name.padEnd(12)} 控制器 ${p.controller.padEnd(14)} 后端 ${p.backend.padEnd(10)} 静态能力 ${p.grants}（+已装插件自动追加）${p.file ? '  ' + p.file : ''}`); console.log(`\n用：cak up --agent <name>；改：编辑 ${AGENTS_DIR}/<name>.yaml；新建：cak agent init <name> [--from bare|coding|review]`); process.exit(0); }
  if (sub === 'show') { const n = argv[2]; if (!n) { console.log('cak agent show <name>'); process.exit(1); } console.log(YAML2.stringify(loadProfile(n))); process.exit(0); }
  if (sub === 'add' || sub === 'remove' || sub === 'loaded') {
    const { findDaemon } = await import('../apps/cak-code/daemon.js'); const info = findDaemon(flag('session') ?? flag('name')); if (!info) { console.log('没找到在跑的内核（先 cak 或 cak up）'); process.exit(1); }
    const call = async (method: string, params: any) => { const r = await fetch(info.url + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cak-token': info.token }, body: JSON.stringify({ cak: '1', jsonrpc: '2.0', id: 1, method, params }) }); const j: any = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
    try {
      if (sub === 'loaded') { const r: any = await call('agents.list', {}); for (const a of r.loaded) console.log(`${a.name === r.defaultAgent ? '●' : ' '} ${a.name.padEnd(12)} 控制器 ${a.controller}  会话 ${a.session}  ${a.workspace}`); process.exit(0); }
      if (sub === 'add') { const n = argv[2]; if (!n) { console.log('cak agent add <profile> [--session 内核名] [--workspace DIR]'); process.exit(1); } const r: any = await call('agents.add', { profile: n, ...(flag('workspace') ? { workspace: flag('workspace') } : {}) }); console.log(`✔ 已挂上 agent ${r.agent}（控制器 ${r.controller}）；界面：cak front --session ${info.name ?? info.session} --agent ${r.agent}`); process.exit(0); }
      if (sub === 'remove') { const n = argv[2]; if (!n) { console.log('cak agent remove <name>'); process.exit(1); } await call('agents.remove', { name: n }); console.log(`✔ 已摘掉 ${n}`); process.exit(0); }
    } catch (e) { console.error('✗ ' + (e as Error).message); process.exit(1); }
  }
  if (sub === 'init') { const n = argv[2]; if (!n) { console.log('cak agent init <name> [--from bare|coding|review]'); process.exit(1); } const from = flag('from') ?? 'bare'; const base = builtinProfiles()[from]; if (!base) { console.log(`没有模板 ${from}`); process.exit(1); } const spec2 = JSON.parse(JSON.stringify(base)); spec2.metadata.name = n; spec2.spec.principal.agent = n; spec2.spec.manifest = { ...(spec2.spec.manifest ?? {}), displayName: n, description: `自定义 agent「${n}」（从 ${from} 复制；改这段描述说明它是干什么的）` }; const f = path.join(AGENTS_DIR, n + '.yaml'); if (fs.existsSync(f)) { console.log(`已存在 ${f}`); process.exit(1); } fs.writeFileSync(f, `# cak agent「${n}」（从 ${from} 复制）——改 controller.provider / model.backend / grants 搭你要的 agent；改完 cak up --agent ${n}\n` + YAML2.stringify(spec2)); console.log(`✔ 写入 ${f}\n  编辑它，然后：cak up --agent ${n} --workspace <目录>`); process.exit(0); }
  console.log('cak agent list | show <name> | init <name> [--from …] | loaded | add <profile> | remove <name>'); process.exit(1);
}
if (cmd === 'front') {
  // 启动一个前端：内置 tty（默认）或已安装的前端插件（roles: frontend）；前端只连 daemon 的控制面
  const os = await import('node:os'); const { spawn } = await import('node:child_process');
  const cfgFile = path.join(os.homedir(), '.cak', 'config.json'); const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { return {}; } };
  const installedFronts = () => { const pdir = path.join(os.homedir(), '.cak', 'plugins'); return fs.existsSync(pdir) ? fs.readdirSync(pdir).filter(d => { try { const m = JSON.parse(fs.readFileSync(path.join(pdir, d, 'manifest.json'), 'utf8')); return (m.roles ?? []).includes('frontend'); } catch { return false; } }) : []; };
  if (has('list')) { const def = readCfg().front ?? 'tui'; const rows = [['tui', '内置 · 正式终端界面（Ink：流式、单键审批、面板、主题）'], ['tty', '内置 · 最薄一行式前端'], ['web', '内置 · 浏览器界面（daemon 提供，打印网址）'], ...installedFronts().map(id => [id, '已安装前端插件（cak add）'])]; for (const [id, d] of rows) console.log(`${id === def ? '●' : ' '} ${id!.padEnd(14)} ${d}`); console.log(`\n默认 ${def}；cak front --default <id> 改默认；cak front <id> 直接启动`); process.exit(0); }
  if (flag('default')) { const v = flag('default')!; fs.mkdirSync(path.dirname(cfgFile), { recursive: true }); fs.writeFileSync(cfgFile, JSON.stringify({ ...readCfg(), front: v }, null, 1) + '\n'); console.log(`默认前端 → ${v}`); process.exit(0); }
  const id = specPath && !specPath.startsWith('--') ? specPath : (readCfg().front ?? 'tui'); const rest = argv.slice(specPath && !specPath.startsWith('--') ? 2 : 1);
  if (id === 'web') { const { findDaemon } = await import('../apps/cak-code/daemon.js'); const info = findDaemon(flag('session')); if (!info) { console.error('没找到在跑的 daemon'); process.exit(2); } const url = `${info.url}/ui#token=${info.token}`; console.log(`浏览器打开：${url}`); const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'; spawn(opener, process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { stdio: 'ignore', detached: true }).unref(); process.exit(0); }
  if (id === 'tui' || id === 'tty') { const here = path.dirname(new URL(import.meta.url).pathname); const c = spawn(process.execPath, [path.resolve(here, '../node_modules/.bin/tsx'), path.resolve(here, `../apps/cak-front/${id === 'tui' ? 'tui.tsx' : 'tty.ts'}`), ...rest], { stdio: 'inherit' }); c.on('close', code => process.exit(code ?? 0)); }
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
  rows.push(['模型 key（~/.cak/secrets/*.key）', keys.length ? true : 'warn', keys.length ? keys.map(k => { const st = fs.statSync(path.join(home, 'secrets', k)); return `${k}${(st.mode & 0o077) ? '（权限过宽，建议 chmod 600）' : ''}`; }).join(', ') : '没有——第一次在终端里跑 cak 会向你要（隐藏输入，只写到 ~/.cak/secrets/deepseek.key）；ANTHROPIC_API_KEY ' + (process.env['ANTHROPIC_API_KEY'] ? '已设' : '未设')]);
  const ids = fs.existsSync(path.join(home, 'identity')) ? fs.readdirSync(path.join(home, 'identity')) : []; rows.push(['agent 身份（~/.cak/identity）', ids.length ? true : 'warn', ids.length ? ids.join(', ') : '还没有（首次运行自动生成）']);
  const reg = path.join(home, 'registry', 'index.json'); let regInfo = '未克隆（第一次运行 cak 会自动拉取）'; if (fs.existsSync(reg)) { try { const i = JSON.parse(fs.readFileSync(reg, 'utf8')); regInfo = `${i.plugins.length} 个插件条目`; } catch { regInfo = 'index.json 解析失败'; } } rows.push(['注册表（~/.cak/registry）', fs.existsSync(reg) ? true : 'warn', regInfo]);
  const pdir = path.join(home, 'plugins'); const plugins = fs.existsSync(pdir) ? fs.readdirSync(pdir).filter(d => fs.existsSync(path.join(pdir, d, 'manifest.json'))) : [];
  for (const id of plugins) { try { const m = JSON.parse(fs.readFileSync(path.join(pdir, id, 'manifest.json'), 'utf8')); const entry = m.cwd ? path.join(m.cwd, ...(m.entrypoint.args?.slice(-1) ?? [])) : (m.entrypoint.args?.[0] ?? ''); const ok = !entry || fs.existsSync(entry); rows.push([`插件 ${id}`, ok, `${m.tier ?? '?'} · 装于 ${String(m.installedAt).slice(0, 10)} · conformance ${m.conformance?.passed ?? '?'}/${(m.conformance?.passed ?? 0) + (m.conformance?.failed ?? 0)}${ok ? '' : ' · 入口文件缺失，重装：cak add ' + id}`]); } catch { rows.push([`插件 ${id}`, false, 'manifest 损坏']); } }
  if (!plugins.length) rows.push(['插件（~/.cak/plugins）', 'warn', '一个都没装（对 cak 里的 agent 说"我想让你能…"或 cak add）']);
  const sdir = path.join(home, 'sessions'); if (fs.existsSync(sdir)) { const fl = fs.readdirSync(sdir).filter(f => f.endsWith('.sqlite')); const bytes = fl.reduce((n, f) => n + fs.statSync(path.join(sdir, f)).size, 0); rows.push(['会话账本', true, `${fl.length} 个 · ${(bytes / 1e6).toFixed(1)} MB（备份 = 备份 ~/.cak/）`]); }
  const width = Math.max(...rows.map(r => r[0].length));
  for (const [k, ok, v] of rows) console.log(`${ok === true ? '✔' : ok === 'warn' ? '△' : '✗'} ${k.padEnd(width + 2)} ${v}`);
  const bad = rows.filter(r => r[1] === false).length; const warn = rows.filter(r => r[1] === 'warn').length; console.log(bad ? `\n${bad} 项不通过` : warn ? `\n能跑（${warn} 项提醒，见 △）` : '\n环境正常'); process.exit(bad ? 1 : 0);
}
if (cmd === 'conformance') {
  const { SubprocessProvider } = await import('../kernel/boundary/subprocess.js');
  const { runConformance, summarize } = await import('../sdk/conformance.js');
  const { loadBuiltinContracts } = await import('../kernel/contract/registry.js');
  const cmdline = (flag('subprocess') ?? '').split(' ').filter(Boolean); if (!cmdline.length || !flag('contract')) { console.log(USAGE); process.exit(1); }
  const { loadRegistryContracts, mergeContracts } = await import('../kernel/boundary/registry.js');
  // 契约来源：内核内置 + --contracts DIR|FILE（可多次）+ ~/.cak/registry/contracts（社区契约随注册表分发，N-50）
  const extraDirs = argv.flatMap((a, i) => a === '--contracts' && argv[i + 1] ? [argv[i + 1]!] : []);
  const fromArgs = extraDirs.flatMap(d => fs.existsSync(d) && fs.statSync(d).isFile() ? [JSON.parse(fs.readFileSync(d, 'utf8'))] : loadRegistryContracts(d));
  const regDir = path.join((await import('node:os')).homedir(), '.cak', 'registry', 'contracts');
  const contract = mergeContracts(loadBuiltinContracts(), fromArgs, loadRegistryContracts(regDir)).find(c => c.name === flag('contract')); if (!contract) { console.log(`未知契约 ${flag('contract')}：不在内核内置、--contracts 指定的文件/目录、也不在 ~/.cak/registry/contracts 里`); process.exit(1); }
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
