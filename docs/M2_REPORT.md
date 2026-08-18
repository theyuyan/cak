# M2 验收报告 — 委派与握手（同进程）

日期：2026-08-18 · 判据：`11_ROADMAP.md` M2 + `tests/golden/G7.yaml`

## 一条命令核实
`npm test` → **9 个测试文件 · 104/104** · `tsc --strict` 0 错误（含 M1 全部 100 项回归）。

## M2 退出标准逐条
| 标准 | 结果 |
|---|---|
| `ctx.spawn` 子任务完整生命周期（父 await child-task，子完成唤醒父） | ✅ `waitFor(taskId)`；两条路径都测：子先结束的竞态（挂起后立即自唤醒）与慢子任务（真正 suspended → 子结束 → resumed） |
| `agent.invoke@1` 同进程双 Runtime | ✅ `Kernel.serve()`：B 为来访者铸窄句柄（holder=[caller,…B]，once）→ 以来访者名义开任务（主体链含 `agent:coordinator`）→ 来访调用入账 → 跑完 → `invocation.executed` + `receipt.issued`；`AgentInvokeProvider` 只见 `ServeTarget` 接口 |
| 名片生成 | ✅ `Kernel.card()`：principal / provides（契约 digest）/ accepts / endpoints / HMAC 签名（篡改即验签失败） |
| receipt API 对接 | ✅ `taskReceipt()`：任务全部事件 Merkle 根 + 签名，A 拿到 root/sig 可用 B 的 key 验、A 的 key 不可验、少一条事件不可验 |
| plan-execute Controller | ✅ 顺序执行；对 `agent.invoke` 句柄先 `attenuate(+budget calls 1)` 再调用（委派 = 收窄）；G7 A 序列含 `handle.attenuated` |
| G7 通过 | ✅ A/B 两本账的事件序列均 == fixture；usage 双方一致；once 生效；repeatable |
| 双方账本回执互验；预算切片随委派 | ✅ 收窄子句柄 budget calls=1，用后计 1 |

## 开源仓库文件（E-track，等你建 GitHub 组织后直接放）
`LICENSE`（Apache-2.0 官方全文，sha256 cfc7749b…）· `NOTICE` · `CONTRIBUTING.md`（DCO、契约先于实现、判据来自设计包）· `SECURITY.md`（90 天披露）· `GOVERNANCE.md`（维护者产生规则）· `CODE_OF_CONDUCT.md` · `.github/CODEOWNERS` · `.github/workflows/ci.yml`（typecheck + test + DCO 检查）。

## 对设计的修订
- G7 fixture：同进程 `agent.invoke` 由 Provider 同步等待对方任务，不进入 awaiting/suspended（异步版留给跨进程 M3）；A 无 context.sources 故无上下文三联。
- 来访者链定为 `[task, agent:caller, ...被访者链]`（"由我执行、以来访者名义"），使被访者根句柄（holder=[me,…]）对该任务仍有效。
- 06 §6：父 await(child-task) 时若子已结束，挂起后立即自唤醒（竞态处理）。

## 没做
- 跨进程 / 异步 `agent.invoke`（awaiting → 唤醒）：M3 传输之后。
- 名片发布（文件 / 注册表适配器）：M5；现在只是 `card()` 生成。
- 幂等重试、Provider 输出 schema 校验、超大输出限流：仍在待办。
- `agent.invoke` 的 `handleToken`（跨进程签名令牌）：字段在，未实现。

## 下一步（M3 · 跨进程）
subprocess 传输（JSON-RPC 2.0/stdio，信封 cak/1）· 签名 token 句柄 · Plugin SDK + conformance 测试套 · MCP Adapter（`x.mcp.*`）。
