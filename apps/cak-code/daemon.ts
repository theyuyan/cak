#!/usr/bin/env tsx
/**
 * cak daemon — 常驻形态：内核 + 插件 + 会话在本进程；任何前端（TUI / 桌面 / 网页 / 别人写的）经本机控制面 API 接入。
 *   npx tsx apps/cak-code/daemon.ts [--workspace DIR] [--session NAME] [--port 0] [其余同 cli.ts]
 * 安全：只听 127.0.0.1；每会话随机 token（写 ~/.cak/daemon/<session>.json，0600），请求必须带 x-cak-token（SSE 用 ?token=）——同机其他进程/用户不能替你按"允许"。
 * API（JSON-RPC 2.0 over HTTP，POST /rpc，信封 cak/1）：
 *   session.status | session.input {text} → {taskId} | session.pending [{taskId}] | session.decide {approvalId, decision: grant|deny|standing, reason?}
 *   session.handles | session.revoke {handleId} | session.report | session.tasks | session.task {taskId}
 *   GET /events?since=N&token=…  → SSE：账本事件（type,seq,taskId,payload）+ daemon 事件（daemon.approval.needed / daemon.task.result / daemon.plugins.reloaded / daemon.note / daemon.model.delta 流式正文）
 * 前端拿到的只是控制面权限（看事件、审批、看状态），不是能力——前端本来就该只做"看和点"。
 */
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { randomBytes } from 'node:crypto';
import { createHost, type Host } from './host.js';
import { parseMcpFlag } from '../../plugins/builtin/mcp-config.js';
import type { LedgerEventView, Observer, ModelBackend } from '../../sdk/types.js';

export interface DaemonOptions { host: Host; port?: number; token?: string; writeInfoFile?: boolean; /** 宿主的流式增量接到这里 → SSE daemon.model.delta */ deltaSink?: { publish?: (e: { taskId: string; invocationId: string; text: string }) => void } }
export interface DaemonHandle { url: string; token: string; port: number; close(): Promise<void>; infoFile?: string }

