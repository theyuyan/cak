"""插件端宿主（与 sdk/plugin-host.ts 对齐）：把一个 Provider 暴露成 subprocess 插件。
serve_plugin(provider, plugin_id, version, kernel_compat) 读 stdin 写 stdout；每个 capability.execute 在线程里跑（Provider 可以是阻塞代码），
cancel 会给该请求打标（迟到结果丢弃）并调用 provider.cancel(cancellation_id)（若有）。stderr 归你自己打日志。"""
from __future__ import annotations
import sys, threading, inspect, asyncio
from typing import Any, Callable, Dict, Optional
from .transport import LineSplitter, decode, encode, response, failure, RPC, CAK_ENVELOPE_VERSION, DecodeError

def _run_maybe_async(fn: Callable, *args: Any) -> Any:
    r = fn(*args)
    if inspect.isawaitable(r):
        return asyncio.run(r)  # type: ignore[arg-type]
    return r

def serve_plugin(provider: Any, plugin_id: str, version: str, kernel_compat: str = "^0.3.0",
                 read=None, write=None, exit_fn=None) -> None:
    write = write or (lambda s: (sys.stdout.write(s), sys.stdout.flush()))
    exit_fn = exit_fn or (lambda: sys.exit(0))
    lock = threading.Lock()
    inflight: Dict[Any, dict] = {}

    def send(env: dict) -> None:
        with lock:
            write(encode(env))

    def handle(e: dict) -> None:
        rid = e.get("id")
        method = e.get("method")
        params = e.get("params") or {}
        if method == "plugin.hello":
            proto = params.get("protocol")
            if proto and proto != f"cak/{CAK_ENVELOPE_VERSION}":
                return send(failure(rid, RPC.INVALID_REQUEST, f"protocol {proto} unsupported"))
            return send(response(rid, {"pluginId": plugin_id, "pluginVersion": version, "protocol": f"cak/{CAK_ENVELOPE_VERSION}", "kernelCompat": kernel_compat, "roles": ["capability"], "implementations": provider.list_implementations()}))
        if method == "plugin.health":
            h = _run_maybe_async(provider.health) if hasattr(provider, "health") else {"status": "healthy"}
            return send(response(rid, h))
        if method == "plugin.shutdown":
            send(response(rid, {}))
            return exit_fn()
        if method == "capability.execute":
            call, ctx = params.get("call"), params.get("ctx")
            if not call or ctx is None:
                return send(failure(rid, RPC.INVALID_PARAMS, "call/ctx required"))
            marker = {"cancelled": False}
            if rid is not None:
                inflight[rid] = marker
            def run() -> None:
                try:
                    r = _run_maybe_async(provider.execute, call, ctx)
                    if marker["cancelled"]:
                        return
                    send(response(rid, r))
                except Exception as ex:  # noqa: BLE001
                    send(failure(rid, RPC.INTERNAL, str(ex)))
                finally:
                    if rid is not None:
                        inflight.pop(rid, None)
            threading.Thread(target=run, daemon=True).start()
            return None
        if method == "cancel":
            req = params.get("requestId")
            if req is not None and req in inflight:
                inflight[req]["cancelled"] = True
            cid = params.get("cancellationId")
            if cid and hasattr(provider, "cancel"):
                try:
                    _run_maybe_async(provider.cancel, cid)
                except Exception:  # noqa: BLE001
                    pass
            return send(response(rid, {}))
        return send(failure(rid, RPC.METHOD_NOT_FOUND, f"unknown method {method!s}"))

    def on_line(line: str) -> None:
        d = decode(line)
        if isinstance(d, DecodeError):
            send(failure(d.id, d.code, d.message))
            return
        handle(d)

    splitter = LineSplitter()
    if read is not None:
        read(lambda chunk: splitter.push(chunk, on_line), exit_fn)
        return
    for raw in sys.stdin:
        splitter.push(raw, on_line)
    exit_fn()
