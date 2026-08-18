// 真后端 #2（OpenAI 兼容 / DeepSeek）：离线映射测试 + secretRef 解析（file:/env:）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { OpenAICompatBackend, resolveSecretRef } from '../../plugins/builtin/openai-compat-backend.js';
describe('OpenAICompatBackend（映射测试，不联网）', () => {
  it('tools → function 定义；tool_calls(arguments 字符串) → toolCalls；tool 消息渲染为 user 文本；usage；file:/env: secretRef', async () => {
    let seen: any; const fake: typeof fetch = async (_u, init) => { seen = JSON.parse(String(init!.body)); return new Response(JSON.stringify({ model: 'deepseek-chat', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'h_file', arguments: '{"path":"workspace/test.txt"}' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 5 } }), { status: 200 }); };
    const kf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cak-key-')), 'k'); fs.writeFileSync(kf, 'sk-test\n');
    expect(resolveSecretRef('file:' + kf)).toBe('sk-test'); process.env['CAK_TEST_KEY'] = 'sk-env'; expect(resolveSecretRef('env:CAK_TEST_KEY')).toBe('sk-env');
    const be = new OpenAICompatBackend('deepseek', { baseUrl: 'https://api.deepseek.com', apiKeyRef: 'file:' + kf, fetch: fake });
    const r = await be.generate({ callId: 'c', model: 'deepseek-chat', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }, { role: 'tool', content: { x: 1 }, toolCallId: 'call_0' }], tools: [{ name: 'h_file', description: 'file.read@1.0.0', inputSchema: { type: 'object' } }] }, { principal: [], trace: { traceId: 't', spanId: 's' } });
    expect(seen.tools[0].function.name).toBe('h_file'); expect(seen.tool_choice).toBe('auto'); expect(seen.messages[2].role).toBe('user'); expect(seen.messages[2].content).toContain('工具结果');
    expect(r.finishReason).toBe('tool_calls'); expect(r.toolCalls![0]).toEqual({ id: 'call_1', name: 'h_file', args: { path: 'workspace/test.txt' } }); expect(r.usage!.units!.inputTokens).toBe(20);
    const nokey = new OpenAICompatBackend('x', { baseUrl: 'http://x', apiKeyRef: 'file:/nonexistent', fetch: fake }); expect((await nokey.generate({ callId: 'c', model: 'm', messages: [] }, { principal: [], trace: { traceId: 't', spanId: 's' } })).finishReason).toBe('error');
  });
});
