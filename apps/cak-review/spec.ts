/** cak-review 的 Agent Spec：只读（git.diff / file.read / file.search / file.list），对外提供 code.review。 */
import type { AgentSpec } from '../../sdk/types.js';
export function buildReviewSpec(o: { backend: 'deepseek' | 'anthropic'; model: string; workspaceName: string }): AgentSpec {
  return {
    apiVersion: 'agent.kernel/v1beta1', kind: 'Agent',
    metadata: { name: 'cak-review', version: '0.1.0', labels: { workspace: o.workspaceName } },
    spec: {
      principal: { agent: 'cak-review' },
      controller: { provider: 'cak-review', config: {} },
      grants: [
        { contract: 'file.read', caveats: [{ kind: 'args.max', path: 'maxBytes', max: 262144 }] },
        { contract: 'file.list' }, { contract: 'file.search' }, { contract: 'git.diff' },
      ],
      model: { backend: o.backend, model: o.model, caveats: [{ kind: 'budget', slice: { inputTokens: 1_000_000, outputTokens: 100_000 } }] },
      minter: { provider: 'static-minter' },
      ledger: { store: 'sqlite' },
      task: { maxSteps: 8, stepTimeoutMs: 180_000, invokeTimeoutMs: 120_000, onLimit: 'final-step', maxConcurrentInvocations: 4 },
      manifest: { displayName: 'cak-review', description: '代码审查 agent：只读 workspace，审未提交改动', provides: ['code.review'] },
    },
  };
}
