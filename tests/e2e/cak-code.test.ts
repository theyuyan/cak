// cak-code：WorkspaceProvider 九个契约的 conformance + 越界防御 · 编程控制器在 mock 模型下的写文件审批流（awaiting → grant → 写入）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Kernel } from '../../kernel/runtime/kernel.js';
import { runConformance, summarize } from '../../sdk/conformance.js';
import { loadBuiltinContracts } from '../../kernel/contract/registry.js';
import { MockBackend } from '../../plugins/builtin/index.js';
import { WorkspaceProvider, CONTRACTS } from '../../apps/cak-code/workspace-provider.js';
import { codingController } from '../../apps/cak-code/controller.js';
import { buildSpec } from '../../apps/cak-code/spec.js';

const mkws = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cak-code-')); fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'a.ts'), 'export const a = 1;\nexport function hello() { return "hi"; }\n'); fs.writeFileSync(path.join(d, 'README.md'), '# demo\n'); return d; };
const contracts = loadBuiltinContracts();
const byName = (n: string) => contracts.find(c => c.name === n)!;

describe('cak-code · WorkspaceProvider', () => {
  it('九个契约 conformance 全过（file.write / shell.exec / git.commit 用安全样例）；路径越界被拒', async () => {
    const ws = mkws(); const p = new WorkspaceProvider(ws, { sessionFile: path.join(ws, '.cak-session.jsonl') });
    fs.writeFileSync(path.join(ws, '.cak-session.jsonl'), JSON.stringify({ role: 'user', content: 'hi' }) + '\n');
    const rep = await runConformance(p, [
      { contract: contracts.find(c => c.name === 'file.read' && c.version === '1.1.0')!, sampleArgs: { path: 'src/a.ts', startLine: 2, endLine: 2 }, badArgs: { path: '../../etc/passwd' } },
      { contract: byName('file.list'), sampleArgs: { path: '.', recursive: true } },
      { contract: byName('file.search'), sampleArgs: { pattern: 'hello', glob: '**/*.ts' } },
      { contract: byName('file.write'), sampleArgs: { path: 'out/x.txt', content: 'x' }, badArgs: { path: '../x', content: 'y' } },
      { contract: byName('file.edit'), sampleArgs: { path: 'README.md', oldText: '# demo', newText: '# demo!' }, badArgs: { path: '../x', oldText: 'a', newText: 'b' }, expectIdempotent: false },
      { contract: byName('shell.exec'), sampleArgs: { argv: ['node', '-e', 'console.log(1+1)'] }, expectIdempotent: false },
      { contract: byName('git.diff'), sampleArgs: {} },
      { contract: byName('session.history'), sampleArgs: { limit: 5 } },
    ]);
    expect(rep.ok, summarize(rep)).toBe(true);
    const esc = await p.execute({ id: 'i', revision: 0, contract: CONTRACTS.read, args: { path: '../../etc/passwd' }, handle: { id: 'h', contract: CONTRACTS.read, caveats: [], delegable: true }, principal: [{ kind: 'agent', id: 'x' }], digest: 'sha256:' + '0'.repeat(64), idempotencyKey: 'i' } as any, { principal: [], trace: { traceId: 't', spanId: 's' } });
    expect('error' in esc && esc.error.message).toContain('escapes workspace');
    // file.read@1.1.0 行范围 + file.search 单文件（第三轮 dogfood：模型连撞 4 次 ENOTDIR、反复缩 maxBytes 读文件头）
    const rd = await p.execute({ id: 'r', revision: 0, contract: CONTRACTS.read, args: { path: 'src/a.ts', startLine: 2, endLine: 2 }, handle: { id: 'h', contract: CONTRACTS.read, caveats: [], delegable: true }, principal: [{ kind: 'agent', id: 'x' }], digest: 'sha256:' + '0'.repeat(64), idempotencyKey: 'r' } as any, { principal: [], trace: { traceId: 't', spanId: 's' } });
    expect('output' in rd && (rd.output as any)).toMatchObject({ content: 'export function hello() { return "hi"; }', startLine: 2, endLine: 2, totalLines: 3 });
    const sf = await p.execute({ id: 's', revision: 0, contract: CONTRACTS.search, args: { path: 'src/a.ts', pattern: 'hello' }, handle: { id: 'h', contract: CONTRACTS.search, caveats: [], delegable: true }, principal: [{ kind: 'agent', id: 'x' }], digest: 'sha256:' + '0'.repeat(64), idempotencyKey: 's' } as any, { principal: [], trace: { traceId: 't', spanId: 's' } });
    expect('output' in sf && (sf.output as any).matches).toEqual([{ path: 'src/a.ts', line: 2, text: 'export function hello() { return "hi"; }' }]);
    // file.edit：oldText 不存在 / 出现多次（未 replaceAll）都拒写且文件不变；唯一匹配才写
    const call = (args: any) => p.execute({ id: 'e', revision: 0, contract: CONTRACTS.edit, args, handle: { id: 'h', contract: CONTRACTS.edit, caveats: [], delegable: true }, principal: [{ kind: 'agent', id: 'x' }], digest: 'sha256:' + '0'.repeat(64), idempotencyKey: 'e' } as any, { principal: [], trace: { traceId: 't', spanId: 's' } });
    fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'x = 1;\nx = 1;\ny = 2;\n');
    const e1 = await call({ path: 'src/a.ts', oldText: 'nope', newText: 'z' }); expect('error' in e1 && e1.error.message).toContain('not found');
    const e2 = await call({ path: 'src/a.ts', oldText: 'x = 1;', newText: 'x = 9;' }); expect('error' in e2 && e2.error.message).toContain('matched 2 times');
    expect(fs.readFileSync(path.join(ws, 'src', 'a.ts'), 'utf8')).toBe('x = 1;\nx = 1;\ny = 2;\n');
    const e3 = await call({ path: 'src/a.ts', oldText: 'y = 2;', newText: 'y = 3;' }); expect('output' in e3 && (e3.output as any).replacements).toBe(1);
    const e4 = await call({ path: 'src/a.ts', oldText: 'x = 1;', newText: 'x = 9;', replaceAll: true }); expect('output' in e4 && (e4.output as any).replacements).toBe(2);
    expect(fs.readFileSync(path.join(ws, 'src', 'a.ts'), 'utf8')).toBe('x = 9;\nx = 9;\ny = 3;\n');
    // newText 含 $& / $$ / $1 时必须原样写入（第四轮 dogfood：模型把 split/join 改成 replaceAll(str,str) 全绿通过——JS 会解释 $ 模式）
    const e5 = await call({ path: 'src/a.ts', oldText: 'x = 9;', newText: 'x = "$&$$$1";', replaceAll: true }); expect('output' in e5 && (e5.output as any).replacements).toBe(2);
    expect(fs.readFileSync(path.join(ws, 'src', 'a.ts'), 'utf8')).toBe('x = "$&$$$1";\nx = "$&$$$1";\ny = 3;\n');
    const e6 = await call({ path: 'src/a.ts', oldText: 'y = 3;', newText: 'y = "$&";' }); expect('output' in e6).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'src', 'a.ts'), 'utf8')).toContain('y = "$&";');
    const sh = await p.execute({ id: 'i2', revision: 0, contract: CONTRACTS.shell, args: { argv: ['node', '-e', 'console.log(process.cwd())'] }, handle: { id: 'h', contract: CONTRACTS.shell, caveats: [], delegable: true }, principal: [{ kind: 'agent', id: 'x' }], digest: 'sha256:' + '0'.repeat(64), idempotencyKey: 'i2' } as any, { principal: [], trace: { traceId: 't', spanId: 's' } });
    expect('output' in sh && String((sh.output as any).stdout).trim()).toBe(fs.realpathSync(ws));
  }, 30000);
});

