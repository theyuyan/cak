/** 本机 agent 身份：Ed25519 钥匙落 ~/.cak/identity/<agent>/（私钥 0600）；首次生成，之后复用——名片、回执、跨进程句柄 token 都靠它。 */
import fs from 'node:fs'; import path from 'node:path';
import { Ed25519Signer } from '../../kernel/identity/ed25519.js';
export function loadOrCreateSigner(dir: string, me: { kind: 'agent'; id: string }) {
  fs.mkdirSync(dir, { recursive: true }); const priv = path.join(dir, 'ed25519.key'), pub = path.join(dir, 'ed25519.pub');
  if (fs.existsSync(priv)) return Ed25519Signer.fromPem(me, fs.readFileSync(priv, 'utf8'), fs.readFileSync(pub, 'utf8'));
  const s = Ed25519Signer.generate(me); fs.writeFileSync(priv, s.privateKeyPem(), { mode: 0o600 }); fs.writeFileSync(pub, s.publicKeyPem()); return s;
}
