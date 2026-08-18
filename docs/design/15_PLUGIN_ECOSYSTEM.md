# 15 · 插件生态建设方案（v0.3 配套）

> 内核回答"能不能装、能不能管"；生态回答**"有没有人来做、做出来能不能被找到、找到了敢不敢用、用了做的人有没有回报、十年后契约还认不认"**。这五问不规划，内核做完就是空壳。
> 路径：内部起步 → 有限开放 → 公开生态。公开 / 开源（建议 Apache-2.0）/ GitHub 三件事已定（§12），落地清单见 §13。

---

## 0. 一页纸

生态 = **契约 × 分发 × 信任 × 激励 × 治理**。内核已经给了三样硬东西：契约（`name@version+digest`）、句柄（没有句柄就没有路径）、账本（每次调用可计量可追责）。生态方案就是把这三样变成**开发者体验、分发渠道、信任分级、结算与声誉、契约治理**五套具体机制，并且**冷启动靠三条腿**：内置插件、MCP 桥、OpenAPI 生成器——不等第三方就有几千个能力可挂。

判据（可验收）：
- 一个陌生开发者，从零到"本地通过契约测试套"**≤ 30 分钟**（`create-cak-plugin` + `cak dev`）
- 任何插件在被启用前必须**在用户机器上跑过契约测试与敌意测试**（trust-but-verify）
- 第三方插件**默认 subprocess**，in-process 只给最高信任级
- 每个契约有**唯一 owner、明确状态（draft/candidate/stable/deprecated）、迁移期**
- 生态健康度有**六个数字**（§9），每季度看

## 1. 生态里有什么（五类成员）

| 成员 | 是什么 | 例 |
|---|---|---|
| **契约（Contract）** | 生态的"标准"本体，可独立于任何实现存在 | `std.file.read@1` · `std.model.generate@1` · `acme.erp.order.query@1` |
| **插件（Plugin）** | 八种角色的实现打包：controller · capability · model-backend · ledger-store · blob-store · policy-minter · interceptor · observer · key-store | `fs-readonly` · `anthropic-backend` · `pg-ledger` |
| **适配器（Adapter）** | 把外部世界包成契约的插件族 | **MCP Bridge**、OpenAPI→契约生成器、CLI 包装器、A2A/其他 Agent 协议 |
| **Agent 名片（AgentCard）** | 一个 Agent 也是生态成员：它发布的契约可被别人调用 | `coordinator` 提供 `acme.report.summarize@1` |
| **工具链（SDK / 模板 / 测试套）** | 让前四类能被做出来、被验证 | `@cak/sdk` · `create-cak-plugin` · `@cak/conformance` |

## 2. 契约治理：生态的宪法

契约是唯一不能"随便"的东西——插件可以烂，契约烂了整个生态跟着烂。

### 2.1 命名空间
| 前缀 | 归属 | 规则 |
|---|---|---|
| `std.*` | 内核维护者 | 经 RFC 进入；破坏性变化必须升 major 并给 ≥ 2 个 minor 的迁移期 |
| `<vendor>.*` | 注册过的组织 | 组织自治；digest 一经发布不可改（改 = 新版本） |
| `x.*` | 任何人 | 实验区；不保证稳定；不得被 `std.*` 依赖 |
| `local.*` | 本机 | 不可发布；`implicit` 契约默认落此 |

### 2.2 生命周期
`draft`（可随时改）→ `candidate`（digest 冻结，≥ 2 个独立实现或 ≥ 1 实现 + 1 真实使用方）→ `stable`（进注册表；破坏性变化只能升 major）→ `deprecated`（标 `sunsetAt` 与 `replacedBy`；内核在 mint 时对 deprecated 契约发 `contract.deprecated` 事件，PolicyMinter 默认仍允许，可配置拒绝）→ `retired`（注册表只读保留 digest 供审计）。

### 2.3 RFC 流程（`std.*`）
一页模板：动机 / 输入输出 Schema / sideEffects 与 idempotent 的理由 / 与现有契约的关系 / 至少一个参考实现 / 至少一个 Golden 用例。**两周评论期**，两位维护者同意进 `candidate`。（两个人的团队照样走：把流程当 checklist，不当仪式。）

