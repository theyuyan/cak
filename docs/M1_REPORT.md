# M1 验收报告 — 五子系统 + 薄循环（单进程）

日期：2026-08-18 · 开发者：Claude · 判据：`docs/design/11_ROADMAP.md` M1 退出标准 + `09_TEST_ACCEPTANCE.md`

## 一条命令核实

```
cd ~/agent-kernel && npm test
```
实测（2026-08-18 09:3x）：**Test Files 8 passed · Tests 100 passed (100)** · `tsc --strict` 0 错误。

| 测试文件 | 用例 | 覆盖 |
|---|---|---|
| tests/ledger | 11 | 账本链向量 · 审批摘要向量 AD-1…6 · LG-1…6（篡改 / 折叠确定性 / 快照=重放 / 崩溃恢复 / 回执 / usage 求和）· 观察者隔离 |
| tests/contract | 8 | 契约 digest 向量 · RG-1…5 · identity 后缀 / HMAC 占位签名 |
| tests/authority | 34 | 句柄向量 HV-1…9（21 条）· 伪造句柄 · AD-1 对齐 · attenuate 5 例 · 单调性 5 对 × 1000 样本零反例（非空 ≥50）· 从账本折叠重建句柄表 + 撤销级联 |
| tests/runtime | 6 | onLimit=fail · Controller 抛错 · step 超时 · 句柄 budget · spawn + attenuate（子任务持有集来自折叠）· 无模型句柄 |
| tests/hostile | 12 | 敌意 Provider 7 种 · Mutation Boundary MB-1/2/3/4/6 · Isolation（越界 DTO 往返、无 Handle/AbortSignal） |
| tests/topology | 6 | 代码扫描：plugins/sdk 不 import kernel · Backend.generate 唯一调用点 · Provider.execute 唯一调用点 · sdk 无 proof/Handle · ControllerContext 无 provider/backend/ledger · 02 yaml 自洽 |
| tests/e2e | 8 | **G1 G2 G3 G4 G5 G6 (+变体) G8**：事件序列 == fixture.strictSequence |
| tests/prep | 15 | 准备阶段全部检查（向量交叉校验 / schema / 拓扑 / spike）继续通过 |

## 用户入口（不是只跑单元测试）

```
npx tsx bin/cak.ts run docs/design/08_AGENT_SPEC.example.yaml \
  --input "读取 workspace/test.txt，然后总结内容。" --workspace examples/minimal-file-agent \
  --mock-script examples/minimal-file-agent/mock-script.json --ledger tmp/ledger.ndjson --verbose
```
实测：装配 5 个句柄 → 28 条账本事件 → `status: finished` · output 摘要 · usage inputTokens=330 · exit 0。
审批场景（`--allow-outside --auto-approve`，同一账本文件二次装配 → 句柄 id 从账本恢复）：挂起 → 打印 approvalId → grant → 恢复 → finished，43 条事件。

## M1 退出标准逐条

| 标准（11_ROADMAP M1） | 结果 |
|---|---|
| Identity（HMAC 占位） | ✅ `kernel/identity`：Principal 链后缀、HmacSigner；回执签名用之 |
| Contract Registry | ✅ digest 校验、冲突 fail-fast、implicit、semver range、确定性路由 |
| Authority（进程内句柄、10 种 caveat、mint/attenuate/verify/revoke） | ✅ 10 种 caveat 全实现（custom 走注册验证器）；从账本重建 |
| Ledger（文件账本 + 内存 blob + 折叠 + 快照 + 回执） | ✅ NDJSON 文件账本启动验链；快照 atHash 校验否则重放；Merkle 回执 |
| Boundary（in-process） | ✅ SDK 只导出 DTO；代码扫描测试守住 |
| Runtime（Task/Step/Invoke/Composer/model.generate 内置/Guard） | ✅ |
| 内置插件 | ✅ simple-react · mock-backend · fs-readonly(+fs-any) · memory-context · text-summarize · safe-file-guard · console/collecting observer · static-minter（默认铸造）· human-approve 以 `kernel.grant()` 夹具形式 |
| G1…G6、G8 通过 | ✅ 8/8（含 G6 变体） |
| HV / LG / invoke / hostile 全过 | ✅ |

## 实现期间对设计的修订（都已回写设计包，含理由）

1. **收尾轮放行 Composer 的上下文读取**（06 §7、10 N-9）：不放行则收尾轮拼不出 Bundle。
2. **上下文源调用入账**导致 Golden 序列多出 `memory.search` 三联事件——设计早就说"上下文读取也是能力、同样入账"，是 fixture 漏了，已按设计改 fixture。
3. **审批恢复不产生额外 `task.step`**：恢复时先完成待审批调用再进下一 step（G3/G8 fixture 修正）。
4. `session.history` 不是契约：会话历史由 Controller 从账本折叠（view.invocations）回喂；示例 Spec 08 已删该行。
5. 句柄收窄给某 task 时，该 task 的持有集由 **`handle.attenuated` 折叠**得出，不在别处 push（单一事实源）。

## M1 明确没做（诚实边界）

- Provider 输出不做 outputSchema 校验（hostile "garbage" 用例只保证不崩）→ 记入待定。
- `usage.recorded` / `receipt.issued` 事件未单独发出（usage 在 `invocation.executed` 里；回执是 API），事件类型保留在 schema。
- 快照只在显式调用时写；未做自动周期快照。
- 幂等重试未实现（`idempotencyKey` 已在 AuthorizedInvocation，重试策略 M2）。
- 敌意 Provider "超大输出" 只保证不崩，未截断/限流。
- spike/ 保留作参考，未再复用其代码。
- 仍无 remote/子进程传输、无真模型后端、无审批控制面（M3/M4）。

## 下一步（等放行）

M2 · 委派与握手：`ctx.spawn` 完整生命周期（父 await child-task 唤醒）· `agent.invoke@1` 同进程双 Runtime · AgentCard 生成 · receipt API 对接 · plan-execute Controller · G7。
