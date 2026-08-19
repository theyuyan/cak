/**
 * RegistryProvider（"一切皆能力"再吃一次狗粮）：把注册表 + 安装器做成 Provider —— plugin.search@1（只读）/ plugin.install@1（写，默认审批）。
 * 小白路径：对 agent 说"我想让你能查数据库"→ agent 搜到 sql-query → 请求安装（用户按 y）→ 装完宿主热加载 → agent 按 setup 说明引导配置。
 * 注册表来源：本地目录（默认 ~/.cak/registry），可选从 git URL 自动 clone / 拉取（best-effort，失败就用本地现有的）。
 */
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { spawn } from 'node:child_process';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '../../sdk/types.js';
import { FileRegistry, installPlugin, type RegistryPluginEntry } from './registry.js';

const SEARCH: ContractRef = { name: 'plugin.search', version: '1.0.0', schemaDigest: 'sha256:5be1047e602ef443793a9a0d729f469704f84b6015bd15b31fb987bab95a6f29' };
const INSTALL: ContractRef = { name: 'plugin.install', version: '1.0.0', schemaDigest: 'sha256:cc40bf07493f5b958d24cb5fd27fbd651e68256bf2226566aa9829a1bb009fff' };
export const DEFAULT_REGISTRY_URL = 'https://github.com/theyuyan/cak-registry.git';

export interface RegistryProviderOptions { registryDir?: string; registryUrl?: string; installDir?: string; onInstalled?: (id: string, contracts: string[]) => void }

