// 极简 MCP Server（stdio / NDJSON / JSON-RPC 2.0）：两个工具 echo、add；用于测试 MCP Bridge，不依赖任何 MCP SDK
import { stdin, stdout } from 'node:process';
let buf = '';
const tools = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'number' }, b: { type: 'number' } } } },
];
const send = o => stdout.write(JSON.stringify(o) + '\n');
stdin.setEncoding('utf8');
stdin.on('data', chunk => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(JSON.parse(line)); } });
function handle(m) {
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0.0.1' } } });
  if (m.method === 'notifications/initialized') return;
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  if (m.method === 'tools/call') {
    const { name, arguments: a = {} } = m.params ?? {};
    if (name === 'echo') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(a.text) }] } });
    if (name === 'add') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }] } });
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'unknown tool' }], isError: true } });
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
}
