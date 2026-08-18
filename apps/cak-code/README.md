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
