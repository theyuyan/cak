/** 前端 SDK（任何前端共用）：连 daemon、调控制面、订阅事件流。只做"看和点"，拿不到能力。 */
import http from 'node:http'; import fs from 'node:fs';
export interface DaemonInfo { url: string; token: string; session?: string; workspace?: string | null; agent?: string }
export class DaemonClient {
  private nextId = 1;
  constructor(readonly info: DaemonInfo) {}
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const p = this.info.agent && params['agent'] === undefined ? { agent: this.info.agent, ...params } : params;
    const r = await fetch(this.info.url + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cak-token': this.info.token }, body: JSON.stringify({ cak: '1', jsonrpc: '2.0', id: this.nextId++, method, params: p }) });
    if (r.status === 401) throw new Error('unauthorized: token 不对（daemon 重启过？重新读 ~/.cak/daemon/<session>.json）');
    const j: any = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result as T;
  }
  /** SSE 订阅：since 之后的事件回放 + 实时；返回关闭函数 */
  events(onEvent: (e: { seq: number; type: string; taskId?: string; payload: any; ts: string }) => void, since = 0): () => void {
    const u = new URL(this.info.url + '/events'); u.searchParams.set('since', String(since)); u.searchParams.set('token', this.info.token); if (this.info.agent) u.searchParams.set('agent', this.info.agent);
    const dbg = process.env['CAK_TUI_DEBUG']; const log = (m: string) => { if (dbg) { try { fs.appendFileSync(dbg, m + '\n'); } catch { /* */ } } };
    log('events: connecting ' + u.toString().replace(/token=[^&]+/, 'token=…'));
    const req = http.get(u, res => { log('events: status ' + res.statusCode); let buf = ''; res.setEncoding('utf8'); res.on('data', (c: string) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const data = block.split('\n').find(l => l.startsWith('data: ')); if (data) { try { onEvent(JSON.parse(data.slice(6))); } catch { /* ignore */ } } } }); });
    req.on('error', e => log('events: error ' + e.message)); return () => { log('events: stop'); req.destroy(); };
  }
}

// ---- 给人看的文案（tty / TUI 共用；网页 index.html 里有同一份 JS 版） ----
/** caveat → 中文短语 */
export function humanCaveat(c: any): string {
  switch (c?.kind) {
    case 'requires-approval': return '需审批';
    case 'args.match': return '参数受限';
    case 'args.prefix': return `${c.path === 'url' ? '地址' : c.path === 'path' ? '路径' : c.path}以「${c.prefix}」开头`;
    case 'args.max': return `${c.path}≤${c.max}`;
    case 'budget': return '预算';
    case 'once': return '一次性';
    case 'time.window': return c.notAfter ? `到期 ${String(c.notAfter).slice(11, 16)}` : '限时';
    case 'no-delegate': return '不可委派';
    case 'provider': return `指定实现 ${c.providerId}`;
    case 'agent': return `限 agent ${c.name ?? c.agent ?? ''}`.trim();
    case 'custom': return c.name ? `自定义 ${c.name}` : '自定义';
    default: return String(c?.kind ?? '');
  }
}
/** 一条句柄 → 一行：id  契约  限制  到期  已撤销 */
export function humanHandle(h: any): string {
  const cav = (h.caveats ?? []).map(humanCaveat).filter(Boolean).join('；') || '无限制';
  return `${h.id}  ${h.contract?.name ?? '?'}  ${cav}${h.expiresAt ? '  到期 ' + String(h.expiresAt).slice(11, 16) : ''}${h.revoked ? '  已撤销' : ''}`;
}
/** session.status → 分行人话（不给绝对路径、不给整坨 JSON） */
export function humanStatus(s: any): string[] {
  const ws = typeof s.workspace === 'string' ? s.workspace.split('/').filter(Boolean).slice(-2).join('/') || s.workspace : '（无）';
  return [
    `会话  ${s.session ?? '?'}`,
    `agent  ${s.agent ?? '?'}${s.running ? `（在跑${s.current?.input ? '：' + String(s.current.input).slice(0, 40) : ''}${s.queued ? `，排队 ${s.queued}` : ''}）` : '（空闲）'}`,
    `工作区  ${ws}`,
    `模型  ${s.backend ?? '?'}/${s.model ?? '?'}`,
    `插件  ${(s.plugins ?? []).length} 个${(s.mcp ?? []).length ? ` · MCP ${s.mcp.length} 个` : ''}`,
    `常设句柄  ${s.standingHandles ?? 0}`,
    `账本 seq  ${s.ledgerSeq ?? '?'}`,
  ];
}
/** 任务尾行：完成 · 3 次调用 · 令牌 1.2k/300 · 缓存 97% */
export function humanTail(status: string, u: any): string {
  const st = status === 'finished' ? '完成' : status === 'failed' ? '失败' : status === 'cancelled' ? '已取消' : status === 'timeout' ? '超时' : status === 'suspended' ? '挂起' : String(status);
  return `· ${st}${u ? ` · ${u.calls} 次调用 · 令牌 ${(Number(u.inputTokens) / 1000).toFixed(1)}k/${u.outputTokens}${u.cachedInputTokens ? ` · 缓存 ${u.cacheHitPct}%` : ''}` : ''}`;
}
/** invocation.denied 的人话：审批拒绝 → 「已拒绝（你）」/「已拒绝（<来源>）」；其他拒绝 → 原因（不带内部码） */
export function humanDenied(p: any, mine: boolean): string {
  const reason = String(p?.reason ?? '');
  if (p?.code === 'APPROVAL_INVALID' && /^审批被拒绝/.test(reason)) { if (mine) return '已拒绝（你）'; const src = reason.replace(/^审批被拒绝[:：]\s*/, '').trim(); return `已拒绝（${src || '别处'}）`; }
  return `✗ 被拒绝：${reason || p?.code || ''}`;
}
/** 连接失败 → 人话 */
export function humanConnError(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (/unauthorized|401/i.test(m)) return '连不上：网址里的 token 不对（内核重启过？重新 cak front web 拿新网址）';
  if (/ECONNREFUSED|fetch failed|Failed to fetch|NetworkError/i.test(m)) return '连不上：内核没在跑（cak up 起一个）';
  return '连不上：' + m.replace(/^[a-z.]+: /, '');
}
