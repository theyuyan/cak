// N-51：同一内核进程里的 agent 互相委派 —— bare 用 agent.invoke(target=coding, contract=agent.task) 把子任务交给 coding；
// 走 daemon 的排队/审批链（被委派方要审批照样弹给前端）；回执来自被委派方账本；不能委派给自己；未知 target 报错并列出可用 agent
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { createHost } from '../../apps/cak-code/host.js';
import { startDaemon, SiblingRouter } from '../../apps/cak-code/daemon.js';
import { DaemonClient } from '../../apps/cak-front/client.js';
import { MockBackend } from '../../plugins/builtin/index.js';
const mkws = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sib-')); fs.writeFileSync(path.join(d, 'README.md'), '# hi\n'); spawnSync('git', ['init', '-q'], { cwd: d }); return d; };

describe('兄弟 agent 委派（N-51）', () => {
  it('bare → agent.invoke(coding, agent.task) 需审批 → coding 收到 [委派自 bare] 文本、写文件也要审批 → 回报 report + 回执；自委派/未知 target 被拒', async () => {
    const ws = mkws(); const router = new SiblingRouter();
    const bareBackend = new MockBackend([
      { finishReason: 'tool_calls', toolCalls: [{ id: 'c0', contract: 'agent.invoke', args: { target: 'bare', contract: { name: 'agent.task', version: '1.0.0' }, args: { intent: '自己委派自己' } } }] },
      { finishReason: 'tool_calls', toolCalls: [{ id: 'c1', contract: 'agent.invoke', args: { target: 'nobody', contract: { name: 'agent.task', version: '1.0.0' }, args: { intent: 'x' } } }] },
      { finishReason: 'tool_calls', toolCalls: [{ id: 'c2', contract: 'agent.invoke', args: { target: 'coding', contract: { name: 'agent.task', version: '1.0.0' }, args: { intent: '写一个 NOTE.md', context: '内容随便' } } }] },
      { finishReason: 'stop', content: '委派完成' },
    ]);
    const codingBackend = new MockBackend([
      { finishReason: 'tool_calls', toolCalls: [{ id: 'k1', contract: 'file.write', args: { path: 'NOTE.md', content: 'by coding\n' } }] },
      { finishReason: 'stop', content: '写好了 NOTE.md' },
    ]);
    let n = 0; const factory = async (profile: string) => createHost({ workspace: ws, agent: profile, session: `sib-${Date.now()}-${n++}`, pluginsDir: null, mcp: null, registryDir: null, backendImpl: profile === 'bare' ? bareBackend : codingBackend, agentTargets: router.targetsFor(profile) });
    const hosts = [await factory('bare'), await factory('coding')];
    const d = await startDaemon({ agents: hosts, name: 'sib', writeInfoFile: false, hostFactory: factory, router });
    try {
      const c = new DaemonClient({ url: d.url, token: d.token });
      const events: any[] = []; const stop = c.events(e => events.push(e), 0);
      const until = async (pred: () => boolean, ms = 15000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + events.map(e => e.type + ':' + e.agent).join(',')); await new Promise(r => setTimeout(r, 50)); } };
      // 审批：谁要就批谁（bare 的 agent.invoke ×3、coding 的 file.write）
      const approved: string[] = [];
      const approveAll = async () => { for (const s of ['bare', 'coding']) { const pend: any[] = await c.call('session.pending', { agent: s }); for (const p of pend) { if (approved.includes(p.approvalId)) continue; approved.push(p.approvalId); await c.call('session.decide', { agent: s, approvalId: p.approvalId, decision: 'approve' }); } } };
      await c.call('session.input', { text: '把写 NOTE.md 的活交给 coding', agent: 'bare' });
      const t0 = Date.now(); while (Date.now() - t0 < 20000) { await approveAll(); if (events.some(e => e.type === 'daemon.task.result' && e.agent === 'bare')) break; await new Promise(r => setTimeout(r, 100)); }
      await until(() => events.some(e => e.type === 'daemon.task.result' && e.agent === 'bare')); stop();
      // coding 真跑了一个任务，输入带来源标记；文件真写了
      const codingRes = events.find(e => e.type === 'daemon.task.result' && e.agent === 'coding'); expect(codingRes).toBeTruthy(); expect(codingRes.payload.output).toBe('写好了 NOTE.md');
      const codingTasks: any[] = await c.call('session.tasks', { agent: 'coding' }); expect(codingTasks[0].input).toMatch(/^\[委派自 bare\] 写一个 NOTE\.md/); expect(fs.existsSync(path.join(ws, 'NOTE.md'))).toBe(true);
      // bare 那边：三次 agent.invoke —— 自委派 ROUTING_ERROR、未知 target 报错并列出可用（coding）、第三次成功拿到 report + receipt
      const bare = hosts[0]!.k.ledger.all() as any[];
      const fails = bare.filter(e => e.type === 'invocation.failed').map(e => e.payload?.error?.message ?? ''); expect(fails.some((m: string) => /unknown target agent bare/.test(m))).toBe(true); expect(fails.some((m: string) => /unknown target agent nobody（可用：coding）/.test(m))).toBe(true);
      const ok = bare.filter(e => e.type === 'invocation.executed').map(e => e.payload?.output).find((o: any) => o && typeof o === 'object' && 'receipt' in o);
      expect(ok.output.report).toBe('写好了 NOTE.md'); expect(ok.receipt.root).toMatch(/^[0-9a-f]{16,}$|^sha256:/); expect(typeof ok.receipt.sig.value).toBe('string');
      // 被委派方审批确实弹过（file.write）
      expect(events.some(e => e.type === 'daemon.approval.needed' && e.agent === 'coding' && e.payload.pending[0].contract === 'file.write')).toBe(true);
    } finally { await d.close(); }
  }, 60000);
});