describe('cak-code · 控制器 + 审批流（mock 模型）', () => {
  it('模型要写文件 → 句柄要审批 → 任务挂起 → 用户批准 → 写入 → 模型汇报；拒绝路径也能收尾', async () => {
    const ws = mkws();
    const script = [
      { finishReason: 'tool_calls' as const, toolCalls: [{ id: 'c1', contract: 'file.read', args: { path: 'src/a.ts' } }] },
      { finishReason: 'tool_calls' as const, toolCalls: [{ id: 'c2', contract: 'file.write', args: { path: 'src/b.ts', content: 'export const b = 2;\n' } }] },
      { finishReason: 'stop' as const, content: '已新增 src/b.ts。' },
    ];
    const spec = buildSpec({ backend: 'deepseek', model: 'mock', workspaceName: 'demo' });
    const k = await Kernel.compose(spec, { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: new MockBackend(script) }, providers: [new WorkspaceProvider(ws)] }, {});
    let res = await k.startTask('给 src 加一个 b.ts', { input: '给 src 加一个 b.ts' });
    expect(res.status).toBe('suspended');
    const pend = k.pendingApprovals(res.taskId); expect(pend.length).toBe(1); expect(pend[0]!.contract.name).toBe('file.write');
    expect(fs.existsSync(path.join(ws, 'src', 'b.ts'))).toBe(false);          // 批准前没写
    k.grant(pend[0]!.approvalId, { kind: 'user', id: 'yuyan' });
    res = await k.resume(res.taskId);
    expect(res.status).toBe('finished'); expect(String(res.output)).toContain('b.ts');
    expect(fs.readFileSync(path.join(ws, 'src', 'b.ts'), 'utf8')).toBe('export const b = 2;\n');
    // 拒绝路径
    const ws2 = mkws();
    const k2 = await Kernel.compose(spec, { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: new MockBackend([script[1]!, { finishReason: 'stop', content: '你拒绝了写入，我停下。' }]) }, providers: [new WorkspaceProvider(ws2)] }, {});
    let r2 = await k2.startTask('写', { input: '写' }); const p2 = k2.pendingApprovals(r2.taskId)[0]!;
    k2.deny(p2.approvalId, { kind: 'user', id: 'yuyan' }, '不要'); r2 = await k2.resume(r2.taskId);
    expect(r2.status).toBe('finished'); expect(fs.existsSync(path.join(ws2, 'src', 'b.ts'))).toBe(false);
    expect(k2.ledger.all().some(e => e.type === 'invocation.denied' && (e.payload as any).reason.includes('不要'))).toBe(true);
  }, 30000);
});

