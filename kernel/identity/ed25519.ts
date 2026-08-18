/** Ed25519 签名（M4）：非对称；Signer 接口不变（sign/verify），keyId = principal key；verify 靠可信公钥表。 */
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey, createPrivateKey, type KeyObject } from 'node:crypto';
import type { Principal, Signature } from '../../sdk/types.js';
import { jcs } from '../ledger/ledger.js';
import { principalKey, type Signer } from './identity.js';

export class Ed25519Signer implements Signer {
  private trusted = new Map<string, KeyObject>();       // keyId → public key
  constructor(private me: { principal: Principal; privateKey: KeyObject; publicKey: KeyObject }) { this.trusted.set(principalKey(me.principal), me.publicKey); }
  static generate(principal: Principal): Ed25519Signer { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return new Ed25519Signer({ principal, privateKey, publicKey }); }
  static fromPem(principal: Principal, privatePem: string, publicPem: string) { return new Ed25519Signer({ principal, privateKey: createPrivateKey(privatePem), publicKey: createPublicKey(publicPem) }); }
  publicKeyPem(): string { return this.me.publicKey.export({ type: 'spki', format: 'pem' }) as string; }
  privateKeyPem(): string { return this.me.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string; }
  /** 信任别人的公钥（名片交换 / 注册表分发） */
  trust(principal: Principal, publicPem: string) { this.trusted.set(principalKey(principal), createPublicKey(publicPem)); }
  sign(payload: unknown, as: Principal): Signature {
    if (principalKey(as) !== principalKey(this.me.principal)) throw new Error(`cannot sign as ${principalKey(as)}: not my key`);
    return { scheme: 'ed25519', keyId: principalKey(as), value: nodeSign(null, Buffer.from(jcs(payload), 'utf8'), this.me.privateKey).toString('base64url') };
  }
  verify(payload: unknown, sig: Signature): boolean {
    if (sig.scheme !== 'ed25519') return false;
    const pub = this.trusted.get(sig.keyId); if (!pub) return false;
    try { return nodeVerify(null, Buffer.from(jcs(payload), 'utf8'), pub, Buffer.from(sig.value, 'base64url')); } catch { return false; }
  }
}
