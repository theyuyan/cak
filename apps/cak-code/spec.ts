/** 运行时动态合入：已装插件契约（按副作用定审批、fs 路径加墙）、记忆上下文源、注册表能力、审查方 agent.invoke、控制器旗标。静态部分在 profiles.ts / ~/.cak/agents/*.yaml。 */
import type { AgentSpec } from '../../sdk/types.js';
import { APPROVE, builtinProfiles } from './profiles.js';
/** 已安装插件带来的契约：只读/无副作用免审批，其余默认要审批（用户可用 s=常设句柄放行一类） */
export type PluginGrant = { contract: string; version?: string; sideEffects: string; pathArg?: boolean };
export interface DynamicOpts { backend?: 'deepseek' | 'anthropic'; model?: string; workspaceName?: string; requireApproval?: boolean; reviewer?: boolean; pluginGrants?: PluginGrant[]; memory?: boolean; registry?: boolean; /** 同一内核进程里的其他 agent 可被委派（agent.invoke → agent.task，N-51） */ siblings?: boolean }
export function mergeDynamic(base: AgentSpec, o: DynamicOpts): AgentSpec {
  const spec: AgentSpec = JSON.parse(JSON.stringify(base));
  const approve = o.requireApproval === false ? [] : APPROVE;
  if (o.requireApproval === false) for (const g of spec.spec.grants) g.caveats = (g.caveats ?? []).filter(c => c.kind !== 'requires-approval');
  if (o.workspaceName) spec.metadata.labels = { ...(spec.metadata.labels ?? {}), workspace: o.workspaceName };
  if (o.backend) spec.spec.model.backend = o.backend; if (o.model) spec.spec.model.model = o.model;
  const have = new Set(spec.spec.grants.map(g => g.contract));
  // 插件契约：read/none 免审批，其余审批；带 fs 路径参数的再加一道句柄墙——只许相对路径、不许 ..（插件自己按 CAK_WORKSPACE 解析是第一道墙）
  for (const g of o.pluginGrants ?? []) { if (have.has(g.contract)) continue; spec.spec.grants.push({ contract: g.contract, ...(g.version ? { version: g.version } : {}), caveats: [...((g.sideEffects === 'read' || g.sideEffects === 'none') ? [] : approve), ...(g.pathArg ? [{ kind: 'args.match' as const, schema: { type: 'object', properties: { path: { type: 'string', pattern: '^(?![/\\\\])(?!.*(^|[/\\\\])\\.\\.([/\\\\]|$))(?![A-Za-z]:).*$' } } } }] : [])] }); have.add(g.contract); }
  // 审查 agent：句柄锁死 target=cak-review / contract=code.review
  if (o.reviewer && !o.siblings && !have.has('agent.invoke')) spec.spec.grants.push({ contract: 'agent.invoke', caveats: [{ kind: 'args.match', schema: { type: 'object', required: ['target', 'contract'], properties: { target: { const: 'cak-review' }, contract: { type: 'object', properties: { name: { const: 'code.review' } } } } } }] });
  // 同进程兄弟 agent（N-51）：agent.invoke 只锁 contract=agent.task（target 动态、由路由器判定），external → 默认审批
  if (o.siblings && !o.reviewer && !have.has('agent.invoke')) spec.spec.grants.push({ contract: 'agent.invoke', caveats: [...approve, { kind: 'args.match', schema: { type: 'object', required: ['target', 'contract'], properties: { contract: { type: 'object', properties: { name: { const: 'agent.task' } } } } } }] });
  else if (o.siblings && o.reviewer && !have.has('agent.invoke')) spec.spec.grants.push({ contract: 'agent.invoke', caveats: [...approve, { kind: 'args.match', schema: { type: 'object', required: ['target', 'contract'], properties: { contract: { type: 'object', properties: { name: { enum: ['agent.task', 'code.review'] } } } } } }] });
  // 有 memory.search 提供者时自动挂成上下文源（$input 占位，N-26）
  const ctx = spec.spec.context ?? { sources: [] }; if (o.memory && !ctx.sources.some(s => s.contract === 'memory.search')) ctx.sources.push({ contract: 'memory.search', args: { query: '$input', limit: 5 }, priority: 20, stability: 'turn' }); spec.spec.context = ctx;
  spec.spec.controller.config = { ...(spec.spec.controller.config ?? {}), reviewer: !!o.reviewer, memory: !!o.memory, registry: !!o.registry, siblings: !!o.siblings };
  return spec;
}
/** 兼容旧调用：cak-code（coding profile）+ 动态合入 */
export function buildSpec(o: DynamicOpts & { backend: 'deepseek' | 'anthropic'; model: string; workspaceName: string }): AgentSpec { return mergeDynamic(builtinProfiles()['coding']!, o); }
