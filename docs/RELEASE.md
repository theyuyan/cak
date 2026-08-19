# 发布（维护者用）

npm scope：`@cak-dev`（`@cak` 被别人占了；bare 名 `cak` 也被占）。命令名仍是 `cak`。

| 包 | 目录 | 命令 |
|---|---|---|
| `@cak-dev/cli` | 仓库根 | `npm publish --access public` |
| `@cak-dev/sdk` | `sdk/` | `npm run build && npm publish --access public` |
| `@cak-dev/create-plugin` | `packages/create-cak-plugin/` | `npm publish --access public` |
| `cak-sdk`（PyPI） | `sdk-python/` | `python3 -m build && python3 -m twine upload dist/*`（需 `pip install build twine`；PyPI 账号另注册） |

前置：`npm login`（发布需 2FA）；npm 组织 `cak-dev` 已建；三处 `package.json` 版本一致（0.3.0）。
发布后：`cak-plugins` 各插件依赖从 `file:../../vendor/cak-dev-sdk-0.3.0.tgz` 改成 `@cak-dev/sdk@^0.3.0`；`create-plugin` 模板默认已指向 `@cak-dev/sdk@^0.3.0`；手册里 `npm i -g @cak-dev/cli` 生效。
验证：`npm view @cak-dev/cli version`；干净目录 `npm i -g @cak-dev/cli && cak doctor`。
