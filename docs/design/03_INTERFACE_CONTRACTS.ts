/**
 * Composable Agent Kernel v0.3 — Interface Contracts（白纸设计）
 *
 * 五个子系统：Identity · Contract · Authority · Ledger · Boundary；Runtime Loop 是消费者。
 * 约定：越界类型（Controller/Provider/Extension 可见）必须 JSON 可往返；句柄越界只以 HandleId（不透明）出现。
 * [RESERVED] = 位置与类型冻结、M1 不实现语义。
 */

// ============================================================================
// 0. 基础
// ============================================================================
export type ID = string;
export type ISODateTime = string;
export type SemVer = string;
export type SemVerRange = string;
export type Digest = string;                       // "sha256:<hex>"
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };
export interface TraceContext { traceId: ID; spanId: ID; parentSpanId?: ID }

// ============================================================================
// 1. Identity（身份）
// ============================================================================
export type PrincipalKind = "org" | "user" | "agent" | "runtime" | "task";
export interface Principal { kind: PrincipalKind; id: ID; display?: string }
/** 谁，以谁的名义：[task, agent, user, org] 由近到远 */
export type PrincipalChain = Principal[];

export interface Signature { scheme: "hmac-sha256" | "ed25519" | string; keyId: ID; value: string }
export interface Signer {
  sign(payload: JsonObject, as: Principal): Promise<Signature>;
  verify(payload: JsonObject, sig: Signature): Promise<boolean>;
}
/** Provider 角色：密钥托管。M1 占位实现（进程内 HMAC） */
export interface KeyStore {
  readonly id: ID;
  keyFor(principal: Principal): Promise<{ keyId: ID; scheme: Signature["scheme"] }>;
  sign(keyId: ID, bytes: string): Promise<string>;
  verify(keyId: ID, bytes: string, value: string): Promise<boolean>;
}

// ============================================================================
// 2. Contract（契约）— 一切可调用皆契约
// ============================================================================
export type SideEffectClass = "none" | "read" | "write" | "external";
export interface ContractRef { name: string; version: SemVer; schemaDigest: Digest }
export interface CapabilityContract extends ContractRef {
  description?: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  permissions?: string[];
  sideEffects: SideEffectClass;
  idempotent: boolean;
  defaultTimeoutMs?: number;
  /** [RESERVED] 结算 */
  pricing?: { unit: "call" | "token" | "second" | "custom"; amount?: number; currency?: string; note?: string };
  /** 是否异步完成（human.* / 远端 Agent）：调用可能进入 awaiting */
  async?: boolean;
}
export interface CapabilityImplementation { providerId: ID; contract: ContractRef; priority?: number; tags?: string[] }
export interface CapabilityDescriptor { contract: CapabilityContract; candidates: CapabilityImplementation[]; origin: "builtin" | "plugin" | "implicit" }
export interface ContractRegistry {
  registerContract(c: CapabilityContract, origin: "builtin" | "plugin"): void;      // 冲突 → CAPABILITY_CONTRACT_CONFLICT
  registerImplementation(i: CapabilityImplementation): void;
  resolve(name: string, range?: SemVerRange): CapabilityDescriptor | undefined;
  list(): CapabilityDescriptor[];
}

// ============================================================================
// 3. Authority（授权）— 句柄
// ============================================================================
export type Caveat =
  | { kind: "args.match"; schema: JsonObject }                     // args 必须满足的 JSON Schema 子集（谓词）
  | { kind: "args.prefix"; path: string; prefix: string }           // 某 arg 必须以前缀开头（如 path 在 workspace/ 下）
  | { kind: "args.max"; path: string; max: number }
  | { kind: "time.window"; notBefore?: ISODateTime; notAfter?: ISODateTime }
  | { kind: "budget"; slice: BudgetSlice }                          // 按调用扣的预算切片
  | { kind: "requires-approval"; approver: Principal | "any-with-approve-handle"; ttlMs?: number }
  | { kind: "once" }                                                // 一次性
  | { kind: "no-delegate" }                                         // 不可再收窄转交
  | { kind: "provider"; providerId: ID }                            // 锁定实现
  | { kind: "custom"; name: string; params: JsonObject };           // 由 PolicyMinter 注册的验证器解释

