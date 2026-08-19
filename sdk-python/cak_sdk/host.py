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
                 read=None, write=None, exit_fn=None, controller=None) -> None:
    """provider 可为 None；controller=工厂(config)->对象(含 decide(ctx))，即子进程控制器（N-48）。ctx.invoke/compose/attenuate/spawn/invoke_preview 阻塞式反向请求内核。"""
    write = write or (lambda s: (sys.stdout.write(s), sys.stdout.flush()))
    exit_fn = exit_fn or (lambda: sys.exit(0))
    lock = threading.Lock()
    inflight: Dict[Any, dict] = {}
    waiting: Dict[int, dict] = {}   # 反向请求 id → {'ev': Event, 'result':..., 'error':...}
    rid = [1000000]
    def reverse(method: str, params: dict):
        with lock: my = rid[0]; rid[0] += 1
        w = {'ev': threading.Event()}; waiting[my] = w
        send({'cak': CAK_ENVELOPE_VERSION, 'jsonrpc': '2.0', 'id': my, 'method': method, 'params': params})
        w['ev'].wait(300)
        waiting.pop(my, None)
        if 'error' in w: raise RuntimeError(w['error'].get('message', 'error'))
        return w.get('result')

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
            roles = (["capability"] if provider is not None else []) + (["controller"] if controller is not None else [])
            return send(response(rid, {"pluginId": plugin_id, "pluginVersion": version, "protocol": f"cak/{CAK_ENVELOPE_VERSION}", "kernelCompat": kernel_compat, "roles": roles, "implementations": provider.list_implementations() if provider is not None else []}))
        if method == "plugin.health":
            h = _run_maybe_async(provider.health) if (provider is not None and hasattr(provider, "health")) else {"status": "healthy"}
            return send(response(rid, h))
        if method == "plugin.shutdown":
            send(response(rid, {}))
            return exit_fn()
        if method == "controller.decide":
            if controller is None:
                return send(failure(rid, RPC.METHOD_NOT_FOUND, "no controller in this plugin"))
            decide_id, view, config = params.get("decideId"), params.get("view"), params.get("config") or {}
            class Ctx:
                pass
            ctx = Ctx(); ctx.view = view
            ctx.invoke = lambda handle, args, opts=None: reverse("ctx.invoke", {"decideId": decide_id, "handle": handle, "args": args, **({"opts": opts} if opts else {})})
            ctx.compose = lambda spec=None: reverse("ctx.compose", {"decideId": decide_id, **({"spec": spec} if spec else {})})
            ctx.invoke_preview = lambda handle, args: reverse("ctx.preview", {"decideId": decide_id, "handle": handle, "args": args})
            ctx.attenuate = lambda handle, add: reverse("ctx.attenuate", {"decideId": decide_id, "handle": handle, "addCaveats": add})
            ctx.spawn = lambda goal, handles, budget, config2=None: reverse("ctx.spawn", {"decideId": decide_id, "goal": goal, "handles": handles, "budget": budget, **({"config": config2} if config2 else {})})
            def run_decide() -> None:
                try:
                    out = _run_maybe_async(controller(config).decide, ctx)
                    send(response(rid, out))
                except Exception as ex:  # noqa: BLE001
                    send(failure(rid, RPC.INTERNAL, str(ex)))
            threading.Thread(target=run_decide, daemon=True).start()
            return None
        if method == "capability.execute":
            if provider is None:
                return send(failure(rid, RPC.METHOD_NOT_FOUND, "no capability provider in this plugin"))
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
        if not d.get("method") and d.get("id") in waiting:   # 内核对反向请求的回应
            w = waiting[d["id"]]
            if "error" in d: w["error"] = d["error"]
            else: w["result"] = d.get("result")
            w["ev"].set(); return
        handle(d)

    splitter = LineSplitter()
    if read is not None:
        read(lambda chunk: splitter.push(chunk, on_line), exit_fn)
        return
    for raw in sys.stdin:
        splitter.push(raw, on_line)
    exit_fn()
