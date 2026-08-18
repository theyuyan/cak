# Composable Agent Kernel v0.3 — 白纸设计：五件不变的事是内核，循环只是消费者

> 状态：**设计提案（与 v0.2 并列供对比；采纳后成为 Phase 0 基线）**
> 记法：TypeScript 参考记法（`03_INTERFACE_CONTRACTS.ts`）；机器规范 `02_TOPOLOGY.yaml`
> 与 v0.2 的关系见 `10_DECISIONS.md`：什么保留、什么换掉、为什么

---

## 0. 一页纸

**内核 = 五个子系统**：**Identity（身份）· Contract（契约）· Authority（授权）· Ledger（账本）· Boundary（边界）**。
它们十年后依然需要，不管模型多聪明。运行循环（Runtime Loop）只是这五个子系统的一个消费者，故意做薄。

三条与 v0.2 不同的主张：

1. **一切可调用的东西都是 Capability，模型也不例外。** `model.generate@1` 是一个契约；渲染 prompt 的"ModelGateway"只是它的内置实现。模型是数据出域的主路径，必须和 shell、文件、外部 API 过同一道门。
2. **授权靠句柄（Capability Handle），不靠按名字查规则。** 内核发出不可伪造、可收窄、可撤销的句柄；Agent 只能用它持有的句柄发起调用；委派 = 收窄；长期授权 = 一个更窄的句柄。策略引擎只在**发句柄时**运行，热路径上内核只做**验证**。
3. **账本是唯一事实源。** 每个状态变化是一条 append-only、hash 链接的事件；状态 = 对账本求折叠（fold）；快照只是折叠的缓存；挂起 / 恢复 = 停止追加 / 从折叠继续；审计 = 账本本身；跨组织回执 = 签过名的账本片段；结算 = 对 usage 事件求和。

它们的共同后果：**Agent 互联（发现 · 信任 · 委派 · 追责 · 结算）不是贴在墙上的功能，而是从这五个子系统自然长出来的**（§9）。

## 1. 目标与非目标

目标（可验收断言）：

| 目标 | 断言 |
|---|---|
| 可组合 | 同一内核二进制，只换 Agent Spec 得到不同 Agent |
| 可替换 | 换模型后端 / 换存储 / 换 Controller，内核与其他插件改动 = 0 行 |
| 可扩展 | 新增 Capability Provider，`kernel/` 改动文件 = 0 |
| 可治理 | 任何调用都必须出示句柄；句柄外无路径；策略后请求冻结 |
| 可追责 | 任一调用能从账本重建"谁、以谁的名义、凭什么句柄、做了什么、花了多少" |
| 可恢复 | 杀进程再起，从账本折叠继续，不丢已授权的调用 |
| 可隔离 | 任意插件抛错 / 挂死 / 返回垃圾，内核不崩，错误到达调用方 |
| 可互联 | 两个独立进程的 Agent 通过名片互相发现，凭句柄按契约调用，双方账本可对账 |

非目标（v0.3 的第一个实现 = "v0.3-M1"）：不做分布式多节点、不做审批 UI、不做计费系统、不做名片簿服务本身、不做 wasm / remote 传输（in-process + subprocess）、不做签名密钥基础设施（接口与字段留位）。

## 2. 五个子系统

```
┌────────────────────────────── KERNEL ──────────────────────────────┐
│  Identity      Contract       Authority        Ledger     Boundary  │
│  谁·以谁名义    能力=契约       句柄·收窄·撤销    事实源      DTO 越界   │
│  ─────────────────────────────────────────────────────────────────  │
│  Runtime Loop（薄）：Task 树 · Controller.decide · invoke 管线        │
└────────────────────────────────────────────────────────────────────┘
       ▲ 插件只经边界 DTO 进出：Controller / CapabilityProvider / ModelBackend /
         Store / PolicyMinter / Interceptor / Observer / KeyStore
```

### 2.1 Identity（身份）

