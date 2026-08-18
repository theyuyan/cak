// cak-review（第二个宿主）：独立 Runtime + Ed25519 身份 + HTTP；cak-code 经 agent.invoke（句柄锁 target/contract）送审 → 拿回结构化结论 + 可验回执；越权 target 被 caveat 拒
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { Kernel, verifyTaskReceipt } from '../../kernel/runtime/kernel.js';
import { Ed25519Signer } from '../../kernel/identity/ed25519.js';
import { serveKernelHttp, RemoteServeTarget, fetchCard, rpc } from '../../kernel/boundary/http.js';
import { MockBackend, AgentInvokeProvider } from '../../plugins/builtin/index.js';
import { WorkspaceProvider } from '../../apps/cak-code/workspace-provider.js';
import { codingController } from '../../apps/cak-code/controller.js';
import { buildSpec } from '../../apps/cak-code/spec.js';
import { reviewController } from '../../apps/cak-review/controller.js';
import { buildReviewSpec } from '../../apps/cak-review/spec.js';
const cleanup: Array<() => Promise<void>> = []; afterAll(async () => { for (const f of cleanup) await f().catch(() => {}); });
const mkrepo = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cak-review-')); fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'a.ts'), 'export const a = 1;\n'); spawnSync('git', ['init', '-q'], { cwd: d }); spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: d }); spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: d }); return d; };

