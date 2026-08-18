# M3 验收报告 — 跨进程

日期：2026-08-18 · 判据：`11_ROADMAP.md` M3 + `09_PROTOCOLS.md §C` + `15_PLUGIN_ECOSYSTEM.md §3/§4/§5`

## 一条命令核实
`npm test` → **11 个测试文件 · 114/114** · `tsc --strict` 0 错误（M1/M2 全部回归）。

## M3 退出标准逐条
| 标准 | 结果 |
|---|---|
| subprocess 传输（JSON-RPC 2.0 / stdio，信封 `cak/1`） | ✅ `sdk/transport.ts`（协议）+ `sdk/plugin-host.ts`（插件端 `servePlugin`）+ `kernel/boundary/subprocess.ts`（内核侧代理）；spawn 用 argv 数组不经 shell；未知信封版本 → -32600、未知方法 → -32601（显式）；子进程死亡 → TRANSPORT_ERROR；坏行不崩 |
| 同一 Provider in-process 与 subprocess 下契约测试全过 | ✅ `plugins/subprocess/fs-readonly.ts` 只是 `servePlugin(new FsReadonlyProvider(root))`；G1 在子进程 Provider 下事件序列与进程内**完全相同**；conformance 两种形态同一组检查全过 |
| 签名 token 句柄 | ✅ `Authority.exportToken / importToken`：JCS 载荷 + 发行者签名；导入 = 验签 + 信任发行者名单 → 入表；篡改 / 错 key / 不信任发行者 / 不可解码 → HANDLE_INVALID；导入后可本地收窄再导出（子 ⊂ 父）；同一调用摘要跨 A/B/C 三处一致（跨进程审批的前提） |
| Plugin SDK + conformance | ✅ `sdk/index.ts`（types / transport / servePlugin / runConformance）；`sdk/conformance.ts` 9 组检查（实现声明·digest·样例合法·执行形状·outputSchema·DTO 往返·args 冻结·幂等·badArgs 不挂·cancel·health·无内核内部）；`cak conformance --subprocess …` 命令行可跑 |
| MCP Adapter（`x.mcp.*`） | ✅ `plugins/builtin/mcp-bridge.ts`：initialize / tools/list / tools/call；工具 → `x.mcp.<server>.<tool>@1.0.0`（implicit 契约，保守 external/非幂等）；fake MCP server 两个工具经同一 invoke 管线调用；未授权的 MCP 工具不在句柄目录（没有句柄就没有路径） |
| 伪造 token 被拒 | ✅ |

## 用户入口
```
npx tsx bin/cak.ts conformance --subprocess "node_modules/.bin/tsx plugins/subprocess/fs-readonly.ts examples/minimal-file-agent" \
  --contract file.read --args '{"path":"workspace/test.txt"}' --bad-args '{"path":"../../etc/passwd"}'
```
实测：`✓ candidate: 14 passed, 0 failed`，exit 0；敌意（never resolve）插件：`✗ 9 passed, 1 failed — C3.completesWithinDeadline`，exit 1。

## 实现期间的修订（已回写 03 / 10）
- N-10 `listContracts?()`：适配器动态发现的工具需要"实现即定义"的路径。
- N-11 内核 Guard 先超时（TIMEOUT），子进程代理只兜底；子进程死亡才是 TRANSPORT_ERROR。
- N-12 conformance 判据收紧：合法样例返回 TIMEOUT/TRANSPORT/INTERNAL/PROVIDER 错误或超期 = 不通过（一个 never-resolve 插件曾"通过"，判据取自被测对象的错误形状是不够的）。

## 没做
- ModelBackend / Interceptor 的 subprocess 形态（协议方法已留：`model.generate` / `interceptor.intercept`），M3 只做了 CapabilityProvider。
- 跨进程 `agent.invoke`（异步 awaiting → 唤醒）：需要两个 Runtime 各在一个进程 + token 句柄传递；M3 只做了 token 句柄本身。
- MCP：只支持 stdio 传输与 tools；resources / prompts / 通知未桥接；协议版本按 `initialize.protocolVersion` 协商但只测了一个 fake server。
- 注册表 R1（Git 索引）与 `cak add`：conformance 已是它的核心；索引格式与签名下一步。
- wasm / remote 传输未做（接口留位）。

## 下一步（M4 · 治理与运营）
审批控制面接口（读 pendingApprovals / 写 grant）· 非对称签名 KeyStore · 账本落 SQLite · Observer → OTel · usage 对账报表 · 幂等重试 / 输出 schema 校验 / 超大输出限流（M1 遗留）。
