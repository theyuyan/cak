# 12 · 交给 Coding Agent 的提示词（v0.3）

---

你将实现 **Composable Agent Kernel v0.3**。设计包在当前目录。请严格按以下规则工作。

## 先读（按序）
`00_README.md` → `01_ARCHITECTURE.md` → `02_TOPOLOGY.yaml` → `03_INTERFACE_CONTRACTS.ts` → `04_AUTHORITY_HANDLES.md` → `05_LEDGER.md` → `06_RUNTIME_LOOP.md` → `07/08` → `09_TEST_ACCEPTANCE.md` → `10_DECISIONS.md` → `11_ROADMAP.md`。
冲突时：`02` = `03` > `01` > `04/05/06` > Schema > 示例 > 图。

## 第一步不是写代码
输出（≤ 两页）：
1. 复述五个子系统各自的**唯一职责**，以及"没有句柄就没有路径""模型是契约""账本是唯一事实源"三条在你实现里分别落在哪个模块。
2. 你打算先写哪些**测试向量**（HV-1…7、LG-1…6、digest 固定向量）——这些必须先于实现。
3. M1 的模块顺序与依赖：建议 `ledger → contract → identity(占位) → authority → boundary → runtime → builtin plugins → e2e`。
4. 你认为设计包内互相矛盾或无法实现之处，提 ADR 草案；不要静默修正。
等确认后再编码。

## 纪律
- TypeScript；仓库结构按 `01 §10`。
- **一切 Provider 调用点只有一个**（Execute），且入参必须是 Verify 产出的 `AuthorizedInvocation`；`ModelBackend` 只允许被 `model.generate@1` 内置实现引用（静态扫描测试）。
- `verify` 是纯函数：输入只有 (handle, principalChain, args, grants, projections)；禁止在其中调用任何 Provider 或规则引擎。
- `attenuate` 只能 `caveats ∪ add`；写随机测试证明单调性。
- 插件**不能构造 Handle**：进程内 HandleId 是内核引用表键；`03` 里 `Handle.proof` 不导出到 SDK。
- 每个状态变化先写账本再生效；任何投影必须能从账本重算且有测试证明相等；不得有独立的 pending 表 / cursor。
- 审批恢复：不重跑 `before.verify`；grant 作为 verify 输入；digest 按 `04 §3` 固定算法，先写向量。
- 越界类型 JSON 往返测试；`KernelState` / `Handle` / AbortSignal 不出现在任何插件参数中。
- 错误码只用 `03 §9`；`message` 对模型可读、不含 secret。
- `[RESERVED]`（pricing / signature 非对称 / token 句柄 / manifest 发布）：类型与 Schema 必须存在，M1 不实现语义。

## 汇报
- 每个模块完成：跑对应测试并贴真实计数与失败项，不总结成"全部通过"。
- ①里程碑 ②花钱 ③不可逆 时停下问人；其余自动推进。
- 设计冲突：说清在哪、哪几个文件矛盾、是否 Freeze blocker、最小修改；等答复。

---