- `Principal`：`org` / `user` / `agent` / `runtime` / `task` 五种，可组链：`task ⊂ agent ⊂ user ⊂ org`。
- 每条账本事件、每个句柄、每次调用都绑定 `PrincipalChain`（"谁，以谁的名义"）。
- 签名：`Signer` 内核接口（`sign / verify`），`KeyStore` 是 Provider 角色。M1 只实现进程内 HMAC 占位；跨组织时换成非对称签名，接口不变。
- 跨组织：句柄和账本片段可签名 → 对方能验证"这句柄真是你发的"、"这回执真是你记的"。

### 2.2 Contract（契约）

- `CapabilityContract { name@version, inputSchema, outputSchema, sideEffects, idempotent, permissions, pricing?, schemaDigest }`；`schemaDigest = sha256(JCS({...语义字段}))`（沿用 v0.2 §B）。
- **一切可调用皆契约**：工具（`file.read@1`）、模型（`model.generate@1`）、上下文源（`memory.search@1`）、人（`human.ask@1` / `human.approve@1`）、其他 Agent（`acme.order.lookup@1`，由对方 Agent 的名片发布）。
- Contract ≠ Implementation：Provider 声明"实现 name@version、digest=X"，装配期比对，冲突 fail-fast（沿用）。
- 内置契约包 `contracts/builtin`：`model.generate@1`、`human.ask@1`、`human.approve@1`、`agent.invoke@1`（把任意 Agent 名片上的契约代理为本地调用）、`ledger.query@1`（Controller 读自己的账本视图，read 类）。

### 2.3 Authority（授权）— 能力句柄

**句柄（Handle）** 是内核铸造的不可伪造引用，含：

```
Handle {
  id, contract(ref), holder(PrincipalChain), parent?(HandleId),
  caveats: Caveat[],           // 只增不减：args 谓词 / 路径前缀 / 时间窗 / 预算切片 / 需审批 / 一次性 / 不可再委派 …
  issuedAt, expiresAt?, revocation: { epoch },   // 撤销靠账本事件 handle.revoked
  proof                        // 进程内：不可伪造对象；跨进程：签名令牌（macaroon 风格，caveat 链可验证）
}
```

- **铸造（mint）**：装配期，`PolicyMinter`（Provider 角色）读 Agent Spec 的 `grants` 与策略规则，为 Agent 主体铸造根句柄集。策略引擎**只在这里**运行。
- **收窄（attenuate）**：任何持有者可以从自己的句柄派生更窄的子句柄（加 caveat），不能放宽。**委派 = 收窄后交给子任务 / 子 Agent。** 子 ⊂ 父由构造保证，不靠检查。
- **验证（verify）**：每次 `invoke` 内核做纯验证：句柄真伪 → 持有者匹配当前 PrincipalChain → 未过期未撤销 → 每条 caveat 对最终 args 成立 → 预算切片够用。**热路径上没有规则引擎**，只有确定性验证。
- **动态限制**：`Interceptor(before.verify)` 可以把请求改窄（新 revision）或拒绝，**不能放宽**；`after.verify` 之后一切只读（Mutation Boundary，沿用 v0.2）。
- **审批**：`requires-approval` 是一种 caveat。带它的句柄被调用时，内核记 `invocation.awaiting` 并挂起该调用，直到账本出现 `grant.issued`（由 `human.approve@1` 的提供方或任意具备审批权句柄的主体写入），且 grant 绑定该调用的 `invocationDigest`（JCS+SHA-256，沿用 v0.2 的范围与失效规则）。**长期授权 = 铸造一个没有该 caveat 的更窄句柄**——不需要单独的 Grant Store。
- **撤销**：`handle.revoked` 事件（含 epoch）；后代句柄同时失效；验证时查折叠出的撤销表。

### 2.4 Ledger（账本）

- **append-only，hash 链接**：`Event { seq, prevHash, hash, ts, task, principal, type, payload, sig? }`。按 Task 分段（Task 树 = 段树），全局单调 seq。
- **状态 = fold(events)**。`TaskView`（Controller 看到的一切）、撤销表、预算余额、待审批表、pending 调用表都是折叠出来的投影；`Snapshot = { seq, foldedState }` 只是缓存，可随时丢弃重算。
- **挂起 = 不再追加；恢复 = 从最新快照 + 其后事件重建投影后继续。** 没有 pendingAction cursor 这类第二事实源。
- **回执（Receipt）**：某次调用相关事件的片段 + Merkle 路径 + 签名 → 可交给调用方 / 对方组织验证。
- **计量**：`invocation.executed.usage`（次数 / token / 秒 / 自定义）+ 契约 `pricing?` → 结算就是对账本求和；双方各记一本，回执对账。
- **可观测**：账本就是审计流；Observer 订阅账本尾部；OTel 导出是 Observer 的一种实现。
- 存储：`LedgerStore { append(events) → seq; read(fromSeq, toSeq?); saveSnapshot / loadSnapshot }` + `BlobStore { put(bytes) → digest; get(digest) }`（大对象、Bundle 内容、模型原始响应进 blob，账本只存 digest）。

