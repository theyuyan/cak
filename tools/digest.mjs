// 为 contracts/builtin/*.json 计算并写入 schemaDigest（幂等）。--check 模式只校验不改写。
import fs from 'node:fs';
import path from 'node:path';
import { contractDigest } from './jcs.mjs';

const dir = path.resolve('contracts/builtin');
const check = process.argv.includes('--check');
let changed = 0, mismatched = 0, total = 0;
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort()) {
  const p = path.join(dir, f);
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  const d = contractDigest(c);
  total++;
  if (c.schemaDigest !== d) {
    if (check) { mismatched++; console.log(`✗ ${f}: file=${c.schemaDigest} computed=${d}`); }
    else { c.schemaDigest = d; fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n'); changed++; console.log(`✎ ${f} → ${d}`); }
  } else console.log(`✓ ${f} ${d}`);
}
console.log(check ? `checked ${total}, mismatched ${mismatched}` : `wrote ${changed}/${total}`);
if (check && mismatched) process.exit(1);
