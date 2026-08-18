/**
 * 真后端 #1：Anthropic Messages API（fetch，无 SDK 依赖）。ModelBackend 角色：只推理。
 * - API key 通过 secretRef 解析（默认读环境变量 ANTHROPIC_API_KEY），不进任何日志 / 账本。
 * - 工具：BackendRequest.tools（name = handleId）→ Anthropic tools；tool_use 块 → toolCalls{name=handleId}。
 * - 未做真实网络测试（要花钱）：tests 里用注入的 fetch 替身验证请求/响应映射；接真 key 时用 --backend anthropic。
 */
import type { ModelBackend, BackendRequest, BackendResult, ProviderCallContext, ContextMessage, Json } from '../../sdk/types.js';

export interface AnthropicBackendOptions { model?: string; apiKeyRef?: string; baseUrl?: string; fetch?: typeof fetch; resolveSecret?: (ref: string) => string | undefined; maxTokens?: number }
export class AnthropicBackend implements ModelBackend {
  readonly id = 'anthropic';
  private f: typeof fetch; private resolve: (ref: string) => string | undefined;
  constructor(private opts: AnthropicBackendOptions = {}) { this.f = opts.fetch ?? fetch; this.resolve = opts.resolveSecret ?? (ref => process.env[ref]); }
  async generate(req: BackendRequest, ctx: ProviderCallContext): Promise<BackendResult> {
    const key = this.resolve(this.opts.apiKeyRef ?? 'ANTHROPIC_API_KEY'); if (!key) return { callId: req.callId, finishReason: 'error', content: 'ANTHROPIC_API_KEY not set (secretRef unresolved)' };
    const system = req.messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n\n');
    const messages = req.messages.filter(m => m.role !== 'system').map(m => toAnthropic(m));
    const body: any = { model: req.model || this.opts.model || 'claude-sonnet-5', max_tokens: (req.params as any)?.maxOutputTokens ?? this.opts.maxTokens ?? 1024, ...(system ? { system } : {}), messages: mergeRoles(messages) };
    if (req.tools?.length) body.tools = req.tools.map(t => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema }));
    if ((req.params as any)?.temperature !== undefined) body.temperature = (req.params as any).temperature;
    const ctrl = new AbortController(); const t = req.deadlineAtMs ? setTimeout(() => ctrl.abort(), Math.max(1, req.deadlineAtMs - Date.now())) : undefined;
    try {
      const res = await this.f((this.opts.baseUrl ?? 'https://api.anthropic.com') + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal: ctrl.signal });
      const data: any = await res.json();
      if (!res.ok) return { callId: req.callId, finishReason: 'error', content: `anthropic ${res.status}: ${data?.error?.message ?? 'error'}` };
      const texts = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      const toolCalls = (data.content ?? []).filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
      const finish = data.stop_reason === 'tool_use' ? 'tool_calls' : data.stop_reason === 'max_tokens' ? 'length' : 'stop';
      return { callId: req.callId, finishReason: finish, ...(texts ? { content: texts } : {}), ...(toolCalls.length ? { toolCalls } : {}), usage: { units: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 } }, raw: { model: data.model, stop_reason: data.stop_reason } };
    } catch (e) { return { callId: req.callId, finishReason: 'error', content: `anthropic transport: ${e instanceof Error ? e.message : String(e)}` }; }
    finally { if (t) clearTimeout(t); void ctx; }
  }
}
function toAnthropic(m: ContextMessage): { role: 'user' | 'assistant'; content: any } {
  if (m.role === 'tool') return { role: 'user', content: `[工具结果 ${m.toolCallId ?? ''}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}` };   // 我方不回喂 assistant tool_use 消息，未配对的 tool_result 会被 API 拒 → 渲染成文本
  const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content as Json);
  return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
}
/** Anthropic 要求 user/assistant 交替：合并相邻同角色 */
function mergeRoles(msgs: Array<{ role: 'user' | 'assistant'; content: any }>) {
  const out: Array<{ role: 'user' | 'assistant'; content: any[] }> = [];
  for (const m of msgs) { const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]; const last = out[out.length - 1]; if (last && last.role === m.role) last.content.push(...parts); else out.push({ role: m.role, content: [...parts] }); }
  if (out.length === 0 || out[0]!.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(begin)' }] });
  return out;
}
