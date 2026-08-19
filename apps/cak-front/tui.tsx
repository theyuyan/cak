#!/usr/bin/env tsx
/**
 * cak TUI — 正式终端前端（前端插件；Ink 渲染）。内核不在本进程：连 daemon 控制面（session.* + SSE）。
 *   npx tsx apps/cak-front/tui.tsx [--session NAME] [--no-motion]
 * 设计口径（docs/design/18_TUI_DESIGN.html）：单栏三段（会话流 / 输入 / 状态线）；框线 ≤300 字符/屏；品牌色只在结构；常驻线留灰，只有"要你处理"才变色；动效三处。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { render, Box, Text, Static, useApp, useInput, usePaste, useStdout } from 'ink';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { findDaemon } from '../cak-code/daemon.js';
import { DaemonClient, humanConnError, humanDenied, humanHandle, humanStatus, humanTail } from './client.js';
import { formatEvent } from '../cak-code/format.js';
import { THEMES, pickTheme, writeConfig, NO_MOTION, type Theme } from './theme.js';

const argv = process.argv.slice(2); const flag = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
type Item =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'line'; text: string; tone: 'dim' | 'ok' | 'danger' | 'attention'; extra?: string }
  | { id: number; kind: 'answer'; text: string }
  | { id: number; kind: 'tail'; text: string }
  | { id: number; kind: 'approval'; contract: string; args: string; diff?: string; decided?: string; ruleHuman?: string };
type Pending = { approvalId: string; invocationId: string; contract: string; args: Record<string, unknown>; diff?: string; rule?: { human: string }; agent?: string };
const COMMANDS = ['/status', '/handles', '/plugins', '/report', '/tasks', '/theme', '/quit'];
/** 审批条摘要：契约 + 最能说明"要动什么"的一个参数（路径 / 网址 / 命令头），不整段 JSON */
const summarize = (contract: string, args: Record<string, unknown>) => { const a: any = args; const key = a.path ?? a.url ?? (Array.isArray(a.argv) ? a.argv.slice(0, 3).join(' ') : undefined) ?? a.repo ?? a.channel ?? a.query ?? a.id ?? a.message; return `${contract}${key ? ' ' + String(key).slice(0, 60) : ''}`; };

