import json, unittest, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from cak_sdk.transport import decode, DecodeError, RPC, LineSplitter, request
from cak_sdk import serve_plugin, ok

class Echo:
    id = "echo"
    def list_implementations(self):
        return [{"providerId": "echo", "contract": {"name": "x.echo", "version": "1.0.0", "schemaDigest": "sha256:" + "0" * 64}, "priority": 50}]
    def execute(self, call, ctx):
        if call["args"].get("boom"):
            raise RuntimeError("boom")
        return ok({"echo": call["args"]})
    def cancel(self, cid):
        self.cancelled = cid

def drive(lines):
    """把若干行喂给 serve_plugin，收集写出的信封（同步 read/write，线程执行 execute 后 join）"""
    out = []
    import threading, time
    def read(on_chunk, on_end):
        for l in lines:
            on_chunk(l + "\n")
        # 等 execute 线程写完
        for _ in range(50):
            time.sleep(0.01)
            if len(out) >= len([l for l in lines]):
                break
    serve_plugin(Echo(), "echo", "0.1.0", read=read, write=lambda s: out.append(json.loads(s)), exit_fn=lambda: None)
    return out

class TestTransport(unittest.TestCase):
    def test_decode(self):
        self.assertIsInstance(decode("not json"), DecodeError)
        d = decode(json.dumps({"cak": "9", "jsonrpc": "2.0", "id": 1, "method": "x"})); self.assertIsInstance(d, DecodeError); self.assertEqual(d.code, RPC.INVALID_REQUEST); self.assertEqual(d.id, 1)
        d = decode(json.dumps({"cak": "1", "jsonrpc": "1.0", "id": "a"})); self.assertEqual(d.code, RPC.INVALID_REQUEST)
        self.assertEqual(decode(json.dumps(request(1, "plugin.hello", {})))["method"], "plugin.hello")
    def test_splitter(self):
        got = []; s = LineSplitter(); s.push('{"a":1}\n{"b"', got.append); s.push(':2}\n\n', got.append)
        self.assertEqual(got, ['{"a":1}', '{"b":2}'])

class TestHost(unittest.TestCase):
    def test_hello_execute_errors(self):
        out = drive([
            json.dumps(request(1, "plugin.hello", {"protocol": "cak/1"})),
            json.dumps(request(2, "capability.execute", {"call": {"id": "i", "revision": 0, "contract": {}, "args": {"x": 1}}, "ctx": {"principal": [], "trace": {}}})),
            json.dumps(request(3, "nope.method", {})),
            json.dumps({"cak": "2", "jsonrpc": "2.0", "id": 4, "method": "plugin.hello"}),
            json.dumps(request(5, "capability.execute", {"call": {"id": "i", "revision": 0, "contract": {}, "args": {"boom": True}}, "ctx": {}})),
            json.dumps(request(6, "plugin.health", {})),
        ])
        by = {o["id"]: o for o in out}
        self.assertEqual(by[1]["result"]["pluginId"], "echo"); self.assertEqual(by[1]["result"]["implementations"][0]["contract"]["name"], "x.echo")
        self.assertEqual(by[2]["result"]["output"]["echo"], {"x": 1})
        self.assertEqual(by[3]["error"]["code"], RPC.METHOD_NOT_FOUND)
        self.assertEqual(by[4]["error"]["code"], RPC.INVALID_REQUEST)
        self.assertEqual(by[5]["error"]["code"], RPC.INTERNAL); self.assertIn("boom", by[5]["error"]["message"])
        self.assertEqual(by[6]["result"]["status"], "healthy")

if __name__ == "__main__":
    unittest.main()