describe('cak-code · 内核入参校验（N-25）', () => {
  it('模型给出不合 inputSchema 的参数（如 {_raw}）→ denied/ARGS_INVALID，不进审批队列、不落盘', async () => {
    const ws = mkws();
    const script = [
      { finishReason: 'tool_calls' as const, toolCalls: [{ id: 'c1', contract: 'file.write', args: { _raw: '{"path": "x' } }] },
      { finishReason: 'stop' as const, content: '参数错了，我停下。' },
    ];
    const spec = buildSpec({ backend: 'deepseek', model: 'mock', workspaceName: 'demo' });
    const k = await Kernel.compose(spec, { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: new MockBackend(script) }, providers: [new WorkspaceProvider(ws)] }, {});
    const res = await k.startTask('写', { input: '写' });
    expect(res.status).toBe('finished');
    const proj = k.ledger.projections();
    const w = Object.values(proj.invocations).find(i => i.contract.name === 'file.write')!;
    expect(w.status).toBe('denied'); expect(w.denyCode).toBe('ARGS_INVALID'); expect(w.denyReason).toContain('inputSchema');
    expect(Object.keys(proj.pendingApprovals).length).toBe(0);
    expect(fs.existsSync(path.join(ws, 'undefined'))).toBe(false);
  });
});


describe('cak-code · 始终允许 = 用户铸的窄根句柄（N-28 / N-29）', () => {
  it('standing(file.edit 限 src/) → src/ 下的编辑不再问、落在窄句柄上、零 denied；src 外仍审批；revoke 后又审批', async () => {
    const ws = mkws();
    const edit = (p: string, o: string, n: string) => ({ finishReason: 'tool_calls' as const, toolCalls: [{ id: 'c', contract: 'file.edit', args: { path: p, oldText: o, newText: n } }] });
    const done = { finishReason: 'stop' as const, content: 'ok' };
    const script = [edit('src/a.ts', 'a = 1', 'a = 2'), done, edit('README.md', '# demo', '# demo2'), done, edit('src/a.ts', 'a = 2', 'a = 3'), done];
    const spec = buildSpec({ backend: 'deepseek', model: 'mock', workspaceName: 'demo' });
    const k = await Kernel.compose(spec, { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: new MockBackend(script) }, providers: [new WorkspaceProvider(ws)] }, {});
    const before = Object.keys(k.ledger.projections().handles).length;
    const h = k.controlPlane().standing({ name: 'file.edit' }, [{ kind: 'args.prefix', path: 'path', prefix: 'src/' }], { by: { kind: 'user', id: 'yuyan' }, reason: 'test' });
    const hv = k.ledger.projections().handles[h.id]!;
    expect(Object.keys(k.ledger.projections().handles).length).toBe(before + 1);
    expect(hv.caveats.some(c => c.kind === 'requires-approval')).toBe(false); expect(hv.caveats.some(c => c.kind === 'args.prefix')).toBe(true);
    // 1) src/ 下：不挂起、执行落在窄句柄、全程零 denied
    let r = await k.startTask('1', { input: '1' }); expect(r.status).toBe('finished');
    const proj1 = k.ledger.projections();
    const inv1 = Object.values(proj1.invocations).find(i => i.contract.name === 'file.edit')!; expect(inv1.status).toBe('executed'); expect(inv1.handleId).toBe(h.id);
    expect(fs.readFileSync(path.join(ws, 'src', 'a.ts'), 'utf8')).toContain('a = 2');
    expect(Object.values(proj1.invocations).filter(i => i.status === 'denied').length).toBe(0);
    // 2) src 外：仍要审批
    r = await k.startTask('2', { input: '2' }); expect(r.status).toBe('suspended');
    const p2 = k.pendingApprovals(r.taskId)[0]!; k.deny(p2.approvalId, { kind: 'user', id: 'yuyan' }, 'no'); r = await k.resume(r.taskId); expect(r.status).toBe('finished');
    // 3) 撤销后 src/ 下也要审批
    k.controlPlane().revoke(h.id, 'test');
    r = await k.startTask('3', { input: '3' }); expect(r.status).toBe('suspended');
    expect(k.pendingApprovals(r.taskId)[0]!.contract.name).toBe('file.edit');
  });
});

