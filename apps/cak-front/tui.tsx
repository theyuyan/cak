#!/usr/bin/env tsx
/**
 * cak TUI — 正式终端前端（前端插件；Ink 渲染）。内核不在本进程：连 daemon 控制面（session.* + SSE）。
 *   npx tsx apps/cak-front/tui.tsx [--session NAME] [--no-motion]
 * 设计口径（docs/design/18_TUI_DESIGN.html）：单栏三段（会话流 / 输入 / 状态线）；框线 ≤300 字符/屏；品牌色只在结构；常驻线留灰，只有"要你处理"才变色；动效三处。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { render, Box, Text, Static, useApp, useInput, useStdout } from 'ink';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { findDaemon } from '../cak-code/daemon.js';
import { DaemonClient } from './client.js';
import { formatEvent } from '../cak-code/format.js';
import { theme, NO_MOTION } from './theme.js';

const argv = process.argv.slice(2); const flag = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
type Item =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'line'; text: string; tone: 'dim' | 'ok' | 'danger' | 'attention'; extra?: string }
  | { id: number; kind: 'answer'; text: string }
  | { id: number; kind: 'tail'; text: string }
  | { id: number; kind: 'approval'; contract: string; args: string; diff?: string; decided?: string; ruleHuman?: string };
type Pending = { approvalId: string; contract: string; args: Record<string, unknown>; diff?: string; rule?: { human: string } };
const COMMANDS = ['/status', '/handles', '/plugins', '/report', '/tasks', '/quit'];
/** 审批条摘要：契约 + 最能说明"要动什么"的一个参数（路径 / 网址 / 命令头），不整段 JSON */
const summarize = (contract: string, args: Record<string, unknown>) => { const a: any = args; const key = a.path ?? a.url ?? (Array.isArray(a.argv) ? a.argv.slice(0, 3).join(' ') : undefined) ?? a.repo ?? a.channel ?? a.query ?? a.id ?? a.message; return `${contract}${key ? ' ' + String(key).slice(0, 60) : ''}`; };