export interface BudgetSlice { calls?: number; inputTokens?: number; outputTokens?: number; seconds?: number; cost?: number; currency?: string }

export type HandleId = ID;
/** 内核内部对象；越界只给 HandleId。插件不能构造。 */
export interface Handle {
  readonly id: HandleId;
  readonly contract: ContractRef;
  readonly holder: PrincipalChain;
  readonly parent?: HandleId;
  readonly caveats: readonly Caveat[];              // 只增不减
  readonly issuedAt: ISODateTime;
  readonly expiresAt?: ISODateTime;
  readonly epoch: number;                           // 撤销世代
  readonly proof: { kind: "in-process" } | { kind: "token"; token: string; sig: Signature };   // 跨进程用 token
}
/** 插件可见的句柄视图（不含 proof） */
export interface HandleView { id: HandleId; contract: ContractRef; caveats: Caveat[]; expiresAt?: ISODateTime; delegable: boolean }

export interface Authority {
  mint(contract: ContractRef, holder: PrincipalChain, caveats: Caveat[], opts?: { expiresAt?: ISODateTime }): Promise<Handle>;    // 仅 Composition / PolicyMinter
  attenuate(parent: HandleId, addCaveats: Caveat[], newHolder?: PrincipalChain): Promise<Handle>;   // 只能加 caveat；放宽 → ATTENUATION_ERROR
  revoke(handle: HandleId, reason?: string): Promise<void>;                                          // 后代同时失效
  verify(handle: HandleId, chain: PrincipalChain, args: JsonObject, satisfied?: ApprovalGrant[]): Promise<VerifyResult>;
  view(handle: HandleId): HandleView;
}
export type VerifyResult =
  | { ok: true; effectiveArgs: JsonObject; digest: Digest; budgetCharge?: BudgetSlice }
  | { ok: false; kind: "needs-approval"; requirement: ApprovalRequirement }
  | { ok: false; kind: "denied"; code: "HANDLE_INVALID" | "CAVEAT_VIOLATION" | "BUDGET_EXCEEDED"; reason: string; retryable: boolean };

/** Provider 角色：装配期铸句柄。策略引擎只在这里运行。 */
export interface PolicyMinter {
  readonly id: ID;
  mint(spec: AgentSpec, principal: PrincipalChain, registry: ContractRegistry): Promise<Array<{ contract: ContractRef; caveats: Caveat[]; expiresAt?: ISODateTime }>>;
  onAttenuate?(parent: HandleView, addCaveats: Caveat[]): Promise<{ allow: boolean; reason?: string }>;
}

// ---- 审批：绑定调用摘要（沿用 v0.2 的范围与失效规则） ----
export interface ApprovalRequirement {
  approvalId: ID; invocationId: ID; revision: number; invocationDigest: Digest;
  contract: ContractRef; handleId: HandleId; providerId?: ID; expiresAt?: ISODateTime; summary?: string;
}
export interface ApprovalSubjectV1 {
  schemaVersion: "approval-subject/1";
  invocation: { id: ID; revision: number; contract: ContractRef; args: JsonObject; handleId: HandleId };
  principalChain: PrincipalChain;
  provider?: { providerId: ID };
}
export interface ApprovalGrant {
  approvalId: ID; invocationDigest: Digest; grantedBy: Principal; grantedAt: ISODateTime; expiresAt?: ISODateTime; sig?: Signature;
}

// ============================================================================
// 4. Ledger（账本）— 唯一事实源
// ============================================================================
export type LedgerEventType =
  | "runtime.composed" | "runtime.started" | "runtime.stopped"
  | "handle.minted" | "handle.attenuated" | "handle.revoked"
  | "task.spawned" | "task.step" | "task.suspended" | "task.resumed" | "task.finished" | "task.failed" | "task.cancelled" | "task.timeout"
  | "invocation.requested" | "invocation.revised" | "invocation.authorized" | "invocation.awaiting" | "invocation.denied"
  | "invocation.executed" | "invocation.failed" | "invocation.cancelled"
  | "grant.issued" | "grant.expired"
  | "bundle.composed" | "human.answered"
  | "usage.recorded" | "receipt.issued"
  | "plugin.degraded" | "plugin.installed" | "plugin.yanked" | "error.raised" | "contract.implicitly_defined";

