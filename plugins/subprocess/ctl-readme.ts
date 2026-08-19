#!/usr/bin/env node
// 子进程控制器示例（任何语言都能这么写）：读 workspace/README.md 的前 40 字当回答；不调模型
import { servePlugin } from "../../sdk/plugin-host.js";
servePlugin(null, { pluginId: "ctl-readme", version: "0.1.0", kernelCompat: "^0.3.0", controller: () => ({ id: "ctl-readme", async decide(ctx) {
  const h = ctx.view.handles.find(x => x.contract.name === "file.read"); if (!h) return { type: "finish", output: "[ctl-readme] no file.read handle" };
  const r = await ctx.invoke(h.id, { path: "README.md" });
  return { type: "finish", output: "[ctl-readme] " + (r.status === "executed" ? String((r.output as any)?.content ?? "").slice(0, 40) : r.status) };
} }) });
