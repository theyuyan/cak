/**
 * @cak/conformance（M3 / E1）：插件一致性测试套。对一个 CapabilityProvider（进程内或 subprocess 代理）跑一组"必须过"的检查，
 * 输出 conformance-report（后续进注册表与信任分级）。判据来自契约与设计包，不来自 Provider 自己的说法。
 */
import Ajv2020 from 'ajv/dist/2020.js';
import type { CapabilityProvider, CapabilityContract, AuthorizedInvocation, ProviderCallContext, JsonObject, Json, HandleView } from './types.js';

export interface ConformanceCase { contract: CapabilityContract; sampleArgs: JsonObject; badArgs?: JsonObject; expectIdempotent?: boolean }
export interface CheckResult { id: string; ok: boolean; detail?: string; durationMs?: number }
export interface ConformanceReport { providerId: string; passed: number; failed: number; checks: CheckResult[]; ok: boolean; startedAt: string; finishedAt: string }

const ajv = new Ajv2020({ strict: false, allErrors: true });
const mkInvocation = (c: CapabilityContract, args: JsonObject, id: string): AuthorizedInvocation => Object.freeze({
  id, revision: 0, contract: { name: c.name, version: c.version, schemaDigest: c.schemaDigest }, args: Object.freeze({ ...args }),
  handle: { id: 'h_conf', contract: { name: c.name, version: c.version, schemaDigest: c.schemaDigest }, caveats: [], delegable: true } as HandleView,
  principal: [{ kind: 'task' as const, id: 't_conf' }, { kind: 'agent' as const, id: 'conformance' }], digest: 'sha256:' + '0'.repeat(64), idempotencyKey: id,
});
const mkCtx = (deadlineMs = 5000): ProviderCallContext => ({ principal: [{ kind: 'task' as const, id: 't_conf' }, { kind: 'agent' as const, id: 'conformance' }], trace: { traceId: 'tr_conf', spanId: 'sp_conf' }, deadlineAtMs: Date.now() + deadlineMs, cancellationId: 'cx_conf' });
const roundtrips = (v: unknown) => { try { return JSON.stringify(JSON.parse(JSON.stringify(v))) === JSON.stringify(v); } catch { return false; } };