### 2.4 兼容规则
- 同 name@version 的 digest 唯一；实现必须匹配。
- minor：只允许 inputSchema **放宽**（新增可选字段）、outputSchema **收紧或新增字段**；patch：只改 description / 示例。
- 破坏性 = 任何会让老调用方失败的改动 → 升 major，新老并存 ≥ 2 minor。
- 内核 `kernelCompat` 用 semver range；内核升 major 时给 `@cak/conformance` 一版迁移向导。

## 3. 开发者体验（DX）：30 分钟从零到通过

```
npx create-cak-plugin my-tool --role capability --contract std.file.read@1
cd my-tool && cak dev
```
`cak dev` 起一个**Mock 内核宿主**：装载插件 → 跑 `@cak/conformance`（契约测试：schema 往返、幂等、超时取消、敌意用例、边界 DTO 往返、拓扑不可达 KernelState）→ 跑 Golden 变体（把插件替进 G1）→ 输出一份 `conformance-report.json`（后面进注册表和信任分级）。

模板给到：八种角色各一个可运行示例 · README 只写"你要实现什么、能拿到什么、拿不到什么" · 契约声明用 `provides.implementations[].contract` 引用 digest，不复制 schema · CI 模板（一条 `cak conformance`）。

**原则**：插件作者**看不到内核内部**（`Handle` / `KernelState` / 其他插件），SDK 类型里就没有；他只见 `AuthorizedInvocation` / `ProviderCallContext` / `ExtensionCallContext`。这既是安全，也是"文档少一半"。

## 4. 分发与发现

### 4.1 三阶段注册表
| 阶段 | 形态 | 何时 |
|---|---|---|
| R0 本地目录 | `~/.cak/plugins/<id>/manifest.yaml`；`cak add ./path` | M1–M2 |
| R1 Git 索引 | 一个仓库里的 `index.json`（manifest 摘要 + 源地址 + conformance 报告 digest + 签名）；`cak add <id>` 拉取 | M3 |
| R2 托管注册表 | HTTP API + 镜像；同一 `index.json` 契约；支持 yank / deprecate | M5 / 开放时 |

### 4.2 `cak add` 做什么（trust-but-verify）
解析 manifest → 校验签名（若有）与 `kernelCompat` → **在本机跑 conformance**（不信报告只信本机结果）→ 校验契约 digest 与注册表一致 → 按信任级决定传输（§5）→ 账本记 `plugin.installed{id, version, digest, tier, conformance}` → 启用。任何一步失败 = 不启用，且给出人能看懂的原因。

### 4.3 发现
- 插件：注册表按契约反查（"谁实现了 `std.file.read@1`"），这比按插件名搜有用得多。
- Agent：`AgentCard` 发布到同一注册表的 `agents/` 段（`principal + provides + endpoints + sig`），发现协议本身是适配器（文件 / 注册表 / DNS）。
- MCP：MCP 服务器目录经 Bridge 自动映射为 `x.mcp.<server>.<tool>@1`（`x.` 区，实验级），要"转正"必须走 RFC 变成 `std.*` 或 `<vendor>.*`。

## 5. 信任分级与安全

| 级 | 条件 | 默认传输 | Minter 默认 |
|---|---|---|---|
| **T0 未验证** | 只有 manifest | 只允许 subprocess；`in-process` 拒绝启用 | 只发 `sideEffects ∈ {none, read}` 的句柄；`external` 必带 `requires-approval` |
| **T1 通过一致性** | 本机 conformance 全过 | subprocess | 同 T0，允许 `write` 但带 `once`/`budget` |
| **T2 已签名 + 评审** | 维护者签名 + 人工评审记录 | subprocess（可申请 in-process） | 按 Spec 正常铸 |
| **T3 内核认证（std）** | 内核仓库内维护、随内核发版 | in-process | 按 Spec |

配套：**沙箱适配器**接口（容器 / seccomp / wasm 后续）；**Secret 只走 secretRef**（插件 config 里禁明文，conformance 会扫）；**漏洞披露渠道** + `plugin.yanked` 事件；**审批疲劳防线**：Minter 默认把同一 Task 内重复的 `requires-approval` 折叠成一次"批准此类操作 N 次 / 到期"的窄句柄，而不是弹 N 次。

安全总原则不变：**没有句柄就没有路径**。信任级只决定"插件跑在哪、默认拿多宽的句柄"，不决定"能不能绕过验证"——谁都不能。

## 6. 经济与激励

