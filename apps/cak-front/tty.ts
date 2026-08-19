#!/usr/bin/env tsx
/**
 * cak-front/tty — 第一个「前端插件」：最薄的终端客户端。内核不在本进程；它只连 daemon 的控制面：看事件、按审批、发输入。
 *   npx tsx apps/cak-front/tty.ts [--session NAME] [--agent NAME]      # 不给 session 就连最近起的 daemon
 *   printf '你好\n' | npx tsx apps/cak-front/tty.ts …                  # 管道模式：每行一条输入，跑完退出（审批无人回答 → 拒绝）
 * 用途：证明"前端 = 可插拔的一层"这条路是通的；TUI / 桌面沿同一 API 做。
 */
import readline from 'node:readline';
import { findDaemon } from '../cak-code/daemon.js';
import { DaemonClient, humanConnError, humanDenied, humanHandle, humanStatus, humanTail } from './client.js';
import { formatEvent } from '../cak-code/format.js';
const argv = process.argv.slice(2); const flag = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`; const bold = (s: string) => `\x1b[1m${s}\x1b[0m`; const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`; const red = (s: string) => `\x1b[31m${s}\x1b[0m`; const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const info = findDaemon(flag('session')); if (!info) { console.error(red('  ✗ 没找到在跑的内核（先 cak up --workspace DIR --name NAME）')); process.exit(2); }
const c = new DaemonClient({ ...info, agent: flag('agent') ?? info.defaultAgent ?? undefined });
let st: any; try { st = await c.call('session.status'); } catch (e) { console.error(red('  ✗ ' + humanConnError(e))); process.exit(2); }
const piped = !process.stdin.isTTY;
console.log(`${bold('cak-front/tty')} ${dim(`→ 内核 ${info.url} · 会话 ${st.session} · agent ${st.agent} · 插件 ${st.plugins.length} 个`)}`);
if (!piped) console.log(dim('  这是前端：内核在 daemon 里。输入即提交；出现审批时按 y/N/s。/status /handles /quit（Ctrl-C 也退出，内核继续跑）'));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !piped });
// 管道模式：一建好就开始攒行（stdin 可能在我们 await 内核状态时就读完关掉了）
const pipedLines: string[] = []; let pipeClosed = false; if (piped) { rl.on('line', l => { if (l.trim()) pipedLines.push(l); }); rl.once('close', () => { pipeClosed = true; }); }
let stop = () => {}; let quitting = false;
const bye = (code = 0) => { if (quitting) return; quitting = true; stop(); try { rl.close(); } catch { /* */ } if (!piped) console.log(dim('\n  已退出前端；内核还在后台跑，停：cak stop')); process.exit(code); };
rl.on('SIGINT', () => bye(0)); process.on('SIGINT', () => bye(0)); if (!piped) rl.on('close', () => bye(0));
const ask = (q: string) => new Promise<string>((res, rej) => { if (quitting) return rej(new Error('closed')); rl.question(q, res); });

// 审批对照：approvalId → invocationId（来自 pending 视图）；我自己决定过的 invocationId；别处已决定的 approvalId
const apInv = new Map<string, string>(); const mine = new Map<string, string>(); const decidedElsewhere = new Set<string>(); const seen = new Set<string>();
const approvalIdOf = (inv: string) => [...apInv.entries()].find(([, v]) => v === inv)?.[0];
let waitingApproval = false; let prompting = false;

const handleLine = async (line: string): Promise<boolean> => {
  line = line.trim(); if (!line) return false;
  if (line === '/quit' || line === '/exit') { bye(0); return false; }
  if (line === '/status') { for (const l of humanStatus(await c.call('session.status'))) console.log(dim('  ' + l)); return false; }
  if (line === '/handles') { const hs = await c.call<any[]>('session.handles'); if (!hs.length) console.log(dim('  （没有句柄）')); for (const h of hs) console.log(dim('  ' + humanHandle(h))); return false; }
  await c.call('session.input', { text: line }); return true;
};
const showPrompt = () => { if (piped || waitingApproval || prompting || quitting) return; prompting = true; ask(bold('\n› ')).then(async line => { prompting = false; try { const submitted = await handleLine(line); if (!submitted) showPrompt(); } catch (e) { console.log(red('  ✗ ' + (e as Error).message)); showPrompt(); } }).catch(() => { prompting = false; }); };

