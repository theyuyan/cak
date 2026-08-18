// 常驻形态：daemon（内核在后台）+ 前端客户端只走控制面 API —— 输入 → SSE 看到调用 → 审批 → 结果；无 token 401；未知方法 -32601；replay 不丢
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { createHost } from '../../apps/cak-code/host.js';
import { startDaemon } from '../../apps/cak-code/daemon.js';
import { DaemonClient } from '../../apps/cak-front/client.js';
import { MockBackend } from '../../plugins/builtin/index.js';
const mkws = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-')); fs.writeFileSync(path.join(d, 'README.md'), '# hi\n'); spawnSync('git', ['init', '-q'], { cwd: d }); return d; };
describe('cak daemon · 前端只走控制面', () => {
  it('session.input → SSE(daemon.approval.needed) → session.decide grant → daemon.task.result；未授权 401；未知方法 -32601；重连回放', async () => {
    const ws = mkws();
    const backend = new MockBackend([
      { finishReason: 'tool_calls', toolCalls: [{ id: 'c1', contract: 'file.write', args: { path: 'NOTE.md', content: 'from daemon\n' } }] },
      { finishReason: 'stop', content: '写好了' },
    ]);
    const host = await createHost({ workspace: ws, backend: 'deepseek', session: 'test-daemon-' + Date.now(), pluginsDir: null, mcp: null, registryDir: null, backendImpl: backend });
    const d = await startDaemon({ host, writeInfoFile: false });
    try {
      // 未授权
      const r401 = await fetch(d.url + '/rpc', { method: 'POST', body: '{}' }); expect(r401.status).toBe(401);
      const c = new DaemonClient({ url: d.url, token: d.token });
      await expect(c.call('nope')).rejects.toThrow(/unknown method/);
      const events: any[] = []; const stop = c.events(e => events.push(e), 0);
      const st: any = await c.call('session.status'); expect(st.workspace).toBe(ws);
      await c.call('session.input', { text: '写个 NOTE.md' });
      // 等审批事件
      const until = async (pred: () => boolean, ms = 8000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + events.map(e => e.type).join(',')); await new Promise(r => setTimeout(r, 50)); } };
      await until(() => events.some(e => e.type === 'daemon.approval.needed'));
      const need = events.find(e => e.type === 'daemon.approval.needed'); expect(need.payload.pending[0].contract).toBe('file.write'); expect(need.payload.pending[0].diff).toContain('+ from daemon');
      expect(fs.existsSync(path.join(ws, 'NOTE.md'))).toBe(false);   // 批准前没写
      const pend: any[] = await c.call('session.pending'); expect(pend.length).toBe(1);
      const dec: any = await c.call('session.decide', { approvalId: pend[0].approvalId, decision: 'grant' }); expect(dec.ok).toBe(true);
      await until(() => events.some(e => e.type === 'daemon.task.result'));
      const res = events.find(e => e.type === 'daemon.task.result'); expect(res.payload.status).toBe('finished'); expect(res.payload.output).toBe('写好了');
      expect(fs.readFileSync(path.join(ws, 'NOTE.md'), 'utf8')).toBe('from daemon\n');
      expect(events.some(e => e.type === 'invocation.executed')).toBe(true);   // 账本事件也在流里
      stop();
      // 重连回放：since=0 能把账本事件补回来
      const replay: any[] = []; const stop2 = c.events(e => replay.push(e), 0); await until(() => replay.some(e => e.type === 'task.finished')); stop2();
      const tasks: any[] = await c.call('session.tasks'); expect(tasks.length).toBe(1); expect(tasks[0].status).toBe('finished');
    } finally { await d.close(); await host.close(); }
  }, 30000);
});