- **计量已经免费**：`usage.recorded` 按契约 / Provider 归因；契约 `pricing?` 字段已在。
- **结算是适配器**（M5）：预付额度 / 内部转账 / 真金白银三种适配器，内核只保证账本可对账、回执可互验。
- **声誉不靠打分靠账本**：注册表展示三样可验证的东西——本机 conformance 通过率（多少台机器跑过）、使用量（`usage` 聚合，去标识）、事故记录（`plugin.degraded` / yank 历史）。不做五星评分。
- **非货币激励**：`x.*` 契约被采纳为 `std.*` 时署名；首批"内核认证插件"清单；每季度公布生态健康数字。
- **内部阶段的激励**：先解决自己公司的 5–10 个真实需求（ERP / OA / 工单 / 知识库 / 报表），每个需求 = 一个插件 + 一个契约，用得上就是最大激励。

## 7. 冷启动：三条腿 + 内部真需求

| 腿 | 内容 | 产出 |
|---|---|---|
| ① 内置插件 | 八种角色各至少一个：simple-react / plan-execute · mock-backend + 一个真后端 · fs-readonly · memory-context · file-ledger + sqlite-ledger · console-observer + otel-observer · static-minter · hmac-keystore | 生态"样板间"，也是 conformance 的参考实现 |
| ② MCP Bridge | 一个插件把任意 MCP Server 的 tools 映射成 `x.mcp.*` 契约 + Provider（subprocess） | 第一天有几千个能力；同时验证 subprocess 传输 |
| ③ 生成器 | OpenAPI → 契约 + Provider 骨架；CLI → 契约（stdin/stdout/exit code） | 企业内部系统一天一个 |
| ④ 内部真需求 | 用①②③在自己公司落 5–10 个 Agent（每个都是一张名片 + 若干契约） | 真实 usage、真实事故、真实审批场景 → 反哺 conformance 与 Minter 默认策略 |

**开放前的门槛**（进入 R2 的条件）：≥ 3 个非内核作者的 T1+ 插件、≥ 1 个外部 Agent 名片互调成功、conformance 在 ≥ 2 台非开发机上跑过、契约 RFC 走过 ≥ 2 轮。

## 8. 与内核里程碑对齐

| 内核 | 生态 | 交付 |
|---|---|---|
| M1 五子系统 | **E0** | `@cak/sdk` 类型（只导出边界 DTO）· conformance 规格与首批用例 · 八个内置插件的 manifest |
| M2 委派与握手 | **E1** | `create-cak-plugin` 八角色模板 · `cak dev` Mock 宿主 · R0 本地目录 · AgentCard 生成 |
| M3 跨进程 + MCP | **E2** | MCP Bridge（`x.mcp.*`）· OpenAPI/CLI 生成器 · R1 Git 索引 · 信任级 T0/T1 与 Minter 默认策略 · `cak add` trust-but-verify |
| M4 治理与运营 | **E3** | 签名与 T2 评审流程 · 契约生命周期与 RFC 上线（`std.*` 首批 ≈ 12 个）· 漏洞披露 · 审批折叠 · 健康度看板 |
| M5 网络 | **E4** | R2 托管注册表 + 镜像 · 名片发布 · 结算适配器 · 开放门槛核验 |

## 9. 生态健康度（六个数字，每季度看）

1. **TTFP**（time-to-first-plugin）：新开发者从 `create-cak-plugin` 到本机 conformance 全过的中位时长（目标 ≤ 30 min）
2. **本机验证率**：`plugin.installed` 里 conformance=pass 的比例（目标 100%——因为不过不给装）
3. **原生占比**：非 `x.mcp.*` 契约的调用量占比（健康 = 上升；全是桥接 = 生态没长自己的骨头）
4. **契约集中度**：前 5 个契约占总调用量的比例（过高 = 生态窄；过低 = 契约碎）
5. **迁移时长**：deprecated → 调用量归零的中位天数
6. **事故率**：每万次调用的 `plugin.degraded` + `invocation.failed{PROVIDER_ERROR}`

## 10. 明确不做 / 不先做

