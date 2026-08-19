// N-52：技能（skill）以插件形态存在 —— 注册表条目 roles:[skill]、entrypoint none、只有 SKILL.md（T0）；`skills` 能力插件把它们列出来（skill.list）并按需读（skill.read）；
// 宿主有 skill.list 时自动挂成上下文源：模型每轮看到「技能清单」；控制器规则让它对得上就先 skill.read。内核零改动。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { Kernel } from '../../kernel/runtime/kernel.js';
import { FileRegistry, installPlugin } from '../../kernel/boundary/registry.js';
import { contractDigest } from '../../kernel/contract/registry.js';
import { MockBackend } from '../../plugins/builtin/index.js';
import { WorkspaceProvider } from '../../apps/cak-code/workspace-provider.js';
import { codingController } from '../../apps/cak-code/controller.js';
import { buildSpec } from '../../apps/cak-code/spec.js';
import type { CapabilityProvider, AuthorizedInvocation, ProviderExecuteResult, Json } from '../../sdk/types.js';
const git = (args: string[], cwd: string) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
const LIST: any = { name: 'skill.list', version: '1.0.0', description: 't', inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' } } }, outputSchema: { type: 'object', required: ['skills', 'summary'], additionalProperties: false, properties: { skills: { type: 'array', items: { type: 'object', required: ['name', 'description', 'source'], additionalProperties: false, properties: { name: { type: 'string' }, description: { type: 'string' }, source: { type: 'string' }, requires: { type: 'array', items: { type: 'string' } }, files: { type: 'integer' } } } }, summary: { type: 'string' } } }, permissions: ['fs.read'], sideEffects: 'read', idempotent: true, defaultTimeoutMs: 5000, async: false };
const READ: any = { name: 'skill.read', version: '1.0.0', description: 't', inputSchema: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1 }, file: { type: 'string' }, maxChars: { type: 'integer', minimum: 200, maximum: 200000, default: 40000 } } }, outputSchema: { type: 'object', required: ['name', 'file', 'text', 'truncated', 'files'], additionalProperties: false, properties: { name: { type: 'string' }, file: { type: 'string' }, text: { type: 'string' }, truncated: { type: 'boolean' }, files: { type: 'array', items: { type: 'string' } }, requires: { type: 'array', items: { type: 'string' } }, source: { type: 'string' } } }, permissions: ['fs.read'], sideEffects: 'read', idempotent: true, defaultTimeoutMs: 5000, async: false };
LIST.schemaDigest = contractDigest(LIST); READ.schemaDigest = contractDigest(READ);
/** 测试内的极简 skills 提供者：只扫 pluginsDir 里 roles 含 skill 的 manifest（真实现是 cak-plugins/plugins/skills，逻辑同源） */
class SkillsFake implements CapabilityProvider {
  readonly id = 'skills'; constructor(private pluginsDir: string) {}
  listImplementations() { return [LIST, READ].map(c => ({ providerId: this.id, contract: { name: c.name, version: c.version, schemaDigest: c.schemaDigest }, priority: 50 })); }
  private skills() { return fs.readdirSync(this.pluginsDir).flatMap(id => { const mp = path.join(this.pluginsDir, id, 'manifest.json'); if (!fs.existsSync(mp)) return []; const m = JSON.parse(fs.readFileSync(mp, 'utf8')); if (!(m.roles ?? []).includes('skill')) return []; const md = fs.readFileSync(path.join(m.cwd, 'SKILL.md'), 'utf8'); const desc = /description:\s*(.*)/.exec(md)?.[1] ?? ''; return [{ name: id, description: desc, source: `plugin:${id}`, dir: m.cwd, body: md.replace(/^---[\s\S]*?---\n/, '') }]; }); }
  async execute(inv: AuthorizedInvocation): Promise<ProviderExecuteResult> {
    const s = this.skills();
    if (inv.contract.name === 'skill.list') return { output: { skills: s.map(x => ({ name: x.name, description: x.description, source: x.source })), summary: `技能库（${s.length}）：\n${s.map(x => `- ${x.name}：${x.description}`).join('\n')}` } as unknown as Json };
    const x = s.find(y => y.name === String((inv.args as any).name)); if (!x) return { error: { code: 'CAPABILITY_ERROR', message: 'unknown skill', retryable: false } };
    return { output: { name: x.name, file: 'SKILL.md', text: x.body, truncated: false, files: [], source: x.source } as unknown as Json };
  }
  async health() { return { status: 'healthy' as const }; }
}

