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

describe('OpenAICompatBackend · 流式（N-44）', () => {
  it('req.onDelta 存在 → stream:true；SSE 正文增量逐段回调；工具调用按 index 拼参数；末尾 usage；折叠结果与非流式同形', async () => {
    const seen: string[] = []; let gotBody: any;
    const chunks = [
      { choices: [{ delta: { role: 'assistant', content: '你好' } }] },
      { choices: [{ delta: { content: '，世界' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'file_read', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, prompt_cache_hit_tokens: 8 } },
    ];
    const sse = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    const fakeFetch = (async (_u: any, init: any) => { gotBody = JSON.parse(init.body); return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }); }) as unknown as typeof fetch;
    const { OpenAICompatBackend } = await import('../../plugins/builtin/openai-compat-backend.js');
    const b = new OpenAICompatBackend('t', { baseUrl: 'http://x', model: 'm', apiKeyRef: 'env:CAK_TEST_KEY', fetch: fakeFetch } as any);
    process.env['CAK_TEST_KEY'] = 'k';
    const r = await b.generate({ callId: 'c', model: 'm', messages: [{ role: 'user', content: 'hi' }], onDelta: (d: { text: string }) => seen.push(d.text) } as any, { principal: [], trace: { traceId: 't', spanId: 's' } } as any);
    expect(gotBody.stream).toBe(true); expect(seen).toEqual(['你好', '，世界']);
    expect(r.finishReason).toBe('tool_calls'); expect(r.content).toBe('你好，世界'); expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'file_read', args: { path: 'a.ts' } }]);
    expect(r.usage?.units).toMatchObject({ inputTokens: 12, outputTokens: 5, custom: { cachedInputTokens: 8, uncachedInputTokens: 4 } });
    // 没有 onDelta → 不开 stream
    const fake2 = (async (_u: any, init: any) => { gotBody = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: {} }), { status: 200 }); }) as unknown as typeof fetch;
    const b2 = new OpenAICompatBackend('t', { baseUrl: 'http://x', model: 'm', apiKeyRef: 'env:CAK_TEST_KEY', fetch: fake2 } as any);
    await b2.generate({ callId: 'c', model: 'm', messages: [{ role: 'user', content: 'hi' }] } as any, { principal: [], trace: { traceId: 't', spanId: 's' } } as any); expect(gotBody.stream).toBeUndefined();
  });
});
