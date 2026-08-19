// __NAME__ — CAK Capability Provider（进程内 / 子进程同一份代码）
// 你只需要实现 listImplementations() 与 execute()。你拿不到内核内部：AuthorizedInvocation 是唯一输入，一定已通过验证。
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef } from '@cak-dev/sdk';

const CONTRACT: ContractRef = { name: '__CONTRACT__', version: '__CONTRACT_VERSION__', schemaDigest: '__DIGEST__' };   // digest：现成契约从注册表抄；新契约 `cak digest <契约.json>` 算；不匹配会在装配期 fail-fast

export class __CLASS__ implements CapabilityProvider {
  readonly id = '__NAME__';
  listImplementations(): CapabilityImplementation[] { return [{ providerId: this.id, contract: CONTRACT, priority: 50 }]; }
  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    // inv.args 已冻结且已过句柄验证；只需按契约 outputSchema 返回 output（或 { error }）
    return { output: { echo: inv.args } };
  }
  async health() { return { status: 'healthy' as const }; }
}
