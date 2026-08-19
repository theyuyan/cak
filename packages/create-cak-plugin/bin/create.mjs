#!/usr/bin/env node
// create-cak-plugin：npm create @cak-dev/plugin <name> --contract <name> [--digest sha256:…] [--sdk <spec>]
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const argv = process.argv.slice(2); const name = argv[0]; const flag = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
if (!name || !flag('contract')) { console.log('用法: create-cak-plugin <name> --contract <contract.name> [--digest sha256:…] [--sdk <npm spec 或 路径>]'); process.exit(1); }
const tpl = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'capability');
const out = path.resolve(name); if (fs.existsSync(out)) { console.error(`已存在: ${out}`); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
const cls = name.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('') + 'Provider';
const vars = { __NAME__: name, __CLASS__: cls, __CONTRACT__: flag('contract'), __DIGEST__: flag('digest') ?? 'sha256:REPLACE_ME_FROM_REGISTRY', __SDK__: flag('sdk') ?? '@cak-dev/sdk@^0.3.0' };
for (const f of fs.readdirSync(tpl)) { let s = fs.readFileSync(path.join(tpl, f), 'utf8'); for (const [k, v] of Object.entries(vars)) s = s.split(k).join(v); fs.writeFileSync(path.join(out, f), s); }
console.log(`✔ 已生成 ${out}\n  下一步: cd ${name} && npm install && npm run build && npm run conformance`);
