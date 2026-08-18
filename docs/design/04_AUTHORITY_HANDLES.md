# 04 · Authority：句柄协议（mint / attenuate / verify / revoke / approval）

**一句话**：没有句柄就没有路径。策略引擎只在铸造与收窄时运行；热路径上的 `verify` 是纯函数。

## 1. 句柄的生命

```
Agent Spec.grants ──PolicyMinter.mint──▶ 根句柄 h0（holder = [agent, user?, org?]）        账本 handle.minted
h0 ──Controller.attenuate(+caveats)──▶ h1 ⊂ h0（holder 可改为 [task, agent, …]）             账本 handle.attenuated
h1 ──ctx.spawn(child, [h1])──▶ 子任务持有 h1                                                   账本 task.spawned
h1 ──ctx.invoke(h1, args)──▶ verify ──▶ authorized / awaiting / denied                          账本 invocation.*
h0 ──revoke──▶ h0、h1 及所有后代同时失效                                                       账本 handle.revoked
```

## 2. Caveat 语义

| kind | 验证规则 | 典型来源 |
|---|---|---|
| `args.match{schema}` | `effectiveArgs` 必须通过该 JSON Schema（子集断言） | 铸造：限定模型名 / 只读模式 |
| `args.prefix{path,prefix}` | `get(args,path)` 是字符串且以 `prefix` 开头（规范化后） | 文件路径限 `workspace/` |
| `args.max{path,max}` | `get(args,path) ≤ max` | maxBytes / maxResults |
| `time.window` | `notBefore ≤ now < notAfter` | 临时授权 |
| `budget{slice}` | 该句柄累计消耗 + 本次预估 ≤ slice（消耗来自账本 usage 折叠） | 每个子任务的预算切片 |
| `requires-approval{approver,ttl}` | 需要账本中存在匹配 `invocationDigest` 且未过期的 `grant.issued` | 高危操作 |
| `once` | 该句柄在账本中尚无 `invocation.authorized` | 一次性令牌 |
| `no-delegate` | `attenuate` 时拒绝 | 不许再转交 |
| `provider{providerId}` | 路由锁定该实现 | 合规要求用特定后端 |
| `custom{name,params}` | 由 PolicyMinter 注册的确定性验证器解释；**必须是纯函数**，输入只有 (caveat, args, projections) | 领域规则 |

**收窄的单调性**：`attenuate(parent, add)` 的结果 `child.caveats = parent.caveats ∪ add`。子句柄接受的 args 集合 ⊆ 父句柄接受的集合，**由构造保证**。`onAttenuate` 只能进一步拒绝，不能删 caveat。

## 3. verify 算法（纯函数）

输入：`handle`, `principalChain`, `args`, `satisfiedGrants[]`, `projections`（撤销表 / 预算 / 已授权计数）
输出：`VerifyResult`

```
1. 句柄真伪：进程内查引用表；跨进程验签 token 与 caveat 链          → 否则 HANDLE_INVALID
2. 持有者：principalChain 必须以 handle.holder 为后缀（task ⊂ agent ⊂ …）→ 否则 HANDLE_INVALID
3. 撤销：handle 及祖先 epoch 均未出现在撤销表                          → 否则 HANDLE_INVALID
4. 期限：issuedAt ≤ now < expiresAt                                       → 否则 HANDLE_INVALID
5. caveats：逐条评估（含祖先链上的全部 caveat）；**先评估全部非审批 caveat，全部通过后才看 `requires-approval`**（不为必然被拒的调用发起审批）
     requires-approval：若 satisfiedGrants 含匹配 digest 且未过期 → 视为满足；否则返回 needs-approval（不算 denied）
     budget：预估消耗超切片 → BUDGET_EXCEEDED
     其他不满足 → CAVEAT_VIOLATION（reason 对模型可读，指出哪条 caveat、期望什么）
6. 通过 → { ok, effectiveArgs（规范化后）, digest, budgetCharge }
```

`digest = sha256(JCS(ApprovalSubjectV1))`，范围：`invocation{id,revision,contract,args,handleId}` + `principalChain` + `provider?`。不进：trace、时间戳、summary、approvalId。

## 4. 审批（requires-approval）

```
verify → needs-approval → 账本 invocation.awaiting{digest, approvalId}
                        → Controller 拿到 InvokeResult{status:"awaiting"}；可继续别的调用，或返回 StepOutcome await
审批方（持有 human.approve@1 句柄的主体 / 系统）→ 账本 grant.issued{approvalId, invocationDigest, grantedBy, expiresAt?}
内核（唤醒）→ 对同一 invocation 同一 revision **重新 verify**（grants 作为输入；不重跑 before.verify）
             → ok → invocation.authorized → execute
             → digest 不符 / 过期 → APPROVAL_INVALID / APPROVAL_EXPIRED
```

**失效规则**（沿用 v0.2，无例外）：revision 变 = grant 失效；句柄变、provider 变也失效（它们在 digest 内）。
**长期授权** = 铸造一个不带 `requires-approval` 的更窄句柄（或带 `time.window`）交给该主体；不需要 Grant Store。
**撤销授权** = 撤销那个句柄。

## 4.1 句柄表的重建（spike 发现）

句柄表（HandleId → Handle）是内核私有引用表，但**它的内容必须能从账本折叠重建**（`handle.minted` / `handle.attenuated` / `handle.revoked` 事件 → `handles` 投影）。重启时：折叠得到句柄定义 → 内核为每个句柄重新附加进程内 proof（`KERNEL` secret）。因此账本里的 `handle.*` 事件 payload 必须包含重建所需的全部字段（contract、holder、caveats、parent、expiresAt），不能只记 id。

## 5. 撤销

`revoke(handleId)` → 账本 `handle.revoked{handleId, epoch}`；折叠出的撤销表按 handleId 记 epoch；verify 第 3 步对句柄及祖先逐个查。后代无需逐个记录——祖先在表里即失效。

## 6. 跨进程句柄（token）— 接口冻结，M1 不实现

- token = base64( JCS({ id, contract, holder, parent?, caveats, issuedAt, expiresAt, epoch }) ) + sig（KeyStore 签，Signer 验）
- 收窄链：子 token 携带父 token 摘要，验签时递归验证；任何一层签名不符 → HANDLE_INVALID
- 撤销：跨进程按 (issuer, id, epoch) 查发行方的撤销列表（`ledger.query@1` 或名片上的撤销端点）

## 7. 测试向量（实现前先写）

- **HV-1** 同一 handle + args 两次 verify 结果字节级相同（纯函数）。
- **HV-2** attenuate 后随机生成 1000 组 args：`child.accept(args) ⇒ parent.accept(args)` 恒成立。
- **HV-3** 试图 attenuate 移除 caveat（构造）→ `ATTENUATION_ERROR`。
- **HV-4** 撤销父句柄 → 子句柄 verify `HANDLE_INVALID`。
- **HV-5** requires-approval：无 grant → needs-approval；有 grant 且 digest 匹配 → ok；revision+1 后旧 grant → APPROVAL_INVALID。
- **HV-6** 插件伪造 Handle 对象 / 伪造 token → HANDLE_INVALID。
- **HV-7** digest 固定向量（含省略字段、Unicode 键序）。