function App({ client, info }: { client: DaemonClient; info: { url: string; session: string; workspace: string } }) {
  const { exit } = useApp(); const { stdout } = useStdout();
  const cols = stdout?.columns ?? 100;
  const [done, setDone] = useState<Item[]>([]);            // 已完成的条目（Static，不重绘）
  const [live, setLive] = useState<Item[]>([]);            // 当前任务里的条目
  const [answer, setAnswer] = useState('');                // 流式正文
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'tool' | 'approval'>('idle');
  const [pending, setPending] = useState<Pending[]>([]); const pendIdx = useRef(0);
  const [input, setInput] = useState(''); const [hist, setHist] = useState<string[]>([]); const histIdx = useRef(-1);
  const [status, setStatus] = useState<any>({}); const [tick, setTick] = useState(0); const [toolSince, setToolSince] = useState<number | null>(null);
  const [panel, setPanel] = useState<{ kind: 'handles'; rows: any[]; sel: number } | null>(null);
  const idRef = useRef(1); const nid = () => idRef.current++;
  const push = (it: Omit<Item, 'id'>) => setLive(l => [...l, { ...(it as any), id: nid() }]);
  // 会话历史（跨会话 ↑↓）
  useEffect(() => { try { const f = path.join(os.homedir(), '.cak', 'sessions', info.session + '.history.jsonl'); if (fs.existsSync(f)) setHist(fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(x => x?.role === 'user').map(x => String(x.content)).slice(-200)); } catch { /* ignore */ } client.call('session.status').then(setStatus).catch(() => {}); }, []);
  // 呼吸点 / 计时
  useEffect(() => { if (NO_MOTION) return; const t = setInterval(() => setTick(x => x + 1), 400); return () => clearInterval(t); }, []);
  // 事件流
  useEffect(() => {
    if (process.env['CAK_TUI_DEBUG']) fs.appendFileSync(process.env['CAK_TUI_DEBUG'], 'effect: subscribing\n');
    const stop = client.events(e => {
      if (process.env['CAK_TUI_DEBUG']) fs.appendFileSync(process.env['CAK_TUI_DEBUG'], `${new Date().toISOString()} ${e.type} ${e.seq}\n`);
      if (e.type === 'daemon.model.delta') { setPhase('thinking'); setAnswer(a => a + String(e.payload.text ?? '')); return; }
      if (e.type === 'daemon.approval.needed') { setPending(e.payload.pending); pendIdx.current = 0; setPhase('approval'); return; }
      if (e.type === 'daemon.task.result') {
        const out = typeof e.payload.output === 'string' ? e.payload.output : JSON.stringify(e.payload.output ?? e.payload.status); const u = e.payload.usage;
        setAnswer(a => { const finalText = a || out; setLive(l => { const items: Item[] = [...l, { id: nid(), kind: 'answer', text: finalText }, { id: nid(), kind: 'tail', text: `· ${e.payload.status} · ${u?.calls ?? '?'} 次调用 · ${u ? `${(u.inputTokens / 1000).toFixed(1)}k/${u.outputTokens} tok` : ''}${u?.cachedInputTokens ? ` · 缓存 ${u.cacheHitPct}%` : ''}` }]; setDone(d => [...d, ...items]); return []; }); return ''; });
        setPhase('idle'); setToolSince(null); client.call('session.status').then(setStatus).catch(() => {}); return;
      }
      if (e.type === 'daemon.plugins.reloaded') { push({ kind: 'line', text: `✔ 已热加载插件：${(e.payload.plugins as string[]).join(', ')}`, tone: 'ok' }); return; }
      if (e.type === 'daemon.note') { push({ kind: 'line', text: `✗ ${e.payload.message}`, tone: 'danger' }); return; }
      if (e.type === 'invocation.requested' && e.payload?.contract?.name === 'model.generate') { setPhase(p => p === 'approval' ? p : 'thinking'); setAnswer(a => a && !a.endsWith('\n') ? a + '\n' : a); return; }   // 新一步：过程文字之间换行
      const l = formatEvent(e); if (!l) return;
      if (l.kind === 'call') { setPhase('tool'); setToolSince(Date.now()); }
      if (['result', 'ok', 'deny', 'fail', 'review'].includes(l.kind)) { setToolSince(null); }
      // 工具结果超过 20 行折叠
      let extra = l.extra; if (extra) { const lines = extra.split('\n'); if (lines.length > 20) extra = lines.slice(0, 20).join('\n') + `\n… 还有 ${lines.length - 20} 行（账本里有全文）`; }
      push({ kind: 'line', text: l.text, tone: l.kind === 'deny' || l.kind === 'fail' ? 'danger' : l.kind === 'ok' ? 'ok' : l.kind === 'review' ? (l.text.includes('approve') ? 'ok' : l.text.includes('request_changes') ? 'danger' : 'attention') : 'dim', extra });
    }, Number.MAX_SAFE_INTEGER - 1);
    return stop;
  }, []);
  // 键盘：审批单键 / 面板 / 历史 / 补全
  useInput(async (ch, key) => {
    if (process.env['CAK_TUI_DEBUG']) fs.appendFileSync(process.env['CAK_TUI_DEBUG'], `key ${JSON.stringify(ch)} ret=${key.return} phase=${phase} panel=${!!panel}\n`);
    if (panel) { if (key.escape || ch === 'q') { setPanel(null); return; } if (key.upArrow) setPanel(p => p && { ...p, sel: Math.max(0, p.sel - 1) }); if (key.downArrow) setPanel(p => p && { ...p, sel: Math.min(p.rows.length - 1, p.sel + 1) }); if (ch === 'x' && panel.rows[panel.sel]) { const h = panel.rows[panel.sel]; try { await client.call('session.revoke', { handleId: h.id }); push({ kind: 'line', text: `✔ 已撤销 ${h.id}（${h.contract.name}）`, tone: 'ok' }); const rows = await client.call<any[]>('session.handles'); setPanel({ kind: 'handles', rows, sel: 0 }); } catch (e) { push({ kind: 'line', text: `✗ ${(e as Error).message}`, tone: 'danger' }); } } return; }
    if (phase === 'approval' && pending.length) {
      const p = pending[pendIdx.current]; if (!p) return; const c = ch.toLowerCase();
      const decide = async (decision: 'grant' | 'deny' | 'standing', all = false) => {
        const targets = all ? pending.slice(pendIdx.current) : [p];
        for (const t of targets) { try { const r: any = await client.call('session.decide', { approvalId: t.approvalId, decision }); push({ kind: 'approval', contract: t.contract, args: summarize(t.contract, t.args), diff: t.diff, decided: decision === 'grant' ? (all ? '本轮全批' : '已允许') : decision === 'deny' ? '已拒绝' : `常设：${r.standing?.human ?? ''}`, ruleHuman: t.rule?.human }); } catch (e) { push({ kind: 'line', text: `✗ ${(e as Error).message}`, tone: 'danger' }); } }
        pendIdx.current += targets.length; if (pendIdx.current >= pending.length) { setPending([]); setPhase('thinking'); } else setPending(x => [...x]);
      };
      if (c === 'y') return decide('grant'); if (c === 'n' || key.return) return decide('deny'); if (c === 'a') return decide('grant', true); if (c === 's' && p.rule) return decide('standing');
      return;
    }
    // 输入框（自己接管，不用 ink-text-input）：回车提交；粘贴/合包（一次多字符且含换行）→ 文本进框、末尾换行=提交；退格删；Ctrl-U 清行
    if (key.return) { const v = input; setInput(''); void submit(v); return; }
    if (ch.length > 1 && /[\r\n]/.test(ch)) { const parts = ch.split(/\r\n|\r|\n/); const endsNl = /[\r\n]$/.test(ch); const text = parts.filter(Boolean).join(' '); const v = input + text; if (endsNl) { setInput(''); void submit(v); } else setInput(v); return; }
    if (key.backspace || key.delete) { setInput(v => v.slice(0, -1)); return; }
    if (key.ctrl && ch === 'u') { setInput(''); return; }
    if (key.upArrow && hist.length) { histIdx.current = histIdx.current < 0 ? hist.length - 1 : Math.max(0, histIdx.current - 1); setInput(hist[histIdx.current] ?? ''); return; }
    if (key.downArrow && hist.length) { histIdx.current = histIdx.current < 0 ? -1 : Math.min(hist.length, histIdx.current + 1); setInput(histIdx.current >= hist.length ? '' : (hist[histIdx.current] ?? '')); if (histIdx.current >= hist.length) histIdx.current = -1; return; }
    if (key.tab) { if (input.startsWith('/')) { const m = COMMANDS.filter(c => c.startsWith(input)); if (m.length === 1) setInput(m[0]!); } return; }
    if (ch && !key.ctrl && !key.meta && !key.escape) setInput(v => v + ch);
  });
  const submit = async (line: string) => {
    line = line.trim(); setInput(''); histIdx.current = -1; if (!line) return;
    if (line === '/quit' || line === '/exit') { exit(); return; }
    if (line === '/status') { const s: any = await client.call('session.status'); setStatus(s); push({ kind: 'line', text: `session ${s.session} · ${s.workspace} · ${s.backend}/${s.model} · 插件 ${s.plugins.join(', ') || '无'} · MCP ${s.mcp.join(', ') || '无'} · 账本 ${s.ledgerSeq} · 常设 ${s.standingHandles}`, tone: 'dim' }); return; }
    if (line === '/handles') { const rows = await client.call<any[]>('session.handles'); setPanel({ kind: 'handles', rows, sel: 0 }); return; }
    if (line === '/plugins') { const s: any = await client.call('session.status'); push({ kind: 'line', text: `插件：${s.plugins.join(', ') || '无'}${s.mcp.length ? ` · MCP：${s.mcp.join(', ')}` : ''}${s.registry ? ' · 注册表 ✓（直接说"我想让你能…"即可安装）' : ''}`, tone: 'dim' }); return; }
    if (line === '/report') { const r: any = await client.call('session.report'); push({ kind: 'line', text: Object.entries(r.contracts ?? {}).map(([k, v]: any) => `${k} ${v.calls}次${v.denied ? ` 拒${v.denied}` : ''}${v.failed ? ` 败${v.failed}` : ''}`).join(' · ') || '（无）', tone: 'dim' }); return; }
    if (line === '/tasks') { const t: any[] = await client.call('session.tasks'); for (const x of t) push({ kind: 'line', text: `${x.taskId} ${x.status} ${String(x.input).slice(0, 60)}`, tone: 'dim' }); return; }
    setHist(h => [...h, line]); setDone(d => [...d, ...live, { id: nid(), kind: 'user', text: line }]); setLive([]); setAnswer(''); setPhase('thinking');
    try { await client.call('session.input', { text: line }); } catch (e) { push({ kind: 'line', text: `✗ ${(e as Error).message}`, tone: 'danger' }); setPhase('idle'); }
  };
  const rule = useMemo(() => theme.rule.repeat(Math.max(10, Math.min(cols, 120))), [cols]);
  const spin = NO_MOTION ? '◌' : theme.spinner[tick % theme.spinner.length];
  const cur = pending[pendIdx.current];
  const statusText = phase === 'idle' ? `空闲 · 账本 ${status.ledgerSeq ?? '?'} · 常设 ${status.standingHandles ?? 0}` : phase === 'thinking' ? `${spin} 在想…` : phase === 'tool' ? `⟳ 工具运行中${toolSince ? ` ${Math.round((Date.now() - toolSince) / 1000)}s` : ''}` : `${spin} 等你审批（${pendIdx.current + 1}/${pending.length}）`;
  const renderItem = (it: Item) => {
    if (it.kind === 'user') return <Text key={it.id}><Text color={theme.accent}>›</Text> {it.text}</Text>;
    if (it.kind === 'answer') return <Text key={it.id}>  {it.text}</Text>;
    if (it.kind === 'tail') return <Text key={it.id} color={theme.dim}>  {it.text}</Text>;
    if (it.kind === 'approval') return <Box key={it.id} flexDirection="column"><Text color={theme.dim}>  ▎审批 {it.args} — {it.decided}</Text></Box>;
    const color = it.tone === 'danger' ? theme.danger : it.tone === 'ok' ? theme.ok : it.tone === 'attention' ? theme.attention : theme.dim;
    return <Box key={it.id} flexDirection="column"><Text color={color}>  {it.text}</Text>{it.extra ? <Text color={theme.dim}>{it.extra.split('\n').map(l => '    ' + l).join('\n')}</Text> : null}</Box>;
  };
  return (
    <Box flexDirection="column">
      <Static items={done}>{(it: Item) => renderItem(it)}</Static>
      {live.map(renderItem)}
      {answer ? <Text>  {answer}<Text color={theme.accent}>{NO_MOTION ? '' : (tick % 2 ? '▍' : ' ')}</Text></Text> : null}
      {cur ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.attention}>  ▎需要审批  <Text bold>{summarize(cur.contract, cur.args)}</Text></Text>
          {!cur.diff ? <Text color={theme.dim}>    {JSON.stringify(cur.args).slice(0, Math.max(20, (cols - 8) * 2))}</Text> : null}
          {cur.diff ? <Text>{cur.diff.split('\n').slice(0, 40).map((l, i) => <Text key={i} color={l.startsWith('+') ? theme.ok : l.startsWith('-') ? theme.danger : theme.dim}>{'    ' + l + '\n'}</Text>)}</Text> : null}
          <Text color={theme.attention}>  ▎ <Text bold>y</Text> 只批这次  <Text bold>N</Text> 拒绝  <Text bold>a</Text> 本轮全批{cur.rule ? <>  <Text bold>s</Text> {cur.rule.human}（本会话不再问）</> : null}</Text>
        </Box>) : null}
      {panel ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>  句柄（↑↓ 选择 · x 撤销 · Esc 返回）</Text>
          {panel.rows.map((h, i) => <Text key={h.id} color={i === panel.sel ? undefined : theme.dim} inverse={i === panel.sel}>  {h.id}  {h.contract.name}  {(h.caveats ?? []).map((c: any) => c.kind === 'requires-approval' ? '需审批' : c.kind === 'args.prefix' ? `${c.path}以${c.prefix}开头` : c.kind).join('；') || '无限制'}{h.expiresAt ? `  到期 ${String(h.expiresAt).slice(11, 16)}` : ''}</Text>)}
        </Box>) : null}
      <Text color={theme.dim}>{rule}</Text>
      <Box>
        <Text color={theme.accent}>› </Text>
        {phase === 'approval' || panel ? <Text color={theme.dim}>{panel ? '（面板中）' : '（先处理上面的审批）'}</Text> : input ? <Text>{input}<Text color={theme.accent}>{NO_MOTION || tick % 2 ? '▍' : ' '}</Text></Text> : <Text color={theme.dim}>输入…（↑ 历史 · Tab 补全 / 命令 · /quit 退出前端，daemon 继续）</Text>}
      </Box>
      <Text color={theme.dim}>  {statusText}</Text>
    </Box>
  );
}

const info = findDaemon(flag('session'));
if (!info) { console.error('  ✗ 没找到在跑的 daemon（先 npx tsx apps/cak-code/daemon.ts --workspace DIR --session NAME）'); process.exit(2); }
const client = new DaemonClient(info);
const st: any = await client.call('session.status').catch(e => { console.error('  ✗ ' + (e as Error).message); process.exit(2); });
process.stdout.write(`\x1b[2mcak · ${st.workspace} · ${st.session} · ${st.backend}/${st.model} · ${st.plugins.length} 插件${st.mcp.length ? ` · MCP ${st.mcp.length}` : ''}\x1b[0m\n`);
render(<App client={client} info={{ url: info.url, session: st.session, workspace: st.workspace }} />, { exitOnCtrlC: true });
