# 搭建自己的 agent：装内核 → 起内核 → 装插件 → 一份配置

这是整个产品的主线：**内核只有一个，agent 是拼出来的**。

```
1  装内核        git clone … && npm install && npm link（发布后：npm i -g cak）
2  起内核        cak up                       ← 内核进程；默认顺手挂一个 bare（引导 agent，可摘）；--no-agent 纯内核
                 cak front                    ← 连上去（TUI / tty / web / 装的界面）
3  装插件        对它说「我想让你能读 PDF」    ← 它去 plugin.search / plugin.install（问你一次）
                 或 cak add doc-read --registry ~/.cak/registry
4  搭 agent      cak agent init my-agent [--from bare|coding|review]
                 编辑 ~/.cak/agents/my-agent.yaml
                 cak up --agent my-agent --workspace <目录>
```

## agent 配置文件长什么样

`~/.cak/agents/<name>.yaml` 就是一份 AgentSpec（内核第一天起就按它组装，`docs/design/07` 是它的 schema）：

```yaml
metadata: { name: my-agent, version: 0.1.0 }
spec:
  principal: { agent: my-agent }
  controller: { provider: cak-code, config: { persona: general } }   # 谁来"想"：内置 cak-code / cak-review / simple-react / plan-execute，或已装的 controller 插件 id
  model: { backend: deepseek, model: deepseek-chat }                 # 用哪家模型：内置 deepseek / anthropic，或已装的 model-backend 插件 id
  grants:                                                            # 持有哪些能力（句柄）；已装能力插件的契约会自动追加（read/none 免审批，其余审批）
    - { contract: session.history }
    - { contract: file.read, caveats: [{ kind: args.max, path: maxBytes, max: 262144 }] }
    - { contract: shell.exec, caveats: [{ kind: requires-approval, approver: any-with-approve-handle, ttlMs: 1800000 }] }
  context: { sources: [{ contract: session.history, args: { limit: 20 }, priority: 10, stability: session }] }
  task: { maxSteps: 25, stepTimeoutMs: 180000, invokeTimeoutMs: 120000, onLimit: final-step }
  manifest: { displayName: my-agent, description: 我自己的 agent, provides: [] }
```
改哪几行就变成什么 agent：
- 换控制器 → 换"脑子"（编程助手 / 审查者 / 简单反应式 / 计划执行 / 你装的）
- 换后端 → 换模型
- 加减 grants → 加减能力，caveat 决定要不要审批、能动到哪
- `provides` 写上契约名 → 它就能被别的 agent 调（配 `cak serve`）

内置三份：`bare`（空内核）、`coding`（编程助手，就是 cak-code）、`review`（审查方）。首次 `cak up` 会把它们写到 `~/.cak/agents/`，之后以文件为准。

## 插件有哪几类、装进来去哪

| 角色（清单 `roles`） | 装进来之后 | 信任 |
|---|---|---|
| `capability` | 契约进你的句柄目录（自动追加到 grants） | T1：子进程、装前本机复跑 conformance |
| `frontend` | `cak front --list` 里多一项 | 只拿控制面权限 |
| `controller`（子进程）| 成为 profile 里可选的 `controller.provider`（插件 id） | **T1：自己的进程、任何语言**（SDK `servePlugin(null, {controller})`；决策期间经 `ctx.*` 反向请求内核，invoke 仍走 verify）— 推荐 |
| `controller` / `model-backend` / `interceptor` / `observer` / `policy-minter`（进程内 `entrypoint: in-process`）| 同上 / 自动挂上 | **T2：跑在内核进程里**，只从注册表装、装前明示 |

## 诚实边界
- 进程内（in-process）的控制器/后端插件能读你能读的一切；这一档信任只给你信得过的来源，注册表条目会标 T2。控制器优先用子进程形态（T1）。
- 一个内核进程可挂 0..N 个 agent（`cak up --no-agent` 是纯内核；`cak agent add <profile>` 往里挂、`remove` 摘、`loaded` 看；前端 `--agent` 选）。插件与配置管理走控制面，不依赖模型。不同内核进程之间的 agent 用 `agent.invoke` 互调（见 cak-review）。

## 已验证的一次完整走法（2026-08-19，只用 `cak` 命令、插件目录从空开始）
`cak up`（bare）→ `cak front tty` 说「我想让你能抓网页」→ 它 plugin.search 找到 http-fetch → 你按 y → 装、热加载 → `cak agent init reader --from bare` → `cak up --agent reader` → 让它看 example.com 并问能否改文件/跑命令 → 它抓到页面并如实答「不能改文件、不能跑命令」（这个 agent 就没被给那些能力）。