### 2.5 Boundary（边界）

- 内核私有对象（Task 内部状态、AbortSignal、Provider 代理、缓存）永不出边界；插件只见 DTO（`ControllerContext` / `ProviderCallContext` / `ExtensionCallContext`），全部 JSON 可往返。
- 句柄越界时以**不透明令牌**形式出现（进程内是内核持有的引用表键；跨进程是签名令牌）。插件不能构造句柄，只能持有与转交。
- 传输：in-process → subprocess（JSON-RPC 2.0 over stdio，信封 `cak/1`）→ wasm → remote；标准接口不因传输重写（沿用 v0.2 §C）。

## 3. Runtime Loop（薄）

### 3.1 Task 树

- `Task { id, parent?, goal, principalChain, handles: HandleId[], budget: BudgetSlice, ledgerSegment, status }`。
- 一个"会话"就是一个长命根 Task；子任务 = `spawn`（附带收窄后的句柄集与预算切片）；子 Agent = 一个由 `agent.invoke@1` 代理的远端 Task。
- 预算：句柄 caveat（按调用扣）+ Task 级切片（按任务扣）；超限 → `BUDGET_EXCEEDED`，默认给 Controller 最后一轮收尾（`mustFinalize`，沿用 v0.2 D-14）。

### 3.2 一步（Step）

```
TaskView ← fold(ledger[task])
Controller.decide(ctx: ControllerContext) 
   ctx 内可多次调用 ctx.invoke(handleId, args, opts) —— 每次都走 invoke 管线（§3.3），同步等待或拿到 awaiting
   返回 StepOutcome = continue | finish(output) | fail(error) | await(reason)   （不再有"capability 批"这种 NextAction）
内核根据 StepOutcome 与 TaskView：
   continue → 下一步（预算 / 轮次检查 → 可能 mustFinalize）
   finish   → task.finished
   fail     → task.failed
   await    → task.suspended（等待账本出现唤醒事件：grant.issued / human.answered / timer / external）
```

- **并行 = Controller 里 `Promise.all(ctx.invoke…)`**；内核用 Task 级并发上限与句柄预算约束。不再需要 batch 状态机；"组合授权"由 `before.verify` 拦截器观察同一 step 内已发起的调用集合来实现（列入待定，但有落点）。
- **模型调用就是 `ctx.invoke(modelHandle, { intent, bundleRef })`。** Controller 决定"要不要问模型"，`model.generate@1` 的内置实现决定"怎么问"（渲染），后端插件只做推理。

### 3.3 invoke 管线（唯一执行路径）

```
ctx.invoke(handleId, args)
 → 记 invocation.requested{ id, revision:0, handleId, args, principalChain }
 → Interceptor(before.verify)：可返回新 args（revision+1，记 invocation.revised）或拒绝
 → verify(handle, finalArgs)：真伪 · 持有者 · 期限 · 撤销 · caveats · 预算
      ok            → 记 invocation.authorized{ digest }   → 冻结（Mutation Boundary）
      needs-approval→ 记 invocation.awaiting{ digest, approvalId } → 该调用挂起（step 可继续或 await）
      fail          → 记 invocation.denied{ reason(模型可读), retryable }
 → Interceptor(after.verify / before.execute)：只读；可包裹
 → CapabilityProvider.execute(AuthorizedInvocation, ProviderCallContext)（超时 / 取消 / 幂等重试）
 → Interceptor(after.execute)：只能改结果
 → 记 invocation.executed{ resultDigest, usage } 或 invocation.failed
 → 返回结果给 Controller
```

