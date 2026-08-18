// M5 · 网络：两个 Runtime 各在自己端口 → 名片发现 → 跨组织句柄 → 远程调用 → 回执互验 → 对账；注册表 R1 + cak add；远程 Provider
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Kernel, verifyTaskReceipt, type Plugins } from '../../kernel/runtime/kernel.js';
import { MemoryLedgerStore } from '../../kernel/ledger/ledger.js';
import { Ed25519Signer } from '../../kernel/identity/ed25519.js';
import { serveKernelHttp, RemoteServeTarget, RemoteProvider, rpc, fetchCard } from '../../kernel/boundary/http.js';
import { FileRegistry, installPlugin, loadInstalledPlugins } from '../../kernel/boundary/registry.js';
import { statement, reconcile } from '../../kernel/runtime/settlement.js';
import { contractDigest, loadBuiltinContracts } from '../../kernel/contract/registry.js';
import { runConformance } from '../../sdk/conformance.js';
import { simpleReact, planExecute, MockBackend, FsReadonlyProvider, MemoryContextProvider, TextSummarizeProvider, SafeFileGuard, AgentInvokeProvider } from '../../plugins/builtin/index.js';
import { specs, loadFixture, mkEnv, taskEvents } from './harness.js';
import type { AgentSpec, CapabilityContract } from '../../sdk/types.js';

const TSX = path.resolve('node_modules/.bin/tsx');
const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => { for (const f of cleanup) await f().catch(() => {}); });
const DOC_BASE = { name: 'doc.summarize', version: '1.0.0', description: '总结一份文档', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } }, outputSchema: { type: 'object' }, sideEffects: 'read', idempotent: true, permissions: [] as string[] } as const;
const DOC_SUMMARIZE: CapabilityContract = { ...DOC_BASE, schemaDigest: contractDigest(DOC_BASE as any), pricing: { unit: 'call', amount: 0.5, currency: 'CREDIT' } } as any;

async function twoAgentsOverHttp(fx: any, env: ReturnType<typeof mkEnv>, registryDir: string) {
  const specA = structuredClone(specs[1]!) as AgentSpec; const specB = structuredClone(specs[0]!) as AgentSpec;
  specB.spec.manifest = { ...(specB.spec.manifest ?? {}), provides: ['doc.summarize'] };
  const sB = Ed25519Signer.generate({ kind: 'agent', id: specB.spec.principal.agent }); const sA = Ed25519Signer.generate({ kind: 'agent', id: specA.spec.principal.agent });
  const rB = { fn: (s: string) => s }; const rA = { fn: (s: string) => s };
  const B = await Kernel.compose(specB, { controllers: { 'simple-react': cfg => simpleReact(cfg) }, backends: { 'mock-backend': new MockBackend(fx.mockBackend.B, s => rB.fn(s)) }, providers: [new FsReadonlyProvider(env.ws), new MemoryContextProvider([{ content: 'B 记忆' }]), new TextSummarizeProvider()], interceptors: [new SafeFileGuard(4096)], contracts: [DOC_SUMMARIZE] }, { signer: sB, ledgerStore: new MemoryLedgerStore() });
  rB.fn = s => ({ '$h.fileB': B.rootHandles[0]!.id }[s] ?? s);
  const srvB = await serveKernelHttp(B); cleanup.push(() => srvB.close());
  // B 发布名片到注册表（endpoints 带真实 URL）
  const reg = new FileRegistry(registryDir); const cardB = { ...B.card(), endpoints: [{ type: 'remote', address: srvB.url }] }; reg.publishCard(cardB as any);
  // A：从注册表发现"谁提供 doc.summarize" → 拿名片 → 信任其公钥 → 远端目标
  const found = reg.findAgentsProviding('doc.summarize'); expect(found.length).toBe(1);
  const url = (found[0]!.endpoints as any[])[0].address as string;
  const liveCard = await fetchCard(url);                                       // 也可直接从对方拿名片
  const A = await Kernel.compose(specA, { controllers: { 'plan-execute': cfg => planExecute(cfg) }, backends: { 'mock-backend': new MockBackend(fx.mockBackend.A, s => rA.fn(s)) }, providers: [new AgentInvokeProvider({ 'minimal-file-agent': new RemoteServeTarget(url) }), new MemoryContextProvider(), new TextSummarizeProvider()], contracts: [DOC_SUMMARIZE] }, { signer: sA, ledgerStore: new MemoryLedgerStore() });
  rA.fn = s => ({ '$h.agent': A.rootHandles[0]!.id }[s] ?? s);
  A.trustPeer(liveCard); B.trustPeer({ principal: { kind: 'agent', id: specA.spec.principal.agent } }, sA.publicKeyPem());   // B 也信任 A（A 的名片本应也在注册表；这里直接交换公钥）
  return { A, B, sA, sB, url, reg, liveCard };
}

