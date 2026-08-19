#!/usr/bin/env tsx
/**
 * cak-front/tty — 第一个「前端插件」：最薄的终端客户端。内核不在本进程；它只连 daemon 的控制面：看事件、按审批、发输入。
 *   npx tsx apps/cak-front/tty.ts [--session NAME]      # 不给 session 就连最近起的 daemon
 * 用途：证明"前端 = 可插拔的一层"这条路是通的；TUI / 桌面沿同一 API 做。
 */
import readline from 'node:readline';
import { findDaemon } from '../cak-code/daemon.js';
import { DaemonClient } from './client.js';
import { formatEvent } from '../cak-code/format.js';
const argv = process.argv.slice(2); const flag = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`; const bold = (s: string) => `\x1b[1m${s}\x1b[0m`; const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`; const red = (s: string) => `\x1b[31m${s}\x1b[0m`; const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const info = findDaemon(flag('session')); if (!info) { console.error(red('  ✗ 没找到在跑的 daemon（先 npx tsx apps/cak-code/daemon.ts --workspace DIR --session NAME）')); process.exit(2); }
const c = new DaemonClient({ ...info, agent: flag('agent') ?? info.defaultAgent ?? undefined }); const st: any = await c.call('session.status');
console.log(`${bold('cak-front/tty')} ${dim(`→ daemon ${info.url} · session ${st.session} · workspace ${st.workspace} · 插件 ${st.plugins.join(',') || '无'}`)}`);
console.log(dim('  这是前端：内核在 daemon 里。输入即提交；出现审批时按 y/N/s。/status /handles /quit'));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); const ask = (q: string) => new Promise<string>(res => rl.question(q, res));
let waitingApproval = false; let prompting = false;
const showPrompt = () => { if (!waitingApproval && !prompting) { prompting = true; ask(bold('\n› ')).then(async line => { prompting = false; line = line.trim(); if (!line) return showPrompt(); if (line === '/quit' || line === '/exit') { stop(); rl.close(); process.exit(0); } if (line === '/status') { console.log(JSON.stringify(await c.call('session.status'), null, 1)); return showPrompt(); } if (line === '/handles') { for (const h of await c.call<any[]>('session.handles')) console.log(`  ${h.id}  ${h.contract.name}  ${h.caveats.map((x: any) => x.kind).join('；') || '无限制'}${h.expiresAt ? '  到期 ' + h.expiresAt : ''}`); return showPrompt(); } await c.call('session.input', { text: line }); }); } };
const stop = c.events(async e => {
  if (e.type === 'daemon.approval.needed') {
    waitingApproval = true;
    for (const p of e.payload.pending as any[]) {
      console.log(yellow(`\n  需要审批：${p.contract} ${JSON.stringify(p.args).slice(0, 140)}`)); if (p.diff) console.log(dim(p.diff.split('\n').map((l: string) => '    ' + (l.startsWith('-') ? red(l) : l.startsWith('+') ? green(l) : l)).join('\n')));
      const ans = (await ask(yellow(`  允许？[y/N${p.rule ? '/s=本会话始终允许这类' : ''}] `))).trim().toLowerCase();
      const r: any = await c.call('session.decide', { approvalId: p.approvalId, decision: ans === 's' && p.rule ? 'standing' : ans === 'y' ? 'grant' : 'deny' });
      if (r.standing) console.log(dim(`  ✔ 常设句柄 ${r.standing.handleId}：${r.standing.human}`));
    }
    waitingApproval = false; return;
  }
  if (e.type === 'daemon.task.result') { const out = typeof e.payload.output === 'string' ? e.payload.output : JSON.stringify(e.payload.output ?? e.payload.status); console.log('\n' + out); const u = e.payload.usage; if (u) console.log(dim(`  · ${e.payload.status} · calls ${u.calls} · tokens ${u.inputTokens}/${u.outputTokens}${u.cachedInputTokens ? `（缓存命中 ${u.cacheHitPct}%）` : ''}`)); showPrompt(); return; }
  if (e.type === 'daemon.plugins.reloaded') { console.log(green(`  ✔ 已热加载插件：${(e.payload.plugins as string[]).join(', ')}`)); return; }
  if (e.type === 'daemon.note') { console.log(red(`  ✗ ${e.payload.message}`)); return; }
  const l = formatEvent(e); if (!l) return; const col = l.kind === 'deny' || l.kind === 'fail' ? red : l.kind === 'ok' ? green : dim; console.log(col('  ' + l.text) + (l.extra ? '\n' + dim(l.extra.split('\n').map(x => '    ' + x).join('\n')) : ''));
}, Number.MAX_SAFE_INTEGER - 1);   // 只看实时（不回放历史）；想回放传 since=0
showPrompt();
