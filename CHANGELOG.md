# Changelog

## 0.3.3（2026-08-19 · 真驱动测试修复批）
五名真实视角测试员（小白 / 开发者 / 运维办公 / 红队 / 前端）并行真驱动 + 全量安装巡检，共 ~70 条发现，本版修掉其中 P1/P2 全部、P3 大半：
- **安全/数据**：`session.decide` 只认 grant|deny|standing（之前任何别的值都当批准）；工作区路径墙按真实路径再判（符号链接逃不出去：内核 file.* 与 8 个插件）；已装插件中读个人数据的（邮件/日历/剪贴板/远端主机/容器，注册表 `sensitiveReads`）读类调用也要审批；agent 配置可 `plugins: {include|exclude|approveReads}`；账本/历史 0600；控制面未鉴权不再列 agent
- **健壮性**：崩溃重启后挂起任务的审批可见、可批、批后续跑（之前是僵尸）；同名 `cak up --name` 拒起（之前覆盖信息文件、共写账本）；插件子进程死了下次调用自动重拉；`cak stop`/`cak agent` 按工作区真实路径找内核；非交互终端下 `cak` 自动用 tty 前端；无注册表目录也能组装（manifest 随带契约定义）
- **性能**：插件懒启动（安装期记录实现清单；老安装首次自愈）——起内核 13 s / 22 子进程 / 1 GB → 3.5 s / 0 子进程；插件安装改 sparse clone（857 MB → 29 MB 级）；会话历史单条 8k 字封顶
- **前端**（网页 / tty / TUI / front-plain）：输入框不再吞审批快捷键；连上先拉待审批、刷新回放历史、别处已决定的置灰；多 agent 切换与标签；时序正确；Ctrl-C 一次退出；管道模式不崩；人话化 /handles /status 与尾行；最小 Markdown；无 alert
- **审批信息**：git.commit 给 status+diff --stat；test.run 说明将执行什么；路径类入参（path/target/outPath/localPath）句柄级墙
- **插件**：webhook 同机多内核（客户端模式）；`CAK_DATA_DIR` 约定（conformance 不弄脏 ~/.cak）；kb-local 按工作区；http-fetch 内网白名单；github.query 不再回显变动字段（幂等）；desktop.open / browser.open / arxiv 文案
- 文档：手册 00/01/05/07 与 README 按实际行为修正；`cak up --reviewer` 入 help；cak-registry CI 每日真装全部条目
- **插件作者路径**（作者视角测试员抓到）：脚手架 `@cak-dev/create-plugin` 0.1.1——默认 SDK 依赖写成了 `@cak-dev/sdk@^0.3.0`（npm 当本地 link，build 必炸）改为 `^0.3.0`、usage 写明 `npm create … -- --contract`、`--contract-version`、生成 `test.mjs`、去掉无人读的 manifest.yaml；新命令 `cak digest <契约.json> [--write]`（算 digest + 检查 additionalProperties）、`cak add ./目录`（本机插件不经注册表直接装、作者自测）、`cak conformance --contract-version`；契约文件 digest 与内容不符 → `cak add`/`cak conformance` 装前就拒（之前能装、内核起不来）；已装插件的坏契约/冲突 → 内核启动只跳过该插件并提示（不再整个起不来）；运行中 `cak add` 装带新契约的插件 → 当前这一句就能用（之前要重启）；CLI 未捕获错误只打一行 code+message（CAK_DEBUG=1 看堆栈）；新文档 `docs/design/19_PLUGIN_WIRE_PROTOCOL.md`（cak/1 线协议，手册 03 原先指向的 09 不是协议页）

## 0.3.2（2026-08-19）
- **同进程 agent 互相委派（N-51）**：`cak up --agent bare --agent coding` 之后，agent 用 `agent.invoke(target=<兄弟名>, contract=agent.task@1, args={intent, context})` 把子任务交给同一内核里的另一个 agent；走 daemon 的排队/审批链（被委派方要审批照样弹），回执来自被委派方账本；不能委派给自己、≥3 层拒绝；unknown target 报错时列出可用 agent。真跑：bare 把写文件委派给 coding，hello.py 落盘、report 回到 bare
- **技能即插件（N-52）**：注册表 `roles:[skill]`（只有 SKILL.md，T0，带可执行入口拒装）；`skills` 能力插件提供 `skill.list/skill.read`，宿主自动把技能清单挂成上下文源，控制器对得上先读再做；现成 3 个技能（cak-plugin-author / weekly-report / incident-triage）
- 社区插件 +6（cak-plugins / cak-registry，共 22 个）：`ssh-exec` · `docker` · `doc-write` · `webhook` · `open-sources` · `desktop`；已用真 agent 端到端跑过 hn.top→doc.write.html→desktop.notify 链与 webhook 叫醒；ssh/docker 只在假命令上测过

## 0.3.1（2026-08-19）
- **社区契约随注册表分发（N-50）**：`cak add` 的一致性测试、宿主组装、`cak conformance --contracts DIR|FILE` 都从 `<registry>/contracts/**`（`~/.cak/registry`）读契约；新插件的新契约不必再等内核发版。同 name@version 不同 digest → `CAPABILITY_CONTRACT_CONFLICT`。内核 Stable API 零改动
- 注册表本地镜像与上游历史分叉时（上游改写历史）自动对齐上游，而不是永远用旧副本
- `cak --version` / `cak --help`（原先落入零参数起内核）；脚手架用法提示改为 `npm create @cak-dev/plugin`
- 社区插件 +5（在 cak-plugins / cak-registry）：`email`（IMAP/SMTP）· `calendar`（CalDAV）· `kb-local`（FTS5+BM25 本地知识库）· `test-run`（结构化测试结果）· `schedule`（定时叫醒 agent）；kb-local / test-run / schedule 已用真 agent 端到端跑过；email / calendar 只在假服务器上测过
- 已发 npm：`@cak-dev/cli` `@cak-dev/sdk` `@cak-dev/create-plugin`；三仓公开

## 0.3.0（2026-08-19）
首个可安装版本（`npm pack` 出包已在干净目录 + 干净 HOME 下验证：doctor / agent list / up / front）。
- 内核 v0.3：Identity · Contract · Authority · Ledger · Boundary 五子系统；接口面冻结（`docs/design/16`）+ 守卫；`kernel-1.0.0-rc.2`
- 主线：`cak up`（bare 空内核）→ 插件管理（`plugin.search/install`，trust-but-verify）→ `cak agent`（AgentSpec YAML 拼 agent）
- 插件：capability（子进程，T1）/ frontend / controller（子进程 T1 或进程内 T2）/ model-backend / interceptor / observer；SDK：`@cak-dev/sdk`（TS）、`cak-sdk`（Python，零依赖）
- 社区插件 11 个（http-fetch · sql-query · memory-sqlite · doc-read · web-search · browser · github · pkg-info · notify · py-summarize · front-plain）+ MCP 桥（`.mcp.json` 兼容）
- 前端：TUI（Ink，流式/单键审批/主题）· tty · web（daemon `/ui`）· 可安装前端插件；`cak front --list/--default`
- 多 agent：cak-code ↔ cak-review 跨进程审查 + 回执验签
- 手册 `docs/manual/00–07`；成熟度路线 `docs/design/17`
已知：只在 macOS(Intel) + DeepSeek 真跑过；Windows 未测；web-search 未用真 key 联网测；PyPI 未发。
