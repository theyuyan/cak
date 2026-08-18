// MCP Bridge 接真 server（@modelcontextprotocol/server-memory，stdio，需要 npx + 网络）：CAK_INTEGRATION=1 时才跑，默认 skip（不让默认套件依赖网络）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { McpBridge } from '../../plugins/builtin/mcp-bridge.js';
import { loadMcpConfig, parseMcpFlag } from '../../plugins/builtin/mcp-config.js';
const live = process.env['CAK_INTEGRATION'] === '1';
describe('MCP · 配置解析（离线）', () => {
  it('.mcp.json（Claude Code / Cursor 同格式）→ 只取 stdio 条目；--mcp "name=cmd args" 解析', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcfg-'));
    fs.writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({ mcpServers: { memory: { command: 'npx', args: ['-y', 'x'], env: { A: '1' } }, remote: { url: 'https://x/mcp' } } }));
    const r = loadMcpConfig(d); expect(r.specs).toEqual([{ serverName: 'memory', command: 'npx', args: ['-y', 'x'], env: { A: '1' } }]); expect(r.skipped).toEqual(['remote']);
    expect(parseMcpFlag('memory=npx -y @modelcontextprotocol/server-memory')).toEqual({ serverName: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] });
    expect(parseMcpFlag('bad')).toBeUndefined();
  });
});
describe.skipIf(!live)('MCP · 真 server（CAK_INTEGRATION=1）', () => {
  it('server-memory：initialize 2025-06-18 → tools/list 映射为 x.mcp.memory.* 契约（无 $schema）→ tools/call 返回 content + structuredContent', async () => {
    const kg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcpkg-')), 'kg.json');
    const b = new McpBridge({ serverName: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { MEMORY_FILE_PATH: kg }, startupTimeoutMs: 60000 });
    await b.start();
    try {
      const names = b.listContracts().map(c => c.name); expect(names).toContain('x.mcp.memory.create_entities'); expect(names).toContain('x.mcp.memory.search_nodes');
      expect(JSON.stringify(b.listContracts().find(c => c.name === 'x.mcp.memory.create_entities')!.inputSchema)).not.toContain('$schema');
      const c = b.listContracts().find(c => c.name === 'x.mcp.memory.create_entities')!;
      const r = await b.execute({ id: 'i', revision: 0, contract: { name: c.name, version: c.version, schemaDigest: c.schemaDigest }, args: { entities: [{ name: 'CAK', entityType: 'project', observations: ['kernel'] }] }, handle: { id: 'h', contract: { name: c.name, version: c.version, schemaDigest: c.schemaDigest }, caveats: [], delegable: true }, principal: [{ kind: 'agent', id: 'x' }], digest: 'sha256:' + '0'.repeat(64), idempotencyKey: 'i' } as any, { principal: [], trace: { traceId: 't', spanId: 's' } });
      expect('output' in r && (r.output as any).structuredContent.entities[0].name).toBe('CAK');
      expect(fs.readFileSync(kg, 'utf8')).toContain('"CAK"');
    } finally { await b.stop(); }
  }, 120000);
});
