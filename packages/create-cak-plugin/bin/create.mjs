#!/usr/bin/env node
// create-cak-plugin：npm create @cak-dev/plugin <name> --contract <name> [--digest sha256:…] [--sdk <spec>]
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const argv = process.argv.slice(2); const name = argv[0]; const flag = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
if (!name || !flag('contract')) { console.log('用法: npm create @cak-dev/plugin <name> -- --contract <contract.name> [--contract-version 1.0.0] [--digest sha256:…] [--sdk <版本范围 或 file:路径>]\n（npm create 后面要加 -- 再跟参数，否则 npm 会吞掉 --contract）'); process.exit(1); }
const tpl = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'capability');
const out = path.resolve(name); if (fs.existsSync(out)) { console.error(`已存在: ${out}`); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
const cls = name.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('') + 'Provider';
// --sdk 接受 '^0.3.0' / '@cak-dev/sdk@^0.3.0' / 'file:…tgz'；写进 package.json 的必须是版本范围或 file: 路径（之前默认值带包名，npm 把它当本地 link，npm install 不报错、build 必炸——作者测试员抓到）
const sdkSpec = (() => { const v = flag('sdk') ?? '^0.3.0'; return v.startsWith('@cak-dev/sdk@') ? v.slice('@cak-dev/sdk@'.length) : v; })();
const contractVersion = flag('contract-version') ?? '1.0.0';
const vars = { __NAME__: name, __CLASS__: cls, __CONTRACT__: flag('contract'), __CONTRACT_VERSION__: contractVersion, __DIGEST__: flag('digest') ?? 'sha256:REPLACE_ME_FROM_REGISTRY', __SDK__: sdkSpec };
for (const f of fs.readdirSync(tpl)) { let s = fs.readFileSync(path.join(tpl, f), 'utf8'); for (const [k, v] of Object.entries(vars)) s = s.split(k).join(v); fs.writeFileSync(path.join(out, f), s); }
console.log(`✔ 已生成 ${out}\n  下一步: cd ${name} && npm install && npm run build && npm test && npm run conformance\n  契约 digest：cak digest <契约.json>（算出来填进 provider.ts）；装进本机：cak add ./${name}`);
