# 10 · 决策：v0.3 相对 v0.2 换了什么、留了什么、为什么

## A. 换掉的（结构性）

| # | v0.2 | v0.3 | 为什么 |
|---|---|---|---|
| S-1 | 内核主体是"一轮循环"，身份 / 账本是 `[RESERVED]` 字段 | **内核 = Identity · Contract · Authority · Ledger · Boundary 五个子系统**，循环是消费者 | 这五件事十年后依然需要；先做主干，互联长在主干上而不是贴在墙上 |
| S-2 | 模型调用经 ModelGateway，绕过 PolicyGate（"Controller 的内部支撑"） | **`model.generate@1` 是契约**，过同一条 invoke 管线；ModelGateway 降为它的内置实现 | 模型是数据出域主路径（sideEffects=external），不该是特权路径；同时工具目录 = 句柄集，不再需要"策略预检" |
| S-3 | PolicyGate = 热路径规则引擎（allow/deny/transform/approval），静态 ACL 按能力名 | **句柄（ocap）**：策略只在 mint / attenuate 时运行，热路径 `verify` 是纯函数；委派 = 收窄；长期授权 = 更窄句柄；撤销 = 事件 | "权限只减不增""Agent as Capability""Grant Store"三件事从一个机制长出来；验证可测试、可复现 |
| S-4 | 事件流 + StateCoordinator/StateChangeSet + RuntimeSnapshot + pendingAction cursor 四套机制 | **账本是唯一事实源**：状态 = fold；快照 = 缓存；挂起 = 停止追加；回执 = 签名片段；结算 = 求和 | 去掉第二事实源；审计 / 恢复 / 追责 / 计量不再是四个功能 |
| S-5 | Session / Turn 为中心；`NextAction.capability[]` 批 + 状态机 | **Task 树 + Step**；能力调用在 `decide` 内经 `ctx.invoke`（可并行）；`StepOutcome = continue/finish/fail/await` | 多 Agent、子任务、并行工具调用自然落地；批状态机消失 |
| S-6 | ContextProvider 独立角色 | 上下文源 = 读契约的 CapabilityProvider；`ctx.compose` 用 task 句柄调用（入账、受治理） | 记忆访问也是"能力"，也该被授权与记账 |
| S-7 | `transform` 效果 | 去掉；等价能力由 `before.verify` 改窄（新 revision）+ verify 覆盖 | 少一个语义分支 |
| S-8 | RuntimeGuard 独立阶段 | 预算是句柄 caveat + Task 切片；Guard 只剩 step 边界检查 | 预算随句柄委派天然切片 |

## B. 原样保留的（v0.2 已经对）

Contract ≠ Implementation + schemaDigest 冲突 fail-fast · Mutation Boundary（策略后只读，违者 POLICY_INTEGRITY_ERROR）· 审批摘要 JCS+SHA-256、范围写死、revision 变即失效、恢复不重跑前置拦截器、Grant ≠ 执行令牌 · DTO 边界与 cancellationId · JSON-RPC over stdio 信封 `cak/1` · 拦截器排序 priority→pluginId→注册序 · `ModelCallIntent` 形状 · 确定性上下文序 · Controller 唯一业务决策 · onLimit 默认给最后一轮 · TypeScript + 内核不是微内核 · MCP 是 Adapter · 名片 / pricing / usage / signature 插座（现在有了主干可以长）。

## C. v0.3 新增的决定