export interface LedgerEvent<P extends JsonObject = JsonObject> {
  seq: number;                 // 全局单调
  prevHash: Digest;
  hash: Digest;                // sha256(JCS({seq,prevHash,ts,taskId,principal,type,payload,schemaVersion}))
  ts: ISODateTime;
  taskId: ID;
  principal: PrincipalChain;
  type: LedgerEventType;
  schemaVersion: SemVer;
  payload: P;                  // 大对象只放 digest（blob）
  sig?: Signature;
}
export interface LedgerStore {
  readonly id: ID;
  append(events: Array<Omit<LedgerEvent, "seq" | "prevHash" | "hash">>): Promise<{ firstSeq: number; lastSeq: number }>;
  read(fromSeq: number, toSeq?: number, filter?: { taskId?: ID; types?: LedgerEventType[] }): AsyncIterable<LedgerEvent>;
  head(): Promise<{ seq: number; hash: Digest }>;
  saveSnapshot(s: LedgerSnapshot): Promise<void>;
  loadSnapshot(taskId?: ID): Promise<LedgerSnapshot | undefined>;
}
export interface BlobStore { readonly id: ID; put(bytes: string, mediaType?: string): Promise<Digest>; get(d: Digest): Promise<{ bytes: string; mediaType?: string } | undefined> }

/** 折叠缓存，不是事实源；可丢弃重算 */
export interface LedgerSnapshot { schemaVersion: SemVer; atSeq: number; atHash: Digest; projections: JsonObject }

/** 折叠器：内核内置；投影是纯函数 */
export interface Fold<S extends JsonObject> { init(): S; apply(state: S, e: LedgerEvent): S }
export interface Projections {
  taskView(taskId: ID): TaskView;
  revocations(): Record<HandleId, { epoch: number; at: ISODateTime }>;
  budgets(): Record<ID, BudgetSlice>;                        // 按 task / handle 剩余
  pendingApprovals(): ApprovalRequirement[];
  invocation(id: ID): InvocationRecord | undefined;
}
export interface Receipt { invocationId: ID; events: LedgerEvent[]; merklePath: Digest[]; root: Digest; sig: Signature }

// ============================================================================
// 5. Runtime Loop（薄）— Task / Step / Invoke
// ============================================================================
export type TaskStatus = "created" | "running" | "suspended" | "finished" | "failed" | "cancelled" | "timeout";
export interface TaskConfig { maxSteps: number; stepTimeoutMs: number; invokeTimeoutMs: number; onLimit?: "final-step" | "fail"; maxConcurrentInvocations?: number }
export interface Task {
  id: ID; parent?: ID; goal: Json; principal: PrincipalChain; handles: HandleId[]; budget: BudgetSlice; config: TaskConfig; status: TaskStatus;
}

export type InvocationStatus = "requested" | "revised" | "authorized" | "awaiting" | "denied" | "executed" | "failed" | "cancelled";
export interface InvocationRecord {
  id: ID; taskId: ID; handleId: HandleId; contract: ContractRef; revision: number; args: JsonObject; status: InvocationStatus;
  digest?: Digest; providerId?: ID; resultDigest?: Digest; error?: KernelError; usage?: UsageRecord; approvalId?: ID; startedAt: ISODateTime; endedAt?: ISODateTime;
}
export interface UsageRecord { units?: { calls?: number; inputTokens?: number; outputTokens?: number; seconds?: number; custom?: JsonObject }; cost?: { amount: number; currency: string }; providerId?: ID; contract?: ContractRef }

