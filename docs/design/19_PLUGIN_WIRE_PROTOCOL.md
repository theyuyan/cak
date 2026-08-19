# 19 · 插件线协议 cak/1（子进程 / 远端插件必读）

任何语言写 CAK 插件，只要实现这一页。参考实现：`sdk/plugin-host.ts`（TS）、`sdk-python/cak_sdk/host.py`（Python，零依赖）；内核侧：`kernel/boundary/subprocess.ts`。

## 传输
- **stdio**：内核 spawn 插件进程；内核 → 插件写 stdin，插件 → 内核写 stdout；**一行一条 JSON（NDJSON）**，`\n` 结尾，UTF-8。stderr 归插件自己（日志），内核不解析。
- **远端**：同一信封走 HTTP（`POST /rpc`，见 N-18），方法不变。
- 信封（JSON-RPC 2.0 + 一个版本字段）：
  ```json
  {"cak":"1","jsonrpc":"2.0","id":1,"method":"plugin.hello","params":{...}}      ← 请求
  {"cak":"1","jsonrpc":"2.0","id":1,"result":{...}}                              ← 成功
  {"cak":"1","jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"…","data":{}}} ← 失败
  ```
  `cak` 必须是 `"1"`；`id` 数字或字符串；错误码沿用 JSON-RPC：-32700 parse / -32600 invalid request / -32601 method not found / -32602 invalid params / -32603 internal / **-32800 cancelled**。

## 方法（内核 → 插件）
其余方法名（`model.generate` / `context.contribute` / `interceptor.intercept` / `event.publish`）是给模型后端 / 上下文源 / 拦截器 / 观察者角色的，同一信封；capability 插件只需下表前五个。
| 方法 | params | result |
|---|---|---|
| `plugin.hello` | `{ kernelVersion: "0.3.x", protocol: "cak/1" }` | `{ pluginId, pluginVersion, protocol: "cak/1", kernelCompat: "^0.3.0", roles: ["capability" \| "controller" …], implementations: [{ contract: { name, version, schemaDigest }, priority }] }`。`protocol` 不是 `cak/1` → 回 -32600。握手超时默认 8 s |
| `plugin.health` | `{}` | `{ status: "healthy" \| "degraded" \| "failed", detail?: string }` |
| `plugin.shutdown` | `{}` | `{}`，然后进程退出 |
| `capability.execute` | `{ call: AuthorizedInvocation, ctx: ProviderCallContext }`（两个都是纯 JSON DTO；`call.args` 已过内核校验与句柄验证） | `ProviderExecuteResult` = `{ output: <符合 outputSchema 的 JSON>, usage?: {…} }` 或 `{ error: { code: "CAPABILITY_ERROR"\|…, message, retryable } }`。**出参多一个字段内核就拒**（`additionalProperties:false`） |
| `cancel` | `{ cancellationId?: string, requestId?: id }` | 通知（不等结果）：`requestId` 让插件丢弃迟到结果；`cancellationId` 转给 provider.cancel |
| `controller.decide`（只对 roles 含 controller 的插件，N-48） | `{ decideId, view, config }` | `StepOutcome`；决策期间插件可向内核发**反向请求** `ctx.invoke / ctx.compose / ctx.preview / ctx.attenuate / ctx.spawn`（params 都带 `decideId`），内核回 result |

内核侧 `capability.execute` 的超时 = 任务 deadline（`ctx.deadlineAtMs`）+ 1 s 兜底；内核 Guard 会先按契约 `defaultTimeoutMs` 超时。

## 类型（与 `sdk/types.ts` 逐字一致）
- `AuthorizedInvocation`: `{ id, revision, contract: { name, version, schemaDigest }, args, handle: { id, contract, caveats[], delegable }, principal: PrincipalChain, digest, idempotencyKey }`
- `ProviderCallContext`: `{ principal, trace: { traceId, spanId }, deadlineAtMs?, cancellationId?, permissions?, metadata? }`

## 最小实现清单（任何语言）
1. 读 stdin 按行 `JSON.parse`；`cak !== "1"` 或无 `method` → 回 -32600。
2. `plugin.hello` 回上表字段；`implementations[].contract.schemaDigest` 必须与契约文件一致（`cak digest <file>` 算）。
3. `capability.execute`：按 `call.contract.name` 分发；永远回 `{output}` 或 `{error}`，不要让进程崩；异常捕获后回 `CAPABILITY_ERROR`。
4. `plugin.health` / `plugin.shutdown` / `cancel` 按表实现（cancel 可空实现）。
5. 验证：`cak conformance --subprocess "<你的命令>" --contract <name> --contracts <契约目录> --args '<sampleArgs>'`。

## 变更纪律
协议只增不改（N-39/N-48）：新方法加在表尾；字段不删不改义；`cak/2` 才允许破坏性变化。`tools/api-surface.mjs` 守卫会数 transport 方法数。
