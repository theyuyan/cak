// 「装内核 → 装插件 → 搭 agent」形状对齐（N-47）：控制器作为进程内插件（T2）经 cak add 装入；agent profile（YAML）指定 controller.provider = 该插件 id；host 按 profile 组装；内核零改动
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { FileRegistry, installPlugin, loadInstalledModules } from '../../kernel/boundary/registry.js';
import { createHost } from '../../apps/cak-code/host.js';
import { builtinProfiles, loadProfile, listProfiles } from '../../apps/cak-code/profiles.js';
import { MockBackend } from '../../plugins/builtin/index.js';
const git = (args: string[], cwd: string) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };

describe('agent 由插件搭出来', () => {
  it('内置 profile 三份可读；自定义 yaml 可读；控制器插件（in-process, T2）装入 → profile 指向它 → host 组装 → task 由该控制器决策', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
    expect(Object.keys(builtinProfiles())).toEqual(['bare', 'coding', 'review']);
    expect(loadProfile('coding').spec.controller.provider).toBe('cak-code');
    // 1) 一个"第三方控制器"插件：不调模型，直接把输入倒过来当结果（证明控制器可替换）
    const work = path.join(tmp, 'work'); fs.mkdirSync(path.join(work, 'ctl'), { recursive: true });
    fs.writeFileSync(path.join(work, 'ctl', 'index.mjs'), `export default function createController(cfg) { return { id: 'echo-reverse', async decide(ctx) { const s = String(ctx.view.input ?? ''); return { type: 'finish', output: '[echo-reverse] ' + [...s].reverse().join('') }; } }; }\n`);
    git(['init', '-q', '-b', 'main'], work); git(['add', '-A'], work); git(['commit', '-qm', 'init'], work); const bare = path.join(tmp, 'remote.git'); git(['clone', '-q', '--bare', work, bare], tmp);
    const reg = new FileRegistry(path.join(tmp, 'registry')); const installDir = path.join(tmp, 'plugins');
    reg.addPlugin({ id: 'echo-reverse', version: '0.1.0', kernelCompat: '^0.3.0', license: 'Apache-2.0', roles: ['controller'], install: { type: 'git', url: bare, ref: 'main', subdir: 'ctl', build: [] }, entrypoint: { type: 'in-process', module: 'index.mjs', export: 'default' }, contracts: [] } as any);
    const r = await installPlugin(reg, 'echo-reverse', installDir); expect(r.installed).toBe(true); expect(r.tier).toBe('T2');
    const mods = await loadInstalledModules(installDir); expect(Object.keys(mods.controllers)).toEqual(['echo-reverse']);
    // 2) 一个 agent profile：从 bare 复制，controller.provider 改成插件 id
    const agentsDir = path.join(tmp, 'agents'); fs.mkdirSync(agentsDir); const spec = JSON.parse(JSON.stringify(builtinProfiles()['bare'])); spec.metadata.name = 'my-echo'; spec.spec.principal.agent = 'my-echo'; spec.spec.controller = { provider: 'echo-reverse', config: {} };
    const yamlPath = path.join(agentsDir, 'my-echo.yaml'); fs.writeFileSync(yamlPath, YAML.stringify(spec));
    expect(listProfiles(agentsDir).find(p => p.name === 'my-echo')?.controller).toBe('echo-reverse');
    // 3) host 按 profile 组装（yaml 路径）：控制器来自已装插件；模型后端给 mock（本控制器不会调它）
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const host = await createHost({ workspace: ws, agent: yamlPath, session: 'prof-' + Date.now(), pluginsDir: installDir, mcp: null, registryDir: null, backendImpl: new MockBackend([{ finishReason: 'stop', content: 'unused' }]) });
    try {
      expect(host.status().controller).toBe('echo-reverse'); expect(host.status().modules).toEqual(['echo-reverse']);
      const res = await host.submit('abc'); expect(res.status).toBe('finished'); expect(res.output).toBe('[echo-reverse] cba');
      // 不存在的控制器 → 组装期明确报错
      const bad = JSON.parse(JSON.stringify(spec)); bad.spec.controller.provider = 'nope'; const badPath = path.join(agentsDir, 'bad.yaml'); fs.writeFileSync(badPath, YAML.stringify(bad));
      await expect(createHost({ workspace: ws, agent: badPath, session: 'prof-bad', pluginsDir: installDir, mcp: null, registryDir: null, backendImpl: new MockBackend([]) })).rejects.toThrow(/没有控制器「nope」/);
    } finally { await host.close(); }
  }, 60000);
});

