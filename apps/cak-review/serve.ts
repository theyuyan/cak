#!/usr/bin/env tsx
/**
 * cak-review — 独立进程的代码审查 agent（第二个宿主）。
 *   npx tsx apps/cak-review/serve.ts --workspace DIR [--port 8790] [--backend deepseek|anthropic] [--model NAME] [--session NAME]
 * 起 HTTP（只听 127.0.0.1），发布名片；cak-code 用 --reviewer http://127.0.0.1:8790 接入。身份 = Ed25519（钥匙落 ~/.cak/identity/cak-review/）。
 */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Kernel } from '../../kernel/runtime/kernel.js';
import { SqliteLedgerStore, SqliteBlobStore } from '../../kernel/ledger/sqlite-store.js';
import { loadOrCreateSigner } from '../cak-code/identity.js';
import { serveKernelHttp } from '../../kernel/boundary/http.js';
import { OpenAICompatBackend } from '../../plugins/builtin/openai-compat-backend.js';
import { AnthropicBackend } from '../../plugins/builtin/anthropic-backend.js';
import { WorkspaceProvider } from '../cak-code/workspace-provider.js';
import { reviewController } from './controller.js';
import { buildReviewSpec } from './spec.js';
import type { LedgerEventView, Observer } from '../../sdk/types.js';

const argv = process.argv.slice(2); const flag = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const workspace = path.resolve(flag('workspace') ?? '.'); const port = Number(flag('port') ?? 8790);
const backendName = flag('backend') ?? 'deepseek'; const modelName = flag('model') ?? (backendName === 'anthropic' ? 'claude-sonnet-5' : 'deepseek-chat');
const sessionName = flag('session') ?? 'review-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const home = path.join(os.homedir(), '.cak'); fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
class TtyObserver implements Observer { readonly id = 'tty'; onEvent(e: LedgerEventView) { const p = e.payload as any; if (e.type === 'task.spawned' && p.goal?.contract) console.log(dim(`  ← 来访 ${p.goal.contract} from ${JSON.stringify(e.principal?.[1] ?? '?')}`)); if (e.type === 'invocation.requested' && !['model.generate'].includes(p.contract?.name)) console.log(dim(`    → ${p.contract.name} ${JSON.stringify(p.args).slice(0, 100)}`)); if (e.type === 'task.finished') console.log(dim(`  ✔ 审查完成 ${e.taskId}`)); } }

const backend = backendName === 'anthropic' ? new AnthropicBackend({ apiKeyRef: 'ANTHROPIC_API_KEY', model: modelName }) : new OpenAICompatBackend('deepseek', { baseUrl: 'https://api.deepseek.com', model: modelName, apiKeyRef: 'file:~/.cak/secrets/deepseek.key' });
const spec = buildReviewSpec({ backend: backendName === 'anthropic' ? 'anthropic' : 'deepseek', model: modelName, workspaceName: path.basename(workspace) });
const signer = loadOrCreateSigner(path.join(home, 'identity', 'cak-review'), { kind: 'agent', id: 'cak-review' });
const k = await Kernel.compose(spec, { controllers: { 'cak-review': cfg => reviewController(cfg) }, backends: { deepseek: backend, anthropic: backend }, providers: [new WorkspaceProvider(workspace)], observers: [new TtyObserver()] }, { ledgerStore: new SqliteLedgerStore(path.join(home, 'sessions', sessionName + '.sqlite')), blobStore: new SqliteBlobStore(path.join(home, 'sessions', sessionName + '.sqlite')), signer });
const srv = await serveKernelHttp(k, { port });
console.log(`cak-review ${dim(`· ${backendName}/${modelName} · workspace ${workspace} · session ${sessionName}`)}\n  名片 GET ${srv.url}/card · 提供 code.review · 只读句柄 · Ctrl-C 退出`);
process.on('SIGINT', async () => { await srv.close(); process.exit(0); });
