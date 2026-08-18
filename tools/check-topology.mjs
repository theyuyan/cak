// 拓扑文件自洽性（代码扫描部分等 M1 有代码后补）：节点引用存在、allowed∩forbidden 空、每条 forbidden_behavior 有 error、每个 invariant 为 true、
// 三条核心主张对应的边存在/不存在。
import fs from 'node:fs'; import YAML from 'yaml';
const t = YAML.parse(fs.readFileSync('docs/design/02_TOPOLOGY.yaml', 'utf8'));
let fails = 0; const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const nodes = new Set(t.nodes); const key = e => e.join('→');
const A = new Set(t.allowed_edges.map(key)), F = new Set(t.forbidden_edges.map(key));
ok([...t.allowed_edges, ...t.forbidden_edges].flat().every(x => x === '*' || nodes.has(x)), '所有边引用的节点都在 nodes 里');
ok([...F].every(k => !A.has(k)), 'allowed ∩ forbidden = ∅');
ok(t.forbidden_behaviors.every(b => b.id && b.text && b.error), '每条 forbidden_behavior 有 id/text/error');
ok(Object.values(t.invariants).every(v => v === true), '所有 invariants 为 true');
ok(A.has('Execute→CapabilityProvider') && A.has('Execute→ModelGenerateBuiltin') && A.has('ModelGenerateBuiltin→ModelBackend'), '主张①：模型走 Execute→ModelGenerateBuiltin→ModelBackend');
ok(F.has('Controller→ModelBackend') && F.has('Controller→CapabilityProvider') && F.has('ModelBackend→InvokePipeline'), '主张①/②：Controller 不直连后端与 Provider；后端不能发起调用');
ok(F.has('PolicyMinter→Verify') && A.has('PolicyMinter→Mint') && A.has('Verify→Handle'), '主张②：策略只在 Mint；Verify 只读句柄');
ok(A.has('InvokePipeline→LedgerAppend') && A.has('LedgerAppend→LedgerStore') && A.has('LedgerStore→Fold') && A.has('Fold→Projections') && A.has('Projections→Step'), '主张③：调用入账 → 折叠 → TaskView → Step 闭环');
ok(F.has('Controller→LedgerAppend') && F.has('CapabilityProvider→LedgerAppend'), '主张③：Controller/Provider 不能直写账本');
const kernelSide = new Set(t.plugin_boundary.kernel_side), pluginSide = new Set(t.plugin_boundary.plugin_side);
ok([...nodes].every(n => kernelSide.has(n) || pluginSide.has(n)), '每个节点都在边界一侧');
ok(t.forbidden_edges.some(([a, b]) => pluginSide.has(a) && (b === 'Handle' || b === 'KernelState')), '插件侧不得触及 Handle/KernelState 有显式禁止边');
console.log(fails ? `\nFAILED: ${fails}` : `\ntopology OK: ${t.nodes.length} nodes / ${A.size} allowed / ${F.size} forbidden / ${t.forbidden_behaviors.length} behaviors / ${Object.keys(t.invariants).length} invariants`);
process.exit(fails ? 1 : 0);
