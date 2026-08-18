// M3：conformance 测试套 · 签名 token 句柄 · MCP Bridge（x.mcp.*）
import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import { runConformance, summarize } from '../../sdk/conformance.js';
import { Authority, invocationDigest } from '../../kernel/authority/authority.js';
import { HmacSigner } from '../../kernel/identity/identity.js';
import { initProjections } from '../../kernel/ledger/ledger.js';
import { loadBuiltinContracts } from '../../kernel/contract/registry.js';
import { SubprocessProvider } from '../../kernel/boundary/subprocess.js';
import { Kernel } from '../../kernel/runtime/kernel.js';
import { FsReadonlyProvider, HostileProvider, MemoryContextProvider, TextSummarizeProvider } from '../../plugins/builtin/index.js';
import { McpBridge } from '../../plugins/builtin/mcp-bridge.js';
import { build, loadFixture, mkEnv } from './harness.js';
import { expectCode } from '../helpers.js';

const TSX = path.resolve('node_modules/.bin/tsx');
const fileRead = loadBuiltinContracts().find(c => c.name === 'file.read' && c.version === '1.0.0')!;
const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => { for (const f of cleanup) await f(); });

describe('M3 · conformance', () => {
  it('fs-readonly（进程内）全过；同一份代码在 subprocess 里也全过', async () => {
    const env = mkEnv(loadFixture('G1'));
    const r1 = await runConformance(new FsReadonlyProvider(env.ws), [{ contract: fileRead, sampleArgs: { path: 'workspace/test.txt' }, badArgs: { path: '../../etc/passwd' } }]);
    expect(r1.ok, summarize(r1)).toBe(true); expect(r1.passed).toBeGreaterThanOrEqual(10);
    const sub = new SubprocessProvider({ id: 'fs-readonly-sub', command: TSX, args: ['plugins/subprocess/fs-readonly.ts', env.ws] }); cleanup.push(() => sub.stop()); await sub.start();
    const r2 = await runConformance(sub, [{ contract: fileRead, sampleArgs: { path: 'workspace/test.txt' }, badArgs: { path: '../../etc/passwd' } }]);
    expect(r2.ok, summarize(r2)).toBe(true);
    expect(r2.checks.map(c => c.id).filter(id => id.startsWith('C3'))).toEqual(r1.checks.map(c => c.id).filter(id => id.startsWith('C3')));   // 同一组检查
  }, 30000);
  it('敌意 Provider（返回垃圾）→ 不通过，并指出 outputSchema 失败项', async () => {
    const r = await runConformance(new HostileProvider('garbage'), [{ contract: fileRead, sampleArgs: { path: 'workspace/test.txt' } }]);
    expect(r.ok).toBe(false); expect(r.checks.some(c => c.id.startsWith('C3.outputSchema') && !c.ok)).toBe(true);
  });
  it('实现 digest 与契约不符 → C1.digest 失败', async () => {
    const bad = { id: 'bad', listImplementations: () => [{ providerId: 'bad', contract: { ...fileRead, schemaDigest: 'sha256:' + 'ff'.repeat(32) } }], async execute() { return { output: { content: '', bytes: 0 } }; } } as any;
    const r = await runConformance(bad, [{ contract: fileRead, sampleArgs: { path: 'x' } }]);
    expect(r.checks.find(c => c.id === 'C1.digest.file.read')!.ok).toBe(false);
  });
});