/** Controller 看到的一切：账本折叠出的视图（DTO） */
export interface TaskView {
  task: Pick<Task, "id" | "parent" | "goal" | "status" | "budget" | "config">;
  step: { index: number; mustFinalize: boolean; reason?: "maxSteps" | "budget" };
  handles: HandleView[];                       // 即工具目录：能用什么、能用到什么程度
  invocations: InvocationRecord[];             // 本 task 全部调用（含 awaiting / denied 的模型可读理由）
  awaiting: ApprovalRequirement[];
  children: Array<Pick<Task, "id" | "status" | "goal">>;
  lastBundleRef?: Digest;
  budgetRemaining: BudgetSlice;
}

/** 已授权调用：Provider 唯一输入；整体冻结 */
export interface AuthorizedInvocation {
  readonly id: ID; readonly revision: number;
  readonly contract: ContractRef;
  readonly args: Readonly<JsonObject>;                // = VerifyResult.effectiveArgs
  readonly handle: Readonly<HandleView>;
  readonly principal: Readonly<PrincipalChain>;
  readonly digest: Digest;
  readonly approvalId?: ID;
  readonly idempotencyKey: string;                     // 默认 = invocation id
}
export type InvokeResult =
  | { status: "executed"; invocationId: ID; output: Json; usage?: UsageRecord }
  | { status: "awaiting"; invocationId: ID; requirement: ApprovalRequirement }
  | { status: "denied"; invocationId: ID; reason: string; retryable: boolean; code: string }
  | { status: "failed"; invocationId: ID; error: KernelError };

export interface ControllerContext {
  view: TaskView;
  trace: TraceContext;
  /** 一切与世界的交互都从这里走；每次都过 invoke 管线并入账 */
  invoke(handle: HandleId, args: JsonObject, opts?: { timeoutMs?: number; idempotencyKey?: string }): Promise<InvokeResult>;
  /** 组装上下文（用本 task 的句柄调用上下文契约，同样入账）；返回 bundle 引用 */
  compose(spec?: ComposeSpec): Promise<{ bundleRef: Digest; stats: { estimatedTokens?: number } }>;
  /** 干跑（N-29）：不写账本地预判某句柄对这组 args 会 ok / needs-approval / denied；控制器用它在同契约多枚句柄间选择 */
  preview(handle: HandleId, args: JsonObject): { status: 'ok' | 'needs-approval' | 'denied'; reason?: string; code?: string };
  /** 收窄自己的句柄（只能加 caveat） */
  attenuate(handle: HandleId, addCaveats: Caveat[]): Promise<HandleId>;
  /** 派生子任务：交给它一组（已收窄的）句柄与预算切片 */
  spawn(goal: Json, handles: HandleId[], budget: BudgetSlice, config?: Partial<TaskConfig>): Promise<{ taskId: ID }>;
  now(): ISODateTime;
}
export type StepOutcome =
  | { type: "continue"; note?: string }
  | { type: "finish"; output: Json; format?: string }
  | { type: "fail"; error: KernelErrorInit }
  | { type: "await"; reason: "approval" | "human" | "child-task" | "external" | "timer"; until?: ISODateTime };

export interface Controller { readonly id: ID; decide(ctx: ControllerContext): Promise<StepOutcome> }

// ============================================================================
// 6. 上下文与模型（模型是契约 model.generate@1）
// ============================================================================
export interface ComposeSpec { sources?: Array<{ handle: HandleId; args?: JsonObject; priority?: number; stability?: "static" | "session" | "turn" }>; maxTokens?: number }
export interface ContextContribution { source: ID; kind: "system" | "message" | "document" | "memory" | "tool_result"; content: Json; priority: number; stability?: "static" | "session" | "turn"; estimatedTokens?: number; cacheKey?: string }
export interface ContextBundle { items: ContextContribution[]; digest: Digest; stats?: { estimatedTokens?: number } }

