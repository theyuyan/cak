# 16 · 内核接口面冻结（v0.3，2026-08-18）

> 起因：三轮 cak-code dogfood 撞出 5 处内核改动（3 个 bug、2 个"为了应用顺手"加的能力）。用户提出：**不能因为插件去改内核，否则以后插件适配不了就改内核，内核会失控。** 本文把这条线划死，并用 `tools/api-surface.mjs` + `tests/api-surface/surface.test.ts` 钉住——接口面一变测试就红。

## 1. 什么算"内核接口面"

| 面 | 位置 | 说明 |
|---|---|---|
| SDK 类型 | `sdk/types.ts` 全部导出符号 | 插件、控制器、后端、观察者、Minter 看到的唯一世界 |
| Kernel 公开方法 | `kernel/runtime/kernel.ts` 非 private 方法 + `controlPlane()` 返回的键 | 宿主应用（如 cak-code、`bin/cak`）用的入口 |
| 账本事件类型 | `LedgerEventType` | 事件是事实源，改语义等于改历史 |
| 错误码 | `KernelErrorCode` | 插件/宿主按码分支 |
| Caveat 种类 | `Caveat.kind` | 授权语言 |
| 传输协议 | 信封版本 `cak:"1"` + `METHODS` | 跨进程插件的线协议 |
| 内置契约 | `contracts/builtin/*.json` | 已由 schemaDigest 锁定，不在此重复 |

指纹快照：`tests/api-surface/surface.json`（`node tools/api-surface.mjs --update` 重写）。

## 2. 分级

**Stable**（改签名 = 破坏性变更，走 §3 流程）：
- `sdk/types.ts` 全部导出符号（下列例外除外）
- Kernel：`compose · startTask · resume · grant · deny · revoke · controlPlane{pending,grant,deny,resume,revoke} · usageReport · pendingApprovals · receipt · taskView · waitFor · mint`
- 账本事件类型、错误码、Caveat 种类、传输信封与方法：**只增不删不改义**

**Experimental**（可改，但改了也要更新快照并在 10_DECISIONS 留一行；不需审批）：
- Kernel：`standing · preview · controlPlane{handles,standing}`（N-28/29，cak-code 逼出来的，先观察一轮再定）
- Kernel：`card · trustPeer · serve · taskReceipt`（M5 网络层，还没有第二个真实对端）
- `ControllerContext.preview`、`ModelCallIntent.cache`
- `resetStats`（测试用，不承诺）

## 3. 改内核的规矩

1. **插件适配不了 → 默认改插件或出新契约版本，不是改内核。** 内核有 7 类扩展点（契约 / Provider / Controller / 拦截器 / 观察者 / Minter / 后端），先证明它们解决不了。
2. **内核只为两种事改行为**：违反已写明不变量的 bug、安全漏洞。这类改动不改签名，不需审批，但要有回归测试 + 10_DECISIONS 条目。
3. **新增 Stable 能力**：先写 10_DECISIONS 条目（含"为什么扩展点不够"），只增不改，旧接口不删只标弃用；更新快照；**由项目所有者（用户）点头**——在有第二个维护者之前，我不能自己批自己。
4. **破坏性变更**：主版本号 +1，至少一个小版本的弃用期，弃用期内旧接口照常工作并在账本记 `plugin.degraded`/日志警告。
5. **Experimental 转 Stable 的条件**：至少两个不同的宿主/插件用过它，且一轮 dogfood 内核零改动。

## 4. 现状与下一道门

- 四轮 dogfood 内核缺口 3 → 2 → 1 → **0**（第四轮：修埋入 bug 的任务，10 次调用、零失败、修在正确位置；内核零改动）。
- **2026-08-18 标 `kernel-1.0.0-rc.1`**（git tag）：Stable 面自此按 §3 走。再一轮不同类型任务的 dogfood 零改动 → 1.0.0。
- 第四轮的教训记在插件层不在内核：agent 的修法全绿 ≠ 修对（`replaceAll(str,str)` 解释 `$&`），已补回归测试；验收 agent 产出要有人/第二个 agent 复核，不能只看测试颜色。
- 从今天起，所有 kernel/ 目录的改动在 PR/commit 里必须写明属于 §3 的哪一条。
