# Composable Agent Kernel v0.3 — 白纸设计包

与 `../CAK-v0.2设计包/` 并列，供对照。**v0.2 = 在 Codex 骨架上做对的修订；v0.3 = 从"一个内核 + 一套插件生态 + Agent 万物互联"这个目标出发的白纸设计。** 采纳哪一版由用户决定；采纳 v0.3 后本包成为 Phase 0 基线。

## 一页纸

内核 = **Identity · Contract · Authority · Ledger · Boundary** 五个子系统；Runtime Loop 是消费者，故意薄。
三条主张：**一切可调用皆契约（模型不例外）· 授权靠句柄不靠查表（策略只在铸造时跑）· 账本是唯一事实源（状态 = 折叠）**。
后果：发现 / 信任 / 委派 / 追责 / 结算从这五个子系统长出来，不需要新架构。

## 文件

| # | 文件 | 效力 |
|---|---|---|
| 00 | `00_README.md` | — |
| 01 | `01_ARCHITECTURE.md` — 主文档（一页纸 / 五子系统 / 薄循环 / 互联怎么长出来 / 代价） | 文字规范 |
| 02 | `02_TOPOLOGY.yaml` — 30 节点 / 45 允许边 / 21 禁止边 / 10 禁止行为 / 17 不变量 | 机器规范（最高） |
| 03 | `03_INTERFACE_CONTRACTS.ts` — 全部接口（`tsc --strict` 通过） | 机器规范（最高） |
| 04 | `04_AUTHORITY_HANDLES.md` — 句柄：caveat 语义 / verify 算法 / 审批 / 撤销 / token / 测试向量 | 高 |
| 05 | `05_LEDGER.md` — 事件 / 折叠 / 快照 / 挂起恢复 / 回执 / 计量 / 测试向量 | 高 |
| 06 | `06_RUNTIME_LOOP.md` — Task 状态机 / Step / Invoke 管线 / 模型即调用 / Golden 序列 | 高 |
| 07/08 | Agent Spec Schema（v1beta1）+ 两个示例（已实测通过；v0.2 的 `capabilities.allow` 会被拒） | 高 / 示例 |
| 09 | `09_TEST_ACCEPTANCE.md` — 分层测试 / G1…G8 / Freeze Gate 12 条 | 高 |
| 10 | `10_DECISIONS.md` — 换掉的 8 项（含理由）/ 保留的 / 新增的 / 待定 / 风险 | 中 |
| 11 | `11_ROADMAP.md` — M0…M5 | 中 |
| 12 | `12_PROMPT_FOR_CODING_AGENT.md` | — |
| 13/14 | Plugin Manifest Schema（v1beta1：九种角色、八个扩展点）+ 五个示例（已实测通过；v0.2 的角色名 / 扩展点被拒） | 高 / 示例 |
| 15 | `15_PLUGIN_ECOSYSTEM.md` — 插件生态建设方案：契约治理 / DX / 分发 / 信任分级 / 激励 / 冷启动 / 与内核里程碑对齐 / 六个健康数字 | 中 |

## 工作区与准备阶段

代码工作区在 `~/agent-kernel/`（`docs/design` 符号链接指向本包）。准备阶段已完成：测试向量（Python 交叉校验）、Golden fixture G1–G8、抛弃式原型（句柄 + 账本，40/40）、事件 Schema、内置契约（含 digest）、工具链与开发纪律——见 `~/agent-kernel/docs/PREP_REPORT.md`。一条命令核实：`cd ~/agent-kernel && npm test`。

## v0.2 → v0.3 十秒对照

| | v0.2 | v0.3 |
|---|---|---|
| 内核主体 | 一轮循环 | 五个子系统 |
| 模型调用 | ModelGateway 特权路径 | `model.generate@1` 契约，过同一管线 |
| 授权 | PolicyGate 规则引擎（热路径） | 句柄：mint 时策略，热路径纯验证 |
| 委派 / 长期授权 / 撤销 | 三套机制（parentRequestId / Grant Store / 待定） | 一个机制：attenuate / 更窄句柄 / revoke 事件 |
| 状态 | State + Snapshot + Events + cursor | 账本折叠 |
| 能力调用 | `NextAction.capability[]` + 批状态机 | `ctx.invoke`（可并行）+ `StepOutcome` |
| 单位 | Session / Turn | Task 树 / Step |
| 上下文源 | 独立角色 | 读契约的能力 |
| 互联 | 三个 `[RESERVED]` 字段 | 五步各有落点（`01 §9`） |
| 实现门槛 | 低 | 高 30–50%（`10 §E`） |

## 图

`../CAK-v0.2架构图/Agent内核v0.3.html`（含 PNG）。图是视觉参考，不是规范源。