不做插件市场 UI（先有索引 JSON）· 不先做货币结算 · 不做"全能插件"（一个插件不该同时是 controller + capability + store）· 不让 MCP 或任何外部协议反向定义 `std.*` · 不给第三方 in-process · 不做五星评分 · 不在开放前设"生态基金"之类空头承诺。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 鸡生蛋：没插件没人来，没人来没插件 | 三条腿冷启动 + 内部真需求，不等外部 |
| MCP 规范频繁变动 | Bridge 是适配器且落 `x.` 区；核心生态不依赖它的稳定 |
| 两个人跑不动治理 | RFC/评审当 checklist；`std.*` 首批控制在 ≈ 12 个；其余放 vendor/x 区自治 |
| 第三方插件出安全事故 | 默认 subprocess + 句柄最小 + 本机 conformance + yank 事件 + 账本可追责 |
| 契约碎片化（十个 `file.read` 变体） | 注册表按契约反查暴露重复；RFC 时强制"与现有契约关系"一节 |
| 审批疲劳让用户闭眼点 | Minter 折叠 + 窄句柄长期授权，把"弹窗"变成"一次性给个范围" |

## 12. 三件事已定（2026-08-18 用户拍板）

| 事项 | 决定 | 落地 |
|---|---|---|
| 是否公开 | **最终公开** | R2 托管注册表要做；`std.*` 治理对外；§7 的开放门槛生效 |
| 许可证 | **开源，希望插件开发者一起维护** | 建议 **Apache-2.0**（内核 · SDK · `std.*` 契约 · 内置插件）：允许商用与闭源插件、带专利授权、企业法务最熟——这三点是"愿意来一起维护"的前提；贡献用 **DCO sign-off**（`git commit -s`）而不是 CLA，门槛最低。第三方插件各自选许可，注册表只要求声明 `license` 字段。**不选** GPL/AGPL（会吓退企业插件作者）、**不选**"源码可见但限商用"类（不算开源，也留不住共同维护者）。若你想保留"内核以后可能有商业版"的选项，现在就该说，因为 Apache-2.0 一旦发布不可收回——我的建议是不留，生态比后门值钱。 |
| 托管 | **GitHub** | 一个组织下三个仓库（§13） |

## 13. GitHub 落地清单（开工时由你建组织与仓库，其余我来）

**组织**：一个 GitHub Organization（名字你定；建议与包名一致，例如 `composable-agent-kernel`）。三个仓库：

| 仓库 | 内容 | 许可 |
|---|---|---|
| `kernel` | 内核 · SDK（`@cak/sdk`）· `@cak/conformance` · 内置插件 · `contracts/std` · 设计包（`docs/design`）| Apache-2.0 |
| `registry` | R1 索引：`index.json`（插件 manifest 摘要 + 源地址 + conformance 报告 digest + 签名）· `contracts/`（`std.*` 与已注册 `<vendor>.*` 的契约文件与 digest）· `agents/`（名片）· RFC 目录 | Apache-2.0（内容）+ CC-BY-4.0（文档，可选） |
| `create-cak-plugin` | 脚手架与八角色模板 | Apache-2.0 |

**每个仓库第一天就有的文件**：`LICENSE` · `NOTICE` · `CONTRIBUTING.md`（DCO、RFC 流程链接、conformance 必过）· `CODE_OF_CONDUCT.md` · `SECURITY.md`（漏洞披露邮箱 + 90 天披露期 + `plugin.yanked` 流程）· `CODEOWNERS`（`contracts/std/**` 只有维护者能合）· `GOVERNANCE.md`（维护者怎么产生：贡献 ≥ N 个被合并的契约/插件 + 现有维护者两票）。

**GitHub Actions**：`kernel` 跑 `npm test`（向量 / schema / 拓扑 / conformance）+ 拓扑代码扫描；`registry` 对每个 PR **重跑被提交插件的 conformance**（不信作者报告）并校验契约 digest；`create-cak-plugin` 对每个模板跑一遍"生成 → conformance 全过"。

**发布**：`kernel` 用 semver tag + GitHub Release + npm（`@cak/*`）；`registry` 的 `index.json` 由 Actions 生成、签名、提交，人不手改；契约进入 `stable` 必须有对应 Release 记录。

**安全底线（沿用你的规则）**：Actions 用最小权限 token；不把任何密钥写进仓库；`registry` 签名私钥在维护者本机 / GitHub OIDC，不进 CI secrets 明文；发布前 `npm pack --dry-run` 看清打包内容。

**现在不做**：不建组织、不建仓库、不推代码——这些是对外动作，等你说开工并由你的账号操作；我只准备文件与流程。

## 14. 判据自查

- 每一条机制都能对应到 §0 的五问之一；对应不上的已删。
- 每一条都能在 §8 找到落地里程碑与交付物。
- 六个健康数字都能从账本 / 注册表算出来，不靠问卷。