describe('M3 · 签名 token 句柄（04 §6）', () => {
  const NOW = '2026-08-18T10:00:00.000Z';
  const issuer = { kind: 'agent' as const, id: 'issuer-agent' };
  const chainAgent = [issuer, { kind: 'org' as const, id: 'acme' }];
  const chainTask = [{ kind: 'task' as const, id: 't1' }, ...chainAgent];
  const ref = { name: fileRead.name, version: fileRead.version, schemaDigest: fileRead.schemaDigest };
  it('导出 → 另一个 Authority 导入（信任发行者）→ verify 语义一致；篡改 / 错 key / 不信任发行者 → HANDLE_INVALID', () => {
    const A = new Authority(); const signerA = new HmacSigner('secret-A');
    const h = A.mint(ref, chainAgent, [{ kind: 'args.prefix', path: 'path', prefix: 'workspace/' }], NOW);
    const token = A.exportToken(h.id, signerA, issuer);
    const B = new Authority();
    const imported = B.importToken(token, signerA, [issuer]);
    expect(imported.id).toBe(h.id);
    const ok = B.verify(h.id, chainTask, { path: 'workspace/a' }, { id: 'i', revision: 0 }, [], initProjections(), NOW); expect(ok.ok).toBe(true);
    const bad = B.verify(h.id, chainTask, { path: '/etc/passwd' }, { id: 'i', revision: 0 }, [], initProjections(), NOW); expect(!bad.ok && bad.kind === 'denied' && bad.code === 'CAVEAT_VIOLATION').toBe(true);
    // 篡改：改 caveats 后重编码
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); parsed.payload.caveats = []; const tampered = Buffer.from(JSON.stringify(parsed)).toString('base64url');
    expectCode(() => new Authority().importToken(tampered, signerA, [issuer]), 'HANDLE_INVALID');
    expectCode(() => new Authority().importToken(token, new HmacSigner('other'), [issuer]), 'HANDLE_INVALID');
    expectCode(() => new Authority().importToken(token, signerA, [{ kind: 'agent', id: 'someone-else' }]), 'HANDLE_INVALID');
    expectCode(() => new Authority().importToken('not-a-token', signerA, [issuer]), 'HANDLE_INVALID');
  });
  it('导入后可继续本地收窄（子 ⊂ 父），导出子 token 由本地 key 签', () => {
    const A = new Authority(); const signerA = new HmacSigner('A'); const signerB = new HmacSigner('B');
    const h = A.mint(ref, chainAgent, [{ kind: 'args.prefix', path: 'path', prefix: 'workspace/' }], NOW);
    const B = new Authority(); B.importToken(A.exportToken(h.id, signerA, issuer), signerA, [issuer]);
    const child = B.attenuate(h.id, [{ kind: 'args.max', path: 'maxBytes', max: 10 }], chainTask, NOW);
    const t2 = B.exportToken(child.id, signerB, { kind: 'agent', id: 'B' });
    const C = new Authority(); C.importToken(t2, signerB, [{ kind: 'agent', id: 'B' }]);
    const r = C.verify(child.id, chainTask, { path: 'workspace/a', maxBytes: 11 }, { id: 'i', revision: 0 }, [], initProjections(), NOW);
    expect(!r.ok && r.kind === 'denied' && r.code === 'CAVEAT_VIOLATION').toBe(true);
    const r2 = C.verify(child.id, chainTask, { path: 'workspace/a', maxBytes: 5 }, { id: 'i', revision: 0 }, [], initProjections(), NOW); expect(r2.ok).toBe(true);
    // 摘要跨实现一致：同一调用在 A/B/C 三处 digest 相同（审批可跨进程验证的前提）
    const d1 = invocationDigest({ id: 'i', revision: 0, contract: ref, args: { path: 'workspace/a', maxBytes: 5 }, handleId: child.id }, chainTask);
    expect((r2 as any).digest).toBe(d1);
  });
});

describe('M3 · MCP Bridge（x.mcp.*）', () => {
  it('fake MCP server 的两个工具映射为 x.mcp.fake.echo/add@1.0.0（implicit 契约）→ 授权后经同一管线调用', async () => {
    const bridge = new McpBridge({ serverName: 'fake', command: process.execPath, args: ['tests/fixtures/fake-mcp-server.mjs'] }); cleanup.push(() => bridge.stop());
    await bridge.start();
    expect(bridge.contracts.map(c => c.name).sort()).toEqual(['x.mcp.fake.add', 'x.mcp.fake.echo']);
    expect(bridge.contracts.every(c => c.sideEffects === 'external' && c.idempotent === false)).toBe(true);   // 保守默认
    // conformance 也能跑 MCP 桥接实现
    const echo = bridge.contracts.find(c => c.name === 'x.mcp.fake.echo')!;
    const rep = await runConformance(bridge, [{ contract: echo, sampleArgs: { text: 'hi' }, expectIdempotent: false }]); expect(rep.ok, summarize(rep)).toBe(true);
    // 装进内核：Spec 授权 x.mcp.fake.add；Controller 直接调用；账本里有 contract.implicitly_defined
    const fx = loadFixture('G1'); const env = mkEnv(fx);
    const b = await build({ fx, env, providers: [bridge, new FsReadonlyProvider(env.ws), new MemoryContextProvider(), new TextSummarizeProvider()], specPatch: s => { s.spec.grants.push({ contract: 'x.mcp.fake.add' }); } });
    const k = await Kernel.compose(b.spec, { ...b.plugins, controllers: { 'simple-react': () => ({ id: 'c', async decide(ctx) { const h = ctx.view.handles.find(x => x.contract.name === 'x.mcp.fake.add')!; const r = await ctx.invoke(h.id, { a: 2, b: 3 }); return { type: 'finish', output: JSON.parse(JSON.stringify(r)) }; } }) } }, {});
    const res = await k.startTask('add'); const out = res.output as any;
    expect(out.status).toBe('executed'); expect(out.output.content[0].text).toBe('5');
    expect(k.ledger.all().some(e => e.type === 'invocation.authorized' && (e.payload as any).providerId === 'mcp-bridge:fake')).toBe(true);
    expect(k.ledger.all().filter(e => e.type === 'contract.implicitly_defined').map(e => (e.payload as any).name).sort()).toEqual(['x.mcp.fake.add', 'x.mcp.fake.echo']);
    // 没授权的 MCP 工具（echo）不在句柄目录里 → 没有句柄就没有路径
    expect(k.taskView(res.taskId).handles.some(h => h.contract.name === 'x.mcp.fake.echo')).toBe(false);
  }, 30000);
});
