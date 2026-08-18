#!/usr/bin/env python3
"""示例：用 Python 实现 text.summarize@1（抽前几句）。运行：python3 summarize_plugin.py（stdio 插件）。
契约 digest 从 cak 仓库 contracts/builtin/text.summarize@1.json 抄；不匹配会在装配期 fail-fast。"""
import re, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from cak_sdk import serve_plugin, ok, error

CONTRACT = {"name": "text.summarize", "version": "1.0.0", "schemaDigest": "sha256:e199070d00d4a32eef314b35a59d3ebf5ce3bd536a9b20c0e822ed39905820c3"}

class SummarizeProvider:
    id = "py-summarize"
    def list_implementations(self):
        return [{"providerId": self.id, "contract": CONTRACT, "priority": 60}]
    def execute(self, call, ctx):
        a = call.get("args") or {}
        text = str(a.get("text", "")).strip()
        max_chars = int(a.get("maxChars", 500))
        if not text:
            return error("CAPABILITY_ERROR", "text is empty")
        sentences = [s for s in re.split(r"(?<=[。！？.!?])\s*", text) if s]
        out, n = [], 0
        for s in sentences:
            if n + len(s) > max_chars:
                break
            out.append(s); n += len(s)
        summary = "".join(out) if out else text[:max_chars]
        return ok({"summary": summary})   # outputSchema additionalProperties:false，只许 summary
    def health(self):
        return {"status": "healthy", "detail": "python " + sys.version.split()[0]}

if __name__ == "__main__":
    serve_plugin(SummarizeProvider(), plugin_id="py-summarize", version="0.1.0", kernel_compat="^0.3.0")
