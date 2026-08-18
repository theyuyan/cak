/**
 * 真后端 #2：OpenAI 兼容 Chat Completions（DeepSeek / OpenAI / 多数网关）。ModelBackend 角色：只推理。
 * - key 通过 secretRef 解析：`env:NAME` / `file:/path`（默认 env:OPENAI_API_KEY）；不进日志 / 账本 / 回复。
 * - tools → function 定义（name = handleId）；tool_calls → toolCalls{name=handleId, args=JSON.parse(arguments)}。
 * - 我方 Controller 用 tool 角色回喂历史（无配对的 assistant tool_calls 消息），因此把 tool 消息渲染成 user 文本，避免 API 拒绝。
 */
import fs from 'node:fs'; import os from 'node:os';
import type { ModelBackend, BackendRequest, BackendResult, ProviderCallContext, ContextMessage } from '../../sdk/types.js';

export interface OpenAICompatOptions { baseUrl: string; model?: string; apiKeyRef?: string; fetch?: typeof fetch; maxTokens?: number; extraHeaders?: Record<string, string> }
export function resolveSecretRef(ref: string): string | undefined {
  if (ref.startsWith('file:')) { const p = ref.slice(5).replace(/^~/, os.homedir()); try { return fs.readFileSync(p, 'utf8').trim(); } catch { return undefined; } }
  if (ref.startsWith('env:')) return process.env[ref.slice(4)];
  return process.env[ref];
}
export class OpenAICompatBackend implements ModelBackend {
  readonly id: string; private f: typeof fetch;
  constructor(id: string, private opts: OpenAICompatOptions) { this.id = id; this.f = opts.fetch ?? fetch; }
  async generate(req: BackendRequest, _ctx: ProviderCallContext): Promise<BackendResult> {
    const key = resolveSecretRef(this.opts.apiKeyRef ?? 'env:OPENAI_API_KEY'); if (!key) return { callId: req.callId, finishReason: 'error', content: `secretRef ${this.opts.apiKeyRef ?? 'env:OPENAI_API_KEY'} unresolved` };
    const messages = toOpenAIThread(req.messages);
    const body: any = { model: req.model || this.opts.model || 'gpt-4o-mini', messages, max_tokens: (req.params as any)?.maxOutputTokens ?? this.opts.maxTokens ?? 1024 };
    if (req.tools?.length) { body.tools = req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema } })); body.tool_choice = 'auto'; }
    if ((req.params as any)?.temperature !== undefined) body.temperature = (req.params as any).temperature;
    const ctrl = new AbortController(); const t = req.deadlineAtMs ? setTimeout(() => ctrl.abort(), Math.max(1, req.deadlineAtMs - Date.now())) : undefined;
    try {
      // 流式（N-44）：请求方给了 onDelta 就用 SSE，边收边回调正文；最终结果与非流式同形（工具调用按 index 拼参数，usage 取末尾 chunk）
      if (req.onDelta) { body.stream = true; body.stream_options = { include_usage: true }; }
      const res = await this.f(this.opts.baseUrl.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(this.opts.extraHeaders ?? {}) }, body: JSON.stringify(body), signal: ctrl.signal });
      const data: any = req.onDelta && res.ok && res.body ? await readSse(res, req.onDelta) : await res.json();
      if (!res.ok) return { callId: req.callId, finishReason: 'error', content: `${this.id} ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 200)}` };
      const choice = data.choices?.[0]; const msg = choice?.message ?? {};
      const toolCalls = (msg.tool_calls ?? []).map((tc: any) => { let args = {}; try { args = JSON.parse(tc.function?.arguments ?? '{}'); } catch { args = { _raw: tc.function?.arguments }; } return { id: tc.id, name: tc.function?.name, args }; });
      const finish = toolCalls.length ? 'tool_calls' : choice?.finish_reason === 'length' ? 'length' : choice?.finish_reason === 'content_filter' ? 'content_filter' : 'stop';
      return { callId: req.callId, finishReason: finish, ...(msg.content ? { content: msg.content } : {}), ...(toolCalls.length ? { toolCalls } : {}), usage: { units: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, ...(cacheUnits(data.usage)) } }, raw: { model: data.model, finish_reason: choice?.finish_reason } };
    } catch (e) { return { callId: req.callId, finishReason: 'error', content: `${this.id} transport: ${e instanceof Error ? e.message : String(e)}` }; }
    finally { if (t) clearTimeout(t); }
  }
}
/** 正规线程：assistant 带 tool_calls，随后的 tool 消息用 tool_call_id 配对；没有配对的 tool 结果退化成 user 文本（API 会拒未配对的 tool 消息） */
function toOpenAIThread(msgs: ContextMessage[]): any[] {
  const out: any[] = []; const openIds = new Set<string>();
  for (const m of msgs) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (m.role === 'assistant' && m.toolCalls?.length) { out.push({ role: 'assistant', content: text || null, tool_calls: m.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) }); for (const tc of m.toolCalls) openIds.add(tc.id); continue; }
    if (m.role === 'tool') { if (m.toolCallId && openIds.has(m.toolCallId)) { out.push({ role: 'tool', tool_call_id: m.toolCallId, content: text }); openIds.delete(m.toolCallId); } else out.push({ role: 'user', content: `[工具结果 ${m.toolCallId ?? ''}] ${text}` }); continue; }
    out.push({ role: m.role, content: text });
  }
  return out;
}