- `invocation.authorized` 之后 args 冻结；任何试图改写 → `POLICY_INTEGRITY_ERROR`。
- 审批恢复：`grant.issued` 到账 → 内核**不重跑 before.verify**，直接重新 verify 同一 revision（grant 作为已满足的 caveat 输入）→ authorized → execute。Grant ≠ 执行令牌（沿用）。
- 幂等：`write/external` 契约的调用带 `idempotencyKey`（默认 = invocationId），重试不重复副作用。

### 3.4 上下文与模型

- **Composer**（内核服务，非授权路径）：`ctx.compose(spec)` 依据 Agent Spec 的 `context` 配置，用 Task 自己的句柄调用各上下文契约（`memory.search@1` 等，读类，**同样过 verify、同样入账**），确定性排序（stability → priority → source），产出 `ContextBundle`（内容进 blob，账本记 digest）。
- **`model.generate@1` 内置实现（原 ModelGateway）**：输入 `{ intent: ModelCallIntent, bundleRef }`；渲染顺序 `[kernel system] → [intent.instructions] → [bundle by stability] → [intent.messages]`；工具 schema 只注入**当前 Task 持有句柄**对应的契约（句柄即工具目录——不用再"预检策略"）；前缀稳定；调用 `ModelBackend.generate`；记 usage。
- `ModelCallIntent` 形状沿用 v0.2 D-4。

## 4. 组合装配（Composition）

九阶段沿用（Parse → Discover → Validate → Resolve → Bind → Register → Health → Compile → Start），新增两件事：

- **Mint**：`PolicyMinter` 依据 `spec.grants` 为 Agent 主体铸造根句柄集，写入账本 `handle.minted`（装配也是账本事件——实例的"出生证明"）。
- **Manifest**：`spec.manifest` 生成名片（`AgentCard`）：我是谁（principal）、提供什么契约、接受什么句柄类型、怎么联系；发布方式是适配器（文件 / 注册中心 / DNS）。

## 5. 插件角色

| 角色 | 接口 | 说明 |
|---|---|---|
| Controller | `decide(ControllerContext) → StepOutcome` | 唯一业务决策者；只能通过 `ctx.invoke / ctx.compose / ctx.spawn / ctx.attenuate` 与世界交互 |
| CapabilityProvider | `execute(AuthorizedInvocation, ProviderCallContext)` | 工具 / 上下文源 / 人机 / 远端 Agent 代理 |
| ModelBackend | `generate(BackendRequest, ProviderCallContext)` | 只推理；被 `model.generate@1` 内置实现调用 |
| LedgerStore / BlobStore | append / read / snapshot；put / get | 基础设施 |
| PolicyMinter | `mint(spec, principal) → Handle[]`；`shouldAttenuate?` | 装配期铸句柄；可选参与 attenuate 审核 |
| Interceptor | `intercept(stage, payload, ctx)` | `before.verify` 可改窄 / 拒绝；其后只读 |
| Observer | `onEvent(LedgerEvent)` | 账本尾部订阅；不改主流程 |
| KeyStore | `sign / verify / keys` | Identity 用；M1 占位 |

**没有的角色**：ContextProvider（→ 读契约的 CapabilityProvider）、ModelProvider（→ ModelBackend）、PolicyEngine 热路径（→ verify）、StateCoordinator（→ 账本折叠）、SnapshotStore（→ LedgerStore 的缓存）。

## 6. 契约、身份、账本如何互锁（一次调用的证据链）

```
handle.minted(h0: file.read@1, caveat pathPrefix=workspace/, holder=agent A)     ← 装配
handle.attenuated(h1 ⊂ h0, +caveat maxBytes≤4096, holder=task T)                ← 委派给子任务
invocation.requested(i1, h1, args{path:"workspace/x"}, rev0)
invocation.revised(i1, rev1, by=safe-file-guard)                                 ← before.verify 改窄
invocation.authorized(i1, rev1, digest=…, provider=fs-ro)                        ← verify 通过，冻结
invocation.executed(i1, resultDigest, usage{calls:1,bytes:812})
receipt(i1) = 上述事件 + Merkle 路径 + sig(A)                                   ← 可交给任何人验证
```
任何一环缺失，后续事件都无法生成——**证据链是构造出来的，不是事后补的**。

