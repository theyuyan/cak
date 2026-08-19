#!/usr/bin/env tsx
/**
 * cak 内核进程（daemon）：一个常驻进程 = 内核服务（插件管理 · agent 配置管理 · 控制面 · 事件流）+ 里面挂 0..N 个 agent（各自 profile / 账本 / 会话）。
 *   npx tsx apps/cak-code/daemon.ts [--name NAME] [--workspace DIR] [--agent bare|coding|<profile>]… [--no-agent] [--port 0] [其余同 cli.ts]
 * 零 agent 也成立：插件/配置管理走控制面，不依赖任何模型；`cak` 一个词默认顺手挂一个 bare（引导用的最小 agent，随时可摘可换）。
 * 安全：只听 127.0.0.1；每个内核进程随机 token（~/.cak/daemon/<name>.json，0600），请求必须带 x-cak-token（SSE 用 ?token=）。
 * API（JSON-RPC 2.0 over HTTP，POST /rpc，信封 cak/1）：
 *   kernel.status | plugins.list | plugins.search {query} | plugins.install {id}（装完所有 agent 热加载）| plugins.registry
 *   agents.list | agents.add {profile, session?, workspace?} | agents.remove {name}
 *   session.status/input/pending/decide/handles/revoke/report/tasks/task（都可带 agent 参数；缺省=默认 agent）
 *   GET /events?since=N&token=…[&agent=NAME] → SSE：账本事件 + daemon 事件（每条带 agent）
 */
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { randomBytes } from 'node:crypto';
import { createHost, type Host, type HostOptions } from './host.js';
import { parseMcpFlag } from '../../plugins/builtin/mcp-config.js';
import { FileRegistry, installPlugin } from '../../kernel/boundary/registry.js';
import { ensureRegistry, DEFAULT_REGISTRY_URL } from '../../kernel/boundary/registry-provider.js';
import { listProfiles, ensureProfiles } from './profiles.js';
import type { LedgerEventView, Observer } from '../../sdk/types.js';
import type { ServeTarget } from '../../plugins/builtin/index.js';

export interface DaemonOptions {
  /** 兼容：单 agent 直接给 host */ host?: Host; agents?: Host[]; name?: string; port?: number; token?: string; writeInfoFile?: boolean;
  /** 兄弟 agent 委派路由（bin/cak.ts 先建、传给每个 host 的 agentTargets，再交给 daemon 接管） */ router?: SiblingRouter;
  /** agents.add 时如何造新 host（继承 up 的参数） */ hostFactory?: (profile: string, opts?: { session?: string; workspace?: string }) => Promise<Host>;
  /** 插件管理服务用的目录 */ registryDir?: string; pluginsDir?: string;
  deltaSink?: { publish?: (e: { taskId: string; invocationId: string; text: string }) => void };
}
export interface DaemonHandle { url: string; token: string; port: number; close(): Promise<void>; infoFile?: string; addAgent(host: Host): void }

type QueueItem = { text: string; resumeTaskId?: string; done?: (r: { taskId: string; status: string; output: unknown; usage: unknown }) => void; fail?: (e: Error) => void };
interface AgentSlot { name: string; host: Host; tasks: Map<string, { input: string; status: string; output?: unknown; startedAt: string; finishedAt?: string }>; queue: QueueItem[]; running: boolean; current?: { taskId?: string; input: string; startedAt: string }; decided: Set<string>; observer: Observer }

/**
 * 兄弟 agent 委派路由（N-51）：同一内核进程里的 agent 之间用 agent.invoke(target, contract=agent.task) 互相委派。
 * 走 daemon 自己的排队/审批链（被委派的 agent 要审批时照样弹给前端），不走 Kernel.serve（那是跨进程、要名片与句柄令牌的路）。
 * 回执 = 目标 agent 账本的 taskReceipt（root+sig），调用方拿到的和跨进程一样可验。
 */