/** prompt 缓存命中：DeepSeek 给 prompt_cache_hit_tokens / prompt_cache_miss_tokens，OpenAI 给 prompt_tokens_details.cached_tokens；放进 units.custom（不动接口） */
function cacheUnits(u: any): { custom?: Record<string, number> } {
  if (!u) return {};
  const cached = typeof u.prompt_cache_hit_tokens === 'number' ? u.prompt_cache_hit_tokens : typeof u.prompt_tokens_details?.cached_tokens === 'number' ? u.prompt_tokens_details.cached_tokens : undefined;
  if (cached === undefined) return {};
  return { custom: { cachedInputTokens: cached, uncachedInputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached) } };
}


/** 把 OpenAI 风格 SSE 流折叠成与非流式相同的 JSON（choices[0].message + usage）；每个正文增量回调 onDelta */
export async function readSse(res: Response, onDelta: (d: { text: string }) => void): Promise<any> {
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''; let content = ''; let finish: string | undefined; let usage: any; let model: string | undefined;
  const calls = new Map<number, { id?: string; name?: string; args: string }>();
  const feed = (line: string) => {
    if (!line.startsWith('data:')) return; const payload = line.slice(5).trim(); if (!payload || payload === '[DONE]') return;
    let j: any; try { j = JSON.parse(payload); } catch { return; }
    if (j.usage) usage = j.usage; if (j.model) model = j.model;
    const ch = j.choices?.[0]; if (!ch) return; const d = ch.delta ?? {};
    if (typeof d.content === 'string' && d.content) { content += d.content; onDelta({ text: d.content }); }
    for (const tc of d.tool_calls ?? []) { const i = Number(tc.index ?? 0); const cur = calls.get(i) ?? { args: '' }; if (tc.id) cur.id = tc.id; if (tc.function?.name) cur.name = tc.function.name; if (tc.function?.arguments) cur.args += tc.function.arguments; calls.set(i, cur); }
    if (ch.finish_reason) finish = ch.finish_reason;
  };
  for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n')) >= 0) { feed(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } }
  if (buf.trim()) feed(buf.trim());
  const tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }));
  return { model, choices: [{ finish_reason: finish ?? (tool_calls.length ? 'tool_calls' : 'stop'), message: { role: 'assistant', ...(content ? { content } : {}), ...(tool_calls.length ? { tool_calls } : {}) } }], usage };
}
