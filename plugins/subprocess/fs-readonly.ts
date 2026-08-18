#!/usr/bin/env tsx
// 子进程形态的 fs-readonly：同一份 FsReadonlyProvider，套上 servePlugin 即成为 subprocess 插件。
// 用法：tsx plugins/subprocess/fs-readonly.ts <workspaceRoot>
import { FsReadonlyProvider } from '../builtin/index.js';
import { servePlugin } from '../../sdk/plugin-host.js';
const root = process.argv[2] ?? process.cwd();
servePlugin(new FsReadonlyProvider(root), { pluginId: 'fs-readonly-subprocess', version: '0.3.0', kernelCompat: '^0.3.0' });
