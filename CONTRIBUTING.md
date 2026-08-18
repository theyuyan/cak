# 贡献指南

感谢你来一起维护。三条规矩，都很短。

## 1. DCO：每个提交签名（`git commit -s`）
不用签 CLA。提交里带一行 `Signed-off-by: 你的名字 <邮箱>`，表示你同意 [Developer Certificate of Origin 1.1](https://developercertificate.org/)。CI 会检查。

## 2. 契约先于实现
- 新能力先提契约（`contracts/` 下的 JSON，`schemaDigest` 用 `npm run digest` 生成），再提实现。
- `std.*` 命名空间只经 RFC 进入（`docs/design/15_PLUGIN_ECOSYSTEM.md §2`）；`x.*` 任何人可发实验契约；`<vendor>.*` 归注册过的组织。
- 同 name@version 的 digest 不可变；改了 = 新版本。

## 3. 判据来自设计包，不来自实现
- 改内核先看 `docs/design/`（02 拓扑 = 03 接口 > 01 架构）。违反 `02_TOPOLOGY.yaml` forbidden_edges 的 PR 不合并（`tests/topology` 会挡）。
- 每个改动带测试；`npm test` 全绿；新增插件必须过一致性测试（`@cak/conformance`，E1 起提供）。
- 发现设计包内部矛盾：提 ADR（`docs/adr/`），不要静默改设计。

## 本地
```
npm install && npm test          # 全部检查（向量 / schema / 拓扑 / 内核 / e2e）
npx tsx bin/cak.ts run docs/design/08_AGENT_SPEC.example.yaml --input "…" --workspace examples/minimal-file-agent --mock-script examples/minimal-file-agent/mock-script.json
```
