/** cak-code 的 Agent Spec：读类默认放行（限 workspace）；写 / shell / commit 要审批；模型有 token 预算。 */
import type { AgentSpec } from '../../sdk/types.js';
/** 已安装插件带来的契约：只读/无副作用免审批，其余默认要审批（用户可用 s=常设句柄放行一类） */
export type PluginGrant = { contract: string; version?: string; sideEffects: string };
export function buildSpec(o: { backend: 'deepseek' | 'anthropic'; model: string; workspaceName: string; requireApproval?: boolean; reviewer?: boolean; pluginGrants?: PluginGrant[]; memory?: boolean }): AgentSpec {
  const approve = o.requireApproval === false ? [] : [{ kind: 'requires-approval' as const, approver: 'any-with-approve-handle' as const, ttlMs: 30 * 60_000 }];
  return {
    apiVersion: 'agent.kernel/v1beta1', kind: 'Agent',
    metadata: { name: 'cak-code', version: '0.1.0', labels: { workspace: o.workspaceName } },
    spec: {
      principal: { agent: 'cak-code' },
      controller: { provider: 'cak-code', config: { maxToolCallsPerStep: 6, reviewer: !!o.reviewer, memory: !!o.memory } },
      grants: [
        { contract: 'file.read', caveats: [{ kind: 'args.max', path: 'maxBytes', max: 262144 }] },
        { contract: 'file.list' }, { contract: 'file.search' }, { contract: 'git.diff' },
        { contract: 'file.write', caveats: approve },
        { contract: 'file.edit', caveats: approve },
        { contract: 'shell.exec', caveats: approve },
        { contract: 'git.commit', caveats: approve },
        { contract: 'session.history' },
        // 审查 agent（第二个宿主）：句柄锁死 target=cak-review / contract=code.review，别的 agent 一个都调不了
        ...(o.pluginGrants ?? []).map(g => ({ contract: g.contract, ...(g.version ? { version: g.version } : {}), caveats: (g.sideEffects === 'read' || g.sideEffects === 'none') ? [] : approve })),
        ...(o.reviewer ? [{ contract: 'agent.invoke', caveats: [{ kind: 'args.match' as const, schema: { type: 'object', required: ['target', 'contract'], properties: { target: { const: 'cak-review' }, contract: { type: 'object', properties: { name: { const: 'code.review' } } } } } }] }] : []),
      ],
      model: { backend: o.backend, model: o.model, caveats: [{ kind: 'budget', slice: { inputTokens: 2_000_000, outputTokens: 300_000 } }] },
      // 有 memory.search 提供者（如 memory-sqlite 插件）时自动挂成上下文源：每轮按输入检索相关长期记忆（$input 占位，N-26）
      context: { sources: [{ contract: 'session.history', args: { limit: 20 }, priority: 10, stability: 'session' }, ...(o.memory ? [{ contract: 'memory.search', args: { query: '$input', limit: 5 }, priority: 20, stability: 'turn' as const }] : [])] },
      minter: { provider: 'static-minter' },
      ledger: { store: 'sqlite' },
      task: { maxSteps: 25, stepTimeoutMs: 180_000, invokeTimeoutMs: 120_000, onLimit: 'final-step', maxConcurrentInvocations: 6 },
      manifest: { displayName: 'cak-code', description: '在代码库里工作的编程助手', provides: [] },
    },
  };
}
