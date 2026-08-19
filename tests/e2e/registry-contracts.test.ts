// N-50：社区插件的契约随注册表分发（<registry>/contracts/**），不必等内核发版：cak add 的 conformance 认得它、宿主 compose 也认得它；同名不同 digest 报冲突
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { Kernel } from '../../kernel/runtime/kernel.js';
import { FileRegistry, installPlugin, loadInstalledPlugins, loadRegistryContracts, mergeContracts } from '../../kernel/boundary/registry.js';
import { contractDigest, loadBuiltinContracts } from '../../kernel/contract/registry.js';
import { MockBackend } from '../../plugins/builtin/index.js';
import { WorkspaceProvider } from '../../apps/cak-code/workspace-provider.js';
import { codingController } from '../../apps/cak-code/controller.js';
import { buildSpec } from '../../apps/cak-code/spec.js';
const TSX = path.resolve('node_modules/.bin/tsx');
const git = (args: string[], cwd: string) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };

const ECHO = { name: 'echo.ping', version: '1.0.0', description: '测试：回显', inputSchema: { type: 'object', required: ['msg'], additionalProperties: false, properties: { msg: { type: 'string' } } }, outputSchema: { type: 'object', required: ['pong'], additionalProperties: false, properties: { pong: { type: 'string' } } }, permissions: [], sideEffects: 'read', idempotent: true, defaultTimeoutMs: 5000, async: false } as any;
ECHO.schemaDigest = contractDigest(ECHO);

describe('注册表随带契约（N-50）', () => {
  it('registry.contracts() 读到 community 契约；installPlugin 的 conformance 认得它；compose 传 contracts 后 agent 能调用；同名不同 digest 报冲突', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regc-'));
    const regDir = path.join(tmp, 'registry'); const reg = new FileRegistry(regDir);
    fs.mkdirSync(path.join(regDir, 'contracts', 'community'), { recursive: true }); fs.writeFileSync(path.join(regDir, 'contracts', 'community', 'echo.ping@1.json'), JSON.stringify(ECHO));
    fs.writeFileSync(path.join(regDir, 'contracts', 'community', 'broken.json'), '{not json');   // 坏文件只跳过
    expect(reg.contracts().map(c => c.name)).toEqual(['echo.ping']);
    expect(loadRegistryContracts(path.join(tmp, 'nope'))).toEqual([]);
    // 冲突：注册表里放一个与内置 file.read 同名同版本但 schema 不同的契约 → mergeContracts 抛
    const fr = loadBuiltinContracts().find(c => c.name === 'file.read')!; const bad = { ...fr, description: 'x', outputSchema: { type: 'object' }, schemaDigest: 'sha256:' + '0'.repeat(64) };
    expect(() => mergeContracts(loadBuiltinContracts(), [bad as any])).toThrow(/CONFLICT|digest/i);
    // 装：入口是本仓的夹具子进程；conformance 用 sampleArgs 真调一次 → 必须认得 echo.ping
    const work = path.join(tmp, 'work'); fs.mkdirSync(path.join(work, 'p'), { recursive: true }); fs.writeFileSync(path.join(work, 'p', 'README.md'), 'x');
    git(['init', '-q', '-b', 'main'], work); git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], work); git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], work);
    const bare = path.join(tmp, 'remote.git'); git(['clone', '-q', '--bare', work, bare], tmp);
    process.env['ECHO_PING_DIGEST'] = ECHO.schemaDigest;
    reg.addPlugin({ id: 'echo-ping', version: '0.1.0', kernelCompat: '^0.3.0', license: 'Apache-2.0', install: { type: 'git', url: bare, ref: 'main', subdir: 'p', build: [] }, entrypoint: { type: 'subprocess', command: TSX, args: [path.resolve('tests/fixtures/echo-ping-plugin.ts')] }, contracts: [{ name: 'echo.ping', version: '1.0.0', sampleArgs: { msg: 'hi' } }] });
    const installDir = path.join(tmp, 'plugins');
    const r = await installPlugin(reg, 'echo-ping', installDir);
    expect(r.installed).toBe(true); expect(r.report.failed).toBe(0);
    // 宿主侧：compose 时把注册表契约作为 plugins.contracts 传入 → 句柄可铸、可调
    const installed = await loadInstalledPlugins(installDir); const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const spec = buildSpec({ backend: 'deepseek', model: 'mock', workspaceName: 'x', pluginGrants: [{ contract: 'echo.ping', version: '1.0.0', sideEffects: 'read' }] });
    const k = await Kernel.compose(spec, { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: new MockBackend([{ finishReason: 'tool_calls', toolCalls: [{ id: 'c1', contract: 'echo.ping', args: { msg: 'ping' } }] }, { finishReason: 'stop', content: '好了' }]) }, providers: [new WorkspaceProvider(ws), ...installed], contracts: reg.contracts() });
    const t = await k.startTask('ping 一下', { input: 'ping 一下' }); expect(t.status).toBe('finished');
    const all = k.ledger.all(); const req = all.findIndex((e: any) => e.type === 'invocation.requested' && e.payload?.contract?.name === 'echo.ping'); expect(req).toBeGreaterThan(0);
    expect(all.slice(req, req + 3).map((e: any) => e.type)).toEqual(['invocation.requested', 'invocation.authorized', 'invocation.executed']);   // 授权 + 执行，没有 denied
    for (const p of installed) await p.stop().catch(() => {});
    // 没传 contracts 时：内核不认识 echo.ping → compose 必须明确报错，而不是静默
    await expect(Kernel.compose(spec, { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: new MockBackend([]) }, providers: [new WorkspaceProvider(ws), ...(await loadInstalledPlugins(installDir))] })).rejects.toThrow(/echo\.ping/);
  }, 60000);
});