function App({ client, info }: { client: DaemonClient; info: { url: string; session: string; workspace: string; agent?: string } }) {
  const { exit } = useApp(); const { stdout } = useStdout();
  const [theme, setTheme] = useState<Theme>(() => pickTheme(flag('theme')));
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
  useEffect(() => {
    // 历史异步读（不阻塞首帧）；只留最后 64KB 里的 user 行
    const f = path.join(os.homedir(), '.cak', 'sessions', info.session + '.history.jsonl');
    fs.promises.stat(f).then(async stt => { const size = stt.size; const start = Math.max(0, size - 65536); const fh = await fs.promises.open(f, 'r'); try { const buf = Buffer.alloc(size - start); await fh.read(buf, 0, buf.length, start); const lines = buf.toString('utf8').split('\n'); if (start > 0) lines.shift(); setHist(lines.filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(x => x?.role === 'user').map(x => String(x.content)).slice(-200)); } finally { await fh.close(); } }).catch(() => {});
    // 连接时：状态 + 已经在等的审批（刷新/重连不能把用户锁在"空闲"里）
    client.call('session.status').then((s: any) => { setStatus(s); if (s.running) setPhase(p => p === 'idle' ? 'thinking' : p); }).catch(e => push({ kind: 'line', text: '✗ ' + humanConnError(e), tone: 'danger' }));
    client.call<Pending[]>('session.pending').then(ps => { if (ps.length) { for (const p of ps) apInv.current.set(p.approvalId, p.invocationId); setPending(ps); pendIdx.current = 0; setPhase('approval'); push({ kind: 'line', text: `有 ${ps.length} 条审批在等你`, tone: 'attention' }); } }).catch(() => {});
  }, []);
  const apInv = useRef(new Map<string, string>()); const mine = useRef(new Map<string, string>());   // approvalId→invocationId；我决定过的 invocationId→decision
  // 呼吸点 / 计时
  useEffect(() => { if (NO_MOTION) return; const t = setInterval(() => setTick(x => x + 1), 400); return () => clearInterval(t); }, []);
  // 事件流
  useEffect(() => {
    if (process.env['CAK_TUI_DEBUG']) fs.appendFileSync(process.env['CAK_TUI_DEBUG'], 'effect: subscribing\n');
    const stop = client.events(e => {
      if (process.env['CAK_TUI_DEBUG']) fs.appendFileSync(process.env['CAK_TUI_DEBUG'], `${new Date().toISOString()} ${e.type} ${e.seq}\n`);
      if (e.type === 'daemon.model.delta') { setPhase('thinking'); setAnswer(a => a + String(e.payload.text ?? '')); return; }
      if (e.type === 'daemon.approval.needed') { const ps = (e.payload.pending as Pending[]).map(p => ({ ...p, agent: e.payload.agent })); for (const p of ps) apInv.current.set(p.approvalId, p.invocationId); setPending(prev => { const known = new Set(prev.map(x => x.approvalId)); const add = ps.filter(p => !known.has(p.approvalId)); if (!prev.length) pendIdx.current = 0; return [...prev, ...add]; }); setPhase('approval'); return; }
      if (e.type === 'daemon.task.result') {
        const out = typeof e.payload.output === 'string' ? e.payload.output : JSON.stringify(e.payload.output ?? e.payload.status); const u = e.payload.usage;
        setAnswer(a => { const finalText = a || out; setLive(l => { const items: Item[] = [...l, { id: nid(), kind: 'answer', text: finalText }, { id: nid(), kind: 'tail', text: humanTail(e.payload.status, u) }]; setDone(d => [...d, ...items]); return []; }); return ''; });
        setPhase('idle'); setToolSince(null); client.call('session.status').then(setStatus).catch(() => {}); return;
      }
      if (e.type === 'daemon.plugins.reloaded') { push({ kind: 'line', text: `✔ 已热加载插件：${(e.payload.plugins as string[]).join(', ')}`, tone: 'ok' }); return; }
      if (e.type === 'daemon.note') { const lvl = e.payload.level; push({ kind: 'line', text: `${lvl === 'error' ? '✗ ' : ''}${e.payload.message}`, tone: lvl === 'error' ? 'danger' : lvl === 'warn' ? 'attention' : 'dim' }); return; }
      // 别处（另一前端 / RPC）已决定的审批：从待办里摘掉、留一行
      if (e.type === 'grant.issued') { const ap = e.payload?.approvalId; if (ap && apInv.current.has(ap) && !mine.current.has(apInv.current.get(ap)!)) { setPending(prev => { const t = prev.find(x => x.approvalId === ap); if (!t) return prev; push({ kind: 'approval', contract: t.contract, args: summarize(t.contract, t.args), decided: '已允许（别处）' }); const rest = prev.filter(x => x.approvalId !== ap); pendIdx.current = Math.min(pendIdx.current, Math.max(0, rest.length - 1)); if (!rest.length) setPhase('thinking'); return rest; }); } return; }
      if (e.type === 'invocation.denied') { const isMine = mine.current.has(e.payload?.invocationId); const ap = [...apInv.current.entries()].find(([, v]) => v === e.payload?.invocationId)?.[0]; if (!isMine && ap) setPending(prev => { const t = prev.find(x => x.approvalId === ap); if (!t) return prev; push({ kind: 'approval', contract: t.contract, args: summarize(t.contract, t.args), decided: humanDenied(e.payload, false) }); const rest = prev.filter(x => x.approvalId !== ap); pendIdx.current = Math.min(pendIdx.current, Math.max(0, rest.length - 1)); if (!rest.length) setPhase('thinking'); return rest; }); if (!(isMine && e.payload?.code === 'APPROVAL_INVALID')) push({ kind: 'line', text: humanDenied(e.payload, isMine), tone: isMine ? 'dim' : 'danger' }); return; }
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
    if (process.env['CAK_TUI_DEBUG']) fs.appendFileSync(process.env['CAK_TUI_DEBUG'], `${new Date().toISOString()} key ${JSON.stringify(ch)} ret=${key.return} phase=${phase} panel=${!!panel}\n`);
    if (panel) { if (key.escape || ch === 'q') { setPanel(null); return; } if (key.upArrow) setPanel(p => p && { ...p, sel: Math.max(0, p.sel - 1) }); if (key.downArrow) setPanel(p => p && { ...p, sel: Math.min(p.rows.length - 1, p.sel + 1) }); if (ch === 'x' && panel.rows[panel.sel]) { const h = panel.rows[panel.sel]; try { await client.call('session.revoke', { handleId: h.id }); push({ kind: 'line', text: `✔ 已撤销 ${h.id}（${h.contract.name}）`, tone: 'ok' }); const rows = await client.call<any[]>('session.handles'); setPanel({ kind: 'handles', rows, sel: 0 }); } catch (e) { push({ kind: 'line', text: `✗ ${(e as Error).message}`, tone: 'danger' }); } } return; }
    if (phase === 'approval' && pending.length) {
      const p = pending[pendIdx.current]; if (!p) return; const c = (ch[0] ?? '').toLowerCase();
      const decide = async (decision: 'grant' | 'deny' | 'standing', all = false) => {
        const targets = all ? pending.slice(pendIdx.current) : [p];
        for (const t of targets) { try { mine.current.set(t.invocationId, decision); const r: any = await client.call('session.decide', { approvalId: t.approvalId, decision, ...(t.agent ? { agent: t.agent } : {}), ...(decision === 'deny' ? { reason: '用户在 TUI 拒绝' } : {}) }); push({ kind: 'approval', contract: t.contract, args: summarize(t.contract, t.args), diff: t.diff, decided: decision === 'grant' ? (all ? '本轮全批' : '已允许') : decision === 'deny' ? '已拒绝（你）' : `常设：${r.standing?.human ?? ''}`, ruleHuman: t.rule?.human }); } catch (e) { const m = (e as Error).message; push({ kind: 'line', text: /no pending approval/.test(m) ? '这条审批已在别处决定' : `✗ ${m}`, tone: 'dim' }); } }
        pendIdx.current += targets.length; if (pendIdx.current >= pending.length) { setPending([]); setPhase('thinking'); } else setPending(x => [...x]);
      };
      if (c === 'y') return decide('grant'); if (c === 'n' || key.return) return decide('deny'); if (c === 'a') return decide('grant', true); if (c === 's' && p.rule) return decide('standing');
      return;
    }
    // 输入框（自己接管，不用 ink-text-input）：回车提交；粘贴/合包（一次多字符且含换行）→ 文本进框、末尾换行=提交；退格删；Ctrl-U 清行
    if (key.return) { const v = input; setInput(''); void submit(v); return; }
    // 一次到达多个字符且含回车 = 键被攒成一块（事件循环忙时会这样；真正的粘贴走 usePaste 括号粘贴通道）→ 逐条处理：每个回车提交一次
    if (ch.length > 1 && /[\r\n]/.test(ch)) { const parts = ch.split(/\r\n|\r|\n/); const endsNl = /[\r\n]$/.test(ch); let cur = input; for (let i = 0; i < parts.length; i++) { cur += parts[i]; const isLast = i === parts.length - 1; if (!isLast || endsNl) { if (isLast && endsNl && !parts[i]) break; void submit(cur); cur = ''; } } setInput(endsNl ? '' : cur); return; }
    if (key.backspace || key.delete) { setInput(v => v.slice(0, -1)); return; }
    if (key.ctrl && ch === 'u') { setInput(''); return; }
    if (key.upArrow && hist.length) { histIdx.current = histIdx.current < 0 ? hist.length - 1 : Math.max(0, histIdx.current - 1); setInput(hist[histIdx.current] ?? ''); return; }
    if (key.downArrow && hist.length) { histIdx.current = histIdx.current < 0 ? -1 : Math.min(hist.length, histIdx.current + 1); setInput(histIdx.current >= hist.length ? '' : (hist[histIdx.current] ?? '')); if (histIdx.current >= hist.length) histIdx.current = -1; return; }
    if (key.tab) { if (input.startsWith('/')) { const m = COMMANDS.filter(c => c.startsWith(input)); if (m.length === 1) setInput(m[0]!); } return; }
    if (ch && !key.ctrl && !key.meta && !key.escape) setInput(v => v + ch);
  });
  usePaste(text => { if (phase === 'approval' || panel) return; setInput(v => v + text.replace(/\r\n|\r|\n/g, ' ')); });   // 真正的粘贴（括号粘贴模式）：整块进输入框，换行变空格，不自动提交
  const submit = async (line: string) => {
    line = line.trim(); setInput(''); histIdx.current = -1; if (!line) return;
    if (line === '/quit' || line === '/exit') { exit(); return; }
    if (line === '/status') { const s: any = await client.call('session.status'); setStatus(s); push({ kind: 'line', text: humanStatus(s).join('\n  '), tone: 'dim' }); return; }
    if (line === '/handles') { const rows = await client.call<any[]>('session.handles'); setPanel({ kind: 'handles', rows, sel: 0 }); return; }
    if (line === '/plugins') { const s: any = await client.call('session.status'); push({ kind: 'line', text: `插件：${s.plugins.join(', ') || '无'}${s.mcp.length ? ` · MCP：${s.mcp.join(', ')}` : ''}${s.registry ? ' · 注册表 ✓（直接说"我想让你能…"即可安装）' : ''}`, tone: 'dim' }); return; }
    if (line === '/report') { const r: any = await client.call('session.report'); push({ kind: 'line', text: Object.entries(r.contracts ?? {}).map(([k, v]: any) => `${k} ${v.calls}次${v.denied ? ` 拒${v.denied}` : ''}${v.failed ? ` 败${v.failed}` : ''}`).join(' · ') || '（无）', tone: 'dim' }); return; }
    if (line.startsWith('/theme')) { const n = line.slice(6).trim(); if (!n) { push({ kind: 'line', text: `主题：${Object.values(THEMES).map(t => `${t.name === theme.name ? '● ' : ''}${t.name}（${t.label}）`).join(' · ')} — /theme <name> 切换并记住`, tone: 'dim' }); return; } const t = THEMES[n]; if (!t) { push({ kind: 'line', text: `✗ 没有主题 ${n}`, tone: 'danger' }); return; } setTheme(t); writeConfig({ theme: n }); push({ kind: 'line', text: `✔ 主题已切到 ${t.label}（已记住）`, tone: 'ok' }); return; }
    if (line === '/tasks') { const t: any[] = await client.call('session.tasks'); for (const x of t) push({ kind: 'line', text: `${x.taskId} ${x.status} ${String(x.input).slice(0, 60)}`, tone: 'dim' }); return; }
    setHist(h => [...h, line]); setDone(d => [...d, ...live, { id: nid(), kind: 'user', text: line }]); setLive([]); setAnswer(''); setPhase('thinking');
    try { await client.call('session.input', { text: line }); } catch (e) { push({ kind: 'line', text: `✗ ${(e as Error).message}`, tone: 'danger' }); setPhase('idle'); }
  };
  const rule = useMemo(() => theme.rule.repeat(Math.max(10, Math.min(cols, 120))), [cols]);
  const spin = NO_MOTION ? '◌' : theme.spinner[tick % theme.spinner.length];
  const cur = pending[pendIdx.current];
  const statusText = phase === 'idle' ? `空闲 · 账本 ${status.ledgerSeq ?? '?'} · 常设 ${status.standingHandles ?? 0}${status.queued ? ` · 排队 ${status.queued}` : ''}` : phase === 'thinking' ? `${spin} 在想…` : phase === 'tool' ? `⟳ 工具运行中${toolSince ? ` ${Math.round((Date.now() - toolSince) / 1000)}s` : ''}` : `${spin} 等你审批（${pendIdx.current + 1}/${pending.length}）`;
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
          <Text color={theme.attention}>  ▎需要审批{cur.agent && cur.agent !== info.agent ? `（agent ${cur.agent}）` : ''}  <Text bold>{summarize(cur.contract, cur.args)}</Text></Text>
          {!cur.diff ? <Text color={theme.dim}>    {JSON.stringify(cur.args).slice(0, Math.max(20, (cols - 8) * 2))}</Text> : null}
          {cur.diff ? <Text>{cur.diff.split('\n').slice(0, 40).map((l, i) => <Text key={i} color={l.startsWith('+') ? theme.ok : l.startsWith('-') ? theme.danger : theme.dim}>{'    ' + l + '\n'}</Text>)}</Text> : null}
          <Text color={theme.attention}>  ▎ <Text bold>y</Text> 只批这次  <Text bold>N</Text> 拒绝  <Text bold>a</Text> 本轮全批{cur.rule ? <>  <Text bold>s</Text> {cur.rule.human}（本会话不再问）</> : null}</Text>
        </Box>) : null}
      {panel ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>  句柄（↑↓ 选择 · x 撤销 · Esc 返回）</Text>
          {panel.rows.map((h, i) => <Text key={h.id} color={i === panel.sel ? undefined : theme.dim} inverse={i === panel.sel}>  {humanHandle(h)}</Text>)}
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
if (!info) { console.error('  ✗ 没找到在跑的内核（先 cak up --workspace DIR --name NAME）'); process.exit(2); }
const client = new DaemonClient({ ...info, agent: flag('agent') ?? info.defaultAgent ?? undefined });
const st: any = await client.call('session.status').catch(e => { console.error('  ✗ ' + humanConnError(e)); process.exit(2); });
process.stdout.write(`\x1b[2mcak · ${st.workspace} · ${st.session} · ${st.backend}/${st.model} · ${st.plugins.length} 插件${st.mcp.length ? ` · MCP ${st.mcp.length}` : ''}\x1b[0m\n`);
const app = render(<App client={client} info={{ url: info.url, session: st.session, workspace: st.workspace, agent: st.agent }} />, { exitOnCtrlC: true });
app.waitUntilExit().then(() => { process.stdout.write('\x1b[2m  已退出前端；内核还在后台跑，停：cak stop\x1b[0m\n'); process.exit(0); });
