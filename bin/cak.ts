#!/usr/bin/env tsx
/**
 * cak — 用户入口（M1）：从命令行跑一个 Agent Spec。
 *   npx tsx bin/cak.ts run <spec.yaml> --input "…" [--workspace DIR] [--mock-script FILE] [--ledger FILE] [--verbose] [--auto-approve]
 * 只用内置插件；模型后端为 mock（--mock-script）——M1 的目的是证明内核链路，不是接真模型（M3/M4）。
 */
import fs from 'node:fs'; import path from 'node:path'; import YAML from 'yaml';
import { Kernel } from '../kernel/runtime/kernel.js';
import { FileLedgerStore, MemoryLedgerStore } from '../kernel/ledger/ledger.js';
import { simpleReact, MockBackend, FsReadonlyProvider, FsAnyProvider, MemoryContextProvider, TextSummarizeProvider, SafeFileGuard, ConsoleObserver, type MockScriptEntry } from '../plugins/builtin/index.js';
import type { AgentSpec } from '../sdk/types.js';

const argv = process.argv.slice(2);
const cmd = argv[0]; const specPath = argv[1];
const flag = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n: string) => argv.includes('--' + n);
const USAGE = `用法:
  cak run <spec.yaml> --input "…" [--workspace DIR] [--mock-script FILE] [--ledger FILE] [--verbose] [--auto-approve] [--allow-outside]
  cak conformance --subprocess "<cmd> [args…]" --contract <name> --args '<json>' [--bad-args '<json>']   # trust-but-verify：本机跑一致性测试`;
if (cmd === 'conformance') {
  const { SubprocessProvider } = await import('../kernel/boundary/subprocess.js');
  const { runConformance, summarize } = await import('../sdk/conformance.js');
  const { loadBuiltinContracts } = await import('../kernel/contract/registry.js');
  const cmdline = (flag('subprocess') ?? '').split(' ').filter(Boolean); if (!cmdline.length || !flag('contract')) { console.log(USAGE); process.exit(1); }
  const contract = loadBuiltinContracts().find(c => c.name === flag('contract')); if (!contract) { console.log(`未知契约 ${flag('contract')}（M3 只查内置契约）`); process.exit(1); }
  const sub = new SubprocessProvider({ id: 'candidate', command: cmdline[0]!, args: cmdline.slice(1) });
  await sub.start();
  const rep = await runConformance(sub, [{ contract, sampleArgs: JSON.parse(flag('args') ?? '{}'), ...(flag('bad-args') ? { badArgs: JSON.parse(flag('bad-args')!) } : {}) }]);
  console.log(summarize(rep)); await sub.stop(); process.exit(rep.ok ? 0 : 1);
}
if (cmd !== 'run' || !specPath) { console.log(USAGE); process.exit(1); }

const spec = YAML.parseAllDocuments(fs.readFileSync(specPath, 'utf8')).map(d => d.toJS())[0] as AgentSpec;
const workspace = path.resolve(flag('workspace') ?? '.');
const script: MockScriptEntry[] = flag('mock-script') ? JSON.parse(fs.readFileSync(flag('mock-script')!, 'utf8')) : [{ finishReason: 'stop', content: '（mock 后端：没有脚本，直接结束）' }];
const backend = new MockBackend(script);
const observers = has('verbose') ? [new ConsoleObserver()] : [];
const ledgerStore = flag('ledger') ? new FileLedgerStore(path.resolve(flag('ledger')!)) : new MemoryLedgerStore();

const t0 = Date.now();
const k = await Kernel.compose(spec, {
  controllers: { 'simple-react': cfg => simpleReact(cfg) },
  backends: { 'mock-backend': backend },
  providers: [has('allow-outside') ? new FsAnyProvider(workspace) : new FsReadonlyProvider(workspace), new MemoryContextProvider([{ content: 'CAK：不变的进内核，会变的做插件' }]), new TextSummarizeProvider()],   // --allow-outside：Provider 放行 workspace 外（治理仍在句柄：需审批）
  interceptors: [new SafeFileGuard(4096)], observers,
}, { ledgerStore });
console.log(`✔ 装配完成 ${spec.metadata.name}@${spec.metadata.version} · 句柄 ${k.rootHandles.length} 个 · 账本 seq=${k.ledger.head().seq}`);
for (const h of k.rootHandles) console.log(`   ${h.id}  ${h.contract.name}@${h.contract.version}  caveats=${h.caveats.map(c => c.kind).join(',') || '-'}`);

let res = await k.startTask(flag('input') ?? '', { input: flag('input') ?? '' });
if (res.status === 'suspended') {
  const pend = k.pendingApprovals(res.taskId);
  console.log(`⏸ 任务挂起，等待审批 ${pend.length} 项：`); for (const p of pend) console.log(`   approvalId=${p.approvalId}  ${p.summary}`);
  if (has('auto-approve')) { for (const p of pend) k.grant(p.approvalId, { kind: 'user', id: process.env['USER'] ?? 'user' }); console.log('   --auto-approve：已写入 grant.issued，恢复…'); res = await k.resume(res.taskId); }
}
console.log(`\n== 结果 ==\nstatus: ${res.status}\noutput: ${typeof res.output === 'string' ? res.output : JSON.stringify(res.output)}`);
const proj = k.ledger.projections(); const invs = Object.values(proj.invocations).filter(i => i.taskId === res.taskId);
console.log(`\n== 账本 ==  事件 ${k.ledger.all().length} 条 · head ${k.ledger.head().hash.slice(0, 23)}… · 用时 ${Date.now() - t0}ms`);
console.log('调用: ' + invs.map(i => `${i.contract.name}[${i.status}${i.denyCode ? ':' + i.denyCode : ''}]`).join(' → '));
const u = proj.usageByTask[res.taskId]; if (u) console.log(`usage: calls=${u.calls} inputTokens=${u.inputTokens} outputTokens=${u.outputTokens}`);
if (flag('ledger')) console.log(`账本文件: ${path.resolve(flag('ledger')!)}`);
process.exit(res.status === 'finished' ? 0 : res.status === 'suspended' ? 2 : 1);
