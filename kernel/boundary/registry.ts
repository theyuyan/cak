/**
 * 注册表 R1（15 §4）：一个目录里的 index.json（插件条目 + 名片）。发现 = 读索引；安装 = trust-but-verify（本机跑 conformance，过了才写入安装目录）。
 * 注册表本身怎么托管（Git 仓库 / HTTP 镜像）是适配器；这里的 FileRegistry 也可指向 git clone 下来的目录。
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CapabilityContract, JsonObject } from '../../sdk/types.js';
import { runConformance, type ConformanceReport } from '../../sdk/conformance.js';
import { SubprocessProvider } from './subprocess.js';
import { SubprocessController } from './subprocess-controller.js';
import { loadBuiltinContracts } from '../contract/registry.js';
import { digest } from '../ledger/ledger.js';
import { err } from '../errors.js';

/** install：从哪里拿代码。git = clone（--depth 1，可选 ref / 子目录）→ 每条 build 命令都是 argv 数组、不经 shell、在 subdir 里跑；之后 entrypoint 在该目录下启动 */
export interface PluginInstallSource { type: 'git'; url: string; ref?: string; subdir?: string; build?: string[][] }
export interface RegistryPluginEntry { id: string; version: string; kernelCompat: string; description?: string; license?: string; entrypoint: { type: 'subprocess'; command: string; args?: string[] } | { type: 'remote'; url: string } | { type: 'in-process'; module: string; export?: string }; contracts: Array<{ name: string; version?: string; sampleArgs: JsonObject; badArgs?: JsonObject }>; roles?: string[]; source?: string; install?: PluginInstallSource; tier?: 'T0' | 'T1' | 'T2' | 'T3' }
export interface RegistryIndex { version: 1; plugins: RegistryPluginEntry[]; agents: Array<Record<string, unknown> & { principal: { kind: string; id: string }; endpoints?: Array<{ type: string; address?: string }> }> }

export class FileRegistry {
  private file: string;
  constructor(dir: string) { fs.mkdirSync(dir, { recursive: true }); this.file = path.join(dir, 'index.json'); if (!fs.existsSync(this.file)) this.write({ version: 1, plugins: [], agents: [] }); }
  read(): RegistryIndex { return JSON.parse(fs.readFileSync(this.file, 'utf8')) as RegistryIndex; }
  private write(i: RegistryIndex) { fs.writeFileSync(this.file, JSON.stringify(i, null, 2) + '\n'); }
  addPlugin(e: RegistryPluginEntry) { const i = this.read(); i.plugins = [...i.plugins.filter(p => p.id !== e.id), e]; this.write(i); }
  getPlugin(id: string) { return this.read().plugins.find(p => p.id === id); }
  listPlugins() { return this.read().plugins; }
  /** 按契约反查：谁实现了 name（15 §4.3） */
  findByContract(name: string) { return this.read().plugins.filter(p => p.contracts.some(c => c.name === name)); }
  publishCard(card: RegistryIndex['agents'][number]) { const i = this.read(); const key = `${card.principal.kind}:${card.principal.id}`; i.agents = [...i.agents.filter(a => `${a.principal.kind}:${a.principal.id}` !== key), card]; this.write(i); }
  findAgent(agentId: string) { return this.read().agents.find(a => a.principal.id === agentId); }
  findAgentsProviding(contractName: string) { return this.read().agents.filter(a => Array.isArray((a as any).provides) && (a as any).provides.some((c: any) => c.name === contractName)); }
}