describe('内核 · 大结果回喂（16 §3-2 bug 修复）', () => {
  it('工具结果 >16KB：账本不内联（outputPreview），但下一步 view.invocations 里 output 完整（从 blob 补回）', async () => {
    const ws = mkws(); fs.writeFileSync(path.join(ws, 'big.txt'), 'x'.repeat(40_000));
    let seen: unknown; const backend = new MockBackend([
      { finishReason: 'tool_calls' as const, toolCalls: [{ id: 'c1', contract: 'file.read', args: { path: 'big.txt' } }] },
      { finishReason: 'stop' as const, content: 'done' },
    ]);
    const orig = backend.generate.bind(backend); (backend as any).generate = async (req: any, ctx: any) => { const tool = req.messages.find((m: any) => m.role === 'tool'); if (tool) seen = tool.content; return orig(req, ctx); };
    const k = await Kernel.compose(buildSpec({ backend: 'deepseek', model: 'mock', workspaceName: 'x', requireApproval: false }), { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: backend }, providers: [new WorkspaceProvider(ws)] }, {});
    const r = await k.startTask('read', { input: 'read' }); expect(r.status).toBe('finished');
    const ev = k.ledger.all().find(e => e.type === 'invocation.executed' && (e.payload as any).outputPreview); expect(ev, '账本应为 preview 形式').toBeTruthy(); expect((ev!.payload as any).output).toBeUndefined();
    expect(String((seen as any)?.result?.content ?? '').length).toBe(40_000);   // 模型看到的是完整内容
  });
});

describe('cak-code · 线程重建按位置配对（DeepSeek 400 回归）', () => {
  it('模型自己调 session.history 当工具 → 线程里 assistant.tool_calls 后紧跟对应 tool 结果；composer 的上下文源调用不出现为孤立 tool 消息', async () => {
    const ws = mkws(); const seen: any[][] = [];
    const backend = new MockBackend([
      { finishReason: 'tool_calls' as const, toolCalls: [{ id: 'c1', contract: 'session.history', args: { limit: 10 } }] },
      { finishReason: 'stop' as const, content: 'ok' },
    ]);
    const orig = backend.generate.bind(backend); (backend as any).generate = async (req: any, ctx: any) => { seen.push(req.messages); return orig(req, ctx); };
    const k = await Kernel.compose(buildSpec({ backend: 'deepseek', model: 'mock', workspaceName: 'x', requireApproval: false, memory: false }), { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: backend }, providers: [new WorkspaceProvider(ws, { sessionFile: path.join(ws, 's.jsonl') })] }, {});
    const r = await k.startTask('x', { input: 'x' }); expect(r.status).toBe('finished');
    const second = seen[1]!;   // 第二次模型调用看到的线程
    const ai = second.findIndex((m: any) => m.role === 'assistant' && m.toolCalls?.length); expect(ai).toBeGreaterThan(-1);
    expect(second[ai + 1].role).toBe('tool'); expect(second[ai + 1].toolCallId).toBe(second[ai].toolCalls[0].id);
    // 孤立 tool 消息（前面不是带 tool_calls 的 assistant）不得出现
    for (let i = 0; i < second.length; i++) if (second[i].role === 'tool') expect(second[i - 1].role === 'tool' || (second[i - 1].role === 'assistant' && !!second[i - 1].toolCalls?.length)).toBe(true);
    // 第一次模型调用：composer 调过 session.history，但线程里不能有 tool 消息
    expect(seen[0]!.some((m: any) => m.role === 'tool')).toBe(false);
  });
});