## 7. 错误与状态

- Task 状态：`created → running ⇄ suspended → finished | failed | cancelled | timeout`；invocation 状态：`requested → (revised)* → authorized | awaiting | denied → executed | failed | cancelled`。
- 错误码沿用 v0.2 十表并调整：删除 `SUSPENSION_INVALID`（恢复只是折叠，没有 resumeToken）、`SNAPSHOT_INCOMPATIBLE` 改为 `LEDGER_INCOMPATIBLE`（事件 schemaVersion）；新增 `HANDLE_INVALID`（真伪 / 持有者 / 过期 / 撤销）、`CAVEAT_VIOLATION`（args 不满足）、`ATTENUATION_ERROR`（试图放宽）。

## 8. 安全模型（一句话版）

**没有句柄就没有路径。** 插件不能构造句柄；Controller 只能收窄不能放宽；验证是纯函数；策略只在铸造时运行；一切进账本且可签名。审批、长期授权、委派、撤销、预算全是句柄与账本的组合，不是五套机制。

## 9. 万物互联怎么长出来

| 步骤 | 由哪几个子系统组合而成 | 今天在 M1 里的位置 |
|---|---|---|
| ① 发现 | Contract（名片列契约）+ Identity（名片带 principal） | `AgentCard` 生成；发布适配器 = 文件 |
| ② 信任 | Identity（签名验签） | `Signer` 接口 + HMAC 占位；`KeyStore` 角色 |
| ③ 委派调用 | Authority（对方为我铸一个窄句柄；我 attenuate 后交子任务）+ Contract | `agent.invoke@1` 内置契约（M1 只代理本进程内另一 Runtime） |
| ④ 追责 | Ledger（回执 = 签名片段） | `receipt(invocationId)` API |
| ⑤ 结算 | Ledger（usage 求和）+ Contract（pricing） | `usage` 事件已记；`pricing` 字段已在契约 |

## 10. 仓库结构

```
agent-kernel/
├── kernel/
│   ├── identity/    principal · signer · keystore-port
│   ├── contract/    registry · digest · builtin-contracts
│   ├── authority/   handle · mint · attenuate · verify · caveats · revocation
│   ├── ledger/      event · chain · fold · projections · receipt · stores-port
│   ├── boundary/    dto · transports(in-process, subprocess) · envelope
│   ├── runtime/     task · step · invoke-pipeline · composer · model-generate(builtin impl) · guard
│   ├── composition/ nine-stages · mint · agent-card
│   └── errors/
├── contracts/builtin/   model.generate@1 · human.ask@1 · human.approve@1 · agent.invoke@1 · ledger.query@1
├── sdk/                 interfaces · schemas · plugin-sdk · testing
├── plugins/builtin/     simple-react · mock-backend · fs-readonly · memory-context · file-ledger · console-observer · static-minter
├── examples/            minimal-file-agent · two-agents-handshake
└── tests/               contract · topology · authority · ledger · invoke · hostile · e2e
```

## 11. v0.3-M1 范围

单进程 · in-process 插件 · 句柄为进程内不可伪造对象（跨进程令牌接口留、不实现）· 文件账本 + 内存 blob · HMAC 占位签名 · `model.generate@1` 内置实现 + Mock 后端 · `file.read@1` · `memory.search@1` · `human.approve@1`（测试夹具）· `agent.invoke@1`（同进程双 Runtime）· Golden E2E 6 个 + 双 Agent 握手 1 个。

## 12. 诚实的代价

- 句柄 + 事件溯源比 v0.2 的"规则闸门 + 状态协调器"**实现门槛更高**：折叠投影要设计好，句柄验证要有测试向量。M1 估计比 v0.2 的 Phase 1 多 30–50% 工作量。
- 换来的是：审批 / 长期授权 / 委派 / 撤销 / 预算 / 审计 / 回执 / 结算 **不再是八个功能，而是两个机制**；Agent 互联不需要新架构。
- v0.2 里已经对的部分（契约 digest、Mutation Boundary、审批摘要与失效、DTO 边界、传输信封、拦截器排序、ModelCallIntent、确定性上下文序）**原样保留**，见 `10_DECISIONS.md`。
