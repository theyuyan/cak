#!/usr/bin/env tsx
/**
 * cak-code — 跑在 CAK 上的编程助手（极简终端 REPL）。
 *   npx tsx apps/cak-code/cli.ts [--workspace DIR] [--backend deepseek|anthropic] [--model NAME] [--session NAME] [--yes]
 * 每条消息 = 一个 Task；写文件 / shell / commit 默认要审批（句柄 caveat），终端 y/N；账本落 ~/.cak/sessions/<session>.sqlite。
 */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import readline from 'node:readline';
import { Kernel } from '../../kernel/runtime/kernel.js';
import { SqliteLedgerStore } from '../../kernel/ledger/sqlite-store.js';
import { OpenAICompatBackend } from '../../plugins/builtin/openai-compat-backend.js';
import { AnthropicBackend } from '../../plugins/builtin/anthropic-backend.js';
import { WorkspaceProvider } from './workspace-provider.js';
import { codingController } from './controller.js';
import { buildSpec } from './spec.js';
import type { LedgerEventView, Observer } from '../../sdk/types.js';

const argv = process.argv.slice(2); const flag = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; }; const has = (n: string) => argv.includes('--' + n);
const workspace = path.resolve(flag('workspace') ?? '.');
const backendName = flag('backend') ?? 'deepseek';
const modelName = flag('model') ?? (backendName === 'anthropic' ? 'claude-sonnet-5' : 'deepseek-chat');
const sessionName = flag('session') ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const home = path.join(os.homedir(), '.cak'); fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
const sessionFile = path.join(home, 'sessions', sessionName + '.history.jsonl');
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`; const bold = (s: string) => `\x1b[1m${s}\x1b[0m`; const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`; const red = (s: string) => `\x1b[31m${s}\x1b[0m`; const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

/** 终端观察者：把账本里的工具调用实时打出来（一行一件事，不画框） */
class TtyObserver implements Observer {
  readonly id = 'tty'; enabled = true;
  onEvent(e: LedgerEventView) {
    if (!this.enabled) return; const p = e.payload as any;
    if (e.type === 'invocation.requested' && !['model.generate', 'session.history'].includes(p.contract?.name)) process.stdout.write(dim(`  → ${p.contract.name} ${short(p.args)}`) + '\n');
    if (e.type === 'invocation.denied') process.stdout.write(red(`  ✗ ${p.code}: ${p.reason}`) + '\n');
    if (e.type === 'invocation.failed') process.stdout.write(red(`  ✗ ${p.error?.code}: ${String(p.error?.message).slice(0, 200)}`) + '\n');
    if (e.type === 'invocation.executed' && p.output && typeof p.output === 'object' && 'exitCode' in p.output) process.stdout.write(dim(`  ← exit ${p.output.exitCode}${p.output.stdout ? '\n' + indent(String(p.output.stdout).slice(0, 1200)) : ''}${p.output.stderr ? '\n' + indent(red(String(p.output.stderr).slice(0, 600))) : ''}`) + '\n');
    if (e.type === 'invocation.executed' && p.output && typeof p.output === 'object' && 'created' in p.output) process.stdout.write(green(`  ✔ 写入 ${p.output.path}（${p.output.bytes} B）`) + '\n');
  }
}
const short = (a: unknown) => { const s = JSON.stringify(a); return s.length > 140 ? s.slice(0, 140) + '…' : s; };
const indent = (s: string) => s.split('\n').map(l => '    ' + l).join('\n');

const backend = backendName === 'anthropic' ? new AnthropicBackend({ apiKeyRef: 'ANTHROPIC_API_KEY', model: modelName }) : new OpenAICompatBackend('deepseek', { baseUrl: 'https://api.deepseek.com', model: modelName, apiKeyRef: 'file:~/.cak/secrets/deepseek.key' });
const spec = buildSpec({ backend: backendName === 'anthropic' ? 'anthropic' : 'deepseek', model: modelName, workspaceName: path.basename(workspace) });
const provider = new WorkspaceProvider(workspace, { sessionFile });
const tty = new TtyObserver();
const k = await Kernel.compose(spec, { controllers: { 'cak-code': cfg => codingController(cfg) }, backends: { deepseek: backend, anthropic: backend }, providers: [provider], observers: [tty] }, { ledgerStore: new SqliteLedgerStore(path.join(home, 'sessions', sessionName + '.sqlite')) });

console.log(`${bold('cak-code')} ${dim(`· ${backendName}/${modelName} · workspace ${workspace} · session ${sessionName}`)}`);
console.log(dim('  读类工具直接执行；写文件 / 执行命令 / 提交默认要你审批。输入 /quit 退出，/report 看用量，/approve-all 本轮全批。'));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>(res => rl.question(q, res));
const oneShot = flag('task');   // --task "…"：非交互跑一条（配合 --yes 全批 / 不带 --yes 则拒绝需审批的操作）

for (;;) {
  const line = oneShot ?? (await ask(bold('\n› '))).trim(); if (!line) continue;
  if (line === '/quit' || line === '/exit') break;
  if (line === '/report') { const r = k.usageReport(); console.log(JSON.stringify({ contracts: r.contracts, events: r.events }, null, 1)); continue; }
  fs.appendFileSync(sessionFile, JSON.stringify({ role: 'user', content: line }) + '\n');
  let res = await k.startTask(line, { input: line });
  while (res.status === 'suspended') {
    const pend = k.pendingApprovals(res.taskId);
    if (!pend.length) break;
    for (const p of pend) {
      const inv = k.ledger.projections().invocations[p.invocationId]!;
      console.log(yellow(`\n  需要审批：${p.contract.name} ${short(inv.args)}`));
      if (inv.contract.name === 'file.write') { const cur = fs.existsSync(path.join(workspace, String(inv.args['path']))) ? fs.readFileSync(path.join(workspace, String(inv.args['path'])), 'utf8') : ''; console.log(dim(indent(miniDiff(cur, String(inv.args['content']))))); }
      const ans = has('yes') ? 'y' : oneShot ? 'n' : (await ask(yellow('  允许？[y/N/a=本轮全批] '))).trim().toLowerCase();
      if (ans === 'a') { for (const q of pend) k.grant(q.approvalId, { kind: 'user', id: os.userInfo().username }); break; }
      if (ans === 'y') k.grant(p.approvalId, { kind: 'user', id: os.userInfo().username }); else k.deny(p.approvalId, { kind: 'user', id: os.userInfo().username }, '用户拒绝');
    }
    res = await k.resume(res.taskId);
  }
  const answer = typeof res.output === 'string' ? res.output : JSON.stringify(res.output ?? res.status);
  console.log('\n' + answer);
  fs.appendFileSync(sessionFile, JSON.stringify({ role: 'assistant', content: answer }) + '\n');
  const u = k.ledger.projections().usageByTask[res.taskId]; if (u) console.log(dim(`  · ${res.status} · calls ${u.calls} · tokens ${u.inputTokens}/${u.outputTokens} · 账本 ${k.ledger.head().seq} 条`));
  if (oneShot) break;
}
rl.close();
console.log(dim(`账本：${path.join(home, 'sessions', sessionName + '.sqlite')}`));
process.exit(0);

function miniDiff(a: string, b: string): string {
  const A = a.split('\n'), B = b.split('\n'); const out: string[] = []; const n = Math.max(A.length, B.length); let shown = 0;
  for (let i = 0; i < n && shown < 40; i++) { if (A[i] === B[i]) continue; if (A[i] !== undefined) out.push(red('- ' + A[i])); if (B[i] !== undefined) out.push(green('+ ' + B[i])); shown++; }
  return out.length ? out.join('\n') : green(`+ (新文件 ${B.length} 行)`);
}
