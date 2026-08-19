# Changelog

## 0.3.0（未发布 · 2026-08-19）
首个可安装版本（`npm pack` 出包已在干净目录 + 干净 HOME 下验证：doctor / agent list / up / front）。
- 内核 v0.3：Identity · Contract · Authority · Ledger · Boundary 五子系统；接口面冻结（`docs/design/16`）+ 守卫；`kernel-1.0.0-rc.2`
- 主线：`cak up`（bare 空内核）→ 插件管理（`plugin.search/install`，trust-but-verify）→ `cak agent`（AgentSpec YAML 拼 agent）
- 插件：capability（子进程，T1）/ frontend / controller（子进程 T1 或进程内 T2）/ model-backend / interceptor / observer；SDK：`@cak-dev/sdk`（TS）、`cak-sdk`（Python，零依赖）
- 社区插件 11 个（http-fetch · sql-query · memory-sqlite · doc-read · web-search · browser · github · pkg-info · notify · py-summarize · front-plain）+ MCP 桥（`.mcp.json` 兼容）
- 前端：TUI（Ink，流式/单键审批/主题）· tty · web（daemon `/ui`）· 可安装前端插件；`cak front --list/--default`
- 多 agent：cak-code ↔ cak-review 跨进程审查 + 回执验签
- 手册 `docs/manual/00–07`；成熟度路线 `docs/design/17`
已知：只在 macOS(Intel) + DeepSeek 真跑过；Windows 未测；web-search 未用真 key 联网测；仓库私有、未发 npm/PyPI。
