/**
 * 注册表 R1（15 §4）：一个目录里的 index.json（插件条目 + 名片）。发现 = 读索引；安装 = trust-but-verify（本机跑 conformance，过了才写入安装目录）。
 * 注册表本身怎么托管（Git 仓库 / HTTP 镜像）是适配器；这里的 FileRegistry 也可指向 git clone 下来的目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityContract, JsonObject } from '../../sdk/types.js';
import { runConformance, type ConformanceReport } from '../../sdk/conformance.js';
import { SubprocessProvider } from './subprocess.js';
import { loadBuiltinContracts } from '../contract/registry.js';
import { digest } from '../ledger/ledger.js';
import { err } from '../errors.js';

export interface RegistryPluginEntry { id: string; version: string; kernelCompat: string; description?: string; license?: string; entrypoint: { type: 'subprocess'; command: string; args?: string[] } | { type: 'remote'; url: string }; contracts: Array<{ name: string; version?: string; sampleArgs: JsonObject; badArgs?: JsonObject }>; source?: string; tier?: 'T0' | 'T1' | 'T2' | 'T3' }
export interface RegistryIndex { version: 1; plugins: RegistryPluginEntry[]; agents: Array<Record<string, unknown> & { principal: { kind: string; id: string }; endpoints?: Array<{ type: string; address?: string }> }> }

export class FileRegistry {
  private file: string;
  constructor(dir: string) { fs.mkdirSync(dir, { recursive: true }); this.file = path.join(dir, 'index.json'); if (!fs.existsSync(this.file)) this.write({ version: 1, plugins: [], agents: [] }); }
  read(): RegistryIndex { return JSON.parse(fs.readFileSync(this.file, 'utf8')) as RegistryIndex; }
  private write(i: RegistryIndex) { fs.writeFileSync(this.file, JSON.stringify(i, null, 2) + '\n'); }
  addPlugin(e: RegistryPluginEntry) { const i = this.read(); i.plugins = [...i.plugins.filter(p => p.id !== e.id), e]; this.write(i); }
  getPlugin(id: string) { return this.read().plugins.find(p => p.id === id); }
  /** 按契约反查：谁实现了 name（15 §4.3） */
  findByContract(name: string) { return this.read().plugins.filter(p => p.contracts.some(c => c.name === name)); }
  publishCard(card: RegistryIndex['agents'][number]) { const i = this.read(); const key = `${card.principal.kind}:${card.principal.id}`; i.agents = [...i.agents.filter(a => `${a.principal.kind}:${a.principal.id}` !== key), card]; this.write(i); }
  findAgent(agentId: string) { return this.read().agents.find(a => a.principal.id === agentId); }
  findAgentsProviding(contractName: string) { return this.read().agents.filter(a => Array.isArray((a as any).provides) && (a as any).provides.some((c: any) => c.name === contractName)); }
}

export interface InstallResult { installed: boolean; id: string; tier: 'T1' | 'none'; report: ConformanceReport; manifestPath?: string }
/** cak add：拉条目 → 起子进程 → 本机跑 conformance（不信注册表里的报告）→ 全过才写入 installDir/<id>/manifest.json */
export async function installPlugin(registry: FileRegistry, id: string, installDir: string, opts: { extraContracts?: CapabilityContract[] } = {}): Promise<InstallResult> {
  const e = registry.getPlugin(id); if (!e) throw err('COMPONENT_NOT_FOUND', `registry has no plugin ${id}`);
  if (e.entrypoint.type !== 'subprocess') throw err('CONFIGURATION_ERROR', `install: only subprocess entrypoints in R1 (got ${e.entrypoint.type})`);
  const known = [...loadBuiltinContracts(), ...(opts.extraContracts ?? [])];
  const sub = new SubprocessProvider({ id: e.id, command: e.entrypoint.command, args: e.entrypoint.args ?? [] });
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
  const dir = path.join(installDir, e.id); fs.mkdirSync(dir, { recursive: true });
  const manifest = { ...e, installedAt: new Date().toISOString(), tier: 'T1' as const, conformance: { digest: digest(report), passed: report.passed, failed: report.failed, checks: report.checks.length } };
  const manifestPath = path.join(dir, 'manifest.json'); fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'conformance-report.json'), JSON.stringify(report, null, 2) + '\n');
  return { installed: true, id, tier: 'T1', report, manifestPath };
}
/** 运行时装载已安装插件（全部 subprocess，与 15 §5 一致：第三方默认不进程内） */
export async function loadInstalledPlugins(installDir: string): Promise<SubprocessProvider[]> {
  if (!fs.existsSync(installDir)) return [];
  const out: SubprocessProvider[] = [];
  for (const id of fs.readdirSync(installDir)) {
    const mp = path.join(installDir, id, 'manifest.json'); if (!fs.existsSync(mp)) continue;
    const m = JSON.parse(fs.readFileSync(mp, 'utf8')) as RegistryPluginEntry & { tier: string };
    if (m.entrypoint.type !== 'subprocess') continue;
    const sub = new SubprocessProvider({ id: m.id, command: m.entrypoint.command, args: m.entrypoint.args ?? [] }); await sub.start(); out.push(sub);
  }
  return out;
}
