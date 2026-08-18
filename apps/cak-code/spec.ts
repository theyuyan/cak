/** cak-code 的 Agent Spec：读类默认放行（限 workspace）；写 / shell / commit 要审批；模型有 token 预算。 */
import type { AgentSpec } from '../../sdk/types.js';
export function buildSpec(o: { backend: 'deepseek' | 'anthropic'; model: string; workspaceName: string; requireApproval?: boolean }): AgentSpec {
  const approve = o.requireApproval === false ? [] : [{ kind: 'requires-approval' as const, approver: 'any-with-approve-handle' as const, ttlMs: 30 * 60_000 }];
  return {
    apiVersion: 'agent.kernel/v1beta1', kind: 'Agent',
    metadata: { name: 'cak-code', version: '0.1.0', labels: { workspace: o.workspaceName } },
    spec: {
      principal: { agent: 'cak-code' },
      controller: { provider: 'cak-code', config: { maxToolCallsPerStep: 6 } },
      grants: [
        { contract: 'file.read', caveats: [{ kind: 'args.max', path: 'maxBytes', max: 262144 }] },
        { contract: 'file.list' }, { contract: 'file.search' }, { contract: 'git.diff' },
        { contract: 'file.write', caveats: approve },
        { contract: 'shell.exec', caveats: approve },
        { contract: 'git.commit', caveats: approve },
        { contract: 'session.history' },
      ],
      model: { backend: o.backend, model: o.model, caveats: [{ kind: 'budget', slice: { inputTokens: 2_000_000, outputTokens: 300_000 } }] },
      context: { sources: [{ contract: 'session.history', args: { limit: 20 }, priority: 10, stability: 'session' }] },
      minter: { provider: 'static-minter' },
      ledger: { store: 'sqlite' },
      task: { maxSteps: 25, stepTimeoutMs: 180_000, invokeTimeoutMs: 120_000, onLimit: 'final-step', maxConcurrentInvocations: 6 },
      manifest: { displayName: 'cak-code', description: '在代码库里工作的编程助手', provides: [] },
    },
  };
}
