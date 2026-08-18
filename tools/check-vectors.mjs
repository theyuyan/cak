// 交叉校验测试向量：用 Python（json.dumps sort_keys + hashlib）作为独立第二实现重算 crossCheck=true 的向量；
// 同时校验 mustEqual / mustDiffer 关系、账本链与篡改测试、契约 digest。任何一项不符 → 退出码 1。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, eventHash, contractDigest, ZERO_HASH } from './jcs.mjs';

const V = p => JSON.parse(fs.readFileSync(path.resolve('tests/vectors', p), 'utf8'));
let fails = 0; const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

// ---- approval digest：Python 独立重算
const ad = V('approval-digest.json');
const py = `
import json,hashlib,sys
vs=json.load(sys.stdin)
out=[]
for v in vs:
    s=json.dumps(v['subject'],sort_keys=True,ensure_ascii=False,separators=(',',':'))
    out.append({'id':v['id'],'jcs':s,'digest':'sha256:'+hashlib.sha256(s.encode('utf-8')).hexdigest()})
print(json.dumps(out))
`;
const cross = ad.vectors.filter(v => v.crossCheck);
const r = spawnSync('python3', ['-c', py], { input: JSON.stringify(cross), encoding: 'utf8' });
if (r.status !== 0) { console.log('python failed', r.stderr); process.exit(1); }
const pyOut = JSON.parse(r.stdout);
for (const v of cross) {
  const p = pyOut.find(x => x.id === v.id);
  ok(p.jcs === v.jcs, `${v.id}: JCS 串与 Python 一致`);
  ok(p.digest === v.digest, `${v.id}: digest 与 Python 一致 (${v.digest.slice(0, 23)}…)`);
}
const byId = Object.fromEntries(ad.vectors.map(v => [v.id, v]));
for (const v of ad.vectors) {
  if (v.mustEqual) ok(v.digest === byId[v.mustEqual].digest, `${v.id}: == ${v.mustEqual}`);
  if (v.mustDiffer) ok(v.digest !== byId[v.mustDiffer].digest, `${v.id}: != ${v.mustDiffer}`);
  ok(digest(v.subject) === v.digest, `${v.id}: 本机重算一致`);
}
// 键序断言：JCS 输出里 "a" 必须在 "z" 之前、"z" 在 "é" 之前（UTF-16 code unit 顺序）
const u = byId['AD-3 unicode keys/values + escapes'].jcs;
ok(u.indexOf('"a":') < u.indexOf('"z":') && u.indexOf('"z":') < u.indexOf('"é":'), 'AD-3: 键序 a < z < é');
ok(u.includes('\\n') && u.includes('\\"'), 'AD-3: 控制字符与引号按 JSON 转义');
ok(!('provider' in byId['AD-4 provider omitted (different from AD-1)'].subject), 'AD-4: 省略键而非 null');

// ---- ledger chain
const lc = V('ledger-chain.json');
let prev = ZERO_HASH;
for (const e of lc.events) {
  ok(e.prevHash === prev, `ledger seq ${e.seq}: prevHash 链接`);
  ok(eventHash(e) === e.hash, `ledger seq ${e.seq}: hash 重算一致`);
  prev = e.hash;
}
ok(prev === lc.headHash, 'ledger head 一致');
// tamper
const t = JSON.parse(JSON.stringify(lc.events)); t[lc.tamperTest.changedIndex].payload.args.path = 'workspace/y.txt';
let changedFrom = -1; let p2 = ZERO_HASH;
for (let i = 0; i < t.length; i++) { const e = { ...t[i], prevHash: p2 }; const h = eventHash(e); if (h !== lc.events[i].hash && changedFrom < 0) changedFrom = i; p2 = h; }
ok(changedFrom === lc.tamperTest.changedIndex && p2 !== lc.headHash, `tamper: 从 index ${changedFrom} 起 hash 变化，head 变化`);

// ---- contract digests
const cd = V('contract-digest.json');
for (const c of cd.contracts) {
  const file = JSON.parse(fs.readFileSync(path.resolve('contracts/builtin', c.file), 'utf8'));
  ok(file.schemaDigest === c.schemaDigest && contractDigest(file) === c.schemaDigest, `contract ${c.name}@${c.version}: 文件内 digest = 向量 = 重算`);
  const clone = { ...file, description: 'CHANGED', pricing: { unit: 'call', amount: 1 }, defaultTimeoutMs: 1 };
  ok(contractDigest(clone) === c.schemaDigest, `contract ${c.name}: description/pricing/timeout 不改 digest`);
  const clone2 = { ...file, inputSchema: { ...file.inputSchema, extra: true } };
  ok(contractDigest(clone2) !== c.schemaDigest, `contract ${c.name}: inputSchema 变则 digest 变`);
}
console.log(fails ? `\nFAILED: ${fails}` : '\nall vectors OK');
process.exit(fails ? 1 : 0);
