#!/usr/bin/env node
// 子进程形态的 text.summarize（测试用：给"agent 替用户装插件"的离线测试当被装对象）
import { servePlugin } from "../../sdk/plugin-host.js";
import { TextSummarizeProvider } from "../builtin/index.js";
servePlugin(new TextSummarizeProvider(), { pluginId: "text-summarize", version: "0.1.0", kernelCompat: "^0.3.0" });
