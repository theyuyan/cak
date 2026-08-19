#!/usr/bin/env node
// 子进程入口：把 Provider 挂到 stdio JSON-RPC（cak/1）。进程内使用时直接 new __CLASS__() 注册即可。
import { servePlugin } from '@cak/sdk';
import { __CLASS__ } from './provider.js';
servePlugin(new __CLASS__(), { pluginId: '__NAME__', version: '0.1.0', kernelCompat: '^0.3.0' });
