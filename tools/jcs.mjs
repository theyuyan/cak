// 独立于内核实现的摘要工具：RFC 8785 JCS（canonicalize 库）+ SHA-256。
// 用途：生成 / 校验测试向量、计算契约 schemaDigest。内核代码将来必须与这里一致，而不是反过来。
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';

export function jcs(obj) {
  const s = canonicalize(obj);
  if (typeof s !== 'string') throw new Error('canonicalize failed');
  return s;
}
export function sha256hex(s) {
  return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}
export function digest(obj) {
  return 'sha256:' + sha256hex(jcs(obj));
}
export const ZERO_HASH = 'sha256:' + '0'.repeat(64);

/** 契约 schemaDigest：只含语义字段（见 04/05 与 v0.2 §B.2） */
export function contractDigest(c) {
  return digest({
    name: c.name,
    version: c.version,
    inputSchema: c.inputSchema,
    outputSchema: c.outputSchema,
    sideEffects: c.sideEffects,
    idempotent: c.idempotent,
    permissions: c.permissions ?? [],
  });
}

/** 账本事件 hash（05 §1） */
export function eventHash(e) {
  return digest({
    seq: e.seq, prevHash: e.prevHash, ts: e.ts, taskId: e.taskId,
    principal: e.principal, type: e.type, payload: e.payload, schemaVersion: e.schemaVersion,
  });
}