describe('子进程控制器（N-48）', () => {
  it('控制器跑在自己的进程里：内核发 controller.decide → 插件反向 ctx.invoke（file.read 仍走 verify）→ 返回 finish；越权句柄被拒后控制器如实汇报', async () => {
    const { SubprocessProvider } = await import('../../kernel/boundary/subprocess.js'); const { subprocessControllers } = await import('../../kernel/boundary/registry.js');
    const { Kernel } = await import('../../kernel/runtime/kernel.js'); const { WorkspaceProvider } = await import('../../apps/cak-code/workspace-provider.js');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'subctl-')); fs.writeFileSync(path.join(ws, 'README.md'), '# hello from subprocess controller test\n');
    const sub = new SubprocessProvider({ id: 'ctl-readme', command: path.resolve('node_modules/.bin/tsx'), args: [path.resolve('plugins/subprocess/ctl-readme.ts')] }); await sub.start();
    try {
      expect(((sub.hello as any).roles as string[])).toContain('controller'); const ctls = subprocessControllers([sub]); expect(Object.keys(ctls)).toEqual(['ctl-readme']);
      const spec = JSON.parse(JSON.stringify(builtinProfiles()['coding'])); spec.spec.controller = { provider: 'ctl-readme', config: {} };
      const k = await Kernel.compose(spec, { controllers: { 'ctl-readme': cfg => ctls['ctl-readme']!(cfg) as any }, backends: { deepseek: new MockBackend([]) }, providers: [new WorkspaceProvider(ws), sub] }, {});
      const r = await k.startTask('x', { input: 'x' }); expect(r.status).toBe('finished'); expect(String(r.output)).toMatch(/^\[ctl-readme\] # hello from subprocess controller/);
      const inv = Object.values(k.ledger.projections().invocations).find(i => i.contract.name === 'file.read')!; expect(inv.status).toBe('executed');   // 反向 invoke 走了内核 verify 并入账
    } finally { await sub.stop(); }
  }, 30000);
});

describe.skipIf(spawnSync('python3', ['--version']).status !== 0)('子进程控制器 · Python', () => {
  it('sdk-python 的控制器：hello roles 含 controller → decide → 反向 ctx.invoke → finish', async () => {
    const { SubprocessProvider } = await import('../../kernel/boundary/subprocess.js'); const { subprocessControllers } = await import('../../kernel/boundary/registry.js');
    const { Kernel } = await import('../../kernel/runtime/kernel.js'); const { WorkspaceProvider } = await import('../../apps/cak-code/workspace-provider.js');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pyctl-')); fs.writeFileSync(path.join(ws, 'README.md'), '# python controller says hi\n');
    const sub = new SubprocessProvider({ id: 'py-ctl', command: 'python3', args: [path.resolve('sdk-python/examples/readme_controller.py')] }); await sub.start();
    try {
      const ctls = subprocessControllers([sub]); expect(Object.keys(ctls)).toEqual(['py-ctl']);
      const spec = JSON.parse(JSON.stringify(builtinProfiles()['coding'])); spec.spec.controller = { provider: 'py-ctl', config: {} };
      const k = await Kernel.compose(spec, { controllers: { 'py-ctl': cfg => ctls['py-ctl']!(cfg) as any }, backends: { deepseek: new MockBackend([]) }, providers: [new WorkspaceProvider(ws), sub] }, {});
      const r = await k.startTask('x', { input: 'x' }); expect(r.status).toBe('finished'); expect(String(r.output)).toMatch(/^\[py-ctl\] # python controller says hi/);
    } finally { await sub.stop(); }
  }, 30000);
});