/** 问一批审批（连接时拉到的 / 事件推来的）；管道模式无人回答 → 拒绝 */
const askApprovals = async (pending: any[], agent?: string) => {
  const todo = pending.filter(p => !seen.has(p.approvalId)); if (!todo.length) return; for (const p of todo) { seen.add(p.approvalId); apInv.set(p.approvalId, p.invocationId); }
  waitingApproval = true;
  for (const p of todo) {
    console.log(yellow(`\n  需要审批${agent && agent !== st.agent ? `（agent ${agent}）` : ''}：${p.contract} ${JSON.stringify(p.args).slice(0, 140)}`)); if (p.diff) console.log(dim(p.diff.split('\n').map((l: string) => '    ' + (l.startsWith('-') ? red(l) : l.startsWith('+') ? green(l) : l)).join('\n')));
    let decision: 'grant' | 'deny' | 'standing' = 'deny';
    if (piped) console.log(dim('  管道模式无人回答审批 → 拒绝'));
    else { let ans = ''; try { ans = (await ask(yellow(`  允许？[y/N${p.rule ? '/s=本会话始终允许这类' : ''}] `))).trim().toLowerCase(); } catch { return; } if (ans === '/quit' || ans === '/exit') { bye(0); return; } decision = ans === 's' && p.rule ? 'standing' : ans === 'y' ? 'grant' : 'deny'; }
    if (decidedElsewhere.has(p.approvalId)) { console.log(dim('  （这条审批已在别处决定，跳过）')); continue; }
    try { mine.set(p.invocationId, decision); const r: any = await c.call('session.decide', { approvalId: p.approvalId, decision, ...(agent ? { agent } : {}), ...(decision === 'deny' ? { reason: `用户在 tty${piped ? '（管道模式）' : ''}拒绝` } : {}) }); if (r.standing) console.log(dim(`  ✔ 常设句柄 ${r.standing.handleId}：${r.standing.human}`)); }
    catch (e) { const m = (e as Error).message; console.log(dim(/no pending approval/.test(m) ? '  （这条审批已在别处决定）' : '  ✗ ' + m)); }
  }
  waitingApproval = false;
  // 任务还在跑就等 task.result 再出提示符（别把 › 插在工具输出中间）；已经不跑了才立刻出
  try { const s3: any = await c.call('session.status'); if (!s3.running) showPrompt(); } catch { showPrompt(); }
};

let inflight = 0; let pipeEof = false; let pipeDone: (() => void) | undefined;
const onTaskDone = () => { inflight = Math.max(0, inflight - 1); if (piped && pipeEof && inflight === 0) pipeDone?.(); };
stop = c.events(async e => {
  if (e.type === 'daemon.approval.needed') { void askApprovals(e.payload.pending as any[], e.payload.agent); return; }
  if (e.type === 'daemon.task.result') { const out = typeof e.payload.output === 'string' ? e.payload.output : JSON.stringify(e.payload.output ?? e.payload.status); console.log('\n' + out); console.log(dim('  ' + humanTail(e.payload.status, e.payload.usage))); onTaskDone(); showPrompt(); return; }
  if (e.type === 'daemon.plugins.reloaded') { console.log(green(`  ✔ 已热加载插件：${(e.payload.plugins as string[]).join(', ')}`)); return; }
  if (e.type === 'daemon.note') { const lvl = e.payload.level; console.log((lvl === 'error' ? red : lvl === 'warn' ? yellow : dim)(`  ${lvl === 'error' ? '✗ ' : ''}${e.payload.message}`)); return; }
  if (e.type === 'grant.issued') { const ap = e.payload?.approvalId; if (ap && seen.has(ap) && !mine.has(apInv.get(ap) ?? '')) { decidedElsewhere.add(ap); console.log(dim('  已允许（别处）' + (waitingApproval ? '——上面那条不用答了，直接回车' : ''))); } return; }
  if (e.type === 'invocation.denied') { const isMine = mine.has(e.payload?.invocationId); if (!isMine && e.payload?.code === 'APPROVAL_INVALID') { const ap = approvalIdOf(e.payload.invocationId); if (ap) decidedElsewhere.add(ap); } console.log((isMine ? dim : red)('  ' + humanDenied(e.payload, isMine))); return; }
  const l = formatEvent(e); if (!l) return; const col = l.kind === 'deny' || l.kind === 'fail' ? red : l.kind === 'ok' ? green : dim; console.log(col('  ' + l.text) + (l.extra ? '\n' + dim(l.extra.split('\n').map(x => '    ' + x).join('\n')) : ''));
}, Number.MAX_SAFE_INTEGER - 1);   // 只看实时（不回放历史）；想回放传 since=0

// 连接时：先拉「已经在等的审批」和状态，别让用户对着"空闲"干等
try {
  const pend = await c.call<any[]>('session.pending'); const s2: any = await c.call('session.status');
  if (s2.running) console.log(dim(`  · agent 在跑${s2.current?.input ? `：${String(s2.current.input).slice(0, 60)}` : ''}${s2.queued ? `（排队 ${s2.queued}）` : ''}`));
  if (pend.length) { console.log(yellow(`  · 有 ${pend.length} 条审批在等你`)); await askApprovals(pend); }
} catch (e) { console.log(red('  ✗ ' + humanConnError(e))); }

if (piped) {
  // 管道模式：stdin 每行一条输入，顺序提交（上一条跑完再发下一条），最后一条结束后退出；不再 question
  if (!pipeClosed) await new Promise<void>(r => rl.once('close', () => r())); pipeEof = true;
  for (const l of pipedLines) { console.log(bold('› ') + l); try { const submitted = await handleLine(l); if (!submitted) continue; inflight++; await new Promise<void>(r => { pipeDone = r; }); } catch (e) { console.log(red('  ✗ ' + (e as Error).message)); } }
  stop(); process.exit(0);
} else showPrompt();