export interface InstallResult { installed: boolean; id: string; tier: 'T1' | 'T2' | 'none'; report: ConformanceReport; manifestPath?: string }
/** cak add：拉条目 → 起子进程 → 本机跑 conformance（不信注册表里的报告）→ 全过才写入 installDir/<id>/manifest.json */
export async function installPlugin(registry: FileRegistry, id: string, installDir: string, opts: { extraContracts?: CapabilityContract[] } = {}): Promise<InstallResult> {
  const e = registry.getPlugin(id); if (!e) throw err('COMPONENT_NOT_FOUND', `registry has no plugin ${id}`);
  if (e.entrypoint.type === 'remote') throw err('CONFIGURATION_ERROR', `install: remote entrypoints are not installable (use them directly)`);
  const dir = path.join(installDir, e.id);
  let cwd: string | undefined;
  if (e.install?.type === 'git') {
    // 拿代码：clone 到 <installDir>/<id>/src（已存在则先删干净重来——安装目录归本工具管），然后跑声明的 build 命令（默认 npm install + npm run build）
    const src = path.join(dir, 'src'); fs.rmSync(src, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    await run(['git', 'clone', '--depth', '1', ...(e.install.ref ? ['--branch', e.install.ref] : []), e.install.url, src], installDir, `git clone ${e.install.url}`);
    cwd = e.install.subdir ? path.join(src, e.install.subdir) : src;
    if (!fs.existsSync(cwd)) throw err('CONFIGURATION_ERROR', `install: subdir ${e.install.subdir} not found in ${e.install.url}`);
    for (const argv of e.install.build ?? [['npm', 'install', '--no-audit', '--no-fund', '--silent'], ['npm', 'run', 'build', '--silent']]) await run(winCmd(argv), cwd, argv.join(' '));
  }
  const known = [...loadBuiltinContracts(), ...(opts.extraContracts ?? [])];
  // 进程内插件（控制器 / 模型后端 / 拦截器 / 观察者 / Minter）：跑在内核进程里，信任级 T2 —— 拉代码/构建后只做"能加载、导出是函数"的健全检查；用什么由 profile 决定
  if (e.entrypoint.type === 'in-process') {
    const modPath = path.resolve(cwd ?? dir, e.entrypoint.module); if (!fs.existsSync(modPath)) throw err('CONFIGURATION_ERROR', `install: module ${e.entrypoint.module} not found after build`);
    const mod = await import(pathToFileURL(modPath).href); const fn = mod[e.entrypoint.export ?? 'default'];
    if (typeof fn !== 'function') throw err('CONFIGURATION_ERROR', `install: ${e.entrypoint.module} does not export function ${e.entrypoint.export ?? 'default'}`);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { ...e, ...(cwd ? { cwd } : {}), modulePath: modPath, installedAt: new Date().toISOString(), tier: 'T2' as const, conformance: { digest: 'n/a', passed: 0, failed: 0, checks: 0 } };
    const manifestPath = path.join(dir, 'manifest.json'); fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    return { installed: true, id, tier: 'T2', report: { ok: true, passed: 0, failed: 0, checks: [] } as unknown as ConformanceReport, manifestPath };
  }
  // 前端 / 子进程控制器等无契约插件：没有 conformance 可跑——拉代码/构建成功即安装（控制器仍是子进程，T1；hello 时再核 roles）
  if (((e.roles ?? []).includes('frontend') || (e.roles ?? []).includes('controller')) && e.contracts.length === 0) {
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { ...e, ...(cwd ? { cwd } : {}), installedAt: new Date().toISOString(), tier: 'T1' as const, conformance: { digest: 'n/a', passed: 0, failed: 0, checks: 0 } };
    const manifestPath = path.join(dir, 'manifest.json'); fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    return { installed: true, id, tier: 'T1', report: { ok: true, passed: 0, failed: 0, checks: [] } as unknown as ConformanceReport, manifestPath };
  }
  const sub = new SubprocessProvider({ id: e.id, command: e.entrypoint.command, args: e.entrypoint.args ?? [], ...(cwd ? { cwd } : {}) });
  let report: ConformanceReport;
  try {
    await sub.start();
    // 条目未写版本时，以插件自己声明实现的版本为准（同名多版本并存时不能靠文件顺序猜）
    const declared = await sub.listImplementations();
    const pickVersion = (name: string, want?: string) => want ?? declared.filter(d => d.contract.name === name).map(d => d.contract.version).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    const cases = e.contracts.map(c => { const contract = known.find(k => k.name === c.name && (pickVersion(c.name, c.version) === undefined || k.version === pickVersion(c.name, c.version))); if (!contract) throw err('COMPONENT_NOT_FOUND', `contract ${c.name} unknown; supply it via extraContracts`); return { contract, sampleArgs: c.sampleArgs, ...(c.badArgs ? { badArgs: c.badArgs } : {}) }; });
    report = await runConformance(sub, cases);
  } finally { await sub.stop().catch(() => {}); }
  if (!report.ok) return { installed: false, id, tier: 'none', report };
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { ...e, ...(cwd ? { cwd } : {}), installedAt: new Date().toISOString(), tier: 'T1' as const, conformance: { digest: digest(report), passed: report.passed, failed: report.failed, checks: report.checks.length } };
  const manifestPath = path.join(dir, 'manifest.json'); fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'conformance-report.json'), JSON.stringify(report, null, 2) + '\n');
  return { installed: true, id, tier: 'T1', report, manifestPath };
}
/** 运行时装载已安装插件（全部 subprocess，与 15 §5 一致：第三方默认不进程内） */
/** 已装子进程插件里的控制器（hello.roles 含 controller）→ 控制器工厂表（id → (cfg) => Controller） */
export function subprocessControllers(subs: SubprocessProvider[]): Record<string, (cfg: JsonObject) => unknown> {
  const out: Record<string, (cfg: JsonObject) => unknown> = {};
  for (const s of subs) { const roles = ((s.hello as any)?.roles ?? []) as string[]; if (roles.includes('controller')) { const sc = new SubprocessController(s, s.id); out[s.id] = cfg => sc.controller(cfg); } }
  return out;
}
export async function loadInstalledPlugins(installDir: string, opts: { env?: Record<string, string> } = {}): Promise<SubprocessProvider[]> {
  if (!fs.existsSync(installDir)) return [];
  const out: SubprocessProvider[] = [];
  for (const id of fs.readdirSync(installDir)) {
    const mp = path.join(installDir, id, 'manifest.json'); if (!fs.existsSync(mp)) continue;
    const m = JSON.parse(fs.readFileSync(mp, 'utf8')) as RegistryPluginEntry & { tier: string };
    if (m.entrypoint.type !== 'subprocess') continue;   // in-process 见 loadInstalledModules；remote 不装载
    if ((m.roles ?? []).includes('frontend')) continue;   // 前端不是 Provider，不装进内核；由 cak front 启动
    const cwd = (m as any).cwd as string | undefined; const sub = new SubprocessProvider({ id: m.id, command: m.entrypoint.command, args: m.entrypoint.args ?? [], ...(cwd ? { cwd } : {}), ...(opts.env ? { env: opts.env } : {}) }); await sub.start(); out.push(sub);
  }
  return out;
}

