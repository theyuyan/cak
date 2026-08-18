/**
 * 真后端 #2：OpenAI 兼容 Chat Completions（DeepSeek / OpenAI / 多数网关）。ModelBackend 角色：只推理。
 * - key 通过 secretRef 解析：`env:NAME` / `file:/path`（默认 env:OPENAI_API_KEY）；不进日志 / 账本 / 回复。
 * - tools → function 定义（name = handleId）；tool_calls → toolCalls{name=handleId, args=JSON.parse(arguments)}。
 * - 我方 Controller 用 tool 角色回喂历史（无配对的 assistant tool_calls 消息），因此把 tool 消息渲染成 user 文本，避免 API 拒绝。
 */
import fs from 'node:fs';
import type { ModelBackend, BackendRequest, BackendResult, ProviderCallContext, ContextMessage } from '../../sdk/types.js';

export interface OpenAICompatOptions { baseUrl: string; model?: string; apiKeyRef?: string; fetch?: typeof fetch; maxTokens?: number; extraHeaders?: Record<string, string> }
export function resolveSecretRef(ref: string): string | undefined {
  if (ref.startsWith('file:')) { const p = ref.slice(5).replace(/^~/, process.env['HOME'] ?? ''); try { return fs.readFileSync(p, 'utf8').trim(); } catch { return undefined; } }
  if (ref.startsWith('env:')) return process.env[ref.slice(4)];
  return process.env[ref];
}
export class OpenAICompatBackend implements ModelBackend {
  readonly id: string; private f: typeof fetch;
  constructor(id: string, private opts: OpenAICompatOptions) { this.id = id; this.f = opts.fetch ?? fetch; }
  async generate(req: BackendRequest, _ctx: ProviderCallContext): Promise<BackendResult> {
    const key = resolveSecretRef(this.opts.apiKeyRef ?? 'env:OPENAI_API_KEY'); if (!key) return { callId: req.callId, finishReason: 'error', content: `secretRef ${this.opts.apiKeyRef ?? 'env:OPENAI_API_KEY'} unresolved` };
    const messages = req.messages.map(m => toOpenAI(m));
    const body: any = { model: req.model || this.opts.model || 'gpt-4o-mini', messages, max_tokens: (req.params as any)?.maxOutputTokens ?? this.opts.maxTokens ?? 1024 };
    if (req.tools?.length) { body.tools = req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema } })); body.tool_choice = 'auto'; }
    if ((req.params as any)?.temperature !== undefined) body.temperature = (req.params as any).temperature;
    const ctrl = new AbortController(); const t = req.deadlineAtMs ? setTimeout(() => ctrl.abort(), Math.max(1, req.deadlineAtMs - Date.now())) : undefined;
    try {
      const res = await this.f(this.opts.baseUrl.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(this.opts.extraHeaders ?? {}) }, body: JSON.stringify(body), signal: ctrl.signal });
      const data: any = await res.json();
      if (!res.ok) return { callId: req.callId, finishReason: 'error', content: `${this.id} ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 200)}` };
      const choice = data.choices?.[0]; const msg = choice?.message ?? {};
      const toolCalls = (msg.tool_calls ?? []).map((tc: any) => { let args = {}; try { args = JSON.parse(tc.function?.arguments ?? '{}'); } catch { args = { _raw: tc.function?.arguments }; } return { id: tc.id, name: tc.function?.name, args }; });
      const finish = toolCalls.length ? 'tool_calls' : choice?.finish_reason === 'length' ? 'length' : choice?.finish_reason === 'content_filter' ? 'content_filter' : 'stop';
      return { callId: req.callId, finishReason: finish, ...(msg.content ? { content: msg.content } : {}), ...(toolCalls.length ? { toolCalls } : {}), usage: { units: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 } }, raw: { model: data.model, finish_reason: choice?.finish_reason } };
    } catch (e) { return { callId: req.callId, finishReason: 'error', content: `${this.id} transport: ${e instanceof Error ? e.message : String(e)}` }; }
    finally { if (t) clearTimeout(t); }
  }
}
function toOpenAI(m: ContextMessage): { role: 'system' | 'user' | 'assistant'; content: string } {
  const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  if (m.role === 'tool') return { role: 'user', content: `[工具结果 ${m.toolCallId ?? ''}] ${text}` };
  return { role: m.role, content: text };
}