export interface ContextMessage { role: "system" | "user" | "assistant" | "tool"; content: Json; name?: string; toolCallId?: ID }
/** model.generate@1 的 args（inputSchema 与此一致） */
export interface ModelGenerateArgs {
  intent: ModelCallIntent;
  bundleRef?: Digest;
  model?: string;                                        // 受句柄 caveat 约束（如 args.match{model:...}）
}
export interface ModelCallIntent {
  purpose: "decide" | "plan" | "summarize" | "extract" | "custom";
  instructions?: string;
  messages?: ContextMessage[];
  tools?: "none" | "held" | { handles: HandleId[] };     // held = 本 task 持有的全部句柄
  outputSchema?: JsonObject;
  params?: { temperature?: number; maxOutputTokens?: number; stop?: string[]; [k: string]: Json | undefined };
  cache?: { stablePrefix?: boolean };
}
/** model.generate@1 的 output（outputSchema 与此一致） */
export interface ModelGenerateOutput {
  content?: Json;
  toolCalls?: Array<{ id: ID; handle: HandleId; args: JsonObject }>;   // 直接给句柄，不再"按名字找工具"
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error";
  usage?: UsageRecord;
}
/** Provider 角色：只推理 */
export interface BackendRequest { callId: ID; model: string; messages: ContextMessage[]; tools?: Array<{ name: string; description?: string; inputSchema: JsonObject }>; outputSchema?: JsonObject; params?: JsonObject; deadlineAtMs?: number }
export interface BackendResult { callId: ID; content?: Json; toolCalls?: Array<{ id: ID; name: string; args: JsonObject }>; finishReason: ModelGenerateOutput["finishReason"]; usage?: UsageRecord; raw?: JsonObject }
export interface ModelBackend { readonly id: ID; generate(req: BackendRequest, ctx: ProviderCallContext): Promise<BackendResult> }

// ============================================================================
// 7. Boundary（边界）— 越界 DTO 与 Provider / Extension
// ============================================================================
export interface ProviderCallContext { principal: PrincipalChain; trace: TraceContext; deadlineAtMs?: number; cancellationId?: ID; permissions?: string[]; metadata?: JsonObject }
export type ExtensionPoint = "before.verify" | "after.verify" | "before.execute" | "after.execute" | "on.task.start" | "on.task.end" | "on.step" | "on.event";
export interface ExtensionCallContext { principal: PrincipalChain; trace: TraceContext; stage: ExtensionPoint; deadlineAtMs?: number; cancellationId?: ID; metadata?: JsonObject }

export interface CapabilityProvider {
  readonly id: ID;
  listImplementations(): CapabilityImplementation[];
  /** 可选：Provider 自带的契约定义（x.* 实验契约 / 适配器）；内核按 implicit 契约注册并发 contract.implicitly_defined（M3 新增，10 N-10） */
  listContracts?(): CapabilityContract[];
  execute(inv: AuthorizedInvocation, ctx: ProviderCallContext): Promise<{ output: Json; usage?: UsageRecord } | { error: KernelErrorInit }>;
  cancel?(cancellationId: ID): Promise<void>;
  health?(): Promise<{ status: "healthy" | "degraded" | "failed"; detail?: string }>;
}

export type InterceptorPayload =
  | { stage: "before.verify"; invocation: { id: ID; revision: number; contract: ContractRef; args: JsonObject; handle: HandleView } }
  | { stage: "after.verify" | "before.execute"; invocation: AuthorizedInvocation }
  | { stage: "after.execute"; invocation: AuthorizedInvocation; result: { output: Json; usage?: UsageRecord } };
export type InterceptorReturn =
  | { args: JsonObject }                 // 仅 before.verify：产生 revision+1；只能改窄（放宽由 verify 自然拒绝）
  | { reject: KernelErrorInit }          // before.verify：视同 denied；其后：视同 failed
  | { result: { output: Json; usage?: UsageRecord } }   // 仅 after.execute
  | void;
export interface Interceptor { readonly id: ID; readonly points: ExtensionPoint[]; readonly priority: number; intercept(p: InterceptorPayload, ctx: ExtensionCallContext): Promise<InterceptorReturn> }
export interface Observer { readonly id: ID; onEvent(e: LedgerEvent): Promise<void> | void }