/** 确保本地有注册表：目录里没有 index.json 就 clone；有就 best-effort `git pull --ff-only`（超时/失败不阻塞） */
export async function ensureRegistry(dir: string, url = DEFAULT_REGISTRY_URL, timeoutMs = 20000): Promise<{ dir: string; refreshed: boolean; note?: string }> {
  const idx = path.join(dir, 'index.json');
  const git = (args: string[], cwd: string) => new Promise<{ code: number; err: string }>(res => { const c = spawn('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] }); let e = ''; c.stderr.on('data', d => e += d); const t = setTimeout(() => { c.kill(); res({ code: -1, err: 'timeout' }); }, timeoutMs); c.on('close', code => { clearTimeout(t); res({ code: code ?? -1, err: e }); }); c.on('error', er => { clearTimeout(t); res({ code: -1, err: er.message }); }); });
  if (!fs.existsSync(idx)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = await git(['clone', '--depth', '1', '-q', url, dir], path.dirname(dir));
    if (r.code !== 0) return { dir, refreshed: false, note: `registry clone failed: ${r.err.trim().split('\n').pop()}` };
    return { dir, refreshed: true };
  }
  if (fs.existsSync(path.join(dir, '.git'))) {
    const r = await git(['pull', '--ff-only', '-q'], dir); if (r.code === 0) return { dir, refreshed: true };
    // 快进失败（上游历史被重写 / 本地被手改）：注册表目录归本工具管、只读镜像，直接对齐上游；fetch 都失败才算离线，用本地副本
    const f = await git(['fetch', '-q', 'origin'], dir);
    if (f.code === 0) { const h = await git(['reset', '-q', '--hard', '@{u}'], dir); if (h.code === 0) return { dir, refreshed: true, note: 'registry: 本地历史与上游分叉，已对齐上游' }; }
    return { dir, refreshed: false, note: `registry pull failed (using local copy): ${(f.code === 0 ? r : f).err.trim().split('\n').pop()}` };
  }
  return { dir, refreshed: false };
}

export class RegistryProvider implements CapabilityProvider {
  readonly id = 'registry';
  readonly registryDir: string; readonly installDir: string;
  constructor(private opts: RegistryProviderOptions = {}) {
    this.registryDir = opts.registryDir ?? path.join(os.homedir(), '.cak', 'registry');
    this.installDir = opts.installDir ?? path.join(os.homedir(), '.cak', 'plugins');
  }
  listImplementations(): CapabilityImplementation[] { return [{ providerId: this.id, contract: SEARCH, priority: 20 }, { providerId: this.id, contract: INSTALL, priority: 20 }]; }
  private registry() { if (!fs.existsSync(path.join(this.registryDir, 'index.json'))) throw new Error(`no registry at ${this.registryDir}（先 clone ${this.opts.registryUrl ?? DEFAULT_REGISTRY_URL} 或指定 --registry）`); return new FileRegistry(this.registryDir); }
  private installed(id: string) { return fs.existsSync(path.join(this.installDir, id, 'manifest.json')); }
  private summary(e: RegistryPluginEntry & { setup?: string }) { return { id: e.id, version: e.version, ...(e.description ? { description: e.description } : {}), contracts: e.contracts.map(c => c.name + (c.version ? '@' + c.version : '')), installed: this.installed(e.id), ...(e.tier ? { tier: e.tier } : {}), ...(e.setup ? { setup: e.setup } : {}), ...(e.source ? { source: e.source } : {}) }; }
  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>;
    try {
      if (inv.contract.name === 'plugin.search') {
        const reg = this.registry(); const q = String(a['query'] ?? '').toLowerCase().trim(); const byContract = a['contract'] ? String(a['contract']) : undefined; const limit = Number(a['limit'] ?? 10);
        const all = (reg.listPlugins() as Array<RegistryPluginEntry & { setup?: string; keywords?: string[] }>).filter(e => !byContract || e.contracts.some(c => c.name === byContract || c.name.startsWith(byContract + '.')));
        // 打分：query 拆词，命中 id / 描述 / 契约名 / keywords / setup 的词数越多越靠前（不要求全中）；一个都不中 → 把全部条目给模型自己判断（小白说的话未必带关键词）
        const words = q.split(/[\s,，、/]+/).filter(Boolean);
        const score = (e: typeof all[number]) => { const hay = [e.id, e.description ?? '', ...e.contracts.map(c => c.name), ...(e.keywords ?? []), e.setup ?? ''].join(' ').toLowerCase(); return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0); };
        const ranked = words.length ? all.map(e => ({ e, s: score(e) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.e) : all;
        const hit = ranked.length ? ranked : all;
        return { output: { plugins: hit.slice(0, limit).map(e => this.summary(e)) } as unknown as Json };
      }
      if (inv.contract.name === 'plugin.install') {
        const reg = this.registry(); const id = String(a['id']); const e = reg.getPlugin(id) as (RegistryPluginEntry & { setup?: string }) | undefined;
        if (!e) return { output: { id, installed: false, passed: 0, failed: 0, message: `registry has no plugin "${id}"（先用 plugin.search 找）` } as unknown as Json };
        const r = await installPlugin(reg, id, this.installDir);
        const contracts = e.contracts.map(c => c.name);
        if (r.installed) this.opts.onInstalled?.(id, contracts);
        return { output: { id, installed: r.installed, ...(r.tier ? { tier: r.tier } : {}), passed: r.report.passed, failed: r.report.failed, failedChecks: r.report.checks.filter(c => !c.ok).map(c => c.id + (c.detail ? ': ' + c.detail : '')), contracts, ...(e.setup ? { setup: e.setup } : {}), message: r.installed ? `已安装（本机 conformance ${r.report.passed} 项全过）；宿主会热加载新能力${e.setup ? '，安装后需要配置：见 setup' : ''}` : `未安装：本机 conformance ${r.report.failed} 项未过` } as unknown as Json };
      }
      return { error: { code: 'ROUTING_ERROR', message: `unknown contract ${inv.contract.name}`, retryable: false } };
    } catch (err) { return { error: { code: 'CAPABILITY_ERROR', message: err instanceof Error ? err.message : String(err), retryable: false } }; }
  }
  async health() { return { status: fs.existsSync(path.join(this.registryDir, 'index.json')) ? 'healthy' as const : 'degraded' as const, detail: this.registryDir }; }
}
