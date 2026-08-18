#!/usr/bin/env tsx
/**
 * cak-code — 跑在 CAK 上的编程助手（极简终端 REPL；内嵌形态：内核在本进程里）。
 *   npx tsx apps/cak-code/cli.ts [--workspace DIR] [--backend deepseek|anthropic] [--model NAME] [--session NAME] [--yes] [--reviewer http://127.0.0.1:8790] [--plugins-dir ~/.cak/plugins | --no-plugins] [--registry DIR | --no-registry] [--mcp "name=cmd args…"]… [--no-mcp]
 * 每条消息 = 一个 Task；写文件 / shell / commit 默认要审批（句柄 caveat），终端 y/N/a/s；账本落 ~/.cak/sessions/<session>.sqlite。
 * 常驻形态见 daemon.ts（内核在后台进程，前端经本机控制面 API 接入：TUI / 桌面 / 网页都是前端插件）。
 */
import readline from 'node:readline';
import { createHost } from './host.js';
import { parseMcpFlag } from '../../plugins/builtin/mcp-config.js';
import { formatEvent } from './format.js';
import type { LedgerEventView, Observer } from '../../sdk/types.js';

const argv = process.argv.slice(2); const flag = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; }; const has = (n: string) => argv.includes('--' + n);
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`; const bold = (s: string) => `\x1b[1m${s}\x1b[0m`; const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`; const red = (s: string) => `\x1b[31m${s}\x1b[0m`; const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const short = (a: unknown) => { const s = JSON.stringify(a); return s.length > 140 ? s.slice(0, 140) + '…' : s; };
const indent = (s: string) => s.split('\n').map(l => '    ' + l).join('\n');

/** 终端观察者：把账本里的工具调用实时打出来（一行一件事，不画框） */
class TtyObserver implements Observer {
  readonly id = 'tty'; onReceipt?: (r: { root: string; sig: any; taskId: string }) => void;
  onEvent(e: LedgerEventView) {
    const l = formatEvent(e); if (!l) return;
    const col = l.kind === 'deny' || l.kind === 'fail' ? red : l.kind === 'ok' ? green : l.kind === 'review' ? (l.text.includes('approve') ? green : l.text.includes('request_changes') ? red : yellow) : dim;
    process.stdout.write(col('  ' + l.text) + '\n' + (l.extra ? indent(l.kind === 'result' ? dim(l.extra) : dim(l.extra)) + '\n' : ''));
    if (l.receipt) this.onReceipt?.(l.receipt as any);
  }
}
const tty = new TtyObserver(); let streaming = false;
const mcpExtra = argv.map((a, i) => a === '--mcp' ? argv[i + 1] : undefined).filter((x): x is string => !!x).map(parseMcpFlag).filter((x): x is NonNullable<typeof x> => !!x);
let host: Awaited<ReturnType<typeof createHost>>;
try {
  host = await createHost({ workspace: flag('workspace') ?? '.', backend: flag('backend') === 'anthropic' ? 'anthropic' : 'deepseek', model: flag('model'), session: flag('session'), reviewerUrl: flag('reviewer'),
    pluginsDir: has('no-plugins') ? null : flag('plugins-dir'), mcp: has('no-mcp') ? null : { extra: mcpExtra }, registryDir: has('no-registry') ? null : flag('registry'), observers: [tty],
    note: (lvl, msg) => console.error((lvl === 'error' ? red : lvl === 'warn' ? yellow : dim)(`  ${lvl === 'warn' ? '△' : lvl === 'error' ? '✗' : '·'} ${msg}`)),
    onModelDelta: has('no-stream') ? undefined : e => { if (!streaming) { process.stdout.write('\n'); streaming = true; } process.stdout.write(e.text); } });
} catch (e) { console.error(red(`  ✗ ${(e as Error).message}`)); process.exit(2); }
tty.onReceipt = async r => { try { const v = await host.verifyReviewReceipt(r); process.stdout.write((v.ok ? green : red)(`  ${v.ok ? '✔' : '✗'} 回执${v.ok ? '已验' : '验证失败'}：cak-review task ${r.taskId}，${v.events} 事件，root ${r.root.slice(0, 23)}…`) + '\n'); } catch (e) { process.stdout.write(red(`  ✗ 回执核验出错：${(e as Error).message}`) + '\n'); } };

console.log(`${bold('cak-code')} ${dim('· ' + host.banner())}`);
console.log(dim('  读类工具直接执行；写文件 / 执行命令 / 提交默认要你审批。输入 /quit 退出，/status 看状态，/report 看用量，/handles 看常设授权，/revoke <id> 撤销。'));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>(res => rl.question(q, res));
const oneShot = flag('task');   // --task "…"：非交互跑一条（配合 --yes 全批 / 不带 --yes 则拒绝需审批的操作）

for (;;) {
  const line = oneShot ?? (await ask(bold('\n› '))).trim(); if (!line) continue;
  if (line === '/quit' || line === '/exit') break;
  if (line === '/status') { const s = host.status(); console.log(`  session   ${s.session}\n  workspace ${s.workspace}\n  模型      ${s.backend}/${s.model}\n  插件      ${s.plugins.join(', ') || '（无）'}\n  MCP       ${s.mcp.join(', ') || '（无）'}\n  账本事件  ${s.ledgerSeq} 条 · ${s.ledgerFile}\n  常设句柄  ${s.standingHandles} 个（/handles 看明细）`); continue; }
  if (line === '/handles') { for (const h of host.k.controlPlane().handles()) console.log(`  ${h.id}  ${h.contract.name}  ${h.caveats.map(c => c.kind === 'requires-approval' ? '需审批' : c.kind === 'args.prefix' ? `${c.path}以${c.prefix}开头` : c.kind === 'args.match' ? `argv 前缀 ${JSON.stringify(((c.schema as any).properties?.argv?.prefixItems ?? []).map((x: any) => x.const))}` : c.kind).join('；') || '无限制'}${h.expiresAt ? '  到期 ' + h.expiresAt : ''}`); continue; }
  if (line.startsWith('/revoke ')) { const id = line.slice(8).trim(); try { host.k.controlPlane().revoke(id, 'cak-code: 用户撤销'); console.log(dim(`  ✔ 已撤销 ${id}`)); } catch (e) { console.log(red(`  ✗ ${(e as Error).message}`)); } continue; }
  if (line === '/report') { const r = host.k.usageReport(); console.log(JSON.stringify({ contracts: r.contracts, events: r.events }, null, 1)); continue; }
  let res = await host.submit(line);
  while (res.status === 'suspended') {
    const pend = host.pending(res.taskId); if (!pend.length) break;
    for (const p of pend) {
      console.log(yellow(`\n  需要审批：${p.contract} ${short(p.args)}`)); if (p.diff) console.log(dim(indent(p.diff.split('\n').map(l => l.startsWith('-') ? red(l) : l.startsWith('+') ? green(l) : l).join('\n'))));
      const ans = has('yes') ? 'y' : oneShot ? 'n' : (await ask(yellow(`  允许？[y/N/a=本轮全批${p.rule ? '/s=本会话始终允许这类' : ''}] `))).trim().toLowerCase();
      if (ans === 'a') { for (const q of pend) host.decide(q.approvalId, 'grant'); break; }
      if (ans === 's' && p.rule) { const r = host.decide(p.approvalId, 'standing'); console.log(dim(`  ✔ 已铸常设句柄 ${r.standing!.handleId}：${r.standing!.human}，12 小时内不再问；/handles 查看，/revoke ${r.standing!.handleId} 撤销`)); continue; }
      host.decide(p.approvalId, ans === 'y' ? 'grant' : 'deny');
    }
    res = await host.resume(res.taskId);
  }
  const answer = typeof res.output === 'string' ? res.output : JSON.stringify(res.output ?? res.status);
  if (streaming) { process.stdout.write('\n'); streaming = false; } else console.log('\n' + answer);   // 流过了就不再整段重打
  host.recordAnswer(answer);
  const u = host.usageOf(res.taskId); if (u) console.log(dim(`  · ${res.status} · calls ${u.calls} · tokens ${u.inputTokens}/${u.outputTokens}${u.cachedInputTokens ? `（缓存命中 ${u.cacheHitPct}%）` : ''} · 账本 ${u.ledgerSeq} 条`));
  if (await host.recomposeIfNeeded()) console.log(green(`  ✔ 已热加载插件：${host.installed.map(p => p.id).join(', ') || '（无）'}`));
  if (oneShot) break;
}
rl.close(); await host.close();
console.log(dim(`账本：${host.ledgerFile}`));
process.exit(0);
