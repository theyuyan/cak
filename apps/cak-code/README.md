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