| # | 决策 | 理由 |
|---|---|---|
| N-1 | Caveat 集合固定 10 种 + `custom`（纯函数验证器） | 可枚举才能测收窄单调性 |
| N-2 | 进程内句柄 = 内核引用表键；跨进程 = 签名 token（macaroon 风格） | 接口一致，M1 先做前者 |
| N-3 | 账本 hash 链全局单条（跨 task 也链接） | 全局不可篡改；task 分段是视图不是分链 |
| N-4 | 快照校验 `atHash`，不符则全量重放 | 缓存永远可丢 |
| N-5 | 上下文源默认重建（不追加）；前缀稳定靠 stability / cacheKey | 沿用 v0.2 D-21 |
| N-6 | `agent.invoke@1` 是内置契约；M1 只支持同进程双 Runtime | 先把握手跑通再谈网络 |
| N-7 | 签名 M1 用 HMAC 占位，`Signer` 接口不变 | 先把"哪些东西要签"定下来 |
| N-8 | Task `maxConcurrentInvocations` 默认 8；并行由 Controller 发起、内核约束 | 与 S-5 配套 |
| N-10 | `CapabilityProvider.listContracts?()`：Provider 可自带契约定义，内核按 implicit 注册（首个实现的 digest 成 canonical + 事件） | 适配器（MCP Bridge）动态发现的工具需要一条"实现即定义"的路径；仍不允许反向定义 std.* |
| N-11 | subprocess 传输：内核侧超时兜底 = 内核 Guard 期限 + 1s，保证 Guard 先以 TIMEOUT 落账；子进程死亡才是 TRANSPORT_ERROR | 错误码语义分清"对方慢"与"对方没了" |
| N-12 | conformance：合法样例返回 TIMEOUT / TRANSPORT_ERROR / INTERNAL_ERROR / PROVIDER_ERROR 或超过期限未完成 = 不通过 | 一个 never-resolve 的敌意插件曾经"通过"过——判据不能接受"任何 error 形状都算过" |
| N-13 | 输出治理进内核：Provider 输出 > `maxOutputBytes`（默认 1MB）→ `PROVIDER_ERROR{oversized}`；不合契约 outputSchema → `PROVIDER_ERROR{schema}`（可关）；账本 payload 只内联 ≤16KB，超过只存 digest+2KB 预览 | 敌意"超大输出"曾能进账本 payload；契约 outputSchema 不校验等于没有 |
| N-14 | 幂等重试只对 `PROVIDER_ERROR{retryable}` 且（契约 idempotent 或显式 idempotencyKey），最多 2 次，`attempt` 入账 | 06 §3 落地；不给非幂等操作偷偷重放 |
| N-15 | 审批控制面 = 内核 `controlPlane()` 四个方法（pending / grant / deny / resume）；`human.approve@1` 提供方只见该接口；拒绝记 `invocation.denied{APPROVAL_INVALID}` 理由回喂 | 审批也是能力：谁批的、凭什么句柄，在审批方自己的账本里可追责 |
| N-16 | 签名：`Signer` 接口不变，M4 起 `Ed25519Signer`（信任 = 显式 trust 对方公钥）；回执签 `{receipt:'task/1',taskId,root}`；名片签 body | 跨组织验回执 / 验名片不需要共享 secret |
| N-17 | 账本存储第二实现 = `node:sqlite`（内置，无外部依赖）；链校验仍在 Ledger.open | 生产可查、可备份；换存储不换语义 |
| N-18 | remote 传输 = HTTP 上的同一 JSON-RPC 信封（cak/1）；服务端方法：agent.card / agent.serve / agent.receipt / handle.mint / handle.status / capability.execute；只监听 127.0.0.1 除非显式 host；TLS / 鉴权在部署层 | 协议一份，传输三种（in-process / subprocess / remote）；名片、回执、句柄铸造是网络的四个最小动词 |
| N-19 | 跨组织授权流程：来访者 `handle.mint` 拿被访者铸的 token → 本地导入（信任被访者公钥）→ 收窄（自己签）→ 出示 → 被访者导入（信任来访者公钥 + 父句柄在本地表）→ 同一 verify | 权限只减不增跨组织依然由构造保证；两边各信一把公钥就够 |
| N-20 | 注册表 R1 = 目录里的 index.json（插件条目 + 名片）；`cak add` 只信本机 conformance，过了才写安装目录（tier T1）；已安装插件一律 subprocess 装载 | 15 §4.2 / §5 落地 |
| N-21 | 结算 = 账本 usage × 契约 pricing 出对账单；`reconcile()` 比对双方 usage；付钱方式不在内核 | 15 §6 |
| N-22 | 真后端 #1 Anthropic：fetch 无 SDK；key 只走 secretRef（默认环境变量）；离线用 fetch 替身测映射，未做真实联网测试（花钱要问） | 15 §7 ①"一个真后端"；先把映射对了 |
| N-23 | 模型看到的工具名 = 契约名别名（`file_write`，同契约多句柄加 `_2`），描述里带 caveat 摘要与 `[handle:id]`；别名→句柄映射只在本次调用内有效，句柄仍是唯一授权凭证 | 真模型拿到不透明句柄 id 当工具名会乱调（cak-code 首跑实证：调不存在工具、把 write 参数塞给 read、绕道 shell 写文件） |
| N-24 | Controller 回喂历史必须重建"assistant(tool_calls) ↔ tool 结果"的正规线程（从账本折叠），后端按各自 API 配对（OpenAI tool_call_id / Anthropic tool_use↔tool_result）；未配对的 tool 结果退化为文本 | 只喂工具结果不喂模型自己的动作 → 模型看不见自己做过什么 → 连读同一文件 25 步（65k token） |
| N-25 | 内核在 route 之后、authority.verify 之前用契约 inputSchema 校验入参；不合规 → `invocation.denied{ARGS_INVALID}`，不进审批队列、不到 Provider。上下文源调用同样受校验 | 只校验出参不校验入参：DeepSeek 吐坏 JSON（`{_raw:…}`）→ 内核照放 → 审批面前出现垃圾请求 → Provider 写出名叫 `undefined` 的文件。schemaDigest 把 inputSchema 算进指纹却不执行，是自欺 |
| N-26 | Agent Spec `context.sources[].args` 里字符串 `"$input"` 占位 → 本任务输入（非字符串取 JSON 文本）；示例 spec 的 memory.search 改为 `{query: $input, limit: 10}` | N-25 一开校验就暴露：示例上下文源一直缺必填 `query`，靠不校验混过 G1–G8。占位而不是"缺就自动补"，避免魔法 |
| N-27 | 编程类 Agent 必须给 `file.edit`（oldText 唯一匹配才写，多处需 replaceAll）作为改局部的唯一路径；`file.write` 只用于新建/整体重写，且描述里明说"digest 别自己编" | 实测：只有整文件写时，模型把 100 行文件覆盖成 1 行再 `git checkout` 自救；`file.read` 不出 digest 时模型会伪造 `expectedOldDigest`（契约不可变，file.read 不加字段） |
| N-28 | 「始终允许」= 用户经控制面 `standing(contract, caveats, {by, expiresAt})` **新铸**一枚不带 requires-approval、只带收窄 caveat 的根句柄（`handle.minted{standing:true, grantedBy}`），之后新任务默认持有；`revoke` 可撤；重启由账本折叠重建。终端只提供由本次调用推导、并原样打给用户看的规则（shell 同前两个 argv 词 / 文件同目录 / commit 全放） | 收窄只能加 caveat，去不掉审批，所以不能靠 attenuate 做"以后别问"；也不能改成关审批（审批疲劳研究：只有 17% 用户看权限——答案是把授权铸窄，不是不问） |
| N-29 | `ctx.preview(handle, args)` 干跑 verify（纯函数，不写账本）→ ok / needs-approval / denied；编程控制器给模型**每契约只露一枚**宽句柄，调用时若 preview 要审批就换同契约能直接过的窄句柄 | 模型看到 `file_edit` 与 `file_edit_2` 只能猜；让控制器凭干跑选句柄既保住"调用者自己挑句柄"的 ocap 不变量，又不给账本添 denied 噪音 |
| N-30 | 契约同名多版本时（如 `file.read` 1.0.0 与 1.1.0），grants 不写版本 → 解析到**最高的已有实现的版本**，没有任何实现才退回最高版；`installPlugin` 对未写版本的条目以插件自己声明的实现版本为准。契约不可变，加字段一律出新小版本（`file.read@1.1.0` 加 startLine/endLine） | 第三轮 dogfood：模型对 40KB 文件反复缩 maxBytes 读文件头、对单文件 file.search 连撞 4 次 ENOTDIR。加 1.1.0 后若按"最高版"解析，只实现 1.0.0 的示例/子进程插件全部路由失败 |
| N-31 | 内核接口面冻结（16_KERNEL_API_FREEZE）：sdk 导出 / Kernel 公开方法 / 事件类型 / 错误码 / caveat 种类 / 传输协议 用指纹快照钉住，测试守卫；分 Stable / Experimental；**插件适配不了默认改插件或出新契约版本，不改内核**；内核只为 bug/安全改行为；新增 Stable 能力要决策条目 + 项目所有者点头；`standing/preview/网络层` 先标 Experimental | 用户 08-18 指出：因插件改内核会让内核失控。三轮 dogfood 的 5 处内核改动里 2 处（standing/preview）确实是"为了应用顺手"，我既写内核又写插件、改起来太方便，需要外部约束 |
| N-32 | 第二个宿主 cak-review（独立进程 + Ed25519 + HTTP，只提供 `code.review@1`、只读句柄）；cak-code 经 `agent.invoke`（caveat 锁 target/contract）送审，提交前必须送审；回执跨进程拉事件验签。served task 的控制器**不得把"我对外提供的契约"的来访句柄当工具给模型**（会自我调用）；非结构化答复给一次修正机会，再不合法就 comment 兜底不伪造判决 | 第四轮教训"agent 产出全绿 ≠ 修对，要第二个 agent 复核"；也是 16 §2 Experimental 转正所需的第二个宿主。真两进程实测内核零改动 |
| N-33 | 第一个真"外部插件"路径走通：`@cak/sdk` 做成可打包的独立 package（`sdk/package.json`，本地 tarball 安装；发 npm 等公开）；create-cak-plugin 生成 → 实现 → 子进程 conformance → 注册表条目 → `cak add` → cak-code 默认装载 `~/.cak/plugins`（插件契约按 sideEffects 定审批：read/none 免审，其余审批，可 s 常设放行）。同时修两处内核 bug（16 §3-2）：内置契约目录按模块位置定位（CLI 曾只能在仓库根跑）；>16KB 结果 view 从 blob 补回（曾让控制器看到 null、模型重试 5 次） | 用户「丰富插件满足不同用户」+ 业界最常见工具（Fetch/Search/Browser/DB/Memory/GitHub）；先做 http.fetch。"只有我写的插件用过"掩盖了这三处 |
| N-34 | MCP 接入以宿主为入口：cak-code 读 workspace `.mcp.json`（Claude Code / Cursor 同格式）+ `--mcp`，每 server 一座 McpBridge，工具 = `x.mcp.<server>.<tool>` 契约、默认审批、可常设放行单个工具；桥默认协商 2025-06-18、去掉 draft-07 `$schema`、透传 structuredContent；真 server 测试用 `CAK_INTEGRATION=1` 门控 | 用户已有的 MCP 配置零改动可用 = 一次接入整个 MCP 生态；默认套件不能依赖网络/npx |
| N-35 | 第一批社区插件三个（`~/cak-plugins/`，全部走外部路径：脚手架→SDK tarball→conformance→注册表→cak add）：`http-fetch`、`sql-query`（连接别名制、只读三重保险）、`memory-sqlite`（FTS5，memory.search+新契约 memory.write）；cak-code 检测到 memory.search 提供者即自动挂为上下文源（`$input`），实现跨会话记忆。**幂等契约的输出不得含每次都变的字段**（durationMs / created）——conformance C5 拒装过两次，是对的 | 用户「丰富插件满足不同用户」；业界最常用类别=抓取/搜索/浏览器/数据库/记忆/代码托管；这三件不用外部 key 能真测。conformance 证明合规不证明查得对（空表也能全过）→ 插件自带 node:test |
| N-36 | 插件代码仓库：私有 monorepo `theyuyan/cak-plugins`（`plugins/<id>/`，随仓库 vendored `@cak/sdk` tarball 直到发 npm）；注册表条目加 `install:{type:'git',url,ref,subdir,build?}`，`cak add` = clone --depth 1 → subdir 里跑 build（argv 数组不经 shell，默认 npm install + npm run build）→ 该 cwd 起子进程过 conformance → manifest 记 cwd → 装载同 cwd。三个插件已从 GitHub 重装验证 | 用户问「插件有库了？」：注册表在 GitHub 但代码只在本机、条目是本机绝对路径=换机器装不到。生态成熟前 monorepo 省事，有外部作者再拆 |
| N-37 | 重启时 spec 与账本对账：句柄表仍由账本重建，但对照 minter 产出，**同契约同 caveats 没有任何根句柄的补铸**（`handle.minted{reason:'spec-reconcile'}` + `runtime.composed{reconciled}`）| 之前改了 spec 重启会被静默忽略（bug，16 §3-2）；也是热加载新插件的基础——同一账本重组内核即得新契约句柄，不需要别的内核 API |
| N-38 | 注册表是 Provider：`plugin.search@1`（只读、免审批、打分排序、搜不到就列全部）/ `plugin.install@1`（写、审批、trust-but-verify）；宿主 cak-code 默认 `~/.cak/registry`（自动 clone/拉取）、装完同账本重组热加载；条目带 `setup`/`keywords` 供 agent 用人话引导。小白路径 = 对 agent 说想要什么能力 | 用户问「小白怎么装」：现在只有高手能走命令行；agent 替人找/装/配置是与产品世界观一致的答案。真驱动实测：找到→解释→装（14/14）→热加载→引导配置→查到数据。首跑失败在我的全词 AND 搜索 + 描述缺常用词 |
| N-39 | 第二个物种：`sdk-python/`（零依赖，标准库）与 `@cak/sdk` 逐字对齐 `cak/1` 线协议（hello/health/shutdown/execute/cancel，-32700/-32600/-32601/-32602/-32603）；execute 在线程里跑（Provider 可阻塞）；示例 `text.summarize` 插件过内核 conformance 13/13、经注册表 git 源 `cak add` 装入、DeepSeek 驱动的 cak-code 真调用（账本 providerId=py-summarize）。协议才是接口，SDK 只是方便 | 用户问「是否真贯彻万物皆 agent」：只有 TS SDK 时谈不上"万物"。跨语言证明的是：内核只认契约与 conformance，不认语言 |
| N-40 | 插件契约的路径安全两道墙：宿主给已装插件传 `CAK_WORKSPACE`（插件只在其内解析，越界拒）+ cak-code 对带 `path` 参数的插件契约自动加 `args.match` caveat（只许相对路径、不许 `..`、不许盘符）。新增只读契约 `git.log`/`git.show`（模型此前每次用 shell 跑 git log）、`doc.read`（PDF/docx/xlsx/csv，社区插件 doc-read） | 只读契约免审批，若能读任意路径等于给了 agent 全盘读权；纵深防御与 file.read 同等对待 |
| N-41 | 第二批社区插件：`web-search`（Brave/Tavily/SearXNG 适配，key 放文件；作者无 key **未联网真测**，未配置时返回结构良好的 CAPABILITY_ERROR 使 conformance 可过——conformance 验协议不验外部服务）、`browser`（Playwright/Chromium：open/act/snapshot，快照=正文+带 ref 的可交互元素，拒内网；真跑 example.com→点链接→IANA 页）、`doc-read`、只读 `git.log/git.show`。插件已 8 个 | 用户「为啥不能再丰富插件生态」；对外部依赖的插件，装前验证与真可用是两回事，要在 setup 与 README 里如实说 |
| N-42 | 第三批（按热度）：`github`（query 只读免审批 + issue.create 审批；令牌 env/文件/`gh auth token`）、`pkg-info`（npm/PyPI 官方源，Context7 类需求的开放实现）、`notify`（Slack/企微/钉钉/generic 别名制）。**N-40 判据修正**：文件路径 caveat 只加给 `permissions` 含 `fs.*` 且带 path 参数的契约（github.query 的 path 是 URL 路径，曾被误拒）| 真跑抓到的：按参数名猜语义不行，契约里的 permissions 字段就是干这个的 |
| N-43 | **前端是一类插件（`roles: frontend`），但不是能力**：内核 + 插件 + 会话常驻为 `daemon`，对外只开本机控制面（JSON-RPC `session.*` + SSE 事件流，127.0.0.1 + 每会话随机 token 0600 文件）；TUI / 桌面 / 网页都只连控制面（看事件、审批、发输入），拿不到能力句柄。cak-code 的组装逻辑抽成 `host.ts`，REPL 与 daemon 共用；`cak add` 对前端不跑 conformance（无契约）；`cak front` 启动前端 | 用户问「TUI 和桌面能不能做成插件」：能，且这样内核/插件一行不改就能换界面、多界面看同一会话；控制面 token 是为了同机其他进程不能替用户按"允许" |
| N-44 | 流式：`BackendRequest.onDelta?(d:{text})`（**Stable 面只增不改**；后端能流就逐段回调正文，不能流的忽略，最终结果同形）；`KernelOptions.onModelDelta` 把增量交给宿主，账本只记最终结果；OpenAI 兼容后端 SSE 实现（工具调用按 index 拼、usage 取末尾 chunk）；daemon 转成 `daemon.model.delta` 事件；REPL 逐段打印。**所有者授权**：用户 2026-08-18「你决定」（我已说明这一项要点头） | TUI 没有流式就是"等一会刷一大段"；改的是可选字段，旧后端零影响 |
| N-45 | TUI（Ink）作为前端插件落地：单栏三段、身份方向 A「靛」、自己接管输入（回车/退格/粘贴合包/历史/Tab）而不用 ink-text-input（终端会把"文本+回车"合成一包，Ink 当文本，粘贴回车永远不提交）；审批单键 y/N/a/s；`/handles` 面板可撤销；`--no-motion`。验收=真 PTY 逐字驱动 + pyte 回放最后一屏量三条口径（100/80 列：框线 ≤100、品牌色 1–2%、状态线无色）| 用户「前端要考虑便捷/功能/动效/UX/布局/配色」+ 早先定的三条口径。真驱动抓到两个自己的坑：daemon SSE 没 flushHeaders（第一个事件前响应头不发）；驱动器首帧即灌整句 |
| N-46 | 多界面可切：`cak front --list/--default/<id>`（`~/.cak/config.json`）；内置 tui / tty / **web**（daemon `GET /ui` 静态页，token 在 URL 片段不经日志，同一设计语言，无头 Chromium 真渲染验证）；TUI 四套主题 `/theme` 热切并记住；社区仓库 `front-plain` 零依赖前端插件经 `cak add` 装、`cak front front-plain` 切，跑通 | 用户「可以做多种 TUI 和多种界面，装好插件能切换」；网页界面也是桌面壳的底子 |
| N-9 | mustFinalize 的那一步只允许 `model.generate@1` 与 Composer 的上下文读取，Controller 发起的其他 invoke 记 `denied{STEP_LIMIT}` | 收尾轮的目的是收尾，不是再干一轮；模型调用与上下文留着让它写总结（M1 实现时发现：不放行上下文读取则收尾轮拼不出 Bundle） |

## D. 待定（不阻塞 Freeze）

跨进程 token 的撤销查询端点 · 名片簿 / 发现协议 · 结算方式 · 密钥分发与信任根 · 组合授权（同 step 多调用的合规）· 快照与账本保留策略 · 事件 payload 迁移策略（schemaVersion 升级）· wasm / remote 传输实现顺序 · Rust/Python 移植。

## E. 诚实的风险

- 句柄 + 事件溯源实现门槛高于 v0.2：折叠投影、句柄验证、崩溃恢复都要先写测试向量。M1 工作量估计比 v0.2 Phase 1 多 30–50%。
- ocap 模型对"按名字查规则"的团队有学习成本；缓解：`static-minter` 让 Spec 里的 grants 看起来就像 ACL，但底层已是句柄。
- 如果用户最终不需要 Agent 互联，S-3 / S-4 的收益缩水到"审计与恢复更干净"——仍值，但没那么划算。
