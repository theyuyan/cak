# Changelog

## 0.3.2（2026-08-19）
- **同进程 agent 互相委派（N-51）**：`cak up --agent bare --agent coding` 之后，agent 用 `agent.invoke(target=<兄弟名>, contract=agent.task@1, args={intent, context})` 把子任务交给同一内核里的另一个 agent；走 daemon 的排队/审批链（被委派方要审批照样弹），回执来自被委派方账本；不能委派给自己、≥3 层拒绝；unknown target 报错时列出可用 agent。真跑：bare 把写文件委派给 coding，hello.py 落盘、report 回到 bare
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
