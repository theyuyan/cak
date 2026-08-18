/**
 * Contract Registry（01 §2.2、05 §B）：Contract ≠ Implementation；digest 冲突装配期 fail-fast；implicit 契约由首个实现定义。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityContract, CapabilityImplementation, ContractRef, ID } from '../../sdk/types.js';
import { digest } from '../ledger/ledger.js';
import { err } from '../errors.js';

export const contractDigest = (c: Omit<CapabilityContract, 'schemaDigest'> & { schemaDigest?: string }) =>
  digest({ name: c.name, version: c.version, inputSchema: c.inputSchema, outputSchema: c.outputSchema, sideEffects: c.sideEffects, idempotent: c.idempotent, permissions: c.permissions ?? [] });

const key = (name: string, version: string) => `${name}@${version}`;
const satisfies = (version: string, range?: string) => {
  if (!range || range === '*') return true;
  const [maj, min, pat] = version.split('.').map(Number);
  const m = range.match(/^(\^|~|>=|=)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) return version === range;
  const [, op, a, b, c] = m; const A = Number(a), B = b === undefined ? undefined : Number(b), C = c === undefined ? undefined : Number(c);
  const cmp = (maj! - A) || ((min ?? 0) - (B ?? 0)) || ((pat ?? 0) - (C ?? 0));
  switch (op) {
    case '^': return maj === A && (B === undefined || cmp >= 0);
    case '~': return maj === A && (B === undefined || min === B) && (C === undefined || (pat ?? 0) >= C);
    case '>=': return cmp >= 0;
    default: return maj === A && (B === undefined || min === B) && (C === undefined || pat === C);
  }
};

export interface Descriptor { contract: CapabilityContract; candidates: CapabilityImplementation[]; origin: 'builtin' | 'plugin' | 'implicit' }

export class ContractRegistry {
  private contracts = new Map<string, Descriptor>();
  private events: Array<{ type: 'contract.implicitly_defined'; payload: { name: string; version: string; schemaDigest: string; providerId: ID } }> = [];

  registerContract(c: CapabilityContract, origin: 'builtin' | 'plugin') {
    const d = contractDigest(c);
    if (c.schemaDigest && c.schemaDigest !== d) throw err('CAPABILITY_CONTRACT_CONFLICT', `${key(c.name, c.version)}: declared schemaDigest ${c.schemaDigest} ≠ computed ${d}`);
    const k = key(c.name, c.version); const existing = this.contracts.get(k);
    if (existing) {
      if (existing.contract.schemaDigest !== d) throw err('CAPABILITY_CONTRACT_CONFLICT', `${k}: digest ${existing.contract.schemaDigest} (${existing.origin}) vs ${d} (${origin})`);
      if (existing.origin === 'implicit') existing.origin = origin;   // 显式定义到来，转正
      return;
    }
    this.contracts.set(k, { contract: { ...c, schemaDigest: d }, candidates: [], origin });
  }
  /** 实现声明必须匹配契约 digest；无契约定义时首个实现的 digest 成为 canonical（需给出完整契约以便注册） */
  registerImplementation(impl: CapabilityImplementation, fullContractIfImplicit?: CapabilityContract) {
    const k = key(impl.contract.name, impl.contract.version); let d = this.contracts.get(k);
    if (!d) {
      if (!fullContractIfImplicit) throw err('COMPONENT_NOT_FOUND', `${k}: no contract registered and provider ${impl.providerId} did not supply one`);
      const cd = contractDigest(fullContractIfImplicit);
      if (cd !== impl.contract.schemaDigest) throw err('CAPABILITY_CONTRACT_CONFLICT', `${k}: implementation digest ${impl.contract.schemaDigest} ≠ supplied contract ${cd}`);
      d = { contract: { ...fullContractIfImplicit, schemaDigest: cd }, candidates: [], origin: 'implicit' };
      this.contracts.set(k, d);
      this.events.push({ type: 'contract.implicitly_defined', payload: { name: impl.contract.name, version: impl.contract.version, schemaDigest: cd, providerId: impl.providerId } });
    }
    if (d.contract.schemaDigest !== impl.contract.schemaDigest) throw err('CAPABILITY_CONTRACT_CONFLICT', `${k}: provider ${impl.providerId} digest ${impl.contract.schemaDigest} ≠ canonical ${d.contract.schemaDigest}`);
    d.candidates.push(impl);
    d.candidates.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.providerId.localeCompare(b.providerId));
  }
  resolve(name: string, range?: string): Descriptor | undefined {
    const matches = [...this.contracts.values()].filter(d => d.contract.name === name && satisfies(d.contract.version, range));
    // N-30：同名多版本时先挑"有实现的"里最高版，没有任何实现才退回最高版（否则加一个新小版本会让只实现老版的插件路由失败）
    matches.sort((a, b) => (b.candidates.length > 0 ? 1 : 0) - (a.candidates.length > 0 ? 1 : 0) || b.contract.version.localeCompare(a.contract.version, undefined, { numeric: true }));
    return matches[0];
  }
  resolveRef(ref: ContractRef): Descriptor | undefined { const d = this.contracts.get(key(ref.name, ref.version)); return d && d.contract.schemaDigest === ref.schemaDigest ? d : undefined; }
  list(): Descriptor[] { return [...this.contracts.values()]; }
  drainEvents() { const e = this.events; this.events = []; return e; }
  /** 路由：确定性 —— priority → providerId；无候选 → ROUTING_ERROR */
  route(ref: ContractRef, lockProvider?: ID): CapabilityImplementation {
    const d = this.resolveRef(ref); if (!d) throw err('ROUTING_ERROR', `no contract ${key(ref.name, ref.version)}`);
    const cands = lockProvider ? d.candidates.filter(c => c.providerId === lockProvider) : d.candidates;
    const c = cands[0]; if (!c) throw err('ROUTING_ERROR', `no provider implements ${key(ref.name, ref.version)}${lockProvider ? ` (locked to ${lockProvider})` : ''}`);
    return c;
  }
}

/** 加载 contracts/builtin/*.json */
const BUILTIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'builtin');   // 按模块位置定位，CLI 从任何目录都能跑（16 §3-2 bug 修复）
export function loadBuiltinContracts(dir = BUILTIN_DIR): CapabilityContract[] {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as CapabilityContract);
}
