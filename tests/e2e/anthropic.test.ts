// 真后端 #1（Anthropic）：不联网；用 fetch 替身验证"内核 → 后端请求"与"后端响应 → 内核"两个方向的映射
import { describe, it, expect } from 'vitest';
import { AnthropicBackend } from '../../plugins/builtin/anthropic-backend.js';
describe('AnthropicBackend（映射测试，不联网）', () => {
  it('system 合并、tool 定义映射、tool_use → toolCalls{name=handleId}、usage 映射；无 key → error 不抛', async () => {
    let seen: any;
    const fake: typeof fetch = async (_url, init) => { seen = JSON.parse(String(init!.body)); return new Response(JSON.stringify({ model: 'm', stop_reason: 'tool_use', content: [{ type: 'text', text: '我来读文件' }, { type: 'tool_use', id: 'tu_1', name: 'h_file', input: { path: 'workspace/test.txt' } }], usage: { input_tokens: 12, output_tokens: 3 } }), { status: 200 }); };
    const be = new AnthropicBackend({ fetch: fake, resolveSecret: () => 'sk-test' });
    const r = await be.generate({ callId: 'c1', model: 'claude-sonnet-5', messages: [{ role: 'system', content: 'S1' }, { role: 'system', content: 'S2' }, { role: 'user', content: '读文件' }, { role: 'tool', content: { output: 1 }, toolCallId: 'tu_0' }], tools: [{ name: 'h_file', description: 'file.read@1.0.0', inputSchema: { type: 'object' } }] }, { principal: [], trace: { traceId: 't', spanId: 's' } });
    expect(seen.system).toBe('S1\n\nS2'); expect(seen.tools[0].name).toBe('h_file'); expect(seen.messages[0].role).toBe('user'); expect(seen.messages[0].content.some((c: any) => c.type === 'tool_result')).toBe(true);
    expect(seen.messages.every((m: any, i: number, a: any[]) => i === 0 || a[i - 1].role !== m.role)).toBe(true);   // 角色交替
    expect(r.finishReason).toBe('tool_calls'); expect(r.toolCalls![0]).toEqual({ id: 'tu_1', name: 'h_file', args: { path: 'workspace/test.txt' } }); expect(r.usage!.units!.inputTokens).toBe(12);
    const noKey = new AnthropicBackend({ fetch: fake, resolveSecret: () => undefined }); const r2 = await noKey.generate({ callId: 'c2', model: 'x', messages: [] }, { principal: [], trace: { traceId: 't', spanId: 's' } }); expect(r2.finishReason).toBe('error');
    const bad: typeof fetch = async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 401 });
    const r3 = await new AnthropicBackend({ fetch: bad, resolveSecret: () => 'k' }).generate({ callId: 'c3', model: 'x', messages: [] }, { principal: [], trace: { traceId: 't', spanId: 's' } }); expect(r3.finishReason).toBe('error'); expect(String(r3.content)).toContain('401');
  });
});
