#!/usr/bin/env python3
"""Python 写的子进程控制器示例（N-48）：不调模型，读 README.md 前 40 字当回答。python3 readme_controller.py"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from cak_sdk import serve_plugin

class ReadmeController:
    def decide(self, ctx):
        h = next((x for x in ctx.view.get("handles", []) if x["contract"]["name"] == "file.read"), None)
        if not h:
            return {"type": "finish", "output": "[py-ctl] no file.read handle"}
        r = ctx.invoke(h["id"], {"path": "README.md"})
        return {"type": "finish", "output": "[py-ctl] " + (str((r.get("output") or {}).get("content", ""))[:40] if r.get("status") == "executed" else r.get("status"))}

if __name__ == "__main__":
    serve_plugin(None, plugin_id="py-ctl", version="0.1.0", kernel_compat="^0.3.0", controller=lambda cfg: ReadmeController())
