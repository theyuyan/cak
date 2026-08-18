// "agent 替小白装插件"（N-38）：注册表是 Provider —— plugin.search（免审批）→ plugin.install（审批）→ 宿主同一账本重组（N-37 补铸新契约根句柄）→ 下一任务就能用新能力。离线：注册表条目用本地 bare git 仓库当源
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { Kernel } from '../../kernel/runtime/kernel.js';
import { SqliteLedgerStore } from '../../kernel/ledger/sqlite-store.js';
import { FileRegistry, loadInstalledPlugins } from '../../kernel/boundary/registry.js';
import { MockBackend } from '../../plugins/builtin/index.js';
import { RegistryProvider } from '../../kernel/boundary/registry-provider.js';
import { WorkspaceProvider } from '../../apps/cak-code/workspace-provider.js';
import { codingController } from '../../apps/cak-code/controller.js';
import { buildSpec } from '../../apps/cak-code/spec.js';
const TSX = path.resolve('node_modules/.bin/tsx');
const git = (args: string[], cwd: string) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };

describe('registry as a Provider · agent 替用户找/装插件 → 热加载', () => {
  it('plugin.search 找到 → plugin.install 需审批 → 批准后装上（本机 conformance）→ 同账本重组内核 → 新契约 text.summarize 可用；越权/不存在的 id 有明确回复', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regprov-'));
    // "远程"插件仓库（内容无所谓，入口用主仓的子进程 text-summarize；验证的是 search→install→hot-load 链路）
    const work = path.join(tmp, 'work'); fs.mkdirSync(path.join(work, 'plugins', 'text-summarize'), { recursive: true }); fs.writeFileSync(path.join(work, 'plugins', 'text-summarize', 'README.md'), 'x');
    git(['init', '-q', '-b', 'main'], work); git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], work); git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], work);
    const bare = path.join(tmp, 'remote.git'); git(['clone', '-q', '--bare', work, bare], tmp);
    const regDir = path.join(tmp, 'registry'); const reg = new FileRegistry(regDir);
    reg.addPlugin({ id: 'text-summarize', version: '0.1.0', kernelCompat: '^0.3.0', license: 'Apache-2.0', description: '把一段文本总结成几句话', install: { type: 'git', url: bare, ref: 'main', subdir: 'plugins/text-summarize', build: [] }, entrypoint: { type: 'subprocess', command: TSX, args: [path.resolve('plugins/subprocess/text-summarize.ts')] }, contracts: [{ name: 'text.summarize', version: '1.0.0', sampleArgs: { text: 'hello world this is a long text' } }], setup: '无需配置' } as any);
    const installDir = path.join(tmp, 'plugins'); const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')); const ledgerStore = new SqliteLedgerStore(path.join(tmp, 'l.sqlite'));
    let changed = 0; const rp = new RegistryProvider({ registryDir: regDir, installDir, onInstalled: () => { changed++; } });
    // 与 cli.ts 的 composeKernel 同构：装载已装插件 → grants → spec → compose（同一账本）
    let installed: Awaited<ReturnType<typeof loadInstalledPlugins>> = [];
    const compose = async (backend: MockBackend) => {
      for (const p of installed) await p.stop().catch(() => {}); installed = await loadInstalledPlugins(installDir);
      const pluginGrants = [...installed.flatMap(p => p.listImplementations().map(i => ({ contract: i.contract.name, version: i.contract.version, sideEffects: 'read' }))), { contract: 'plugin.search', version: '1.0.0', sideEffects: 'read' }, { contract: 'plugin.install', version: '1.0.0', sideEffects: 'write' }];
      return Kernel.compose(buildSpec({ backend: 'deepseek', model: 'mock', workspaceName: 'x', pluginGrants, registry: true }), { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: backend }, providers: [new WorkspaceProvider(ws), ...installed, rp] }, { ledgerStore });
    };
    // 任务 1：搜 → 装（审批）→ 汇报
    const k1 = await compose(new MockBackend([
      { finishReason: 'tool_calls', toolCalls: [{ id: 'c1', contract: 'plugin.search', args: { query: '总结' } }] },
      { finishReason: 'tool_calls', toolCalls: [{ id: 'c2', contract: 'plugin.install', args: { id: 'text-summarize' } }] },
      { finishReason: 'stop', content: '装好了' },
    ]));
    let r = await k1.startTask('我想让你能总结文本', { input: '我想让你能总结文本' });
    expect(r.status).toBe('suspended'); const pend = k1.pendingApprovals(r.taskId); expect(pend[0]!.contract.name).toBe('plugin.install');
    const searchInv = Object.values(k1.ledger.projections().invocations).find(i => i.contract.name === 'plugin.search')!; expect((searchInv.output as any).plugins[0]).toMatchObject({ id: 'text-summarize', installed: false, setup: '无需配置' });
    expect(fs.existsSync(path.join(installDir, 'text-summarize', 'manifest.json'))).toBe(false);   // 批准前没装
    k1.grant(pend[0]!.approvalId, { kind: 'user', id: 'yuyan' }); r = await k1.resume(r.taskId); expect(r.status).toBe('finished');
    const inst = Object.values(k1.ledger.projections().invocations).find(i => i.contract.name === 'plugin.install')!; expect((inst.output as any).installed, JSON.stringify(inst.output)).toBe(true); expect((inst.output as any).contracts).toEqual(['text.summarize']);
    expect(changed).toBe(1); expect(fs.existsSync(path.join(installDir, 'text-summarize', 'manifest.json'))).toBe(true);
    // 热加载：同一账本重组 → N-37 给 text.summarize 补根句柄 → 任务 2 直接用
    const k2 = await compose(new MockBackend([{ finishReason: 'tool_calls', toolCalls: [{ id: 'c3', contract: 'text.summarize', args: { text: 'CAK 是内核。它有插件。它能互联。' } }] }, { finishReason: 'stop', content: 'ok' }]));
    expect(k2.rootHandles.some(h => h.contract.name === 'text.summarize')).toBe(true);
    expect(k2.ledger.all().some(e => e.type === 'handle.minted' && (e.payload as any).reason === 'spec-reconcile')).toBe(true);
    const r2 = await k2.startTask('总结', { input: '总结' }); expect(r2.status).toBe('finished');
    const sum = Object.values(k2.ledger.projections().invocations).find(i => i.contract.name === 'text.summarize')!; expect(sum.status).toBe('executed');
    for (const p of installed) await p.stop().catch(() => {});
    // 不存在的 id：明确回复而不是异常
    const k3 = await compose(new MockBackend([{ finishReason: 'tool_calls', toolCalls: [{ id: 'c4', contract: 'plugin.install', args: { id: 'nope' } }] }, { finishReason: 'stop', content: 'x' }]));
    let r3 = await k3.startTask('装 nope', { input: '装 nope' }); k3.grant(k3.pendingApprovals(r3.taskId)[0]!.approvalId, { kind: 'user', id: 'yuyan' }); r3 = await k3.resume(r3.taskId);
    const bad = Object.values(k3.ledger.projections().invocations).find(i => i.contract.name === 'plugin.install' && i.taskId === r3.taskId)!; expect((bad.output as any).installed).toBe(false); expect((bad.output as any).message).toContain('registry has no plugin');
    for (const p of installed) await p.stop().catch(() => {});
  }, 120000);
});
