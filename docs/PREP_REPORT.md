# 准备阶段报告（2026-08-17）

用户指令：「由你来开发，现阶段先不着急，做好充足准备再开始」→「那你把需要准备的都准备好吧」。
状态：**准备完成，未开工。** 未写任何内核正式代码；仓库里只有判据、原型、Schema、工具与文档。

## 一次跑完的核实（`npm run prep:all`，2026-08-17 17:45）

| 项 | 结果 |
|---|---|
| 测试向量交叉校验 `tools/check-vectors.mjs` | **56 ✓ / 0 ✗**；其中 5 个审批摘要向量由 **Python 独立实现**重算一致 |
| 契约 schemaDigest `tools/digest.mjs --check` | 8 个内置契约，mismatched 0，幂等 |
| Schema `tools/check-schemas.mjs` | AgentSpec 示例 2/2、PluginManifest 示例 5/5、事件 4/4 通过；6 个反例全部被拒；8 个契约 schema 可编译 |
| 拓扑 `tools/check-topology.mjs` | 30 节点 / 45 允许边 / 21 禁止边 / 10 禁止行为 / 17 不变量；三条主张有边可查 |
| 原型 `spike/run.ts` | **40 ✓ / 0 ✗**：句柄向量 21 条 + 伪造句柄 1 + 单调性 5 对×1000 样本（零反例、每对 ≥50 非空）+ attenuate 4 + 端到端 8（含快照=重放、崩溃恢复、grant 重验、revision 失效、篡改检测）+ 与 AD-1 向量对齐 |
| `tsc --strict` | 03 接口 + spike 零错误 |
| `vitest` | 15 / 15 |

## 交付物位置

```
~/agent-kernel/                       ← 工作区（git 已 init，未提交）
├── docs/design → ~/Desktop/CAK-v0.3设计包   （符号链接，单一事实源；新增 13/14 PluginManifest schema+例）
├── docs/TOOLCHAIN.md · DEVELOPMENT_DISCIPLINE.md · PREP_REPORT.md
├── contracts/builtin/*.json          8 个内置契约（含 schemaDigest）
├── sdk/schemas/events/ledger-event.schema.json   30 种事件类型、19 种 payload 结构
├── tests/vectors/  approval-digest · ledger-chain · contract-digest · handle-attenuation
├── tests/golden/   G1–G8 + README（Mock 后端脚本 + 严格事件序列 + 断言）
├── tests/prep/prep.test.ts           15 项挂到 vitest
├── spike/          ledger.ts · authority.ts · run.ts（抛弃式，M1 不复用代码，只复用结论）
└── tools/          jcs · gen-vectors · check-vectors · digest · check-schemas · check-topology
```

## 原型撞出来的设计发现（已回写设计包）

1. **句柄表必须能从账本重建**（`04 §4.1`）：`handle.*` 事件 payload 要含 contract / holder / caveats / parent / expiresAt；事件 schema 已强制（反例测试：缺字段被拒）。
2. **verify 顺序**：先评估全部非审批 caveat，通过后才看 `requires-approval`（`04 §3` 第 5 步）——否则会为必然被拒的调用发起审批。
3. **mustFinalize 那一步**：只允许 `model.generate@1`，其他 invoke 记 `denied{STEP_LIMIT}`（`06 §7`、`10 N-9`）——写 G6 时发现原文没定。
4. **G1 里的 `invocation.revised`** 只在拦截器真的改了 args 时出现（`06 §8` 已改措辞）。
5. **属性测试要防"空过"**：随机 args 若极少落进子句柄接受集，1000 样本零反例是假安全；已加"每对至少 50 个 child-ok"的断言。

## 诚实的边界

- 原型的句柄表在"崩溃"后没有真的清空重建（注释里写明了简化）；M1 必须按 `04 §4.1` 从折叠重建并测试。
- Golden fixture 的事件序列是**从设计推导**的期望，实现时若发现设计本身遗漏（如某处该多一条 `usage.recorded`），改的是设计与 fixture 一起改，并记 ADR。
- 拓扑的"代码扫描"部分要等有代码；现在只校验了 yaml 自洽。
- 没有引入 lint / 格式化；没有 CI 服务；没有 remote。

## 开工时的第一步（等你说「开工」）

按 `DEVELOPMENT_DISCIPLINE.md`：M1 从 `ledger` 模块开始，先把 `tests/vectors/ledger-chain.json` 与 LG-1…6 挂成正式测试，再写实现。
