/** 事件 → 一行人话（REPL 与前端客户端共用；不画框，只在"要你处理"处变色由调用方决定） */
export interface Line { kind: 'call' | 'deny' | 'fail' | 'result' | 'ok' | 'review'; text: string; extra?: string; receipt?: { root: string; sig: unknown; taskId: string } }
const short = (a: unknown) => { const s = JSON.stringify(a); return s.length > 140 ? s.slice(0, 140) + '…' : s; };
export function formatEvent(e: { type: string; payload: unknown }): Line | undefined {
  const p = e.payload as any;
  if (e.type === 'invocation.requested') { if (['model.generate', 'session.history', 'memory.search'].includes(p.contract?.name)) return undefined; return { kind: 'call', text: `→ ${p.contract.name} ${short(p.contract.name === 'file.edit' ? { path: p.args.path } : p.args)}` }; }
  if (e.type === 'invocation.denied') return { kind: 'deny', text: `✗ ${p.code}: ${p.reason}` };
  if (e.type === 'invocation.failed') return { kind: 'fail', text: `✗ ${p.error?.code}: ${String(p.error?.message).slice(0, 200)}` };
  if (e.type !== 'invocation.executed' || !p.output || typeof p.output !== 'object') return undefined; const o = p.output;
  if ('exitCode' in o) return { kind: 'result', text: `← exit ${o.exitCode}`, extra: [o.stdout ? String(o.stdout).slice(0, 1200) : '', o.stderr ? String(o.stderr).slice(0, 600) : ''].filter(Boolean).join('\n') || undefined };
  if ('receipt' in o && o.output && typeof o.output === 'object' && 'verdict' in o.output) { const v = o.output; return { kind: 'review', text: `⚖ 审查 ${v.verdict}：${v.summary}`, extra: (v.findings ?? []).map((f: any) => `· [${f.severity}] ${f.file ?? ''}${f.line ? ':' + f.line : ''} ${f.message}`).join('\n') || undefined, receipt: o.receipt }; }
  if ('elements' in o && 'title' in o) return { kind: 'result', text: `← 浏览器「${String(o.title).slice(0, 60)}」 ${String(o.url).slice(0, 80)} · ${o.elements.length} 个可交互元素 · 正文 ${String(o.text).length} 字` };
  if ('status' in o && 'body' in o) return { kind: 'result', text: `← HTTP ${o.status} ${o.title ? '「' + String(o.title).slice(0, 60) + '」' : ''} ${o.bytes} B${o.truncated ? '（截断）' : ''}` };
  if (Array.isArray(o.content) && 'isError' in o) return { kind: 'result', text: `← MCP ${String(o.content?.[0]?.text ?? JSON.stringify(o.structuredContent ?? '')).replace(/\s+/g, ' ').slice(0, 160)}` };
  if ('installed' in o && 'passed' in o) return { kind: o.installed ? 'ok' : 'fail', text: `${o.installed ? '✔' : '✗'} 插件 ${o.id}：${o.message ?? ''}` };
  if ('replacements' in o) return { kind: 'ok', text: `✔ 编辑 ${o.path}（替换 ${o.replacements} 处）` };
  if ('created' in o) return { kind: 'ok', text: `✔ 写入 ${o.path}（${o.bytes} B）` };
  return undefined;
}
