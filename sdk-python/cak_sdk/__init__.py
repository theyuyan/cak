"""cak-sdk（Python）：CAK 插件边界。与 @cak-dev/sdk（TypeScript）逐字对齐同一条线协议：JSON-RPC 2.0 over NDJSON（stdio），信封 {"cak":"1","jsonrpc":"2.0",…}。
你只需要实现一个 Provider：list_implementations() 与 execute(call, ctx)。内核内部对象在这里不存在——AuthorizedInvocation 是唯一输入，一定已过验证。
"""
from .transport import CAK_ENVELOPE_VERSION, RPC, encode, decode, request, response, failure, LineSplitter
from .types import ContractRef, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, CapabilityProvider, ok, error
from .host import serve_plugin

__all__ = ["CAK_ENVELOPE_VERSION", "RPC", "encode", "decode", "request", "response", "failure", "LineSplitter",
           "ContractRef", "CapabilityImplementation", "AuthorizedInvocation", "ProviderCallContext", "ProviderExecuteResult", "CapabilityProvider", "ok", "error",
           "serve_plugin"]
__version__ = "0.3.0"