/** argv 数组 spawn（不经 shell）；非零退出 → CONFIGURATION_ERROR 带 stderr 尾巴 */
function run(argv: string[], cwd: string, label: string): Promise<void> {
  return new Promise((res, rej) => {
    const c = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); let errS = '';
    c.stderr.on('data', d => { errS += d; if (errS.length > 4000) errS = errS.slice(-4000); });
    c.on('error', e => rej(err('CONFIGURATION_ERROR', `install: ${label}: ${e.message}`)));
    c.on('close', code => code === 0 ? res() : rej(err('CONFIGURATION_ERROR', `install: ${label} exited ${code}: ${errS.trim().split('\n').slice(-5).join(' | ')}`)));
  });
}

/** Windows 上 npm/npx/tsx 等是 .cmd 垫片，spawn 不经 shell 时要写全名（代码审查修正，Windows 未实测） */
export function winCmd(argv: string[]): string[] { if (process.platform !== 'win32' || !argv.length) return argv; const c = argv[0]!; return /^(npm|npx|pnpm|yarn|tsx)$/.test(c) ? [c + '.cmd', ...argv.slice(1)] : argv; }

/** 进程内插件装载（T2）：按角色返回工厂。控制器 `(config) => Controller`；后端 `(opts) => ModelBackend`；拦截器/观察者/Minter `() => 实例`。id = 插件 id */
export async function loadInstalledModules(installDir: string): Promise<{ controllers: Record<string, (cfg: JsonObject) => unknown>; backends: Record<string, (opts: JsonObject) => unknown>; interceptors: unknown[]; observers: unknown[]; minters: Record<string, unknown>; loaded: string[] }> {
  const out = { controllers: {} as Record<string, (cfg: JsonObject) => unknown>, backends: {} as Record<string, (opts: JsonObject) => unknown>, interceptors: [] as unknown[], observers: [] as unknown[], minters: {} as Record<string, unknown>, loaded: [] as string[] };
  if (!fs.existsSync(installDir)) return out;
  for (const id of fs.readdirSync(installDir)) {
    const mp = path.join(installDir, id, 'manifest.json'); if (!fs.existsSync(mp)) continue;
    const m = JSON.parse(fs.readFileSync(mp, 'utf8')) as RegistryPluginEntry & { modulePath?: string };
    if (m.entrypoint.type !== 'in-process' || !m.modulePath || !fs.existsSync(m.modulePath)) continue;
    let mod: any; try { mod = await import(pathToFileURL(m.modulePath).href); } catch { continue; }
    const fn = mod[m.entrypoint.export ?? 'default']; if (typeof fn !== 'function') continue;
    const roles = m.roles ?? [];
    if (roles.includes('controller')) out.controllers[id] = fn as any;
    if (roles.includes('model-backend')) out.backends[id] = fn as any;
    if (roles.includes('interceptor')) out.interceptors.push(fn());
    if (roles.includes('observer')) out.observers.push(fn());
    if (roles.includes('policy-minter')) out.minters[id] = fn();
    out.loaded.push(id);
  }
  return out;
}
