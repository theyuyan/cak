#!/usr/bin/env tsx
// 敌意子进程插件（测试）：模式由 argv[2] 决定：never | crash-on-execute | garbage-line
import { HostileProvider } from '../builtin/index.js';
import { servePlugin } from '../../sdk/plugin-host.js';
const mode = process.argv[2] ?? 'never';
if (mode === 'garbage-line') { process.stdout.write('this is not json\n'); }
const provider = mode === 'crash-on-execute'
  ? { id: 'crasher', listImplementations: () => new HostileProvider('never').listImplementations(), async execute() { process.exit(3); return { output: null }; } }
  : new HostileProvider('never', 'hostile-sub');
servePlugin(provider as any, { pluginId: 'hostile-subprocess', version: '0.3.0', kernelCompat: '^0.3.0' });