export class SiblingRouter {
  private agents = new Map<string, AgentSlot>(); private runOn?: (s: AgentSlot, text: string) => Promise<{ taskId: string; status: string; output: unknown; usage: unknown }>;
  /** daemon 启动后接管 */ attach(agents: Map<string, AgentSlot>, runOn: SiblingRouter['runOn']) { this.agents = agents; this.runOn = runOn; }
  names() { return [...this.agents.keys()]; }
  /** 给某个 agent 用的 targets 视图：排除自己；成员随 agents.add/remove 动态变化 */
  targetsFor(self: string): Record<string, ServeTarget> {
    const mk = (name: string): ServeTarget => ({ serve: async (caller, contract, args) => {
      if (contract.name !== 'agent.task') return { error: { code: 'ROUTING_ERROR', message: `同进程 agent 只接受 agent.task（收到 ${contract.name}）`, retryable: false } };
      const s = this.agents.get(name); if (!s || !this.runOn) return { error: { code: 'ROUTING_ERROR', message: `agent ${name} 不在了`, retryable: false } };
      const intent = String(args['intent'] ?? '').trim(); if (!intent) return { error: { code: 'ARGS_INVALID', message: 'agent.task 需要 intent', retryable: false } };
      const context = args['context'] ? String(args['context']) : '';
      const depth = (String(args['context'] ?? '').match(/\[委派自 /g) ?? []).length; if (depth >= 3) return { error: { code: 'ROUTING_ERROR', message: '委派层数过深（≥3），拒绝', retryable: false } };
      const text = `[委派自 ${caller.agentId}] ${intent}${context ? `\n\n${context}` : ''}`;
      const r = await this.runOn(s, text);
      if (r.status !== 'finished') return { error: { code: 'CAPABILITY_ERROR', message: `agent ${name} 的任务 ${r.status}`, retryable: false } };
      let receipt: { root: string; sig: { scheme: string; keyId: string; value: string } };
      try { const rc = s.host.k.taskReceipt(r.taskId); receipt = { root: rc.root, sig: rc.sig as any }; } catch { receipt = { root: '', sig: { scheme: '', keyId: '', value: '' } }; }
      const u = (r.usage as any) ?? {}; const report = typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? null);
      return { output: { report } as any, usage: { calls: Number(u.calls ?? 0), inputTokens: Number(u.inputTokens ?? 0), outputTokens: Number(u.outputTokens ?? 0) }, receipt, taskId: r.taskId };
    } });
    const router = this;
    return new Proxy({}, {
      get(_t, k) { if (typeof k !== 'string' || k === self) return undefined; if (!router.agents.has(k)) return undefined; return mk(k); },
      has(_t, k) { return typeof k === 'string' && k !== self && router.agents.has(k); },
      ownKeys() { return router.names().filter(n => n !== self); },
      getOwnPropertyDescriptor(_t, k) { return typeof k === 'string' && k !== self && router.agents.has(k) ? { enumerable: true, configurable: true, value: mk(k) } : undefined; },
    }) as Record<string, ServeTarget>;
  }
}