describe('cak-review · 第二个宿主经 HTTP 审查 cak-code 的改动', () => {
  it('cak-code 改文件 → agent.invoke(cak-review, code.review) → 审查方自己 git.diff → 结论回来（verdict/findings）→ 回执用审查方公钥可验、篡改不过 → 提交；越权 target 被 CAVEAT_VIOLATION 拒', async () => {
    const ws = mkrepo();
    // 审查方 B：mock 模型先 git.diff，再给 JSON 结论
    const reviewScript = [
      { finishReason: 'tool_calls' as const, toolCalls: [{ id: 'r1', contract: 'git.diff', args: {} }] },
      { finishReason: 'stop' as const, content: '```json\n{"verdict":"request_changes","summary":"a 改成 2 但没有测试","findings":[{"severity":"major","file":"src/a.ts","line":1,"message":"补一个断言"}]}\n```' },
      { finishReason: 'tool_calls' as const, toolCalls: [{ id: 'r2', contract: 'git.diff', args: {} }] },
      { finishReason: 'stop' as const, content: '{"verdict":"approve","summary":"OK","findings":[]}' },
    ];
    const sB = Ed25519Signer.generate({ kind: 'agent', id: 'cak-review' });
    const B = await Kernel.compose(buildReviewSpec({ backend: 'deepseek', model: 'mock', workspaceName: 'x' }), { controllers: { 'cak-review': cfg => reviewController(cfg) }, backends: { deepseek: new MockBackend(reviewScript) }, providers: [new WorkspaceProvider(ws)] }, { signer: sB });
    const srv = await serveKernelHttp(B); cleanup.push(() => srv.close());
    const card = await fetchCard(srv.url); expect((card as any).provides.map((c: any) => c.name)).toEqual(['code.review']);
    // cak-code A：改文件 → 送审（被打回）→ 再改 → 再送审（通过）→ 提交
    const codeScript = [
      { finishReason: 'tool_calls' as const, toolCalls: [{ id: 'c1', contract: 'file.edit', args: { path: 'src/a.ts', oldText: 'a = 1', newText: 'a = 2' } }] },
      { finishReason: 'tool_calls' as const, toolCalls: [{ id: 'c2', contract: 'agent.invoke', args: { target: 'cak-review', contract: { name: 'code.review', version: '1.0.0' }, args: { intent: '把 a 改成 2' } } }] },
      { finishReason: 'tool_calls' as const, toolCalls: [{ id: 'c3', contract: 'file.write', args: { path: 'src/a.test.ts', content: 'import { a } from "./a"; if (a !== 2) throw new Error();\n' } }] },
      { finishReason: 'tool_calls' as const, toolCalls: [{ id: 'c4', contract: 'agent.invoke', args: { target: 'cak-review', contract: { name: 'code.review', version: '1.0.0' }, args: { intent: '把 a 改成 2 并加测试' } } }] },
      { finishReason: 'tool_calls' as const, toolCalls: [{ id: 'c5', contract: 'git.commit', args: { message: 'a=2 with test' } }] },
      { finishReason: 'stop' as const, content: '已提交；审查 approve。' },
    ];
    const sA = Ed25519Signer.generate({ kind: 'agent', id: 'cak-code' });
    const specA = buildSpec({ backend: 'deepseek', model: 'mock', workspaceName: 'x', requireApproval: false, reviewer: true });
    const A = await Kernel.compose(specA, { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: new MockBackend(codeScript) }, providers: [new WorkspaceProvider(ws), new AgentInvokeProvider({ 'cak-review': new RemoteServeTarget(srv.url) })] }, { signer: sA });
    A.trustPeer(card as any);
    const res = await A.startTask('把 a 改成 2', { input: '把 a 改成 2' });
    expect(res.status).toBe('finished'); expect(String(res.output)).toContain('approve');
    const invs = Object.values(A.ledger.projections().invocations).filter(i => i.contract.name === 'agent.invoke');
    expect(invs.length).toBe(2); expect(invs.every(i => i.status === 'executed')).toBe(true);
    const o1 = invs[0]!.output as any, o2 = invs[1]!.output as any;
    expect(o1.output.verdict).toBe('request_changes'); expect(o1.output.findings[0].file).toBe('src/a.ts');
    expect(o2.output.verdict).toBe('approve');
    // 审查方确实自己取了 diff（它的账本里有 git.diff），并且看到的是 cak-code 的改动
    const bInvs = Object.values(B.ledger.projections().invocations).filter(i => i.contract.name === 'git.diff'); expect(bInvs.length).toBe(2);
    expect(String((bInvs[0]!.output as any).diff)).toContain('a = 2');
    // 回执：跨进程拉事件 → 用 A 信任的 B 公钥验；篡改 root 不过；未信任的 signer 不过
    const ev = await rpc(srv.url, 'agent.receipt', { taskId: o2.receipt.taskId }); const events = ((ev.result as any).events as Array<{ hash: string; type: string }>);
    const covered = events.slice(0, events.findIndex(e => e.type === 'receipt.issued'));
    expect(verifyTaskReceipt({ taskId: o2.receipt.taskId, events: covered, root: o2.receipt.root, sig: o2.receipt.sig }, sA)).toBe(true);
    expect(verifyTaskReceipt({ taskId: o2.receipt.taskId, events: covered.slice(1), root: o2.receipt.root, sig: o2.receipt.sig }, sA)).toBe(false);
    expect(verifyTaskReceipt({ taskId: o2.receipt.taskId, events: covered, root: o2.receipt.root, sig: o2.receipt.sig }, Ed25519Signer.generate({ kind: 'agent', id: 'stranger' }))).toBe(false);
    // 提交确实发生
    expect(spawnSync('git', ['log', '--oneline'], { cwd: ws, encoding: 'utf8' }).stdout).toContain('a=2 with test');
    // 越权：target 不是 cak-review → 句柄 caveat 拒（CAVEAT_VIOLATION），审查方压根收不到
    const A2 = await Kernel.compose(specA, { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: new MockBackend([{ finishReason: 'tool_calls', toolCalls: [{ id: 'x', contract: 'agent.invoke', args: { target: 'evil', contract: { name: 'code.review', version: '1.0.0' }, args: { intent: 'x' } } }] }, { finishReason: 'stop', content: 'denied' }]) }, providers: [new WorkspaceProvider(ws), new AgentInvokeProvider({ evil: new RemoteServeTarget(srv.url), 'cak-review': new RemoteServeTarget(srv.url) })] }, { signer: sA });
    const r2 = await A2.startTask('x', { input: 'x' }); expect(r2.status).toBe('finished');
    const bad = Object.values(A2.ledger.projections().invocations).find(i => i.contract.name === 'agent.invoke')!; expect(bad.status).toBe('denied'); expect(bad.denyCode).toBe('CAVEAT_VIOLATION');
    expect(Object.values(B.ledger.projections().tasks).length).toBe(2);   // 审查方只收到过两次来访
  }, 60000);
  it('审查方模型先吐散文 → 得到一次"只出 JSON"的修正机会 → 合法结论；模型的工具列表里没有 code.review（不自我调用）', async () => {
    const ws = mkrepo(); fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'export const a = 3;\n');
    const seen: string[][] = [];
    const backend = new MockBackend([
      { finishReason: 'stop' as const, content: 'I reviewed it manually. Looks fine overall.' },
      { finishReason: 'stop' as const, content: 'ok here: {"verdict":"approve","summary":"没问题","findings":[]} thanks' },
    ]);
    const origGen = backend.generate.bind(backend); (backend as any).generate = async (req: any, ctx: any) => { seen.push((req.tools ?? []).map((t: any) => t.name)); return origGen(req, ctx); };
    const B = await Kernel.compose(buildReviewSpec({ backend: 'deepseek', model: 'mock', workspaceName: 'x' }), { controllers: { 'cak-review': cfg => reviewController(cfg) }, backends: { deepseek: backend }, providers: [new WorkspaceProvider(ws)] }, { signer: Ed25519Signer.generate({ kind: 'agent', id: 'cak-review' }) });
    const r = await B.serve({ agentId: 'cak-code' }, { name: 'code.review' }, { intent: 'x' });
    expect('output' in r && (r.output as any).verdict).toBe('approve');
    expect(seen.length).toBe(2); expect(seen[0]).not.toContain('code_review'); expect(seen[0]).toContain('git_diff'); expect(seen[1]).toEqual([]);
  });
});
