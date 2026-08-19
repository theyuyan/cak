import { test } from 'node:test'; import assert from 'node:assert/strict';
import { __CLASS__ } from './dist/provider.js';
// 直接调 provider（不经内核）：把 sampleArgs 换成你契约的真实入参；断言出参字段与 outputSchema 完全对齐（多一个字段内核会拒）
const CONTRACT = { name: '__CONTRACT__', version: '__CONTRACT_VERSION__', schemaDigest: '__DIGEST__' };
const call = (p, args) => p.execute({ id: 'i', revision: 0, contract: CONTRACT, args, handle: { id: 'h', contract: CONTRACT, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });
test('execute 返回 output 或明确的 CAPABILITY_ERROR', async () => {
  const r = await call(new __CLASS__(), {});
  assert.ok('output' in r || (r.error && r.error.code), JSON.stringify(r));
});
