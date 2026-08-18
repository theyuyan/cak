// 真驱动 cak-code 交互版：像人一样坐在终端前——看到提示才输入。用法：node tests/drive-repl.mjs <workspace> [scenario.json]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ws = process.argv[2]; const scenario = JSON.parse(fs.readFileSync(process.argv[3] ?? 'tests/repl-scenario.json', 'utf8'));
const child = spawn('node_modules/.bin/tsx', ['apps/cak-code/cli.ts', '--workspace', ws, '--session', 'drive-' + Date.now()], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
let buf = ''; let turn = 0; let approvals = 0; const transcript = [];
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const send = (s, why) => { transcript.push({ dir: 'in', text: s, why }); child.stdin.write(s + '\n'); };
child.stdout.on('data', d => {
  const s = strip(String(d)); process.stdout.write(s); buf += s;
  // 审批提示
  if (/允许？\[[^\]]*\] $/.test(buf)) { const ans = scenario.approvals[approvals] ?? 'n'; approvals++; buf = ''; setTimeout(() => send(ans, `approval#${approvals}`), 200); return; }
  // 输入提示（新一轮）
  if (/› $/.test(buf)) { buf = ''; const next = scenario.turns[turn]; turn++; if (next === undefined) { setTimeout(() => send('/quit', 'end'), 200); return; } setTimeout(() => send(next, `turn#${turn}`), 300); }
});
child.stderr.on('data', d => process.stderr.write(strip(String(d))));
child.on('close', code => { fs.writeFileSync('tmp/repl-transcript.json', JSON.stringify(transcript, null, 1)); console.log(`\n[driver] exit ${code}; turns sent ${turn}, approvals answered ${approvals}`); process.exit(code ?? 1); });
setTimeout(() => { console.log('\n[driver] timeout'); child.kill(); }, Number(scenario.timeoutMs ?? 600000));
