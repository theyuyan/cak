/**
 * @cak/sdk · 传输协议（09 §C，M3）：JSON-RPC 2.0 over NDJSON（stdio），信封 { cak:"1", jsonrpc:"2.0", ... }。
 * 未知 cak 版本 → -32600；未知 method → -32601（显式，不静默）。
 * 本文件是插件端与内核端共用的纯协议工具（无内核依赖）。
 */
import type { Json, JsonObject } from './types.js';

export const CAK_ENVELOPE_VERSION = '1';
export interface Envelope { cak: '1'; jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: JsonObject; result?: Json; error?: { code: number; message: string; data?: JsonObject } }
export const RPC = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, CANCELLED: -32800 } as const;

export const METHODS = ['plugin.hello', 'plugin.health', 'plugin.shutdown', 'capability.execute', 'model.generate', 'context.contribute', 'interceptor.intercept', 'cancel', 'event.publish',
  // N-48（只增）：控制器跑子进程——内核→插件 controller.decide{decideId, view, config}；决策期间插件→内核反向请求 ctx.*{decideId,…}
  'controller.decide', 'ctx.invoke', 'ctx.compose', 'ctx.preview', 'ctx.attenuate', 'ctx.spawn'] as const;
export type Method = typeof METHODS[number];

export const encode = (e: Envelope) => JSON.stringify(e) + '\n';
export function decode(line: string): Envelope | { error: { code: number; message: string }; id?: number | string | null } {
  let o: any; try { o = JSON.parse(line); } catch { return { error: { code: RPC.PARSE, message: 'parse error' } }; }
  if (!o || typeof o !== 'object') return { error: { code: RPC.INVALID_REQUEST, message: 'not an object' } };
  const id = typeof o.id === 'number' || typeof o.id === 'string' ? o.id : null;
  if (o.cak !== CAK_ENVELOPE_VERSION) return { error: { code: RPC.INVALID_REQUEST, message: `unsupported envelope version ${String(o.cak)} (expected ${CAK_ENVELOPE_VERSION})` }, id };
  if (o.jsonrpc !== '2.0') return { error: { code: RPC.INVALID_REQUEST, message: 'jsonrpc must be 2.0' }, id };
  return o as Envelope;
}
export const request = (id: number | string, method: Method, params: JsonObject): Envelope => ({ cak: '1', jsonrpc: '2.0', id, method, params });
export const response = (id: number | string | null, result: Json): Envelope => ({ cak: '1', jsonrpc: '2.0', id, result });
export const failure = (id: number | string | null, code: number, message: string, data?: JsonObject): Envelope => ({ cak: '1', jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

/** 按行切分的流式解析器（stdin 可能一次给半行 / 多行） */
export class LineSplitter {
  private buf = '';
  push(chunk: string, onLine: (line: string) => void) { this.buf += chunk; let i; while ((i = this.buf.indexOf('\n')) >= 0) { const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (line) onLine(line); } }
}
