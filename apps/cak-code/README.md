# cak-code — 跑在 CAK 上的编程助手（MVP）

```
npx tsx apps/cak-code/cli.ts --workspace <repo> [--backend deepseek|anthropic] [--model NAME]           # 交互 REPL
npx tsx apps/cak-code/cli.ts --workspace <repo> --task "…" [--yes]                                        # 一条任务；--yes 自动批准
```
- 能力（契约）：file.read / file.list / file.search / git.diff（读，直接执行）· file.write / shell.exec / git.commit（**默认要你审批**：句柄 caveat，终端 y/N/a）
- 每条消息 = 一个 Task；历史经 `session.history@1` 回喂；账本 `~/.cak/sessions/<session>.sqlite`（`cak report` 可看用量）
- 模型 key：`~/.cak/secrets/deepseek.key`（file: secretRef）或 `ANTHROPIC_API_KEY`
- 实测（DeepSeek）：「补一个 sub 函数 → node 验证 → git 提交」23 次调用 / 18k tokens 完成；首跑发现并修掉两个内核层问题（工具命名、线程回喂，见设计 N-23/N-24）

没做：流式输出、每会话"始终允许"（应做成收窄后的长期句柄）、子任务并行、prefix 缓存、更好的 diff 展示。

## 契约（9 个）与实测教训

`file.read / file.list / file.search`（免审批）· `file.edit / file.write / shell.exec / git.commit`（默认审批，30 分钟内同参数不重复问）· `git.diff / session.history`。

- **改局部一律 `file.edit`**（oldText 必须唯一匹配，否则拒写；多处用 replaceAll）。首次 dogfood 只有 `file.write` 时，DeepSeek 把 100 行文件覆盖成 1 行再 `git checkout` 自救，18 次模型调用 / 23 万 token；加 `file.edit` + 内核入参校验后同一任务 5 次调用 / 2.5 万 token、零拒绝零失败（N-25 / N-27）。
- 内核在审批之前按契约 inputSchema 校验入参：模型吐坏 JSON 只会得到 `ARGS_INVALID` 回喂，不会走到审批面前，更不会落盘。
- 真驱动交互版：`node tests/drive-repl.mjs <workspace> tests/repl-scenario.json`（像人一样等提示再输入、按脚本回答审批）。
- **审批提示多一档 `s=本会话始终允许这类`**：不是关审批，而是由内核新铸一枚只许干这类事的窄句柄（如"shell.exec 以 `npx vitest` 开头" / "file.edit 路径以 `apps/cak-code/` 开头"），12 小时到期、`/handles` 可查、`/revoke <id>` 可撤、重启仍在（在账本里）。实测 4 轮写/shell 只问 2 次（N-28 / N-29）。

## 插件与 MCP

- **已安装插件默认装载**：`cak add <id> --registry <cak-registry 目录>` 装到 `~/.cak/plugins`（本机复跑 conformance 才装），cak-code 启动自动装载（全部子进程）；`--no-plugins` 关闭。插件契约按 sideEffects 定审批：read/none 免审，其余审批（`s` 可常设放行）。首个外部插件：`http-fetch`（`~/cak-plugins/http-fetch`）。
- **MCP 直接兼容 `.mcp.json`**（与 Claude Code / Cursor 同格式）+ `--mcp "name=cmd args…"`：每个 server 一座桥，工具映射为 `x.mcp.<server>.<tool>` 契约，默认要审批，`s` = 常设放行该工具。实测 `@modelcontextprotocol/server-memory`：9 个工具，写入→检索→按查到的内容回答，服务器自己的知识图谱文件落盘。真 server 测试：`CAK_INTEGRATION=1 npx vitest run tests/e2e/mcp-real.test.ts`。
- **已有社区插件（`~/cak-plugins/`，均 T1 已装）**：`http-fetch`（受控出网）· `sql-query`（只读 SQL，别名连接：`~/.cak/sql-query.json`）· `memory-sqlite`（长期记忆，FTS5；装上后 cak-code 自动把 `memory.search` 挂为上下文源——实测会话 B 全新目录记得会话 A 存的"pnpm+vitest"偏好）。
- **小白路径（agent 替你装插件）**：直接说"我想让你能查数据库/抓网页/记住东西"→ agent `plugin.search` 找到并用人话解释 → `plugin.install`（你按 y，本机复跑 conformance 才装）→ 自动热加载 → 按 setup 说明引导配置（口令让你自己填文件）→ 下一句就能用。注册表默认 `~/.cak/registry`（自动从 GitHub 拉取），`--registry DIR` 指定，`--no-registry` 关闭。
