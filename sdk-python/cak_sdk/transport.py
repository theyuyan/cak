"""线协议（与 sdk/transport.ts 对齐）：未知 cak 版本 → -32600；未知 method → -32601；坏 JSON → -32700。"""
from __future__ import annotations
import json
from typing import Any, Callable, Optional, Union

CAK_ENVELOPE_VERSION = "1"

class RPC:
    PARSE = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL = -32603
    CANCELLED = -32800

METHODS = ("plugin.hello", "plugin.health", "plugin.shutdown", "capability.execute", "model.generate", "context.contribute", "interceptor.intercept", "cancel", "event.publish")

def encode(envelope: dict) -> str:
    return json.dumps(envelope, ensure_ascii=False, separators=(",", ":")) + "\n"

def decode(line: str) -> Union[dict, "DecodeError"]:
    """合法信封 → dict；否则 DecodeError（带 id 以便回错误）"""
    try:
        o = json.loads(line)
    except Exception:
        return DecodeError(RPC.PARSE, "parse error", None)
    if not isinstance(o, dict):
        return DecodeError(RPC.INVALID_REQUEST, "not an object", None)
    rid = o.get("id") if isinstance(o.get("id"), (int, str)) else None
    if o.get("cak") != CAK_ENVELOPE_VERSION:
        return DecodeError(RPC.INVALID_REQUEST, f"unsupported envelope version {o.get('cak')!s} (expected {CAK_ENVELOPE_VERSION})", rid)
    if o.get("jsonrpc") != "2.0":
        return DecodeError(RPC.INVALID_REQUEST, "jsonrpc must be 2.0", rid)
    return o

class DecodeError:
    __slots__ = ("code", "message", "id")
    def __init__(self, code: int, message: str, rid: Optional[Union[int, str]]):
        self.code, self.message, self.id = code, message, rid

def request(rid: Union[int, str], method: str, params: dict) -> dict:
    return {"cak": CAK_ENVELOPE_VERSION, "jsonrpc": "2.0", "id": rid, "method": method, "params": params}

def response(rid: Optional[Union[int, str]], result: Any) -> dict:
    return {"cak": CAK_ENVELOPE_VERSION, "jsonrpc": "2.0", "id": rid, "result": result}

def failure(rid: Optional[Union[int, str]], code: int, message: str, data: Optional[dict] = None) -> dict:
    err: dict = {"code": code, "message": message}
    if data:
        err["data"] = data
    return {"cak": CAK_ENVELOPE_VERSION, "jsonrpc": "2.0", "id": rid, "error": err}

class LineSplitter:
    """stdin 可能一次给半行 / 多行；按 \\n 切、去空行"""
    def __init__(self) -> None:
        self._buf = ""
    def push(self, chunk: str, on_line: Callable[[str], None]) -> None:
        self._buf += chunk
        while True:
            i = self._buf.find("\n")
            if i < 0:
                break
            line = self._buf[:i].strip()
            self._buf = self._buf[i + 1:]
            if line:
                on_line(line)
