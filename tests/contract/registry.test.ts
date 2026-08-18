// RG-1…5（09 §1）+ 契约 digest 向量
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { ContractRegistry, contractDigest, loadBuiltinContracts } from '../../kernel/contract/registry.js';
import { isSuffix, HmacSigner } from '../../kernel/identity/identity.js';
import { expectCode } from '../helpers.js';

const V = JSON.parse(fs.readFileSync('tests/vectors/contract-digest.json', 'utf8'));
const builtin = loadBuiltinContracts();
const fileRead = builtin.find(c => c.name === 'file.read')!;

describe('contract registry', () => {
  it('内置契约 digest 与向量一致（16 个）', () => {
    for (const c of builtin) expect(contractDigest(c)).toBe(V.contracts.find((x: any) => x.name === c.name).schemaDigest);
    expect(builtin.length).toBe(16);
  });
  it('RG-1 同 name@version 不同 digest → CAPABILITY_CONTRACT_CONFLICT', () => {
    const r = new ContractRegistry(); r.registerContract(fileRead, 'builtin');
    const other = { ...fileRead, inputSchema: { ...fileRead.inputSchema, extra: true }, schemaDigest: undefined as any };
    expectCode(() => r.registerContract(other, 'plugin'), 'CAPABILITY_CONTRACT_CONFLICT');
    expectCode(() => r.registerImplementation({ providerId: 'p', contract: { name: 'file.read', version: '1.0.0', schemaDigest: 'sha256:' + 'ff'.repeat(32) } }), 'CAPABILITY_CONTRACT_CONFLICT');
  });
  it('RG-2 同 digest 两个实现 → 正常；路由按 priority → providerId 确定', () => {
    const r = new ContractRegistry(); r.registerContract(fileRead, 'builtin');
    const ref = { name: 'file.read', version: '1.0.0', schemaDigest: contractDigest(fileRead) };
    r.registerImplementation({ providerId: 'zeta', contract: ref, priority: 10 });
    r.registerImplementation({ providerId: 'alpha', contract: ref, priority: 10 });
    r.registerImplementation({ providerId: 'best', contract: ref, priority: 1 });
    expect(r.route(ref).providerId).toBe('best');
    expect(r.route(ref, 'zeta').providerId).toBe('zeta');
    expectCode(() => r.route(ref, 'nobody'), 'ROUTING_ERROR');
  });
  it('RG-3 只有实现没有定义 → implicit，首个 digest 成 canonical，第二个不同 digest 冲突', () => {
    const r = new ContractRegistry();
    const c = { ...fileRead, name: 'x.local.thing', schemaDigest: '' } as any; c.schemaDigest = contractDigest(c);
    r.registerImplementation({ providerId: 'p1', contract: { name: c.name, version: c.version, schemaDigest: c.schemaDigest } }, c);
    expect(r.resolve('x.local.thing')?.origin).toBe('implicit');
    expect(r.drainEvents()[0]?.type).toBe('contract.implicitly_defined');
    const c2 = { ...c, inputSchema: { type: 'object' } }; c2.schemaDigest = contractDigest(c2);
    expectCode(() => r.registerImplementation({ providerId: 'p2', contract: { name: c2.name, version: c2.version, schemaDigest: c2.schemaDigest } }, c2), 'CAPABILITY_CONTRACT_CONFLICT');
  });
  it('RG-4 description/pricing/timeout 不改 digest；inputSchema 改则变', () => {
    expect(contractDigest({ ...fileRead, description: 'x', pricing: { unit: 'call', amount: 1 }, defaultTimeoutMs: 1 })).toBe(contractDigest(fileRead));
    expect(contractDigest({ ...fileRead, inputSchema: { type: 'object' } })).not.toBe(contractDigest(fileRead));
  });
  it('RG-5 semver range 解析：^1 / 1.0.0 / >=1 / 不匹配', () => {
    const r = new ContractRegistry(); r.registerContract(fileRead, 'builtin');
    expect(r.resolve('file.read', '^1')?.contract.version).toBe('1.0.0');
    expect(r.resolve('file.read', '1.0.0')).toBeTruthy();
    expect(r.resolve('file.read', '>=1')).toBeTruthy();
    expect(r.resolve('file.read', '^2')).toBeUndefined();
    expect(r.resolve('nope')).toBeUndefined();
  });
});
describe('identity', () => {
  const org = { kind: 'org', id: 'acme' } as const, agent = { kind: 'agent', id: 'a' } as const, task = { kind: 'task', id: 't' } as const;
  it('后缀判断：task 链 ⊇ agent 持有者；反之不成立；空 holder 不成立', () => {
    expect(isSuffix([task, agent, org], [agent, org])).toBe(true);
    expect(isSuffix([agent, org], [task, agent, org])).toBe(false);
    expect(isSuffix([task, agent, org], [{ kind: 'agent', id: 'b' }, org])).toBe(false);
    expect(isSuffix([task, agent, org], [])).toBe(false);
  });
  it('HMAC 占位签名可验、改动即败', () => {
    const s = new HmacSigner('k'); const sig = s.sign({ a: 1 }, agent);
    expect(s.verify({ a: 1 }, sig)).toBe(true); expect(s.verify({ a: 2 }, sig)).toBe(false);
    expect(new HmacSigner('other').verify({ a: 1 }, sig)).toBe(false);
  });
});
