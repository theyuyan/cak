# create-cak-plugin

30 分钟从零到通过一致性测试（目标见 cak 仓库 `docs/design/15_PLUGIN_ECOSYSTEM.md §3`）。

```
npm create @cak-dev/plugin my-tool --contract file.read --digest sha256:5cbc…   # digest 从注册表 / cak 仓库 contracts 抄
cd my-tool && npm install && npm run build && npm run conformance
```
生成的插件是**同一份代码两种形态**：进程内直接 `new XxxProvider()` 注册；子进程用 `node dist/main.js`（stdio JSON-RPC cak/1）。
你只需要实现 `listImplementations()` 与 `execute()`；SDK 类型里没有内核内部对象。

现状（诚实）：`@cak-dev/sdk` 尚未发布到 npm，模板默认依赖 `github:theyuyan/cak#main`；发布 npm 后改为 `^0.3`。目前只有 capability 角色模板；其余角色（controller / model-backend / interceptor / observer …）随后补。
