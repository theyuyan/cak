# 使用手册：cak-code（编程/通用助手）

## 启动参数

```
npx tsx ~/agent-kernel/apps/cak-code/cli.ts
  [--workspace DIR]            工作区（默认当前目录）。文件读写只能在这里面
  [--backend deepseek|anthropic] [--model NAME]
  [--session NAME]             会话名（默认时间戳）；同名 = 续上同一账本（历史、常设授权都在）
  [--task "…"] [--yes]         一次性任务；--yes 全部自动批准（脚本用；不带 --yes 则需审批的操作一律拒绝）
  [--reviewer http://127.0.0.1:8790]   接审查 agent（提交前必须送审）
  [--plugins-dir DIR | --no-plugins]   已装插件目录（默认 ~/.cak/plugins）
  [--registry DIR | --no-registry]     注册表（默认 ~/.cak/registry 自动拉取）
  [--mcp "name=cmd args…"]… [--no-mcp] MCP 服务器（另读工作区 .mcp.json）
```

## 会话里的命令

| 命令 | 作用 |
|---|---|
| `/status` | 会话名、工作区、模型、已装插件、MCP、账本条数与位置、常设句柄数 |
| `/handles` | 列出所有句柄：契约、限制（需审批 / 路径前缀 / argv 前缀…）、到期时间 |
| `/revoke <句柄id>` | 撤销一枚常设句柄（立刻生效，入账） |
| `/report` | 用量：按契约的调用次数、token、失败/拒绝数 |
| `/quit` `/exit` | 退出（账本已经落盘，随时可续） |

## 审批：它什么时候会问你

| 操作 | 默认 |
|---|---|
| 读文件、列目录、搜索、看 diff、查历史、查记忆、`plugin.search`、只读 SQL | **不问** |
| 写文件、精确编辑、跑命令、git 提交、`plugin.install`、写记忆、抓网页、MCP 工具 | **问** |

提示：`允许？[y/N/a=本轮全批/s=本会话始终允许这类]`
- `y` 只批这一次；30 分钟内**完全相同**的调用不重复问
- `N`（或直接回车）拒绝——模型会得到"用户拒绝"并换做法或停下
- `a` 本轮任务里剩下的全批
- `s` **本会话始终允许这类**：内核给你新铸一枚"只许干这类事"的句柄，规则由这次调用推导并**原样打给你看**：
  - 命令：以同样的前两个词开头（如 `npx vitest …`）
  - 文件写/编辑：同一目录下
  - 抓网页：同一站点
  - MCP 工具：这一个工具
  - git 提交：任何提交
  12 小时到期；`/handles` 可查、`/revoke` 可撤；重启还在（在账本里）

一次性任务里 `--yes` 等于每次都答 `y`；不带 `--yes` 等于每次都答 `N`。

## 它是怎么"记得"的

- 同一 `--session` 内：账本回喂完整历史
- 跨会话：装了 `memory-sqlite` 后，每一句输入会自动检索相关长期记忆带进上下文；你说"记住…"它会写一条（要审批）

## 审查 agent

带 `--reviewer` 时，提交前它必须先把未提交改动送给 cak-review；`request_changes` 会先改再送审；结论显示为 `⚖ 审查 approve|request_changes|comment：…` + 逐条 findings；`✔ 回执已验` 表示这份结论确实出自对方、事件未被改。

## 账本：一切的事实源

`~/.cak/sessions/<session>.sqlite`，SQLite，表 `events`（哈希链）。谁在什么时候调了什么、给了什么参数、你批没批、结果的摘要——全在里面，事后可查：
```bash
sqlite3 ~/.cak/sessions/<session>.sqlite "select seq,type,substr(body,1,120) from events order by seq"
```
`npx tsx ~/agent-kernel/bin/cak.ts report <spec.yaml> --ledger <文件>` 出用量报表。

## 已知限制（诚实）

- 无流式输出：模型想完才一次性打出
- 每步把整个线程重发给模型：长任务 10 万+ token 属正常，尚未做 prompt 缓存
- 只有 DeepSeek 真跑过；Anthropic 后端未联网验证
- 大工具结果（>16KB）重启后旧任务里看不到（blob 只在内存）
- 一个终端一个会话，没有并行子任务
