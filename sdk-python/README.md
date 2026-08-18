# cak-sdk（Python）

CAK 插件的 Python 边界，**零依赖**（标准库），与 `@cak/sdk`（TypeScript）跑同一条线协议：JSON-RPC 2.0 over NDJSON（stdio），信封 `{"cak":"1","jsonrpc":"2.0",…}`。内核这边看不出插件是什么语言写的——它只看契约和 conformance。

```python
from cak_sdk import serve_plugin, ok, error

class MyProvider:
    id = "my-plugin"
    def list_implementations(self):
        return [{"providerId": self.id, "contract": {"name": "text.summarize", "version": "1.0.0", "schemaDigest": "sha256:…"}, "priority": 50}]
    def execute(self, call, ctx):          # call = AuthorizedInvocation：args 已过内核验证
        return ok({"summary": call["args"]["text"][:100]})

serve_plugin(MyProvider(), plugin_id="my-plugin", version="0.1.0", kernel_compat="^0.3.0")
```
验证：`cak conformance --subprocess "python3 my_plugin.py" --contract text.summarize --args '{"text":"…"}'`（内核复跑一致性测试，13 项）。
示例 `examples/summarize_plugin.py` 已过 13/13。测试：`python3 -m unittest -q tests/test_sdk.py`。
未发布 PyPI；本地 `pip install -e sdk-python`。
