# cak-review — 跑在 CAK 上的代码审查 agent（第二个宿主）

独立进程、独立账本、独立 Ed25519 身份；对外只提供 `code.review@1`；对 workspace 只有只读句柄（git.diff / file.read / file.search / file.list）。

```
npx tsx apps/cak-review/serve.ts --workspace DIR [--port 8790] [--backend deepseek|anthropic] [--session NAME]
npx tsx apps/cak-code/cli.ts   --workspace DIR --reviewer http://127.0.0.1:8790 …
```

cak-code 接上 `--reviewer` 后：取名片 → 信任其公钥 → 拿到一枚 `agent.invoke` 句柄（caveat 锁死 target=cak-review、contract=code.review，别的谁都调不了）→ 系统提示要求**提交前必须送审**，`request_changes` 先修再审 → 结论打印为 `⚖ 审查 …` → 跨进程拉审查方该 task 的事件，Merkle 根 + 签名对上才打 `✔ 回执已验`。

实测（DeepSeek，两进程，2026-08-18）：cak-code 修一个埋入 bug → 送审 → 审查方 `git.diff` + 按行读 6 行 → 一次给出合法 JSON（approve + 1 条 minor）→ 回执 27 事件验签通过 → 提交。审查方开发时踩过的坑：来访 task 持有 `code.review` 句柄，若把 held 句柄全给模型当工具，模型会调用自己——已剔除；非 JSON 答复给一次"只出 JSON"修正机会，仍不合法则 `verdict=comment` 兜底（不伪造判决）。
