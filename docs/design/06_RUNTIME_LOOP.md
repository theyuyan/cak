# 06 · Runtime Loop：Task · Step · Invoke 管线（薄）

## 1. Task 状态机

```
created → running ⇄ suspended
running → finished | failed | cancelled | timeout
suspended → cancelled | timeout（until 到期且无唤醒 → timeout）
```

## 2. Step（一次 Controller.decide）

```
[Fold] TaskView ← projections.taskView(taskId)
[Guard-pre] maxSteps / budget → 可能 mustFinalize=true（final-step）；deadline → timeout；cancel → cancelled
[Decide] outcome ← Controller.decide(ctx)      // ctx.invoke / compose / attenuate / spawn 期间可多次、可并行
[Record] task.step{index, outcome}
[Guard-post]
   continue → 下一 step
   finish   → task.finished{outputRef} → Outputs
   fail     → task.failed
   await    → task.suspended（等待唤醒事件）
   mustFinalize 时返回 continue/await → task.failed(STEP_LIMIT | BUDGET_EXCEEDED)
```

不再有 `NextAction.capability[]`：能力调用发生在 decide 内部，通过 `ctx.invoke`。并行 = Controller 自己 `Promise.all`，受 `task.maxConcurrentInvocations` 与句柄预算约束。

## 3. Invoke 管线状态

```
requested ─(before.verify 改 args)─▶ revised* ─▶ verify
verify ─ok──────▶ authorized ─▶ (after.verify/before.execute 只读) ─▶ executing ─▶ executed | failed | cancelled
verify ─needs-approval▶ awaiting ─(grant.issued)─▶ verify（同 revision，不重跑 before.verify）
verify ─denied─▶ denied（reason 模型可读，retryable）
```
- `revised` 次数 ≤ `invoke.maxRevisions`（默认 8）→ 否则 `POLICY_INTEGRITY_ERROR{subcode:revision_limit}`。
- `authorized` 之后 args 冻结（Object.freeze + 执行前深比较）。
- 超时：`invokeTimeoutMs` / 契约 `defaultTimeoutMs` / 句柄 `time.window` 三者取最小；超时发 cancel，迟到结果丢弃并记 `invocation.failed{late:true}`。
- 幂等重试：契约 `idempotent=true` 或调用带 `idempotencyKey` 时自动重试 `PROVIDER_ERROR{retryable}`；`attempt` 记入事件。

## 4. 模型调用就是一次 invoke

```
ctx.invoke(modelHandle, { intent, bundleRef })
 → verify（caveats 如 args.match{model}, budget{tokens}）
 → Execute → ModelGenerateBuiltin：
      读 bundle（blob）→ 渲染 [kernel system][intent.instructions][bundle by stability][intent.messages]
      工具 = intent.tools（none / held / 指定句柄）→ 从句柄的契约生成 tool schema（**句柄即工具目录**）
      → ModelBackend.generate(BackendRequest)
      → 把后端返回的 toolCalls{name} 映射回 handleId（名字 = 渲染时给的别名，一一对应）
      → 记 usage
 → 返回 ModelGenerateOutput{content, toolCalls[{handle,args}], finishReason, usage}
Controller 拿到 toolCalls 后逐个 / 并行 ctx.invoke(handle, args) —— 模型永远拿不到执行权
```

## 5. 上下文

`ctx.compose(spec)`：按 Agent Spec `context.sources`（或 spec 覆盖）用 task 句柄逐个 `invoke`（读契约，同样入账）→ 归一化 → 确定序（stability → priority → source → 注册序）→ Bundle 内容进 blob → `bundle.composed{bundleRef}` → 返回 ref。Next step 默认重建；`cacheKey`/`stability` 帮助前缀稳定。

## 6. 子任务与子 Agent

- `ctx.spawn(goal, handles, budget)`：内核校验 handles 全部由本 task 持有（可先 attenuate），预算切片 ≤ 本 task 剩余；`task.spawned`；子任务独立 step 循环；完成 → 父任务的 `view.children` 更新，若父在 `await(child-task)` 则唤醒；**若父挂起时子已全部终态，挂起后立即自唤醒**（M2 实现发现的竞态）。
- 来访调用（`agent.invoke@1` 被访方 `serve`）：被访者为来访者铸窄句柄（holder=[caller, …被访者链]，once）→ 任务主体链 `[task, agent:caller, …被访者链]`（由我执行、以来访者名义）→ 来访调用入账 → 跑完记 `invocation.executed` + `receipt.issued`。同进程 M2 为同步等待；跨进程异步（awaiting）留 M3。
- 子 Agent（跨 Runtime）：`agent.invoke@1` 契约的 Provider 把调用转发到对方 Runtime，附带**收窄后的 token 句柄**（M1 同进程双 Runtime 直接传引用）；对方按自己的账本处理并回执。

## 7. Guard 规则

| 触发 | 默认 |
|---|---|
| maxSteps / task budget 命中 | `final-step`：下一 step `mustFinalize=true`，只许 finish / fail；该 step 内除 `model.generate@1` 与 **Composer 发起的上下文读取**外，Controller 发起的 invoke 一律 `denied{STEP_LIMIT, retryable:false}`（给模型收尾的机会——收尾也需要上下文——不给继续干活的机会） |
| stepTimeoutMs / 任务 deadline | `timeout` |
| cancel | `cancelled`（向所有进行中 invocation 传播 cancel） |
| 句柄 budget caveat 命中 | 该 invoke `BUDGET_EXCEEDED`（denied，retryable=false），任务继续 |

## 8. Golden 序列（G1：读文件并总结）

```
task.spawned(root) → task.step#0
  bundle.composed → invocation.requested(model.generate) → authorized → executed{toolCalls:[file.read]}
  invocation.requested(file.read h1) → [revised 仅当 safe-file-guard 改了 args] → authorized → executed{usage}
  task.step#0{continue}
task.step#1
  bundle.composed → invocation(model.generate) → executed{content: 摘要}
  task.step#1{finish} → task.finished
```