describe('M5 · 两个 Runtime 跨进程边界（HTTP）互联', () => {
  it('发现 → 信任公钥 → 远程 agent.invoke → B 按自己账本处理 → A 用 B 公钥验回执 → usage 对账一致；A 事件序列 == G7', async () => {
    const fx = loadFixture('G7'); const env = mkEnv(fx); const regDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cak-reg-'));
    const { A, B, sA, liveCard, url } = await twoAgentsOverHttp(fx, env, regDir);
    // 名片本身可验（用名片里的公钥）
    const { sig, ...body } = liveCard; expect(sA.verify(body, sig)).toBe(true);
    const res = await A.startTask(fx.input.user, { input: fx.input.user });
    expect(res.status).toBe('finished');
    expect(taskEvents(A, res.taskId)).toEqual(fx.strictSequenceA);
    const inv = Object.values(A.ledger.projections().invocations).find(i => i.contract.name === 'agent.invoke')!; expect(inv.status).toBe('executed');
    const out = inv.output as any;
    // 回执：从 B 拉完整事件（agent.receipt），用 A 信任的 B 公钥验；篡改失败
    const bTask = out.receipt.taskId as string;
    const bAll = B.ledger.all().filter(e => e.taskId === bTask); const covered = bAll.slice(0, bAll.findIndex(e => e.type === 'receipt.issued'));   // 回执覆盖 receipt.issued 之前的全部事件（跨进程时经 agent.receipt 拉取）
    expect(verifyTaskReceipt({ taskId: bTask, events: covered, root: out.receipt.root, sig: out.receipt.sig }, sA)).toBe(true);
    expect(verifyTaskReceipt({ taskId: bTask, events: covered.slice(1), root: out.receipt.root, sig: out.receipt.sig }, sA)).toBe(false);
    const viaHttp = await rpc(url, 'agent.receipt', { taskId: bTask }); expect(((viaHttp.result as any).events as any[]).length).toBeGreaterThanOrEqual(covered.length);   // 跨进程拉回执事件
    // 对账
    const rc = reconcile(inv.usage?.units as any, (out.usage?.units ?? out.usage) as any); expect(rc.ok, JSON.stringify(rc)).toBe(true);
    // 对账单：B 的 doc.summarize 有 pricing 0.5 CREDIT/次 → B 侧… B 记的是自己内部调用；A 侧对 agent.invoke 无 pricing → 用 B 的账本出单
    const stB = statement(B); expect(stB.lines.some(l => l.contract === 'file.read')).toBe(true);
  }, 60000);
  it('跨组织句柄：A 请求 B 铸窄句柄（token）→ A 导入并收窄（budget calls 1）→ 出示 token 调用 → 成功；同 token 二次 → 拒；B 撤销后 → 拒', async () => {
    const fx = loadFixture('G7'); const env = mkEnv(fx); const regDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cak-reg-'));
    const { A, B, url } = await twoAgentsOverHttp(fx, env, regDir);
    const minted = await rpc(url, 'handle.mint', { caller: { agentId: 'coordinator' }, contract: { name: 'doc.summarize' }, caveats: [] as any });
    expect(minted.error).toBeUndefined(); const { handleId, token } = minted.result as any;
    // A 导入（信任 B）→ 收窄 → 导出（A 签）
    const h = A.authority.importToken(token, A.signer, [{ kind: 'agent', id: 'minimal-file-agent' }]); expect(h.id).toBe(handleId);
    const child = A.authority.attenuate(h.id, [{ kind: 'budget', slice: { calls: 1 } }, { kind: 'once' }], undefined, new Date().toISOString());
    const childToken = A.authority.exportToken(child.id, A.signer, { kind: 'agent', id: 'coordinator' });
    // B 收到 A 签的子 token：信任 A 公钥 + 父句柄在 B 表里 → 通过；once → 第二次拒
    const r1 = await new RemoteServeTarget(url).serve({ agentId: 'coordinator' }, { name: 'doc.summarize' }, { path: 'workspace/test.txt' }, { handleToken: childToken });
    expect('error' in r1 ? r1.error.message : 'ok').toBe('ok');
    const r2 = await new RemoteServeTarget(url).serve({ agentId: 'coordinator' }, { name: 'doc.summarize' }, { path: 'workspace/test.txt' }, { handleToken: childToken });
    expect('error' in r2).toBe(true); expect(('error' in r2 ? r2.error.code : '')).toMatch(/CAVEAT_VIOLATION|HANDLE_INVALID|BUDGET_EXCEEDED/);
    // 撤销父句柄 → 新铸一个子 token 也不行了
    B.controlPlane().revoke(handleId, 'test');
    const st = await rpc(url, 'handle.status', { handleId }); expect((st.result as any).revoked).toBe(true);
    const child2 = A.authority.attenuate(h.id, [{ kind: 'once' }], undefined, new Date().toISOString());
    const r3 = await new RemoteServeTarget(url).serve({ agentId: 'coordinator' }, { name: 'doc.summarize' }, { path: 'workspace/test.txt' }, { handleToken: A.authority.exportToken(child2.id, A.signer, { kind: 'agent', id: 'coordinator' }) });
    expect('error' in r3 && r3.error.code).toBe('HANDLE_INVALID');
    // 不信任的发行者签的 token → 拒
    const evil = Ed25519Signer.generate({ kind: 'agent', id: 'evil' }); const forged = A.authority.exportToken(child2.id, evil, { kind: 'agent', id: 'evil' });
    const r4 = await new RemoteServeTarget(url).serve({ agentId: 'evil' }, { name: 'doc.summarize' }, { path: 'workspace/test.txt' }, { handleToken: forged });
    expect('error' in r4 && r4.error.code).toBe('HANDLE_INVALID');
  }, 60000);
  it('远端 HTTP 上的 CapabilityProvider：conformance 全过；未知信封版本被拒', async () => {
    const fx = loadFixture('G1'); const env = mkEnv(fx);
    const spec = structuredClone(specs[0]!) as AgentSpec;
    const host = await Kernel.compose(spec, { controllers: { 'simple-react': cfg => simpleReact(cfg) }, backends: { 'mock-backend': new MockBackend([]) }, providers: [new FsReadonlyProvider(env.ws), new MemoryContextProvider(), new TextSummarizeProvider()] }, {});
    const srv = await serveKernelHttp(host, { provider: new FsReadonlyProvider(env.ws) }); cleanup.push(() => srv.close());
    const remote = new RemoteProvider('fs-remote', srv.url); await remote.start();
    const fileRead = loadBuiltinContracts().find(c => c.name === 'file.read')!;
    const rep = await runConformance(remote, [{ contract: fileRead, sampleArgs: { path: 'workspace/test.txt' }, badArgs: { path: '../../etc/passwd' } }]); expect(rep.ok).toBe(true);
    const bad = await fetch(srv.url + '/rpc', { method: 'POST', body: JSON.stringify({ cak: '9', jsonrpc: '2.0', id: 1, method: 'agent.card' }) }).then(r => r.json()) as any;
    expect(bad.error.code).toBe(-32600);
  }, 30000);
});

