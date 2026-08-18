# 工具链（一次定死，之后不再讨论）

| 项 | 决定 | 备注 |
|---|---|---|
| 语言 | TypeScript 5.x，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | 见 `tsconfig.json`；`03_INTERFACE_CONTRACTS.ts` 必须在此配置下编译 |
| 运行时 | Node ≥ 22（`.nvmrc` = v22）；本机 25 亦可 | ESM only（`"type": "module"`） |
| 执行 TS | `tsx`（开发 / spike / 脚本），产物用 `tsc` 出 `dist/` | 不用 ts-node |
| 测试 | `vitest` | `npm test`；所有判据只来自 `docs/design` 与 `tests/vectors` |
| 规范化 / 摘要 | `canonicalize`（RFC 8785 JCS）+ `node:crypto` SHA-256 | 向量已用 Python 交叉校验；内核实现必须过 `tests/vectors` |
| Schema | `ajv` 8（draft 2020-12）+ `ajv-formats` | AgentSpec / PluginManifest / 事件 / 契约 args |
| YAML | `yaml` | Spec / Manifest / Golden fixture |
| 仓库形态 | **单包**（`kernel/ contracts/ sdk/ plugins/ tests/`）直到 M3；M3 起按 `sdk` / `plugins/*` 拆 workspaces | 早拆包只会增加摩擦 |
| 格式 / Lint | 暂不引入（M1 结束前用 `tsc` 兜底）；M2 起 biome | 避免第一天就争风格 |
| CI | `npm run prep:all`（向量 → schema → 拓扑 → spike → vitest）；M1 起加 `tests/topology` 代码扫描 | 本地 = CI，同一条命令 |
| 账本文件 | NDJSON，每行一事件，启动验链 | M1 文件实现；接口见 `03 §4` |
| 传输 | in-process（M1）→ subprocess JSON-RPC 2.0/stdio 信封 `cak/1`（M3） | 见 `01 §2.5` |
| 签名 | M1 HMAC-SHA256 占位（`node:crypto`）；M4 ed25519 | `Signer` 接口不变 |
| 目录 | 见 `docs/design/01_ARCHITECTURE.md §10` | `docs/design` 是指向桌面设计包的符号链接（单一事实源） |

## 常用命令

```
npm run vectors:check    # 向量交叉校验（含 Python 独立实现）
npm run digest -- --check# 契约 schemaDigest 一致性
npm run schemas:check    # Spec / Manifest / 事件 / 契约 schema
npm run topology:check   # 02_TOPOLOGY.yaml 自洽 + 三条主张
npm run spike            # 抛弃式原型：句柄向量 / 单调性 / 端到端 / 崩溃恢复
npm test                 # 以上全部（vitest）
npm run prep:all         # 逐个跑一遍并打印
```
