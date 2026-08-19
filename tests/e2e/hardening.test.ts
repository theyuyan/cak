// 真驱动测试员抓到的 P1（2026-08-19）的回归：decide fail-closed · 符号链接越界 · 重启后孤儿审批可批可续 · 同名 daemon 拒起
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { createHost } from '../../apps/cak-code/host.js';
import { startDaemon } from '../../apps/cak-code/daemon.js';
import { DaemonClient } from '../../apps/cak-front/client.js';
import { MockBackend } from '../../plugins/builtin/index.js';
import { WorkspaceProvider } from '../../apps/cak-code/workspace-provider.js';
const mkws = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-')); fs.writeFileSync(path.join(d, 'README.md'), '# hi\n'); spawnSync('git', ['init', '-q'], { cwd: d }); return d; };
const call = (p: WorkspaceProvider, name: string, args: any) => p.execute({ id: 'i', revision: 0, contract: { name, version: '1.0.0', schemaDigest: 'x' } as any, args, handle: { id: 'h', contract: { name, version: '1.0.0', schemaDigest: 'x' }, caveats: [], delegable: true } as any, principal: [], digest: 'x', idempotencyKey: 'i' } as any, { principal: [], trace: { traceId: 't', spanId: 's' } } as any);

describe('加固回归', () => {
  it('工作区里的符号链接不能把 file.read / file.list 带出去；直接越界照旧拒', async () => {
    const ws = mkws(); fs.symlinkSync('/etc/hosts', path.join(ws, 'link_hosts')); fs.mkdirSync(path.join(ws, 'sub')); fs.symlinkSync(os.homedir(), path.join(ws, 'sub', 'home_link'));
    const p = new WorkspaceProvider(ws);
    const r1 = await call(p, 'file.read', { path: 'link_hosts' }); expect(String((r1 as any).error?.message)).toMatch(/escapes workspace \(symlink/);
    const r2 = await call(p, 'file.list', { path: 'sub/home_link' }); expect(String((r2 as any).error?.message)).toMatch(/escapes workspace/);
    const r3 = await call(p, 'file.list', { path: 'sub' }); expect((r3 as any).output.entries).toEqual([{ path: 'sub/home_link', type: 'file' }]);   // 只列名不跟
    const r4 = await call(p, 'file.read', { path: '../../etc/passwd' }); expect(String((r4 as any).error?.message)).toMatch(/escapes workspace/);
    const r5 = await call(p, 'file.write', { path: 'sub/new.txt', content: 'ok' }); expect((r5 as any).output).toBeTruthy(); expect(fs.readFileSync(path.join(ws, 'sub', 'new.txt'), 'utf8')).toBe('ok');   // 不存在的新文件按父目录判，正常写
  });
  it('session.decide：非法/缺省 decision 报错且不放行；approve 是 grant 别名；重启后孤儿审批仍可见、批准后续跑', async () => {
    const ws = mkws();
    const script = [{ finishReason: 'tool_calls', toolCalls: [{ id: 'c1', contract: 'file.write', args: { path: 'NOTE.md', content: 'v1\n' } }] }, { finishReason: 'stop', content: '写好了' }];
    const session = 'hard-' + Date.now();
    let host = await createHost({ workspace: ws, backend: 'deepseek', session, pluginsDir: null, mcp: null, registryDir: null, backendImpl: new MockBackend(script as any) });
    let d = await startDaemon({ host, writeInfoFile: false });
    const c1 = new DaemonClient({ url: d.url, token: d.token });
    await c1.call('session.input', { text: '写 NOTE.md' });
    const until = async (f: () => Promise<boolean>) => { const t0 = Date.now(); while (!(await f())) { if (Date.now() - t0 > 8000) throw new Error('timeout'); await new Promise(r => setTimeout(r, 60)); } };
    await until(async () => ((await c1.call('session.pending')) as any[]).length > 0);
    const ap = ((await c1.call('session.pending')) as any[])[0].approvalId;
    await expect(c1.call('session.decide', { approvalId: ap, decision: 'maybe' })).rejects.toThrow(/decision 必须是/);
    await expect(c1.call('session.decide', { approvalId: ap })).rejects.toThrow(/decision 必须是/);
    expect(fs.existsSync(path.join(ws, 'NOTE.md'))).toBe(false);
    expect(((await c1.call('session.pending')) as any[]).length).toBe(1);   // 还挂着
    // 运行中可见
    const st: any = await c1.call('session.status'); expect(st.running).toBe(true); expect(st.current?.input).toBe('写 NOTE.md');
    const tasks: any[] = await c1.call('session.tasks'); expect(tasks.some(t => t.status === 'running' && t.input === '写 NOTE.md')).toBe(true);
    // "崩溃"：不批就关掉 daemon（任务停在 suspended），同一账本重起
    await d.close(); await host.close();
    host = await createHost({ workspace: ws, backend: 'deepseek', session, pluginsDir: null, mcp: null, registryDir: null, backendImpl: new MockBackend(script.slice(1) as any) });
    d = await startDaemon({ host, writeInfoFile: false });
    const c2 = new DaemonClient({ url: d.url, token: d.token });
    const pend2: any[] = await c2.call('session.pending'); expect(pend2.length).toBe(1); expect(pend2[0].approvalId).toBe(ap);
    const tasks2: any[] = await c2.call('session.tasks'); expect(tasks2.some(t => t.status === 'suspended' && t.input === '写 NOTE.md')).toBe(true);   // 孤儿任务被认领
    const stop = c2.events(() => {}, 0);
    const r = await c2.call('session.decide', { approvalId: ap, decision: 'approve' }); expect(r).toEqual({ ok: true });
    stop();
    await until(async () => fs.existsSync(path.join(ws, 'NOTE.md')));   // 批准 → 续跑 → 真写了
    await until(async () => ((await c2.call('session.tasks')) as any[]).some(t => t.status === 'finished'));
    expect(((await c2.call('session.pending')) as any[]).length).toBe(0);
    await d.close();
  }, 30000);
});
