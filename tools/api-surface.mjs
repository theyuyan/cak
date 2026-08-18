// 内核公开接口面指纹（N-31 冻结）：sdk/types.ts 每个导出符号 + Kernel 公开方法签名 + 账本事件类型 + 错误码 + caveat 种类 + 传输协议版本。
// 用法：node tools/api-surface.mjs            → 打印当前指纹并与 tests/api-surface/surface.json 比对（不一致 exit 1）
//       node tools/api-surface.mjs --update   → 重写快照（改 stable 项之前必须先在 10_DECISIONS.md 加条目）
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto'; import ts from 'typescript';
const sha = s => 'sha256:' + createHash('sha256').update(s).digest('hex').slice(0, 16);
const norm = s => s.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const snapArg = process.argv.indexOf('--snapshot'); const SNAP = path.resolve(snapArg >= 0 ? process.argv[snapArg + 1] : 'tests/api-surface/surface.json');
const out = { sdk: {}, kernel: {}, ledgerEventTypes: [], errorCodes: [], caveatKinds: [], transport: {} };
// 1) sdk/types.ts 导出
{
  const src = ts.createSourceFile('types.ts', fs.readFileSync('sdk/types.ts', 'utf8'), ts.ScriptTarget.ES2022, true);
  for (const st of src.statements) {
    const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : []; if (!mods.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    let name; if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isEnumDeclaration(st)) name = st.name?.text; else if (ts.isVariableStatement(st)) name = st.declarationList.declarations.map(d => d.name.getText()).join(',');
    if (!name) continue; out.sdk[name] = sha(norm(st.getText()));
    if (name === 'KernelErrorCode') out.errorCodes = [...st.getText().matchAll(/'([A-Z_]+)'/g)].map(m => m[1]);
    if (name === 'Caveat') out.caveatKinds = [...st.getText().matchAll(/kind: '([a-z.-]+)'/g)].map(m => m[1]);
  }
}
// 2) Kernel 公开方法签名（含 static compose、controlPlane 返回对象的键）
{
  const text = fs.readFileSync('kernel/runtime/kernel.ts', 'utf8');
  const src = ts.createSourceFile('kernel.ts', text, ts.ScriptTarget.ES2022, true);
  const cls = src.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'Kernel');
  for (const m of cls.members) {
    if (!ts.isMethodDeclaration(m)) continue; const mods = ts.getModifiers(m) ?? []; if (mods.some(x => x.kind === ts.SyntaxKind.PrivateKeyword)) continue;
    const name = m.name.getText(); const sig = m.getText().slice(0, m.body ? m.body.getStart() - m.getStart() : undefined);
    out.kernel[name] = sha(norm(sig));
    if (name === 'controlPlane' && m.body) out.kernel['controlPlane.keys'] = [...m.body.getText().matchAll(/^\s+([a-zA-Z]+): \(/gm)].map(x => x[1]).sort().join(',');
  }
}
// 3) 账本事件类型
{ const t = fs.readFileSync('kernel/ledger/ledger.ts', 'utf8'); const m = t.match(/export type LedgerEventType =([\s\S]*?);/); out.ledgerEventTypes = [...m[1].matchAll(/'([a-z_.]+)'/g)].map(x => x[1]); }
// 4) 传输协议
{ const t = fs.readFileSync('sdk/transport.ts', 'utf8'); out.transport.envelope = (t.match(/CAK_ENVELOPE_VERSION = '([^']+)'/) ?? [])[1] ?? null; const m = t.match(/const METHODS = \[([^\]]*)\]/); out.transport.methods = m ? [...m[1].matchAll(/'([a-zA-Z.]+)'/g)].map(x => x[1]) : []; }

const cur = JSON.stringify(out, null, 1) + '\n';
if (process.argv.includes('--update')) { fs.mkdirSync(path.dirname(SNAP), { recursive: true }); fs.writeFileSync(SNAP, cur); console.log(`snapshot written: ${SNAP}`); process.exit(0); }
if (process.argv.includes('--print')) { process.stdout.write(cur); process.exit(0); }
if (!fs.existsSync(SNAP)) { console.error(`no snapshot at ${SNAP}; run with --update`); process.exit(2); }
const prev = JSON.parse(fs.readFileSync(SNAP, 'utf8')); const diffs = [];
const cmpMap = (label, a, b) => { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if (a[k] !== b[k]) diffs.push(`${label}.${k}: ${a[k] ?? '(none)'} → ${b[k] ?? '(removed)'}`); } };
cmpMap('sdk', prev.sdk, out.sdk); cmpMap('kernel', prev.kernel, out.kernel);
for (const k of ['ledgerEventTypes', 'errorCodes', 'caveatKinds']) { const A = prev[k].join(','), B = out[k].join(','); if (A !== B) diffs.push(`${k}: [${A}] → [${B}]`); }
if (JSON.stringify(prev.transport) !== JSON.stringify(out.transport)) diffs.push(`transport: ${JSON.stringify(prev.transport)} → ${JSON.stringify(out.transport)}`);
if (diffs.length) { console.error('接口面变化：\n  ' + diffs.join('\n  ') + '\n→ 若是有意的：stable 项先在 docs/design/10_DECISIONS.md 加条目并按 16_KERNEL_API_FREEZE.md 走流程，再 node tools/api-surface.mjs --update'); process.exit(1); }
console.log(`api surface unchanged (${Object.keys(out.sdk).length} sdk symbols, ${Object.keys(out.kernel).length} kernel methods, ${out.ledgerEventTypes.length} event types, ${out.errorCodes.length} error codes, ${out.caveatKinds.length} caveat kinds, transport cak/${out.transport.envelope} · ${out.transport.methods.length} methods)`);