/** 把 Host 挂成本机 HTTP 控制面；返回 url/token/close。可在测试里进程内起（Host 用 mock 后端） */
export async function startDaemon(o: DaemonOptions): Promise<DaemonHandle> {
  const host = o.host; const token = o.token ?? randomBytes(24).toString('hex');
  // 事件流：观察者 → 内存环形缓冲 + 订阅者
  const buffer: Array<{ seq: number; type: string; taskId?: string; payload: unknown; ts: string }> = []; const subs = new Set<http.ServerResponse>(); let daemonSeq = 0;
  const publish = (ev: { seq?: number; type: string; taskId?: string; payload: unknown }) => { const rec = { seq: ev.seq ?? ++daemonSeq + 1_000_000_000, type: ev.type, taskId: ev.taskId, payload: ev.payload, ts: new Date().toISOString() }; buffer.push(rec); if (buffer.length > 5000) buffer.splice(0, buffer.length - 5000); const line = `id: ${rec.seq}\nevent: ${rec.type}\ndata: ${JSON.stringify(rec)}\n\n`; for (const r of subs) { try { r.write(line); } catch { subs.delete(r); } } };
  const observer: Observer = { id: 'daemon-stream', onEvent(e: LedgerEventView) { publish({ seq: e.seq, type: e.type, taskId: e.taskId, payload: e.payload }); } };
  host.k.ledger.subscribe(observer);
  if (o.deltaSink) o.deltaSink.publish = e => publish({ type: 'daemon.model.delta', taskId: e.taskId, payload: e });
  // 任务队列：一次一个；挂起时发 approval.needed，等前端 decide 完再 resume
  const tasks = new Map<string, { input: string; status: string; output?: unknown; startedAt: string; finishedAt?: string }>();
  let running = false; const queue: string[] = []; const decided = new Set<string>();   // 前端已决定的 approvalId（内核里 awaiting 要到 resume 才出 pending，所以自己记）
  const pump = async () => {
    if (running) return; running = true;
    while (queue.length) {
      const text = queue.shift()!;
      try {
        let res = await host.submit(text); tasks.set(res.taskId, { input: text, status: res.status, startedAt: new Date().toISOString() });
        while (res.status === 'suspended') {
          const pend = host.pending(res.taskId); if (!pend.length) break;
          publish({ type: 'daemon.approval.needed', taskId: res.taskId, payload: { taskId: res.taskId, pending: pend } });
          while (pend.some(p => !decided.has(p.approvalId))) await new Promise(r => setTimeout(r, 150));   // 等前端把这一批全决定（grant/deny/standing）
          res = await host.resume(res.taskId);
        }
        const answer = typeof res.output === 'string' ? res.output : JSON.stringify(res.output ?? res.status); host.recordAnswer(answer);
        const usage = host.usageOf(res.taskId); tasks.set(res.taskId, { input: text, status: res.status, output: res.output, startedAt: tasks.get(res.taskId)!.startedAt, finishedAt: new Date().toISOString() });
        publish({ type: 'daemon.task.result', taskId: res.taskId, payload: { taskId: res.taskId, status: res.status, output: res.output, usage } });
        if (await host.recomposeIfNeeded()) { host.k.ledger.subscribe(observer); publish({ type: 'daemon.plugins.reloaded', payload: { plugins: host.installed.map(p => p.id) } }); }
      } catch (e) { publish({ type: 'daemon.note', payload: { level: 'error', message: (e as Error).message } }); }
    }
    running = false;
  };
  const methods: Record<string, (p: any) => unknown | Promise<unknown>> = {
    'session.status': () => ({ ...host.status(), running, queued: queue.length, tasks: tasks.size }),
    'session.input': (p) => { const text = String(p?.text ?? '').trim(); if (!text) throw new Error('text required'); queue.push(text); void pump(); return { queued: queue.length + (running ? 1 : 0) }; },
    'session.pending': (p) => host.pending(p?.taskId ? String(p.taskId) : undefined),
    'session.decide': (p) => { const r = host.decide(String(p?.approvalId), p?.decision, p?.reason ? String(p.reason) : undefined); decided.add(String(p?.approvalId)); return r; },
    'session.handles': () => host.k.controlPlane().handles(),
    'session.revoke': (p) => { host.k.controlPlane().revoke(String(p?.handleId), 'frontend: 用户撤销'); return { ok: true }; },
    'session.report': () => { const r = host.k.usageReport(); return { contracts: r.contracts, events: r.events }; },
    'session.tasks': () => [...tasks.entries()].map(([id, t]) => ({ taskId: id, ...t, output: typeof t.output === 'string' ? t.output.slice(0, 200) : t.output })),
    'session.task': (p) => { const t = tasks.get(String(p?.taskId)); if (!t) throw new Error('unknown task'); return { taskId: p.taskId, ...t }; },
  };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authed = req.headers['x-cak-token'] === token || u.searchParams.get('token') === token;
    if (u.pathname === '/') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ cak: '1', daemon: 'cak-code', session: host.sessionName, auth: authed })); }
    if (!authed) { res.statusCode = 401; return res.end('unauthorized'); }
    if (u.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.flushHeaders(); res.write(': connected\n\n');   // 立刻把头发出去，客户端不用等第一个事件
      const since = Number(u.searchParams.get('since') ?? 0);
      // 回放：先补账本里 since 之后的事件（前端重连不丢），再补 daemon 缓冲，再实时
      for (const e of host.k.ledger.all().filter(x => x.seq > since)) res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify({ seq: e.seq, type: e.type, taskId: e.taskId, payload: e.payload, ts: e.ts })}\n\n`);
      for (const b of buffer.filter(x => x.seq > 1_000_000_000 && x.seq > since)) res.write(`id: ${b.seq}\nevent: ${b.type}\ndata: ${JSON.stringify(b)}\n\n`);
      subs.add(res); req.on('close', () => subs.delete(res)); return;
    }
    if (u.pathname === '/rpc' && req.method === 'POST') {
      let body = ''; req.on('data', d => body += d); req.on('end', async () => {
        res.setHeader('content-type', 'application/json'); let env: any; try { env = JSON.parse(body); } catch { res.statusCode = 400; return res.end(JSON.stringify({ cak: '1', jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })); }
        const id = env.id ?? null; const m = methods[env.method];
        if (env.cak !== '1' || env.jsonrpc !== '2.0') return res.end(JSON.stringify({ cak: '1', jsonrpc: '2.0', id, error: { code: -32600, message: 'bad envelope' } }));
        if (!m) return res.end(JSON.stringify({ cak: '1', jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${env.method}` } }));
        try { const result = await m(env.params ?? {}); res.end(JSON.stringify({ cak: '1', jsonrpc: '2.0', id, result })); } catch (e) { res.end(JSON.stringify({ cak: '1', jsonrpc: '2.0', id, error: { code: -32000, message: (e as Error).message } })); }
      }); return;
    }
    res.statusCode = 404; res.end('not found');
  });
  await new Promise<void>(r => server.listen(o.port ?? 0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port; const url = `http://127.0.0.1:${port}`;
  let infoFile: string | undefined;
  if (o.writeInfoFile !== false) { const dir = path.join(os.homedir(), '.cak', 'daemon'); fs.mkdirSync(dir, { recursive: true }); infoFile = path.join(dir, host.sessionName + '.json'); fs.writeFileSync(infoFile, JSON.stringify({ url, token, pid: process.pid, session: host.sessionName, workspace: host.workspace, startedAt: new Date().toISOString() }, null, 1), { mode: 0o600 }); }
  return { url, token, port, infoFile, close: async () => { for (const s of subs) { try { s.end(); } catch { /* */ } } await new Promise<void>(r => server.close(() => r())); if (infoFile) fs.rmSync(infoFile, { force: true }); } };
}

/** 读某个会话的连接信息（前端用）：~/.cak/daemon/<session>.json；不给 session 就取最新的一个 */
export function findDaemon(session?: string): { url: string; token: string; session: string; workspace: string; pid: number } | undefined {
  const dir = path.join(os.homedir(), '.cak', 'daemon'); if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const pick = session ? files.find(f => path.basename(f, '.json') === session) : files[0]; if (!pick) return undefined;
  const info = JSON.parse(fs.readFileSync(pick, 'utf8'));
  try { process.kill(info.pid, 0); } catch { fs.rmSync(pick, { force: true }); return undefined; }   // 进程不在了 = 陈旧文件
  return info;
}

// ---- 作为程序运行 ----
const isMain = process.argv[1] && /daemon\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2); const flag = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; }; const has = (n: string) => argv.includes('--' + n);
  const mcpExtra = argv.map((a, i) => a === '--mcp' ? argv[i + 1] : undefined).filter((x): x is string => !!x).map(parseMcpFlag).filter((x): x is NonNullable<typeof x> => !!x);
  const sink: { publish?: (e: { taskId: string; invocationId: string; text: string }) => void } = {};
  const host = await createHost({ workspace: flag('workspace') ?? '.', backend: flag('backend') === 'anthropic' ? 'anthropic' : 'deepseek', model: flag('model'), session: flag('session'), reviewerUrl: flag('reviewer'), pluginsDir: has('no-plugins') ? null : flag('plugins-dir'), mcp: has('no-mcp') ? null : { extra: mcpExtra }, registryDir: has('no-registry') ? null : flag('registry'), note: (lvl, msg) => console.error(`  ${lvl}: ${msg}`), onModelDelta: e => sink.publish?.(e) });
  const d = await startDaemon({ host, port: Number(flag('port') ?? 0), deltaSink: sink });
  console.log(`cak daemon · ${host.banner()}\n  控制面 ${d.url}（token 在 ${d.infoFile}，只有你这个用户能读）\n  前端：npx tsx apps/cak-front/tty.ts --session ${host.sessionName}   · Ctrl-C 退出`);
  const bye = async () => { await d.close(); await host.close(); process.exit(0); }; process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
export type { ModelBackend };
