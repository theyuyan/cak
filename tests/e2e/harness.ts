// Golden 运行器：读 tests/golden/Gn.yaml（判据），装配内核 + 内置插件，跑任务，返回按 taskId 过滤的事件类型序列与句柄。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import YAML from 'yaml';
import { Kernel, type Plugins, type KernelOptions } from '../../kernel/runtime/kernel.js';
import { FileLedgerStore, MemoryLedgerStore } from '../../kernel/ledger/ledger.js';
import { simpleReact, MockBackend, FsReadonlyProvider, FsAnyProvider, MemoryContextProvider, TextSummarizeProvider, SafeFileGuard, CollectingObserver, type MockScriptEntry } from '../../plugins/builtin/index.js';
import type { AgentSpec, CapabilityProvider, Interceptor, HandleId } from '../../sdk/types.js';

export const specs = YAML.parseAllDocuments(fs.readFileSync('docs/design/08_AGENT_SPEC.example.yaml', 'utf8')).map(d => d.toJS() as AgentSpec);
export const minimalSpec = () => structuredClone(specs[0]!);
export const loadFixture = (id: string) => YAML.parse(fs.readFileSync(`tests/golden/${id}.yaml`, 'utf8'));

export interface RunEnv { ws: string; outside: string; ledgerFile: string }
export function mkEnv(fx: any): RunEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cak-e2e-')); const ws = path.join(base, 'ws'); const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(ws, 'workspace'), { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  for (const [f, content] of Object.entries<string>(fx.workspace ?? {})) { const p = path.join(ws, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content === '<8000 bytes of text>' ? 'x'.repeat(8000) : content); }
  for (const [f, content] of Object.entries<string>(fx.files ?? {})) { const p = f.replace('$outside', outside); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
  return { ws, outside, ledgerFile: path.join(base, 'ledger.ndjson') };
}
/** 把 fixture 里的 $h.* 符号解析成真实句柄：$h.file=grants[0]，$h.fileAny=grants[1]，$h.model=model */
export function symbolResolver(k: Kernel) {
  const map: Record<string, HandleId> = { '$h.file': k.rootHandles[0]!.id, '$h.fileAny': k.rootHandles[1]!.id, '$h.model': k.rootHandles.find(h => h.contract.name === 'model.generate')!.id };
  return (s: string) => map[s] ?? s;
}
export interface BuildOpts { fx: any; env: RunEnv; persistent?: boolean; providers?: CapabilityProvider[]; interceptors?: Interceptor[]; specPatch?: (s: AgentSpec) => void; script?: MockScriptEntry[] }
export async function build(o: BuildOpts) {
  const spec = minimalSpec(); o.specPatch?.(spec);
  const obs = new CollectingObserver();
  const script: MockScriptEntry[] = (o.script ?? o.fx.mockBackend?.script ?? []).map((e: any) => ({ ...e, toolCalls: e.toolCalls?.map((tc: any) => ({ ...tc, args: substitute(tc.args, o.env) })) }));
  let resolver: (s: string) => HandleId = s => s;
  const backend = new MockBackend(script, s => resolver(s));
  const fsro = new FsReadonlyProvider(o.env.ws); const fsany = new FsAnyProvider(o.env.ws);
  const providers = o.providers ?? [fsro, new MemoryContextProvider([{ content: 'CAK 记忆条目：把不变的做进内核', cacheKey: 'm1' }]), new TextSummarizeProvider()];
  const plugins: Plugins = { controllers: { 'simple-react': cfg => simpleReact(cfg) }, backends: { 'mock-backend': backend }, providers, interceptors: o.interceptors ?? [new SafeFileGuard(4096)], observers: [obs] };
  const kopts: KernelOptions = { ledgerStore: o.persistent ? new FileLedgerStore(o.env.ledgerFile) : new MemoryLedgerStore(), signKey: 'e2e' };
  const k = await Kernel.compose(spec, plugins, kopts);
  resolver = symbolResolver(k);
  const rebind = (k2: Kernel) => { resolver = symbolResolver(k2); };   // 重新装配后句柄 id 变了：让 mock 后端的 $h.* 指向新内核
  return { k, obs, backend, fsro, fsany, plugins, kopts, spec, rebind };
}
export function substitute<T>(v: T, env: RunEnv): T { return JSON.parse(JSON.stringify(v).replaceAll('$outside', env.outside)) as T; }
export const taskEvents = (k: Kernel, taskId: string) => k.ledger.all().filter(e => e.taskId === taskId).map(e => e.type);
