# M5 验收报告 — 网络（路线图最后一站）

日期：2026-08-18 · 判据：`11_ROADMAP.md` M5 + `01_ARCHITECTURE.md §9`（互联五步）+ `15_PLUGIN_ECOSYSTEM.md §4/§5/§6`

## 一条命令核实
`npm test` → **14 个测试文件 · 130/130** · `tsc --strict` 0 错误（M1–M4 全部回归）。

## M5 退出标准："两个独立进程 / 主机的 Agent：发现 → 铸窄句柄 → 调用 → 回执互验 → 账本对账"
| 步骤 | 实现 | 怎么验的 |
|---|---|---|
| ① 发现 | `FileRegistry`（index.json：插件条目 + 名片；按契约反查"谁提供"）；`cak serve --publish DIR` 发布名片（endpoints 带真实 URL）；`GET /card` / `agent.card` | 测试：从注册表 `findAgentsProviding('doc.summarize')` → 拿 URL → `fetchCard` |
| ② 信任 | 名片含 `publicKeyPem`；`trustPeer(card)` 把对方公钥交给 Ed25519 签名者 | 名片验签通过；篡改失败；不信任的发行者签的 token 被拒 |
| ③ 委派调用 | `handle.mint`（被访者为来访者铸窄句柄并返回 token）→ 来访者导入、收窄（+budget/once）、出示 → 被访者 `serve(handleToken)` 导入（信任来访者公钥 + 父句柄在本地表）→ 同一 verify | 成功一次；同 token 二次拒（budget/once）；被访者 `revoke` 后新子 token 也拒；`RemoteServeTarget` 让 `AgentInvokeProvider` 跨 HTTP 调用，A 的事件序列 == G7 |
| ④ 追责 | `agent.receipt` 跨进程拉回执事件；`verifyTaskReceipt(receipt, 已信任签名者)` | 用 B 公钥验过；少一条事件 → 根不符 |
| ⑤ 结算 | `statement(kernel)`（usage × pricing）· `reconcile(local, remote)` | A 记的 agent.invoke usage == B 回执 usage |
| 注册表 + `cak add` | `installPlugin`：起子进程 → 本机跑 conformance → 全过才写 `installDir/<id>/manifest.json`（T1）；`loadInstalledPlugins` 全部 subprocess 装载 | 合规插件安装成功并被内核装载跑通 G1；敌意插件不安装 |
| 远程 Provider | `RemoteProvider(url)`（HTTP 上的插件）| conformance 全过；坏信封 -32600 |
| 真后端 #1 | `AnthropicBackend`（fetch，无 SDK；key 只走 secretRef） | 离线映射测试（system 合并 / tools / tool_use→toolCalls / usage / 无 key / 401）；**未联网测试** |

## 用户入口
```
cak serve <spec> --port 47311 --key-dir ~/.cak/keys --publish ./registry --workspace …   # 常驻：生成/加载 ed25519 密钥、发布名片
cak card  <spec> --key-dir ~/.cak/keys                                                     # 名片（含公钥）
cak add   <pluginId> --registry ./registry --install-dir ~/.cak/plugins                    # 本机验过才装
cak run … --plugins-dir ~/.cak/plugins --backend anthropic                                 # 用已安装插件 + 真后端（需 ANTHROPIC_API_KEY）
cak statement <spec> --ledger FILE                                                         # 对账单
```
实测：`cak serve` 起在 127.0.0.1:47311，名片写进注册表 index.json（endpoints=真实 URL），`GET /card` 返回含公钥的名片；坏信封 → -32600；`handle.mint` 未在 provides 的契约 → -32602。

## 没做 / 边界
- 注册表 R2（托管 HTTP + 镜像 + yank）：R1 的 index.json 契约已定，R2 是部署。
- TLS / 鉴权：serve 只监听本机；公网部署要反代 + TLS + 访问控制（部署层）。
- Anthropic 后端未真实联网（要花钱，按纪律等你说）。
- wasm 传输、MCP resources/prompts、OTel SDK：仍未做（有意）。
- `agent.invoke` 跨进程仍是同步等待（长任务应改异步 awaiting + 回调/轮询）。

## 路线图状态
M0 准备 → M1 五子系统 → M2 委派 → M3 跨进程 → M4 治理 → **M5 网络：全部完成**。
接下来是"用起来"：GitHub 组织 + 三仓库（你的账号）· 真后端联网验证 · 用公司真需求落 5–10 个 Agent（15 §7 ④）· 反馈回 conformance 与 Minter 默认策略。
