# M4 验收报告 — 治理与运营

日期：2026-08-18 · 判据：`11_ROADMAP.md` M4

## 一条命令核实
`npm test` → **12 个测试文件 · 125/125** · `tsc --strict` 0 错误（M1–M3 全部回归）。

## M4 退出标准逐条
| 标准 | 结果 |
|---|---|
| 审批控制面接口（读 pending / 写 grant） | ✅ `Kernel.controlPlane()`：pending / grant / **deny** / resume；`human.approve@1` 提供方（审批也是能力：审批 Agent 用同一管线写 grant，自己账本可追责）；CLI `cak approvals / approve [--deny]` 跨进程操作同一账本 |
| 非对称签名 KeyStore | ✅ `Ed25519Signer`（node:crypto）；`Signer` 接口不变；trust(公钥) 才能验；名片 / 任务回执 / token 句柄全部可用 ed25519；A 信任 B 公钥后可验 B 的回执与名片，不信任则不能 |
| 账本落 SQLite | ✅ `SqliteLedgerStore`（node:sqlite 内置）：append 事务、snapshot、按 task/type query；篡改一行 → LEDGER_CORRUPT；内核直接跑其上 G1 序列不变、重启恢复句柄；CLI `--ledger x.sqlite` |
| Observer → OTel | ✅（**OTel-ready，不是 OTel SDK**）：`MetricsObserver`（计数快照可被任何导出器消费）· `JsonlObserver`（每事件一行，filelog 接收器直接吃）；未引入 OTel 依赖 |
| usage 对账报表 | ✅ `Kernel.usageReport()` 按 task / 契约 / Provider / 句柄，全部由账本折叠；CLI `cak report` |
| 危险能力默认拒绝且全链路可审计 | ✅（M1 起）；M4 补：拒绝审批的理由入账并回喂 |
| 杀进程后挂起任务可恢复 | ✅（M1 G8）；M4 补：跨进程 CLI 恢复（run 挂起 → approvals → approve 恢复完成） |
| token / 费用按契约 / Provider 归因 | ✅ usageReport.contracts / providers |
| M1 遗留：幂等重试 / 输出 schema 校验 / 超大输出限流 | ✅ 全部落地（N-13 / N-14） |

## 用户入口（三条命令，两个进程，同一 SQLite 账本）
```
cak run … --ledger tmp/m4.sqlite --allow-outside     → ⏸ 挂起，approvalId=apr_ac51…
cak approvals <spec> --ledger tmp/m4.sqlite          → apr_ac51…  task=t_bb9d…  file.read  … expires …
cak approve   <spec> --ledger tmp/m4.sqlite --id apr_ac51… --by user:alice   → ✔ 已批准 → status: finished
cak report    <spec> --ledger tmp/m4.sqlite          → 按 task / handles / contracts / providers 的 JSON
```

## 没做
- OTel SDK 真接入（有意不引依赖；`MetricsObserver.snapshot()` / JSONL 已够接 collector）。
- KeyStore 作为独立 Provider 角色（现为 `Ed25519Signer` 类；密钥分发靠 `trust()`；名片交换公钥的自动化在 M5）。
- 审批 UI（协议与 CLI 有，界面无——按设计不属内核）。
- 撤销 API 的控制面入口（`handle.revoked` 事件与验证有；`revoke()` 未挂到 controlPlane —— 补在 M5 跨组织撤销时一起做）。

## 下一步（M5 · 网络）
名片发布 / 发现适配器（文件 / 注册表）· 注册表 R1 索引 + `cak add`（trust-but-verify）· remote 传输（HTTP JSON-RPC）· 跨组织句柄铸造 / 撤销端点 · 结算适配（usage → 对账单）。
