#!/usr/bin/env node
// 测试夹具：提供一个"内核里不存在、只在注册表 contracts/community 里定义"的契约 echo.ping@1（N-50：社区契约随注册表分发）
import { servePlugin } from '../../sdk/plugin-host.js';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderExecuteResult, ContractRef } from '../../sdk/types.js';
const CONTRACT: ContractRef = { name: 'echo.ping', version: '1.0.0', schemaDigest: process.env['ECHO_PING_DIGEST']! };
class EchoPing implements CapabilityProvider {
  readonly id = 'echo-ping';
  listImplementations(): CapabilityImplementation[] { return [{ providerId: this.id, contract: CONTRACT, priority: 50 }]; }
  async execute(inv: AuthorizedInvocation): Promise<ProviderExecuteResult> { return { output: { pong: String((inv.args as any).msg) } }; }
  async health() { return { status: 'healthy' as const }; }
}
servePlugin(new EchoPing(), { pluginId: 'echo-ping', version: '0.1.0', kernelCompat: '^0.3.0' });
