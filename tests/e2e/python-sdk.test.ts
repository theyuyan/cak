// 第二个物种：Python 写的插件（sdk-python）经同一条 stdio 协议接入 —— 内核只看契约与 conformance，不看语言。本机没有 python3 则跳过
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process'; import path from 'node:path';
import { SubprocessProvider } from '../../kernel/boundary/subprocess.js';
import { runConformance, summarize } from '../../sdk/conformance.js';
import { loadBuiltinContracts } from '../../kernel/contract/registry.js';
const py = spawnSync('python3', ['--version'], { encoding: 'utf8' }); const hasPy = py.status === 0;
describe.skipIf(!hasPy)('Python SDK · 子进程插件走同一协议', () => {
  it('sdk-python/examples/summarize_plugin.py：hello 报 implementations → conformance 全过 → 输出合 text.summarize outputSchema；坏信封/未知方法回标准错误码', async () => {
    const sub = new SubprocessProvider({ id: 'py-summarize', command: 'python3', args: [path.resolve('sdk-python/examples/summarize_plugin.py')] });
    await sub.start();
    try {
      const impls = sub.listImplementations(); expect(impls[0]!.contract.name).toBe('text.summarize');
      const rep = await runConformance(sub, [{ contract: loadBuiltinContracts().find(c => c.name === 'text.summarize')!, sampleArgs: { text: 'CAK 是内核。它有插件。它让 agent 互联。' } }]);
      expect(rep.ok, summarize(rep)).toBe(true);
      const h = await sub.health(); expect(h.status).toBe('healthy'); expect(String((h as any).detail)).toContain('python');
    } finally { await sub.stop(); }
    // 协议边界：直接喂坏信封 / 未知方法
    const probe = spawnSync('python3', [path.resolve('sdk-python/examples/summarize_plugin.py')], { input: '{"cak":"9","jsonrpc":"2.0","id":1,"method":"plugin.hello"}\n{"cak":"1","jsonrpc":"2.0","id":2,"method":"nope"}\nnot json\n', encoding: 'utf8' });
    const lines = probe.stdout.trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0]).toMatchObject({ id: 1, error: { code: -32600 } }); expect(lines[1]).toMatchObject({ id: 2, error: { code: -32601 } }); expect(lines[2]).toMatchObject({ error: { code: -32700 } });
  }, 30000);
});