describe('技能即插件（N-52）', () => {
  it('注册表装 skill（roles:[skill]，entrypoint none，只有 SKILL.md）→ T0 manifest；有 skill.list 时清单自动进上下文；模型按清单 skill.read 读全文；带可执行入口的 skill 被拒', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skl-'));
    // "远程"技能包：一个目录一份 SKILL.md
    const work = path.join(tmp, 'work'); fs.mkdirSync(path.join(work, 'skills', 'weekly-report'), { recursive: true });
    fs.writeFileSync(path.join(work, 'skills', 'weekly-report', 'SKILL.md'), '---\nname: weekly-report\ndescription: 写周报（先 git.log 收集本周提交，再按模块归类成文）\n---\n# 周报流程\n1. git.log 拉本周\n2. 归类\n3. 成文\n');
    fs.mkdirSync(path.join(work, 'skills', 'bad-skill'), { recursive: true }); fs.writeFileSync(path.join(work, 'skills', 'bad-skill', 'SKILL.md'), '---\ndescription: 带脚本的\n---\nx');
    git(['init', '-q', '-b', 'main'], work); git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], work); git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], work);
    const bare = path.join(tmp, 'remote.git'); git(['clone', '-q', '--bare', work, bare], tmp);
    const reg = new FileRegistry(path.join(tmp, 'registry')); const installDir = path.join(tmp, 'plugins');
    reg.addPlugin({ id: 'weekly-report', version: '0.1.0', kernelCompat: '^0.3.0', license: 'Apache-2.0', roles: ['skill'], description: '写周报的流程', install: { type: 'git', url: bare, ref: 'main', subdir: 'skills/weekly-report', build: [] }, entrypoint: { type: 'none' }, contracts: [] });
    reg.addPlugin({ id: 'bad-skill', version: '0.1.0', kernelCompat: '^0.3.0', license: 'Apache-2.0', roles: ['skill'], install: { type: 'git', url: bare, ref: 'main', subdir: 'skills/bad-skill', build: [] }, entrypoint: { type: 'subprocess', command: 'node', args: ['x.js'] }, contracts: [] });
    const r = await installPlugin(reg, 'weekly-report', installDir); expect(r.installed).toBe(true); expect(r.tier).toBe('T0');
    const m = JSON.parse(fs.readFileSync(r.manifestPath!, 'utf8')); expect(m.roles).toEqual(['skill']); expect(fs.existsSync(path.join(m.cwd, 'SKILL.md'))).toBe(true);
    await expect(installPlugin(reg, 'bad-skill', installDir)).rejects.toThrow(/must not have an executable entrypoint/);
    // 宿主侧：skills 提供者 + 两个 grant → mergeDynamic 自动挂 skill.list 上下文源 + 控制器 skills 规则
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const spec = buildSpec({ backend: 'deepseek', model: 'mock', workspaceName: 'x', pluginGrants: [{ contract: 'skill.list', version: '1.0.0', sideEffects: 'read' }, { contract: 'skill.read', version: '1.0.0', sideEffects: 'read' }] });
    expect(spec.spec.context?.sources.some(s => s.contract === 'skill.list')).toBe(true); expect(spec.spec.controller.config?.['skills']).toBe(true);
    const backend = new MockBackend([{ finishReason: 'tool_calls', toolCalls: [{ id: 'c1', contract: 'skill.read', args: { name: 'weekly-report' } }] }, { finishReason: 'stop', content: '按 weekly-report 技能写好了' }]);
    const k = await Kernel.compose(spec, { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: backend }, providers: [new WorkspaceProvider(ws), new SkillsFake(installDir)], contracts: [LIST, READ] });
    const t = await k.startTask('帮我写周报', { input: '帮我写周报' }); expect(t.status).toBe('finished'); expect(t.output).toBe('按 weekly-report 技能写好了');
    // 模型第一轮就看到了技能清单（来自上下文源），系统提示含技能规则
    const first = backend.calls[0]!; const text = JSON.stringify(first);
    expect(text).toContain('技能库（1）'); expect(text).toContain('weekly-report：写周报'); expect(text).toContain('技能库：上下文里会给一份');
    // skill.read 真被调用、读到正文
    const all = k.ledger.all() as any[]; const rd = all.find(e => e.type === 'invocation.requested' && e.payload?.contract?.name === 'skill.read'); expect(rd).toBeTruthy();
    const ex = all.find(e => e.type === 'invocation.executed' && e.payload?.output?.file === 'SKILL.md'); expect(ex.payload.output.text).toContain('# 周报流程');
  }, 60000);
});
