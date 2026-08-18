# 09 · 测试策略与 Freeze Gate（v0.3）

原则不变：判据来自设计包，不来自实现输出；Golden 用固定 Mock 后端，字节级可重复。

## 1. 分层

| 层 | 目录 | 关键用例 |
|---|---|---|
| Authority | `tests/authority` | HV-1…7（`04 §7`）：verify 纯函数、收窄单调（1000 组随机 args）、撤销级联、审批 digest、伪造句柄 |
| Ledger | `tests/ledger` | LG-1…6（`05 §8`）：链校验、折叠确定性、快照=重放、崩溃恢复无重复副作用、回执验证、usage=预算扣减 |
| Invoke pipeline | `tests/invoke` | before.verify 改窄允许 / 放宽被 verify 拒；after.verify 改 args → POLICY_INTEGRITY_ERROR；maxRevisions；超时取消；幂等重试；模型调用走同一管线（无旁路：静态扫描 ModelBackend 只被 ModelGenerateBuiltin 引用） |
| Runtime loop | `tests/runtime` | Task 状态机全部转移；mustFinalize；并行 invoke 受并发上限与预算；spawn 句柄必须为本 task 持有；子任务完成唤醒父 |
| Contract | `tests/contract` | digest 冲突 fail-fast；implicit 契约；实现 digest 不匹配 |
| Boundary | `tests/boundary` | 所有越界类型 JSON 往返；Provider / Controller 拿不到 Handle 对象与 KernelState；句柄只以 id 出现 |
| Topology | `tests/topology` | `02` forbidden_edges 静态扫描 + 集成；invariants |
| Hostile | `tests/hostile` | Provider / Backend / Interceptor / Observer 各：同步 throw、异步 reject、never resolve、忽略 cancel、返回不合 schema、超大对象、改共享对象、double completion、事件洪水 |
| Composition | `tests/composition` | 九阶段 fail-fast；mint 写账本；名片生成 |
| E2E | `tests/e2e` | 见 §2 |

## 2. Golden E2E

| # | 场景 | 断言 |
|---|---|---|
| G1 | 读 workspace/test.txt 并总结 | `06 §8` 事件序列固定；两次运行账本除 ts/seq 外相同 |
| G2 | 读 /etc/passwd（h-file 有 prefix caveat） | `invocation.denied{CAVEAT_VIOLATION}` 理由含"workspace/"；Controller 改路径成功 |
| G3 | 用 h-file-any 读 workspace 外（requires-approval） | awaiting → StepOutcome await → task.suspended → 夹具写 grant.issued → 重新 verify（before.verify 调用次数 0）→ executed；`once` 使第二次 denied |
| G4 | before.verify 拦截器改 maxBytes 4096 | revision=1；Provider 收到 4096；authorized.digest 用 rev1 |
| G5 | 敌意 Provider never resolve | TIMEOUT；任务继续；finish 含失败说明 |
| G6 | maxSteps=2 | step#1 mustFinalize；Controller finish；再 invoke → 拒绝 |
| G7 | 双 Agent 握手（coordinator → minimal-file-agent，同进程双 Runtime） | coordinator 用 agent.invoke 句柄调用；对方为其铸窄句柄；对方账本有 invocation.*；双方 receipt 可互验；usage 双方一致 |
| G8 | 杀进程恢复 | 在 G3 awaiting 时 kill → 重启 → 折叠恢复 → grant → 完成；账本无重复 executed |

## 3. Freeze Gate（全真才冻结）

1. `no_handle_no_path`：静态扫描 + 运行时——所有 Provider 调用点唯一（Execute），且入参必须来自 Verify。
2. `model_is_a_capability`：ModelBackend 仅被 ModelGenerateBuiltin 引用；G1 中模型调用出现在 `invocation.*` 事件里。
3. HV-1…7 全过；收窄单调性随机测试 ≥ 1000 组零反例。
4. LG-1…6 全过；G8 崩溃恢复过。
5. Mutation Boundary：after.verify 改 args 必失败；before.verify 放宽必被 verify 拒。
6. 审批：G3 + HV-5；resume 不重跑 before.verify（计数为 0）。
7. Task 状态机全部转移有测试；mustFinalize 生效（G6）。
8. 契约冲突 fail-fast；名片可生成且含 provides digest。
9. Boundary：越界类型往返；插件拿不到 Handle 对象。
10. G7 双 Agent 握手通过（同进程）；`agent.invoke@1` 走完整管线。
11. 错误码表每个 code 至少一条测试触达。
12. 01 / 02 / 03 / 04 / 05 / 06 对同一事实描述一致（脚本 grep 关键标识符 + 人工）。