export async function startDaemon(o: DaemonOptions): Promise<DaemonHandle> {
  const token = o.token ?? randomBytes(24).toString('hex');
  const home = path.join(os.homedir(), '.cak'); const pluginsDir = o.pluginsDir ?? path.join(home, 'plugins'); const registryDir = o.registryDir ?? path.join(home, 'registry');
  const buffer: Array<{ seq: number; type: string; agent?: string; taskId?: string; payload: unknown; ts: string }> = []; const subs = new Map<http.ServerResponse, string | undefined>(); let daemonSeq = 0;
  const publish = (ev: { seq?: number; type: string; agent?: string; taskId?: string; payload: unknown }) => {
    const rec = { seq: ev.seq ?? ++daemonSeq + 1_000_000_000, type: ev.type, agent: ev.agent, taskId: ev.taskId, payload: ev.payload, ts: new Date().toISOString() };
    buffer.push(rec); if (buffer.length > 5000) buffer.splice(0, buffer.length - 5000);
    const line = `id: ${rec.seq}\nevent: ${rec.type}\ndata: ${JSON.stringify(rec)}\n\n`;
    for (const [r, want] of subs) { if (want && rec.agent && want !== rec.agent) continue; try { r.write(line); } catch { subs.delete(r); } }
  };
  const agents = new Map<string, AgentSlot>(); let defaultAgent: string | undefined;
  const addAgent = (host: Host) => {
    const name = host.agentName; if (agents.has(name)) throw new Error(`agent ${name} already loaded`);
    const observer: Observer = { id: 'daemon-stream:' + name, onEvent(e: LedgerEventView) {
      publish({ seq: e.seq, type: e.type, agent: name, taskId: e.taskId, payload: e.payload });
      // 跨进程审查方（--reviewer）的回执：拿对方账本事件重算 Merkle 根 + 验签，结果作为 daemon.note 广播（老 cli.ts 路径打 ✔ 回执已验；daemon 路径之前没人验——dev 测试员抓到）
      const out = (e.payload as any)?.output; if (e.type === 'invocation.executed' && out && typeof out === 'object' && out.receipt?.root && out.receipt?.sig && host.reviewerUrl) {
        void host.verifyReviewReceipt({ root: out.receipt.root, sig: out.receipt.sig, taskId: out.receipt.taskId }).then(v => publish({ type: 'daemon.note', agent: name, taskId: e.taskId, payload: { level: v.ok ? 'info' : 'error', message: `${v.ok ? '✔ 回执已验' : '✗ 回执验证失败'}：审查方 task ${out.receipt.taskId}，${v.events} 事件`, receipt: { ok: v.ok, taskId: out.receipt.taskId, root: out.receipt.root } } })).catch(err => publish({ type: 'daemon.note', agent: name, taskId: e.taskId, payload: { level: 'error', message: `回执验证出错：${(err as Error).message}` } }));
      }
    } };
    host.k.ledger.subscribe(observer);
    agents.set(name, { name, host, tasks: new Map(), queue: [], running: false, decided: new Set(), observer }); defaultAgent ??= name;
    publish({ type: 'daemon.agent.added', agent: name, payload: { ...host.status(), agent: name } });
  };
  for (const h of [...(o.host ? [o.host] : []), ...(o.agents ?? [])]) addAgent(h);
  if (o.deltaSink) o.deltaSink.publish = e => { const a = [...agents.values()].find(s => Object.keys(s.host.k.ledger.projections().tasks).includes(e.taskId)); publish({ type: 'daemon.model.delta', agent: a?.name, taskId: e.taskId, payload: e }); };
  const slot = (p: any): AgentSlot => { const n = p?.agent ? String(p.agent) : defaultAgent; if (!n) throw new Error('这个内核里没有 agent（agents.add 挂一个，或 cak up --agent bare）'); const s = agents.get(n); if (!s) throw new Error(`unknown agent ${n}（在跑：${[...agents.keys()].join(', ') || '无'}）`); return s; };
  const pump = async (s: AgentSlot) => {
    if (s.running) return; s.running = true;
    while (s.queue.length) {
      const item = s.queue.shift()!; const text = item.text;
      try {
        // 任务开始前先看插件目录有没有变（命令行 cak add 装的新插件/新契约要在这一轮就能用，而不是下一轮）
        if (await s.host.recomposeIfNeeded()) { s.host.k.ledger.subscribe(s.observer); publish({ type: 'daemon.plugins.reloaded', agent: s.name, payload: { agent: s.name, plugins: s.host.installed.map(p => p.id) } }); }
        const startedAt = new Date().toISOString(); s.current = { input: text, startedAt };
        // 普通输入 = 新任务；resumeTaskId = 续跑一个重启前挂起的任务（审批刚被批/拒）
        let res = item.resumeTaskId ? await s.host.resume(item.resumeTaskId) : await s.host.submit(text); s.current.taskId = res.taskId; s.tasks.set(res.taskId, { input: text, status: res.status, startedAt: s.tasks.get(res.taskId)?.startedAt ?? startedAt });
        while (res.status === 'suspended') {
          const pend = s.host.pending(res.taskId); if (!pend.length) break;
          publish({ type: 'daemon.approval.needed', agent: s.name, taskId: res.taskId, payload: { agent: s.name, taskId: res.taskId, pending: pend } });
          while (pend.some(p => !s.decided.has(p.approvalId))) await new Promise(r => setTimeout(r, 150));
          res = await s.host.resume(res.taskId);
        }
        const answer = typeof res.output === 'string' ? res.output : JSON.stringify(res.output ?? res.status); s.host.recordAnswer(answer);
        const usage = s.host.usageOf(res.taskId); s.tasks.set(res.taskId, { input: text, status: res.status, output: res.output, startedAt: s.tasks.get(res.taskId)!.startedAt, finishedAt: new Date().toISOString() });
        publish({ type: 'daemon.task.result', agent: s.name, taskId: res.taskId, payload: { agent: s.name, taskId: res.taskId, status: res.status, output: res.output, usage } });
        item.done?.({ taskId: res.taskId, status: res.status, output: res.output, usage });
        if (await s.host.recomposeIfNeeded()) { s.host.k.ledger.subscribe(s.observer); publish({ type: 'daemon.plugins.reloaded', agent: s.name, payload: { agent: s.name, plugins: s.host.installed.map(p => p.id) } }); }
      } catch (e) { publish({ type: 'daemon.note', agent: s.name, payload: { level: 'error', message: (e as Error).message } }); item.fail?.(e as Error); }
      finally { s.current = undefined; }
    }
    s.running = false;
  };
  /** 重启前挂起的任务（账本里 suspended、待批）：登记到任务表 + 把它们的审批重新广播，让前端能看到、能批；批/拒之后由 session.decide 排队续跑（dev 测试员抓到的"僵尸审批"） */
  const adoptOrphans = (s: AgentSlot) => {
    const pend = s.host.pending(); const byTask = new Map<string, typeof pend>(); for (const p of pend) { const t = (s.host.k.ledger.projections().invocations[p.invocationId]?.taskId) ?? ''; if (!byTask.has(t)) byTask.set(t, []); byTask.get(t)!.push(p); }
    for (const [taskId, ps] of byTask) { if (!taskId || s.tasks.has(taskId)) continue; const rec = s.host.k.ledger.projections().tasks[taskId]; const input = typeof rec?.input === 'string' ? rec.input : JSON.stringify(rec?.input ?? ''); s.tasks.set(taskId, { input, status: 'suspended', startedAt: new Date().toISOString() }); publish({ type: 'daemon.approval.needed', agent: s.name, taskId, payload: { agent: s.name, taskId, pending: ps, resumed: true } }); }
    if (byTask.size) publish({ type: 'daemon.note', agent: s.name, payload: { level: 'warn', message: `有 ${byTask.size} 个重启前挂起的任务在等审批（批或拒后会续跑）` } });
  };
  for (const s of agents.values()) adoptOrphans(s);
  o.router?.attach(agents, (s, text) => new Promise((done, fail) => { s.queue.push({ text, done, fail }); void pump(s); }));
  /** 插件管理服务（不依赖模型）：装完让每个 agent 重组热加载 */
  const reloadAll = async () => { for (const s of agents.values()) { s.host.markPluginsChanged(); if (await s.host.recomposeIfNeeded()) { s.host.k.ledger.subscribe(s.observer); publish({ type: 'daemon.plugins.reloaded', agent: s.name, payload: { agent: s.name, plugins: s.host.installed.map(p => p.id) } }); } } };
  const installedList = () => fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir).flatMap(id => { try { const m = JSON.parse(fs.readFileSync(path.join(pluginsDir, id, 'manifest.json'), 'utf8')); return [{ id, version: m.version, roles: m.roles ?? ['capability'], tier: m.tier, contracts: (m.contracts ?? []).map((c: any) => c.name), installedAt: m.installedAt }]; } catch { return []; } }) : [];
  const methods: Record<string, (p: any) => unknown | Promise<unknown>> = {
    'kernel.status': () => ({ name: o.name ?? null, agents: [...agents.values()].map(s => ({ ...s.host.status(), name: s.name, running: s.running, queued: s.queue.length })), defaultAgent: defaultAgent ?? null, plugins: installedList().map(p => p.id), registry: fs.existsSync(path.join(registryDir, 'index.json')) }),
    'plugins.list': () => installedList(),
    'plugins.registry': () => { if (!fs.existsSync(path.join(registryDir, 'index.json'))) return { available: false, note: `no registry at ${registryDir}` }; return { available: true, plugins: new FileRegistry(registryDir).listPlugins().map((e: any) => ({ id: e.id, version: e.version, description: e.description, roles: e.roles ?? ['capability'], contracts: e.contracts.map((c: any) => c.name), installed: fs.existsSync(path.join(pluginsDir, e.id, 'manifest.json')), setup: e.setup })) }; },
    'plugins.search': (p) => { const q = String(p?.query ?? '').toLowerCase().split(/[\s,，、/]+/).filter(Boolean); const all = (methods['plugins.registry']!({}) as any).plugins ?? []; const score = (e: any) => q.reduce((n: number, w: string) => n + ([e.id, e.description ?? '', ...(e.contracts ?? [])].join(' ').toLowerCase().includes(w) ? 1 : 0), 0); return q.length ? all.map((e: any) => ({ e, s: score(e) })).filter((x: any) => x.s > 0).sort((a: any, b: any) => b.s - a.s).map((x: any) => x.e) : all; },
    'plugins.install': async (p) => { if (!fs.existsSync(path.join(registryDir, 'index.json'))) throw new Error(`no registry at ${registryDir}`); const r = await installPlugin(new FileRegistry(registryDir), String(p?.id), pluginsDir); if (r.installed) await reloadAll(); return { id: r.id, installed: r.installed, tier: r.tier, passed: r.report.passed, failed: r.report.failed, failedChecks: r.report.checks.filter(c => !c.ok).map(c => c.id) }; },
    'agents.list': () => ({ loaded: [...agents.values()].map(s => ({ ...s.host.status(), name: s.name, running: s.running })), profiles: listProfiles(), defaultAgent: defaultAgent ?? null }),
    'agents.add': async (p) => { if (!o.hostFactory) throw new Error('this kernel process cannot create agents (no hostFactory)'); const h = await o.hostFactory(String(p?.profile ?? 'bare'), { session: p?.session ? String(p.session) : undefined, workspace: p?.workspace ? String(p.workspace) : undefined }); addAgent(h); adoptOrphans(agents.get(h.agentName)!); writeInfo(); return { ...h.status(), agent: h.agentName }; },
    'agents.remove': async (p) => { const s = agents.get(String(p?.name)); if (!s) throw new Error(`unknown agent ${p?.name}`); await s.host.close(); agents.delete(s.name); if (defaultAgent === s.name) defaultAgent = [...agents.keys()][0]; publish({ type: 'daemon.agent.removed', agent: s.name, payload: { agent: s.name } }); writeInfo(); return { ok: true }; },
    'session.status': (p) => { const s = slot(p); return { ...s.host.status(), agent: s.name, running: s.running, queued: s.queue.length, tasks: s.tasks.size, ...(s.current ? { current: s.current } : {}) }; },
    'session.input': (p) => { const s = slot(p); if (typeof p?.text !== 'string') throw new Error('text must be a string'); const text = p.text.trim(); if (!text) throw new Error('text required'); s.queue.push({ text }); void pump(s); return { agent: s.name, queued: s.queue.length + (s.running ? 1 : 0) }; },
    'session.pending': (p) => slot(p).host.pending(p?.taskId ? String(p.taskId) : undefined),
    'session.decide': (p) => {
      const s = slot(p); const apId = String(p?.approvalId);
      const ap = s.host.pending().find(x => x.approvalId === apId); const taskId = ap ? s.host.k.ledger.projections().invocations[ap.invocationId]?.taskId : undefined;
      const r = s.host.decide(apId, p?.decision, p?.reason ? String(p.reason) : undefined); s.decided.add(apId);
      // 不是当前正在跑的任务（重启前挂起的孤儿）：这个任务的审批都有结论了就排队续跑
      // 注意：pending 投影要等 resume 后才清，所以用 decided 集判断「该任务的审批是否都有结论了」
      if (taskId && s.current?.taskId !== taskId && !s.queue.some(q => q.resumeTaskId === taskId) && s.host.pending(taskId).every(x => s.decided.has(x.approvalId))) { const rec = s.tasks.get(taskId); s.queue.push({ text: rec?.input ?? '', resumeTaskId: taskId }); void pump(s); }
      return r;
    },
    'session.handles': (p) => { const k = slot(p).host.k; const revoked = k.ledger.projections().revoked; return k.controlPlane().handles().map(h => ({ ...h, revoked: revoked[h.id] !== undefined })); },
    'session.revoke': (p) => { const k = slot(p).host.k; const id = String(p?.handleId); if (k.ledger.projections().revoked[id] !== undefined) return { ok: true, already: true }; k.controlPlane().revoke(id, 'frontend: 用户撤销'); return { ok: true }; },
    'session.report': (p) => { const r = slot(p).host.k.usageReport(); return { contracts: r.contracts, events: r.events }; },
    'session.tasks': (p) => [...(slot(p).current ? [{ taskId: slot(p).current!.taskId ?? null, input: slot(p).current!.input, status: 'running', startedAt: slot(p).current!.startedAt }] : []), ...[...slot(p).tasks.entries()].filter(([id]) => id !== slot(p).current?.taskId).map(([id, t]) => ({ taskId: id, ...t, output: typeof t.output === 'string' ? t.output.slice(0, 200) : t.output, ...(typeof t.output === 'string' && t.output.length > 200 ? { outputTruncated: true, outputChars: t.output.length } : {}) }))],   // 列表只给摘要；全文用 session.task {taskId}
    'session.task': (p) => { const t = slot(p).tasks.get(String(p?.taskId)); if (!t) throw new Error('unknown task'); return { taskId: p.taskId, ...t }; },
  };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authed = req.headers['x-cak-token'] === token || u.searchParams.get('token') === token;
    if (u.pathname === '/') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ cak: '1', daemon: 'cak-kernel', auth: authed, ...(authed ? { name: o.name ?? null, agents: [...agents.keys()] } : {}) })); }
    if (u.pathname === '/ui' && req.method === 'GET') { const f = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../cak-front/web/index.html'); if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('no web ui'); } res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store'); return res.end(fs.readFileSync(f)); }
    if (!authed) { res.statusCode = 401; return res.end('unauthorized'); }
    if (u.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.flushHeaders(); res.write(': connected\n\n');
      const since = Number(u.searchParams.get('since') ?? 0); const want = u.searchParams.get('agent') ?? undefined;
      for (const s of agents.values()) { if (want && want !== s.name) continue; for (const e of s.host.k.ledger.all().filter(x => x.seq > since)) res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify({ seq: e.seq, type: e.type, agent: s.name, taskId: e.taskId, payload: e.payload, ts: e.ts })}\n\n`); }
      for (const b of buffer.filter(x => x.seq > 1_000_000_000 && x.seq > since && (!want || !x.agent || x.agent === want))) res.write(`id: ${b.seq}\nevent: ${b.type}\ndata: ${JSON.stringify(b)}\n\n`);
      subs.set(res, want); req.on('close', () => subs.delete(res)); return;
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
  let infoFile: string | undefined; const name = o.name ?? defaultAgent ?? 'kernel';
  function writeInfo() { if (o.writeInfoFile === false) return; const dir = path.join(home, 'daemon'); fs.mkdirSync(dir, { recursive: true }); infoFile = path.join(dir, name + '.json'); fs.writeFileSync(infoFile, JSON.stringify({ url, token, pid: process.pid, session: name, name, agents: [...agents.keys()], defaultAgent: defaultAgent ?? null, workspace: defaultAgent ? agents.get(defaultAgent)!.host.workspace : null, startedAt: new Date().toISOString() }, null, 1), { mode: 0o600 }); }
  writeInfo();
  return { url, token, port, infoFile, addAgent: (h: Host) => { addAgent(h); writeInfo(); }, close: async () => { for (const [s] of subs) { try { s.end(); } catch { /* */ } } await new Promise<void>(r => server.close(() => r())); if (infoFile) fs.rmSync(infoFile, { force: true }); } };
}

/** 读某个内核进程的连接信息（前端用）：~/.cak/daemon/<name>.json；不给就取最新的一个 */
export function findDaemon(name?: string): { url: string; token: string; session: string; name?: string; agents?: string[]; defaultAgent?: string | null; workspace: string | null; pid: number } | undefined {
  const dir = path.join(os.homedir(), '.cak', 'daemon'); if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const load = (f: string) => { try { const info = JSON.parse(fs.readFileSync(f, 'utf8')); process.kill(info.pid, 0); return info; } catch { fs.rmSync(f, { force: true }); return undefined; } };   // 死进程的 json 顺手清掉
  if (name) { const f = files.find(x => path.basename(x, '.json') === name); return f ? load(f) : undefined; }
  // 没指定名字：先找"工作区 = 当前目录"的内核；一个就它；多个 → 报错让人指定；一个都没有 → 退回最近的那个（老行为）
  const alive = files.map(load).filter(Boolean) as any[]; const cwd = process.cwd();
  const real = (x: string) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  const here = alive.filter(i => i.workspace && real(i.workspace) === real(cwd));
  if (here.length === 1) return here[0]; if (here.length > 1) throw new Error(`当前目录有 ${here.length} 个在跑的内核（${here.map(i => i.session).join(', ')}），用 --session <名字> 指定`);
  return alive[0];
}

// ---- 作为程序运行 ----
const isMain = process.argv[1] && /daemon\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2); const flag = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; }; const has = (n: string) => argv.includes('--' + n);
  const mcpExtra = argv.map((a, i) => a === '--mcp' ? argv[i + 1] : undefined).filter((x): x is string => !!x).map(parseMcpFlag).filter((x): x is NonNullable<typeof x> => !!x);
  const sink: { publish?: (e: { taskId: string; invocationId: string; text: string }) => void } = {};
  const baseOpts = (): Omit<HostOptions, 'agent' | 'session'> => ({ workspace: flag('workspace') ?? '.', backend: flag('backend') as any, model: flag('model'), reviewerUrl: flag('reviewer'), pluginsDir: has('no-plugins') ? null : flag('plugins-dir'), mcp: has('no-mcp') ? null : { extra: mcpExtra }, registryDir: has('no-registry') ? null : flag('registry'), note: (lvl, msg) => console.error(`  ${lvl}: ${msg}`), onModelDelta: e => sink.publish?.(e) });
  const name = flag('name') ?? flag('session') ?? path.basename(path.resolve(flag('workspace') ?? '.'));
  const router = new SiblingRouter();   // N-51：同进程 agent 互相委派（agent.invoke → agent.task）
  const hostFactory = (profile: string, o2?: { session?: string; workspace?: string }) => createHost({ ...baseOpts(), ...(o2?.workspace ? { workspace: o2.workspace } : {}), agent: profile, session: o2?.session ?? `${name}.${profile}`, agentTargets: router.targetsFor(profile) });
  ensureProfiles();
  const registryDir = has('no-registry') ? undefined : path.resolve(flag('registry') ?? path.join(os.homedir(), '.cak', 'registry')); if (registryDir && !flag('registry')) await ensureRegistry(registryDir, DEFAULT_REGISTRY_URL);
  const wantedAgents = argv.flatMap((a, i) => a === '--agent' ? [argv[i + 1]!] : []); const wanted = has('no-agent') ? [] : (wantedAgents.length ? wantedAgents : ['bare']);
  { const f = path.join(os.homedir(), '.cak', 'daemon', name + '.json'); if (fs.existsSync(f)) { let j: any; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { j = undefined; } let alive = false; if (j?.pid) { try { process.kill(j.pid, 0); alive = true; } catch { alive = false; } } if (alive) { console.error(`已有同名内核在跑：${name}（pid ${j.pid}，工作区 ${j.workspace ?? '纯内核'}）。连它：cak front --session ${name}；停它：cak stop --session ${name}；或换个 --name。`); process.exit(2); } } }
  const hosts: Host[] = []; for (const p of wanted) hosts.push(await hostFactory(p));
  const d = await startDaemon({ agents: hosts, name, port: Number(flag('port') ?? 0), deltaSink: sink, hostFactory, router, registryDir, pluginsDir: has('no-plugins') ? undefined : flag('plugins-dir') });
  console.log(`cak 内核 · ${name} · agent ${hosts.map(h => h.agentName).join(', ') || '（无，纯内核）'}${flag('reviewer') ? ` · 审查方 ${flag('reviewer')}` : ''}\n  控制面 ${d.url}（token 只在 ${d.infoFile}，0600）\n  界面：cak front --session ${name}   · 网页：cak front web --session ${name}   · 挂 agent：cak agent add <profile> --session ${name}\n  停：Ctrl-C，或在别处 cak stop --session ${name}`);
  const bye = async () => { await d.close(); for (const h of hosts) await h.close(); process.exit(0); }; process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
