/** Identity（01 §2.1）：Principal 链、后缀判断、HMAC 占位签名（M1）；Signer 接口不变，M4 换非对称。 */
import { createHmac, randomBytes } from 'node:crypto';
import type { Principal, PrincipalChain, Signature } from '../../sdk/types.js';
import { jcs } from '../ledger/ledger.js';

/** chain 必须以 holder 为后缀：task ⊂ agent ⊂ user ⊂ org */
export function isSuffix(chain: PrincipalChain, holder: PrincipalChain): boolean {
  if (holder.length === 0 || holder.length > chain.length) return false;
  const off = chain.length - holder.length;
  return holder.every((p, i) => chain[off + i]!.kind === p.kind && chain[off + i]!.id === p.id);
}
export const principalKey = (p: Principal) => `${p.kind}:${p.id}`;
export const chainKey = (c: PrincipalChain) => c.map(principalKey).join('<');

export interface Signer { sign(payload: unknown, as: Principal): Signature; verify(payload: unknown, sig: Signature): boolean }
/** M1 占位：进程内 HMAC；keyId = principal key */
export class HmacSigner implements Signer {
  private secret: Buffer;
  constructor(secret?: string) { this.secret = secret ? Buffer.from(secret) : randomBytes(32); }
  sign(payload: unknown, as: Principal): Signature { return { scheme: 'hmac-sha256', keyId: principalKey(as), value: createHmac('sha256', this.secret).update(principalKey(as) + '|' + jcs(payload)).digest('hex') }; }
  verify(payload: unknown, sig: Signature): boolean { return sig.scheme === 'hmac-sha256' && createHmac('sha256', this.secret).update(sig.keyId + '|' + jcs(payload)).digest('hex') === sig.value; }
}
