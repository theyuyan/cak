# Composable Agent Kernel (CAK)

一个内核，一套插件生态，Agent 之间靠契约互联。
**内核只做五件十年后依然需要的事：身份 · 契约 · 授权 · 账本 · 边界。** 会变的（模型、控制策略、上下文、存储、传输、界面、协议）全是插件。

三条主张：
- **一切可调用皆契约** —— 工具、模型（`model.generate@1`）、上下文源、人（`human.approve@1`）、别的 Agent（`agent.invoke@1`）走同一条 invoke 管线。
- **授权靠句柄，不靠查表** —— 内核铸造不可伪造、只能收窄、可撤销的句柄；策略只在铸造时运行，热路径是纯验证。没有句柄就没有路径。
- **账本是唯一事实源** —— append-only hash 链；状态 = 折叠；挂起 / 恢复 / 回执 / 审计 / 结算都从账本长出来。

## 状态
设计包 `docs/design/`（v0.3）；实现按路线图 **M0–M5 全部完成**（`docs/M1_REPORT.md` … `M5_REPORT.md`）：单进程内核 → 委派与握手 → 子进程 / MCP / 一致性测试 → 治理与运营（审批、Ed25519、SQLite）→ 网络（HTTP、名片、跨组织句柄、注册表、结算）。
`npm test`：14 个测试文件 130 项，判据全部来自设计包与测试向量。

## 快速开始
```
npm install && npm test
npx tsx bin/cak.ts run docs/design/08_AGENT_SPEC.example.yaml \
  --input "读取 workspace/test.txt，然后总结内容。" --workspace examples/minimal-file-agent \
  --mock-script examples/minimal-file-agent/mock-script.json --ledger tmp/ledger.ndjson --verbose
npx tsx bin/cak.ts            # 全部子命令：run · conformance · approvals · approve · report · serve · card · add · statement
```

## 目录
```
docs/design/   设计包（规范：02 TOPOLOGY = 03 CONTRACTS > 01 ARCHITECTURE）      docs/*.md  纪律 / 工具链 / 各里程碑验收报告
kernel/        identity · contract · authority · ledger · boundary · runtime      sdk/       插件可见的边界类型 · 传输协议 · 插件宿主 · 一致性测试套
plugins/       内置插件（controller / backend / provider / interceptor / observer / MCP bridge）   contracts/builtin  内置契约（含 digest）
tests/         vectors（Python 交叉校验）· golden G1–G8 · 各模块 · hostile · topology 扫描 · e2e     bin/cak.ts  命令行入口
```

## 参与
`CONTRIBUTING.md`（DCO 签名、契约先于实现、判据来自设计包）· `GOVERNANCE.md` · `SECURITY.md` · 生态方案 `docs/design/15_PLUGIN_ECOSYSTEM.md`。

## 许可
Apache-2.0（见 `LICENSE`、`NOTICE`）。
