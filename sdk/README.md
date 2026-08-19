# @cak-dev/sdk

插件作者需要的一切，且**只有**这些：`types.ts` 边界 DTO（CapabilityProvider / Controller / ModelBackend / Interceptor / Observer / PolicyMinter …）、stdio JSON-RPC 传输（信封 `cak/1`）、`servePlugin()`、`runConformance()`。里面没有内核内部对象。

```ts
import { servePlugin } from '@cak-dev/sdk';
servePlugin(new MyProvider(), { pluginId: 'my-tool', version: '0.1.0', kernelCompat: '^0.3.0' });
```
未发布 npm 前用本地 tarball：在 cak 仓库 `cd sdk && npm pack`，插件里 `npm i ../cak/sdk/cak-dev-sdk-0.3.0.tgz`。
