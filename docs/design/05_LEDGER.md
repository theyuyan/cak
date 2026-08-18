# 05 · Ledger：账本协议（事件 · 折叠 · 快照 · 回执 · 计量）

**一句话**：状态 = fold(events)。没有第二个事实源。

## 1. 事件

```
LedgerEvent { seq, prevHash, hash, ts, taskId, principal, type, schemaVersion, payload, sig? }
hash = sha256(JCS({ seq, prevHash, ts, taskId, principal, type, payload, schemaVersion }))
```
- 全局单调 `seq`；`prevHash` 链接前一条（跨 task 也链接，保证全局不可篡改）。
- 大对象不进 payload：Bundle 内容、模型原始响应、工具大输出进 `BlobStore`，payload 只存 digest。
- 事件类型全集见 `03 §4`；每类 payload 的 schema 在 `sdk/schemas/events/*.json`（M1 交付）。

关键事件 payload（摘要）：

| type | payload |
|---|---|
| `handle.minted` | `{ handleId, contract, holder, caveats, expiresAt? }` |
| `handle.attenuated` | `{ handleId, parent, addCaveats, holder }` |
| `handle.revoked` | `{ handleId, epoch, reason? }` |
| `task.spawned` | `{ taskId, parent?, goal, handles[], budget, config }` |
| `task.step` | `{ taskId, index, outcome: continue/finish/fail/await, decisionTrace? }` |
| `invocation.requested` | `{ invocationId, handleId, contract, args, revision:0 }` |
| `invocation.revised` | `{ invocationId, revision, args, by }` |
| `invocation.authorized` | `{ invocationId, revision, digest, effectiveArgs, providerId, budgetCharge? }` |
| `invocation.awaiting` | `{ invocationId, revision, digest, approvalId, expiresAt? }` |
| `invocation.denied` | `{ invocationId, revision, code, reason, retryable }` |
| `invocation.executed` | `{ invocationId, resultDigest, usage?, durationMs }` |
| `invocation.failed` | `{ invocationId, error }` |
| `grant.issued` | `{ approvalId, invocationDigest, grantedBy, expiresAt?, sig? }` |
| `bundle.composed` | `{ bundleRef, stats, sources[] }` |
| `usage.recorded` | `{ invocationId?, contract, providerId, units, cost? }` |
| `receipt.issued` | `{ invocationId, root, sig }` |

## 2. 折叠（Projections）

全部投影是纯函数 `apply(state, event)`；内核内置，可增不可绕：

| 投影 | 用途 |
|---|---|
| `taskView(taskId)` | Controller 看到的一切：句柄目录、调用记录（含 awaiting / denied 理由）、子任务、预算余额、step 索引、mustFinalize |
| `revocations()` | verify 第 3 步 |
| `budgets()` | 按 task / handle 剩余；来自 `invocation.authorized.budgetCharge` 与 `usage.recorded` |
| `pendingApprovals()` | awaiting 且未 grant / 未过期 |
| `invocation(id)` | 单条调用全生命周期 |
| `handleTree()` | 句柄父子（撤销级联、回执） |

**禁止**：任何投影之外的可变运行时状态被用于决策（如独立 pending 表、cursor）。缓存可以，但必须能从账本重算且测试证明相等。

## 3. 快照

`LedgerSnapshot { schemaVersion, atSeq, atHash, projections }` — 只是缓存。
恢复：`loadSnapshot` → 校验 `atHash` 与账本一致 → 从 `atSeq+1` 重放 → 继续。快照丢失或不兼容 → 从头重放（`LEDGER_INCOMPATIBLE` 只在事件 schemaVersion 无法迁移时抛）。

## 4. 挂起 / 恢复 = 停止追加 / 继续追加

- `StepOutcome.await` → `task.suspended{reason, until?}`；进程可以退出。
- 唤醒事件：`grant.issued` / `human.answered` / `task.finished(child)` / 定时器 / 外部 `event.publish` → `task.resumed` → 下一 step 从折叠继续。
- 审批恢复：内核对 awaiting 的 invocation **重新 verify**（不重跑 before.verify）→ 继续执行 → 结果进账本 → 下一 step Controller 在 `view.invocations` 里看到结果。

## 5. 回执（Receipt）

`receipt(invocationId)`：取该调用相关事件（requested…executed + 相关 handle.* + grant.*），构造 Merkle 树，用 runtime 主体密钥签根。
验证方：重算各事件 hash 与 Merkle 根 → 验签 → 得到"谁、凭什么句柄、做了什么、花了多少"的不可否认证据。跨组织时双方各持一份，对账即比对 receipt。

## 6. 计量与结算

- 每次 `invocation.executed` 附 `usage`（Provider 报或内核算）；`model.generate@1` 内置实现记 token。
- 契约 `pricing?` × usage = 费用（可选）；`budgets()` 投影按 handle / task 扣减。
- 结算方式（预付 / 后付 / 内部转账）**不在内核**；内核保证账本可对账。

## 7. 存储接口

`LedgerStore { append, read(fromSeq,toSeq?,filter), head, saveSnapshot, loadSnapshot }`、`BlobStore { put, get }`。
M1：文件账本（NDJSON，每行一事件，启动时验链）+ 内存 blob。生产可换 SQLite / PG / 对象存储，接口不变。

## 8. 测试向量

- **LG-1** 追加 N 条 → 任意改一条 payload → 验链失败 `LEDGER_CORRUPT`。
- **LG-2** 同一事件序列两次折叠 → 投影字节级相同。
- **LG-3** 快照 + 重放 = 全量重放（深比较）。
- **LG-4** 杀进程（在 awaiting 状态）→ 重启 → grant 到账 → 调用完成；账本无重复副作用（idempotencyKey）。
- **LG-5** receipt 验证：篡改任一事件 → 验证失败。
- **LG-6** usage 求和 = budgets 投影扣减量。