export async function runConformance(provider: CapabilityProvider, cases: ConformanceCase[]): Promise<ConformanceReport> {
  const checks: CheckResult[] = []; const startedAt = new Date().toISOString();
  const add = (id: string, ok: boolean, detail?: string, durationMs?: number) => checks.push({ id, ok, ...(detail ? { detail } : {}), ...(durationMs !== undefined ? { durationMs } : {}) });
  const guard = async <T,>(id: string, fn: () => Promise<T>): Promise<T | undefined> => { const t = Date.now(); try { const r = await fn(); return r; } catch (e) { add(id, false, `threw: ${e instanceof Error ? e.message : String(e)}`, Date.now() - t); return undefined; } };

  // C1 实现声明：非空、digest 与契约一致、providerId 一致
  const impls = provider.listImplementations();
  add('C1.implementations.nonEmpty', impls.length > 0, `${impls.length} implementations`);
  for (const c of cases) {
    const impl = impls.find(i => i.contract.name === c.contract.name && i.contract.version === c.contract.version);
    add(`C1.declares.${c.contract.name}`, !!impl, impl ? undefined : 'not declared');
    if (impl) add(`C1.digest.${c.contract.name}`, impl.contract.schemaDigest === c.contract.schemaDigest, impl.contract.schemaDigest === c.contract.schemaDigest ? undefined : `impl ${impl.contract.schemaDigest} ≠ contract ${c.contract.schemaDigest}`);
    add(`C1.providerId.${c.contract.name}`, !impl || impl.providerId === provider.id, impl && impl.providerId !== provider.id ? `impl says ${impl.providerId}` : undefined);
  }
  for (const c of cases) {
    const inSchema = ajv.compile(c.contract.inputSchema); const outSchema = ajv.compile(c.contract.outputSchema);
    add(`C2.sampleArgs.valid.${c.contract.name}`, !!inSchema(c.sampleArgs), inSchema.errors ? JSON.stringify(inSchema.errors).slice(0, 200) : undefined);
    // C3 执行：返回形状、outputSchema、DTO 往返
    const t = Date.now(); const DEADLINE = 5000;
    const r = await guard(`C3.execute.${c.contract.name}`, () => Promise.race([provider.execute(mkInvocation(c.contract, c.sampleArgs, 'inv_c3'), mkCtx(DEADLINE)), new Promise<'timeout'>(res => setTimeout(() => res('timeout'), DEADLINE + 500))]));
    add(`C3.completesWithinDeadline.${c.contract.name}`, r !== 'timeout' && r !== undefined, r === 'timeout' ? `no result within ${DEADLINE}ms` : undefined, Date.now() - t);
    if (r !== undefined && r !== 'timeout') {
      const shape = r && typeof r === 'object' && ('output' in r || 'error' in r);
      add(`C3.shape.${c.contract.name}`, !!shape, shape ? undefined : `got ${JSON.stringify(r).slice(0, 120)}`);
      if (shape && 'output' in r) {
        add(`C3.outputSchema.${c.contract.name}`, !!outSchema(r.output), outSchema.errors ? JSON.stringify(outSchema.errors).slice(0, 200) : undefined);
        add(`C3.roundtrip.${c.contract.name}`, roundtrips(r), roundtrips(r) ? undefined : 'result not JSON-roundtrippable');
      } else if (shape) {
        const code = (r as any).error?.code;
        add(`C3.errorShape.${c.contract.name}`, typeof code === 'string' && typeof (r as any).error?.message === 'string');
        // sampleArgs 是合法输入：返回 TIMEOUT / TRANSPORT_ERROR / INTERNAL_ERROR 视为不通过（Provider 挂了或坏了）
        add(`C3.sampleArgsSucceed.${c.contract.name}`, !['TIMEOUT', 'TRANSPORT_ERROR', 'INTERNAL_ERROR', 'PROVIDER_ERROR'].includes(code), `error ${code}: ${(r as any).error?.message}`);
      }
    }
    // C4 不改 args（冻结对象；Provider 试图改会抛或无效）
    const frozenArgs = Object.freeze({ ...c.sampleArgs }); const inv = mkInvocation(c.contract, frozenArgs, 'inv_c4');
    await guard(`C4.execute.${c.contract.name}`, () => provider.execute(inv, mkCtx()));
    add(`C4.argsUnchanged.${c.contract.name}`, JSON.stringify(inv.args) === JSON.stringify(c.sampleArgs));
    // C5 幂等：同 args 两次输出相同（仅 idempotent 契约）
    if (c.contract.idempotent && (c.expectIdempotent ?? true)) {
      const a = await guard(`C5.idem.a.${c.contract.name}`, () => provider.execute(mkInvocation(c.contract, c.sampleArgs, 'inv_c5a'), mkCtx()));
      const b = await guard(`C5.idem.b.${c.contract.name}`, () => provider.execute(mkInvocation(c.contract, c.sampleArgs, 'inv_c5b'), mkCtx()));
      if (a !== undefined && b !== undefined) add(`C5.idempotent.${c.contract.name}`, JSON.stringify(a) === JSON.stringify(b));
    }
    // C6 badArgs：不崩（返回 error 或 output 均可，但不得抛/挂）
    if (c.badArgs) { const rb = await guard(`C6.badArgs.${c.contract.name}`, () => Promise.race([provider.execute(mkInvocation(c.contract, c.badArgs!, 'inv_c6'), mkCtx(2000)), new Promise<'timeout'>(res => setTimeout(() => res('timeout'), 2500))])); add(`C6.badArgs.noHang.${c.contract.name}`, rb !== 'timeout' && rb !== undefined); }
    // C7 取消：有 cancel 则调用不抛
    if (provider.cancel) await guard(`C7.cancel.${c.contract.name}`, () => provider.cancel!('cx_conf'));
    // C8 健康：有 health 则返回 status
    if (provider.health) { const h = await guard(`C8.health`, () => provider.health!()); if (h) add('C8.health.shape', ['healthy', 'degraded', 'failed'].includes(h.status)); }
  }
  // C9 越界：Provider 对象自身不该暴露内核内部（没有 authority/ledger/proof 字段）
  add('C9.noKernelInternals', !['authority', 'ledger', 'proof', 'kernel'].some(k => k in (provider as any)));
  const passed = checks.filter(c => c.ok).length, failed = checks.length - passed;
  return { providerId: provider.id, passed, failed, checks, ok: failed === 0, startedAt, finishedAt: new Date().toISOString() };
}
export const summarize = (r: ConformanceReport) => `${r.ok ? '✓' : '✗'} ${r.providerId}: ${r.passed} passed, ${r.failed} failed` + (r.failed ? '\n' + r.checks.filter(c => !c.ok).map(c => `   ✗ ${c.id}${c.detail ? ' — ' + c.detail : ''}`).join('\n') : '');
