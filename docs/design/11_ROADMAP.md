# 11 · 路线（v0.3）

| 里程碑 | 交付 | 退出标准 |
|---|---|---|
| **M0 · Freeze** | 本包 00~12；03 编译；07 Schema 与 08 示例互过；02 拓扑可测 | `09 §3` Freeze Gate 12 条全真 |
| **M1 · 五子系统 + 薄循环（单进程）** | Identity（HMAC 占位）· Contract Registry · Authority（进程内句柄、10 种 caveat、mint/attenuate/verify/revoke）· Ledger（文件账本 + 内存 blob + 折叠 + 快照 + 回执）· Boundary（in-process）· Runtime（Task/Step/Invoke/Composer/`model.generate@1` 内置实现/Guard）· 内置插件（simple-react · mock-backend · fs-readonly · memory-context · file-ledger · console-observer · static-minter · human-approve 夹具）| G1…G6、G8；HV / LG / invoke / hostile 全过 |
| **M2 · 委派与握手** | `ctx.spawn` 子任务 · `agent.invoke@1`（同进程双 Runtime）· 名片生成 · receipt API · plan-execute Controller | G7 通过；双方账本回执互验；预算切片随委派 |
| **M3 · 跨进程** | subprocess 传输（JSON-RPC/stdio）· 签名 token 句柄 · Plugin SDK + 契约测试套 · MCP Adapter（MCP tool → 契约 + 实现，走同一管线） | 同一 Provider in-process 与 subprocess 下契约测试全过；MCP 工具在 G1 变体里跑通；伪造 token 被拒 |
| **M4 · 治理与运营** | 审批控制面接口（读 pendingApprovals、写 grant.issued）· 非对称签名 KeyStore · 账本落 SQLite/PG · Observer→OTel · usage 对账报表 | 危险能力默认要句柄且可审计；杀进程后 awaiting 任务可恢复；token/费用按契约/Provider 归因 |
| **M5 · 网络** | 名片发布适配器 · 跨组织句柄铸造与撤销端点 · remote 传输 · 结算适配 | 两个独立进程 / 主机的 Agent：发现 → 铸窄句柄 → 调用 → 回执互验 → 账本对账 |

不提前做：名片簿服务、计费系统、审批 UI、wasm、分布式调度。
放行规则：每个里程碑由用户放行；Coding Agent 只在 ①里程碑 ②花钱 ③不可逆 时停下问。
