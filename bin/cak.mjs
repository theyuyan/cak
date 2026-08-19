#!/usr/bin/env node
// `cak` 命令入口（npm bin）：交给同仓库的 tsx 跑 bin/cak.ts。发布后用户 `npm i -g @cak-dev/cli` 即得 cak；开发期 `npm link`。
import { spawn } from 'node:child_process'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import fs from 'node:fs';
const here = path.dirname(fileURLToPath(import.meta.url));
const tsx = path.resolve(here, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
if (!fs.existsSync(tsx)) { console.error('cak: 缺依赖，先在 cak 目录 npm install'); process.exit(1); }
const c = spawn(tsx, [path.resolve(here, 'cak.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
c.on('close', code => process.exit(code ?? 0));
