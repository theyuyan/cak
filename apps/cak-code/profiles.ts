/**
 * Agent 配置（profile）= 一份 AgentSpec：控制器是谁、用哪个模型后端、持有哪些能力、上下文源、观察者、拦截器。
 * 用户视角：装内核 → `cak up`（空内核 + 插件管理）→ 装插件 → 用/改 profile 搭出自己的 agent。cak-code 只是内置的第一份 profile（coding）。
 * 位置：~/.cak/agents/<name>.yaml（首次 `cak up` 会把内置三份写出去，之后以文件为准；改了重起即生效）。
 * 静态部分写在文件里；运行时动态部分（已装插件的契约、记忆上下文源、注册表能力、审查方）由 host 用 mergeDynamic 合入，不写回文件。
 */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import YAML from 'yaml';
import type { AgentSpec } from '../../sdk/types.js';
import { buildReviewSpec } from '../cak-review/spec.js';

export const APPROVE = [{ kind: 'requires-approval' as const, approver: 'any-with-approve-handle' as const, ttlMs: 30 * 60_000 }];
export const AGENTS_DIR = path.join(os.homedir(), '.cak', 'agents');

/** 内置 profile：bare（空内核：只有对话 + 插件管理）· coding（编程助手 = 原 cak-code）· review（审查方） */
export function builtinProfiles(): Record<string, AgentSpec> {
  const base = (name: string, displayName: string, description: string, persona: 'general' | 'coding', grants: AgentSpec['spec']['grants']): AgentSpec => ({
    apiVersion: 'agent.kernel/v1beta1', kind: 'Agent',
    metadata: { name, version: '0.1.0' },
    spec: {
      principal: { agent: name },
      controller: { provider: 'cak-code', config: { maxToolCallsPerStep: 6, persona } },
      grants,
      model: { backend: 'deepseek', model: 'deepseek-chat', caveats: [{ kind: 'budget', slice: { inputTokens: 2_000_000, outputTokens: 300_000 } }] },
      context: { sources: [{ contract: 'session.history', args: { limit: 20 }, priority: 10, stability: 'session' }] },
      minter: { provider: 'static-minter' },
      ledger: { store: 'sqlite' },
      task: { maxSteps: 25, stepTimeoutMs: 180_000, invokeTimeoutMs: 120_000, onLimit: 'final-step', maxConcurrentInvocations: 6 },
      manifest: { displayName, description, provides: [] },
    },
  });
  return {
    bare: base('bare', 'bare', '空内核：只带对话与插件管理，其余能力靠装插件搭出来', 'general', [{ contract: 'session.history' }]),
    coding: base('cak-code', 'cak-code', '在代码库里工作的编程助手', 'coding', [
      { contract: 'file.read', caveats: [{ kind: 'args.max', path: 'maxBytes', max: 262144 }] },
      { contract: 'file.list' }, { contract: 'file.search' }, { contract: 'git.diff' }, { contract: 'git.log' }, { contract: 'git.show' },
      { contract: 'file.write', caveats: APPROVE }, { contract: 'file.edit', caveats: APPROVE }, { contract: 'shell.exec', caveats: APPROVE }, { contract: 'git.commit', caveats: APPROVE },
      { contract: 'session.history' },
    ]),
    review: buildReviewSpec({ backend: 'deepseek', model: 'deepseek-chat', workspaceName: 'workspace' }),
  };
}
/** 保证 ~/.cak/agents 里有内置三份（不覆盖用户改过的）；返回目录 */
export function ensureProfiles(dir = AGENTS_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, spec] of Object.entries(builtinProfiles())) { const f = path.join(dir, name + '.yaml'); if (!fs.existsSync(f)) fs.writeFileSync(f, `# cak agent profile「${name}」——改了重起 cak up 即生效。控制器/后端/能力都可以换成已装插件的 id\n` + YAML.stringify(spec)); }
  return dir;
}
/** 读 profile：名字（~/.cak/agents/<name>.yaml，缺文件时用内置）或 yaml 路径 */
export function loadProfile(nameOrPath: string, dir = AGENTS_DIR): AgentSpec {
  const p = nameOrPath.endsWith('.yaml') || nameOrPath.endsWith('.yml') ? path.resolve(nameOrPath) : path.join(dir, nameOrPath + '.yaml');
  if (fs.existsSync(p)) return YAML.parse(fs.readFileSync(p, 'utf8')) as AgentSpec;
  const b = builtinProfiles()[nameOrPath]; if (!b) throw new Error(`没有 agent 配置「${nameOrPath}」（内置：${Object.keys(builtinProfiles()).join(' / ')}；自定义放 ${dir}/<name>.yaml）`);
  return b;
}
export function listProfiles(dir = AGENTS_DIR): Array<{ name: string; file?: string; builtin: boolean; controller: string; backend: string; grants: number }> {
  const out = new Map<string, { name: string; file?: string; builtin: boolean; controller: string; backend: string; grants: number }>();
  for (const [n, s] of Object.entries(builtinProfiles())) out.set(n, { name: n, builtin: true, controller: s.spec.controller.provider, backend: s.spec.model.backend, grants: s.spec.grants.length });
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(x => /\.ya?ml$/.test(x))) { try { const s = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as AgentSpec; const n = f.replace(/\.ya?ml$/, ''); out.set(n, { name: n, file: path.join(dir, f), builtin: !!builtinProfiles()[n], controller: s.spec.controller.provider, backend: s.spec.model.backend, grants: s.spec.grants.length }); } catch { /* skip bad */ } }
  return [...out.values()];
}
