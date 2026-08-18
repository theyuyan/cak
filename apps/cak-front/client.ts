/** 前端 SDK（任何前端共用）：连 daemon、调控制面、订阅事件流。只做"看和点"，拿不到能力。 */
import http from 'node:http';
export interface DaemonInfo { url: string; token: string; session?: string; workspace?: string }
export class DaemonClient {
  private nextId = 1;
  constructor(readonly info: DaemonInfo) {}
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const r = await fetch(this.info.url + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cak-token': this.info.token }, body: JSON.stringify({ cak: '1', jsonrpc: '2.0', id: this.nextId++, method, params }) });
    if (r.status === 401) throw new Error('unauthorized: token 不对（daemon 重启过？重新读 ~/.cak/daemon/<session>.json）');
    const j: any = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result as T;
  }
  /** SSE 订阅：since 之后的事件回放 + 实时；返回关闭函数 */
  events(onEvent: (e: { seq: number; type: string; taskId?: string; payload: any; ts: string }) => void, since = 0): () => void {
    const u = new URL(this.info.url + '/events'); u.searchParams.set('since', String(since)); u.searchParams.set('token', this.info.token);
    const req = http.get(u, res => { let buf = ''; res.setEncoding('utf8'); res.on('data', (c: string) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const data = block.split('\n').find(l => l.startsWith('data: ')); if (data) { try { onEvent(JSON.parse(data.slice(6))); } catch { /* ignore */ } } } }); });
    req.on('error', () => {}); return () => req.destroy();
  }
}
