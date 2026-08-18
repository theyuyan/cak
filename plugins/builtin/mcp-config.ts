/** 读 workspace 的 .mcp.json（与 Claude Code / Cursor 同格式：{"mcpServers":{name:{command,args,env}}}）→ McpBridgeSpec[]。只认 stdio（command）；有 url 的远程 server 先跳过并告知。 */
import fs from 'node:fs'; import path from 'node:path';
import type { McpBridgeSpec } from './mcp-bridge.js';
export function loadMcpConfig(workspace: string, file = '.mcp.json'): { specs: McpBridgeSpec[]; skipped: string[] } {
  const p = path.join(workspace, file); if (!fs.existsSync(p)) return { specs: [], skipped: [] };
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string }> };
  const specs: McpBridgeSpec[] = []; const skipped: string[] = [];
  for (const [name, c] of Object.entries(raw.mcpServers ?? {})) { if (c.command) specs.push({ serverName: name, command: c.command, args: c.args ?? [], ...(c.env ? { env: c.env } : {}) }); else skipped.push(name); }
  return { specs, skipped };
}
/** --mcp "name=cmd arg1 arg2"（可重复） */
export function parseMcpFlag(v: string): McpBridgeSpec | undefined { const i = v.indexOf('='); if (i <= 0) return undefined; const parts = v.slice(i + 1).trim().split(/\s+/).filter(Boolean); if (!parts.length) return undefined; return { serverName: v.slice(0, i).trim(), command: parts[0]!, args: parts.slice(1) }; }
