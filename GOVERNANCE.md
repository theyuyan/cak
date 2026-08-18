# 治理

## 角色
- **维护者（Maintainer）**：能合并到 `kernel/` `sdk/` `contracts/std` `docs/design`；负责 RFC 评审、发布、安全响应。
- **贡献者**：任何提交过被合并 PR 的人。

## 维护者怎么产生
被合并 ≥ 3 个非琐碎 PR（含至少 1 个契约或插件）+ 现有维护者两票同意 → 加入。连续 6 个月无活动 → 转为荣誉维护者（可随时回来）。

## 决策
- 日常：PR 评审，一位维护者批准即可（`contracts/std` 与 `kernel/authority` `kernel/ledger` 需两位）。
- 契约进入 `std.*`：RFC，两周评论期，两位维护者同意（`docs/design/15_PLUGIN_ECOSYSTEM.md §2.3`）。
- 破坏性变化：ADR + 迁移期（`§2.4`）。
- 争议：维护者多数票；平票时由创始维护者裁决并公开理由。

## 许可
Apache-2.0；贡献用 DCO。契约文件同许可。第三方插件各自选，注册表只要求声明。