// ============================================================================
// 8. Agent Spec / Agent Card / Plugin Manifest
// ============================================================================
export interface AgentSpec {
  apiVersion: "agent.kernel/v1beta1";
  kind: "Agent";
  metadata: { name: string; version: SemVer; labels?: Record<string, string> };
  spec: {
    principal: { org?: ID; agent: ID };
    controller: { provider: ID; config?: JsonObject };
    /** 铸句柄的依据：契约 + caveats。取代 v0.2 的 capabilities.allow */
    grants: Array<{ contract: string; version?: SemVerRange; caveats?: Caveat[]; expiresAt?: ISODateTime }>;
    model: { backend: ID; model: string; caveats?: Caveat[] };          // 生成 model.generate@1 句柄
    context?: { sources: Array<{ contract: string; args?: JsonObject; priority?: number; stability?: "static" | "session" | "turn" }> };
    minter?: { provider: ID; config?: JsonObject };
    ledger: { store: ID; blob?: ID };
    observers?: ID[];
    interceptors?: ID[];
    task: TaskConfig;
    budget?: BudgetSlice;
    manifest?: AgentCardSpec;                                            // 名片
  };
}
export interface AgentCardSpec { displayName?: string; description?: string; provides?: string[]; endpoints?: Array<{ type: "in-process" | "subprocess" | "remote"; address?: string }> }
/** 生成物：名片（可发布、可签名） */
export interface AgentCard { principal: Principal; displayName?: string; description?: string; provides: ContractRef[]; accepts: { handleProofs: Array<"in-process" | "token"> }; endpoints: AgentCardSpec["endpoints"]; sig?: Signature }

export interface PluginManifest {
  id: ID; version: SemVer; kernelCompat: SemVerRange; displayName?: string;
  roles: Array<"controller" | "capability" | "model-backend" | "ledger-store" | "blob-store" | "policy-minter" | "interceptor" | "observer" | "key-store">;
  provides?: { contracts?: CapabilityContract[]; implementations?: CapabilityImplementation[]; extensions?: Array<{ id: ID; points: ExtensionPoint[]; priority: number }> };
  entrypoint: { type: "in-process"; module: string; export?: string } | { type: "subprocess"; command: string; args?: string[]; env?: Record<string, string> } | { type: "wasm"; module: string } | { type: "remote"; url: string; auth?: { secretRef: string } };
  configSchema?: JsonObject;
  health?: { startupTimeoutMs?: number; probe?: "call" | "none" };
}

// ============================================================================
// 9. Errors
// ============================================================================
export type KernelErrorCode =
  | "CONFIGURATION_ERROR" | "COMPATIBILITY_ERROR" | "COMPONENT_NOT_FOUND" | "DEPENDENCY_ERROR" | "BINDING_ERROR"
  | "CAPABILITY_CONTRACT_CONFLICT" | "AMBIGUOUS_ROUTE" | "ROUTING_ERROR"
  | "HANDLE_INVALID" | "CAVEAT_VIOLATION" | "ATTENUATION_ERROR" | "POLICY_INTEGRITY_ERROR"
  | "APPROVAL_INVALID" | "APPROVAL_EXPIRED" | "LEDGER_INCOMPATIBLE" | "LEDGER_CORRUPT"
  | "ARGS_INVALID" | "CAPABILITY_ERROR" | "PROVIDER_ERROR" | "TIMEOUT" | "CANCELLED"
  | "BUDGET_EXCEEDED" | "STEP_LIMIT" | "TRANSPORT_ERROR" | "INTERNAL_ERROR";
export interface KernelErrorInit { code: KernelErrorCode; message: string; retryable?: boolean; detail?: JsonObject }
export interface KernelError extends KernelErrorInit { id: ID; at: ISODateTime; taskId?: ID; trace?: TraceContext }

// ============================================================================
// 10. 传输信封（沿用 v0.2）
// ============================================================================
export interface TransportEnvelope<T = Json> { cak: "1"; jsonrpc: "2.0"; id?: ID | number | null; method?: string; params?: T; result?: T; error?: { code: number; message: string; data?: JsonObject } }