describe('M5 · 注册表 R1 + cak add（trust-but-verify）', () => {
  it('合规插件：本机 conformance 全过 → 写入安装目录（T1）；敌意插件：不安装；已安装插件可被内核装载跑 G1', async () => {
    const fx = loadFixture('G1'); const env = mkEnv(fx);
    const regDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cak-reg-')); const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cak-plugins-'));
    const reg = new FileRegistry(regDir);
    reg.addPlugin({ id: 'fs-readonly-sub', version: '0.3.0', kernelCompat: '^0.3.0', license: 'Apache-2.0', entrypoint: { type: 'subprocess', command: TSX, args: ['plugins/subprocess/fs-readonly.ts', env.ws] }, contracts: [{ name: 'file.read', sampleArgs: { path: 'workspace/test.txt' }, badArgs: { path: '../../x' } }] });
    reg.addPlugin({ id: 'hostile-sub', version: '0.0.1', kernelCompat: '^0.3.0', entrypoint: { type: 'subprocess', command: TSX, args: ['plugins/subprocess/hostile.ts', 'never'] }, contracts: [{ name: 'file.read', sampleArgs: { path: 'workspace/test.txt' } }] });
    expect(reg.findByContract('file.read').map(p => p.id).sort()).toEqual(['fs-readonly-sub', 'hostile-sub']);
    const ok = await installPlugin(reg, 'fs-readonly-sub', installDir); expect(ok.installed).toBe(true); expect(ok.tier).toBe('T1'); expect(fs.existsSync(ok.manifestPath!)).toBe(true);
    const bad = await installPlugin(reg, 'hostile-sub', installDir); expect(bad.installed).toBe(false); expect(fs.existsSync(path.join(installDir, 'hostile-sub'))).toBe(false);
    // 装载已安装插件 → 跑 G1（fs 来自安装目录里的子进程插件）
    const installed = await loadInstalledPlugins(installDir); cleanup.push(async () => { for (const p of installed) await p.stop(); });
    expect(installed.map(p => p.id)).toEqual(['fs-readonly-sub']);
    const b = await (await import('./harness.js')).build({ fx, env, providers: [...installed, new MemoryContextProvider([{ content: 'x' }]), new TextSummarizeProvider()] });
    const res = await b.k.startTask(fx.input.user, { input: fx.input.user }); expect(res.status).toBe('finished'); expect(taskEvents(b.k, res.taskId)).toEqual(fx.strictSequence);
  }, 90000);
});
