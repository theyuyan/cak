"""边界 DTO（与 sdk/types.ts 的 Provider 侧对齐）。JSON 形态原样透传，Python 侧用 TypedDict 只做提示，不做运行时校验（校验在内核）。"""
from __future__ import annotations
from typing import Any, Dict, List, Optional, Protocol, TypedDict, Union, runtime_checkable

Json = Any

class ContractRef(TypedDict):
    name: str
    version: str
    schemaDigest: str

class CapabilityImplementation(TypedDict, total=False):
    providerId: str
    contract: ContractRef
    priority: int
    tags: List[str]

class HandleView(TypedDict, total=False):
    id: str
    contract: ContractRef
    caveats: List[dict]
    delegable: bool

class AuthorizedInvocation(TypedDict, total=False):
    """内核 Verify 之后交给 Provider 的唯一输入：args 已冻结、已过句柄验证"""
    id: str
    revision: int
    contract: ContractRef
    args: Dict[str, Json]
    handle: HandleView
    principal: List[dict]
    digest: str
    idempotencyKey: str

class ProviderCallContext(TypedDict, total=False):
    principal: List[dict]
    trace: dict
    deadlineAtMs: int
    cancellationId: str

class KernelError(TypedDict, total=False):
    code: str
    message: str
    retryable: bool
    detail: dict

ProviderExecuteResult = Dict[str, Any]   # {"output": Json, "usage"?: {...}} 或 {"error": KernelError}

def ok(output: Json, usage: Optional[dict] = None) -> ProviderExecuteResult:
    r: ProviderExecuteResult = {"output": output}
    if usage:
        r["usage"] = usage
    return r

def error(code: str, message: str, retryable: bool = False, detail: Optional[dict] = None) -> ProviderExecuteResult:
    e: KernelError = {"code": code, "message": message, "retryable": retryable}
    if detail:
        e["detail"] = detail
    return {"error": e}

@runtime_checkable
class CapabilityProvider(Protocol):
    id: str
    def list_implementations(self) -> List[CapabilityImplementation]: ...
    def execute(self, call: AuthorizedInvocation, ctx: ProviderCallContext) -> ProviderExecuteResult: ...
    # 可选：def health(self) -> dict ；def cancel(self, cancellation_id: str) -> None
