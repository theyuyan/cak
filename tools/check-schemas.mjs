// 校验：07 AgentSpec schema ← 08 示例；13 PluginManifest schema ← 14 示例；事件 schema ← 向量里的账本事件 + 反例；契约文件自洽（inputSchema/outputSchema 本身是合法 JSON Schema）
import fs from 'node:fs'; import path from 'node:path'; import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js'; import addFormats from 'ajv-formats';
const D = 'docs/design/'; let fails = 0; const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const mk = () => { const a = new Ajv2020({ strict: false, allErrors: true }); addFormats(a); return a; };
const load = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const ydocs = p => YAML.parseAllDocuments(fs.readFileSync(p, 'utf8')).map(d => d.toJS());

let v = mk().compile(load(D + '07_AGENT_SPEC.schema.json'));
ydocs(D + '08_AGENT_SPEC.example.yaml').forEach((d, i) => ok(v(d), `AgentSpec 示例 #${i + 1} (${d?.metadata?.name}) 通过 07 schema ${v.errors ? JSON.stringify(v.errors).slice(0, 200) : ''}`));
v = mk().compile(load(D + '13_PLUGIN_MANIFEST.schema.json'));
ydocs(D + '14_PLUGIN_MANIFEST.example.yaml').forEach((d, i) => ok(v(d), `PluginManifest 示例 #${i + 1} (${d?.id}) 通过 13 schema ${v.errors ? JSON.stringify(v.errors).slice(0, 200) : ''}`));
ok(!v({ id: 'x', version: '0.3.0', kernelCompat: '^0.3.0', roles: ['model'], entrypoint: { type: 'in-process', module: 'm' } }), 'PluginManifest 反例：v0.2 角色名 model 被拒');
ok(!v({ id: 'x', version: '0.3.0', kernelCompat: '^0.3.0', roles: ['interceptor'], provides: { extensions: [{ id: 'e', kind: 'interceptor', priority: 1, points: ['before.policy'] }] }, entrypoint: { type: 'in-process', module: 'm' } }), 'PluginManifest 反例：v0.2 扩展点 before.policy 被拒');

// events
const ev = mk().compile(load('sdk/schemas/events/ledger-event.schema.json'));
const chain = load('tests/vectors/ledger-chain.json');
chain.events.forEach(e => ok(ev(e), `事件 seq ${e.seq} ${e.type} 通过事件 schema ${ev.errors ? JSON.stringify(ev.errors).slice(0, 200) : ''}`));
const bad1 = { ...chain.events[0], payload: { handleId: 'h' } };            // 缺 contract/holder/caveats
ok(!ev(bad1), '事件反例：handle.minted 缺重建字段被拒（4.1 句柄表重建要求）');
const bad2 = { ...chain.events[2], payload: { ...chain.events[2].payload, revision: 3 } };   // requested 必须 rev 0
ok(!ev(bad2), '事件反例：invocation.requested revision≠0 被拒');
const bad3 = { ...chain.events[0], type: 'invocation.transformed' };
ok(!ev(bad3), '事件反例：未知事件类型被拒');

// contracts self-check: schemas are valid JSON Schema & sample args validate
const cdir = 'contracts/builtin';
for (const f of fs.readdirSync(cdir).filter(x => x.endsWith('.json')).sort()) {
  const c = load(path.join(cdir, f)); const a = mk();
  let good = true; try { a.compile(c.inputSchema); a.compile(c.outputSchema); } catch (e) { good = false; }
  ok(good, `契约 ${c.name}@${c.version}: inputSchema/outputSchema 可编译`);
}
const fr = load(path.join(cdir, 'file.read@1.json')); const frv = mk().compile(fr.inputSchema);
ok(frv({ path: 'workspace/a.txt', maxBytes: 4096 }) && !frv({ path: 'x', maxBytes: 0 }) && !frv({}), 'file.read inputSchema：正例过、maxBytes=0 与缺 path 被拒');
const mg = load(path.join(cdir, 'model.generate@1.json')); const mgv = mk().compile(mg.inputSchema); const mgo = mk().compile(mg.outputSchema);
ok(mgv({ intent: { purpose: 'decide', tools: 'held' }, bundleRef: 'sha256:' + 'a'.repeat(64) }) && !mgv({ intent: { purpose: 'think' } }), 'model.generate inputSchema：purpose 枚举生效');
ok(mgo({ finishReason: 'tool_calls', toolCalls: [{ id: 'c1', handle: 'h_1', args: { path: 'w' } }] }) && !mgo({ finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'file.read', args: {} }] }), 'model.generate outputSchema：toolCalls 用 handle 不用 name');
console.log(fails ? `\nFAILED: ${fails}` : '\nall schemas OK'); process.exit(fails ? 1 : 0);
