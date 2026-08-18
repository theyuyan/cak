/**
 * @cak/sdk — 插件可见的边界类型（DTO）。
 * 这里没有 Handle、没有 KernelState、没有 AbortSignal：插件拿不到内核内部对象（01 §2.5 / 02 plugin_boundary）。
 * 与 docs/design/03_INTERFACE_CONTRACTS.ts 保持一致；03 是规范，本文件是实现引用的子集。
 */

export type ID = string;
export type ISODateTime = string;
export type SemVer = string;
export type Digest = string;
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };
export interface TraceContext { traceId: ID; spanId: ID; parentSpanId?: ID }

// ---- Identity ----
export type PrincipalKind = 'org' | 'user' | 'agent' | 'runtime' | 'task';
export interface Principal { kind: PrincipalKind; id: ID; display?: string }
export type PrincipalChain = Principal[];
export interface Signature { scheme: string; keyId: ID; value: string }

// ---- Contract ----
export type SideEffectClass = 'none' | 'read' | 'write' | 'external';
export interface ContractRef { name: string; version: SemVer; schemaDigest: Digest }
export interface CapabilityContract extends ContractRef {
  description?: string; inputSchema: JsonObject; outputSchema: JsonObject; permissions?: string[];
  sideEffects: SideEffectClass; idempotent: boolean; defaultTimeoutMs?: number; async?: boolean;
  pricing?: { unit: 'call' | 'token' | 'second' | 'custom'; amount?: number; currency?: string; note?: string };
}
export interface CapabilityImplementation { providerId: ID; contract: ContractRef; priority?: number; tags?: string[] }

// ---- Authority（插件只见视图与 caveat 类型）----
export interface BudgetSlice { calls?: number; inputTokens?: number; outputTokens?: number; seconds?: number; cost?: number; currency?: string }
export type Caveat =
  | { kind: 'args.match'; schema: JsonObject }
  | { kind: 'args.prefix'; path: string; prefix: string }
  | { kind: 'args.max'; path: string; max: number }
  | { kind: 'time.window'; notBefore?: ISODateTime; notAfter?: ISODateTime }
  | { kind: 'budget'; slice: BudgetSlice }
  | { kind: 'requires-approval'; approver: Principal | 'any-with-approve-handle'; ttlMs?: number }
  | { kind: 'once' }
  | { kind: 'no-delegate' }
  | { kind: 'provider'; providerId: ID }
  | { kind: 'custom'; name: string; params: JsonObject };
export type HandleId = ID;
export interface HandleView { id: HandleId; contract: ContractRef; caveats: Caveat[]; expiresAt?: ISODateTime; delegable: boolean }

export interface ApprovalRequirement {
  approvalId: ID; invocationId: ID; revision: number; invocationDigest: Digest; contract: ContractRef; handleId: HandleId; providerId?: ID; expiresAt?: ISODateTime; summary?: string;
}

// ---- Errors ----
export type KernelErrorCode =
  | 'CONFIGURATION_ERROR' | 'COMPATIBILITY_ERROR' | 'COMPONENT_NOT_FOUND' | 'DEPENDENCY_ERROR' | 'BINDING_ERROR'
  | 'CAPABILITY_CONTRACT_CONFLICT' | 'AMBIGUOUS_ROUTE' | 'ROUTING_ERROR'
  | 'HANDLE_INVALID' | 'CAVEAT_VIOLATION' | 'ATTENUATION_ERROR' | 'POLICY_INTEGRITY_ERROR'
  | 'APPROVAL_INVALID' | 'APPROVAL_EXPIRED' | 'LEDGER_INCOMPATIBLE' | 'LEDGER_CORRUPT'
  | 'ARGS_INVALID' | 'CAPABILITY_ERROR' | 'PROVIDER_ERROR' | 'TIMEOUT' | 'CANCELLED'
  | 'BUDGET_EXCEEDED' | 'STEP_LIMIT' | 'TRANSPORT_ERROR' | 'INTERNAL_ERROR';
export interface KernelErrorInit { code: KernelErrorCode; message: string; retryable?: boolean; detail?: JsonObject }
export interface KernelError extends KernelErrorInit { id: ID; at: ISODateTime; taskId?: ID }

// ---- Invocation（Provider 唯一输入）----
export interface UsageRecord { units?: { calls?: number; inputTokens?: number; outputTokens?: number; seconds?: number; custom?: JsonObject }; cost?: { amount: number; currency: string }; providerId?: ID; contract?: ContractRef }
export interface AuthorizedInvocation {
  readonly id: ID; readonly revision: number; readonly contract: ContractRef; readonly args: Readonly<JsonObject>;
  readonly handle: Readonly<HandleView>; readonly principal: Readonly<PrincipalChain>; readonly digest: Digest;
  readonly approvalId?: ID; readonly idempotencyKey: string;
}
export type InvokeResult =
  | { status: 'executed'; invocationId: ID; output: Json; usage?: UsageRecord }
  | { status: 'awaiting'; invocationId: ID; requirement: ApprovalRequirement }
  | { status: 'denied'; invocationId: ID; reason: string; retryable: boolean; code: string }
  | { status: 'failed'; invocationId: ID; error: KernelError };

// ---- Provider / Extension 上下文 ----
export interface ProviderCallContext { principal: PrincipalChain; trace: TraceContext; deadlineAtMs?: number; cancellationId?: ID; permissions?: string[]; metadata?: JsonObject }
export type ExtensionPoint = 'before.verify' | 'after.verify' | 'before.execute' | 'after.execute' | 'on.task.start' | 'on.task.end' | 'on.step' | 'on.event';
export interface ExtensionCallContext { principal: PrincipalChain; trace: TraceContext; stage: ExtensionPoint; deadlineAtMs?: number; cancellationId?: ID; metadata?: JsonObject }

export type ProviderExecuteResult = { output: Json; usage?: UsageRecord } | { error: KernelErrorInit };
export interface CapabilityProvider {
  readonly id: ID;
  listImplementations(): CapabilityImplementation[];
  /** 可选：Provider 自带的契约定义（用于 x.* 实验契约 / 适配器）；内核按 implicit 契约注册（首个实现的 digest 成 canonical，发 contract.implicitly_defined） */
  listContracts?(): CapabilityContract[];
  execute(inv: AuthorizedInvocation, ctx: ProviderCallContext): Promise<ProviderExecuteResult>;
  cancel?(cancellationId: ID): Promise<void>;
  health?(): Promise<{ status: 'healthy' | 'degraded' | 'failed'; detail?: string }>;
}

// ---- Model backend ----
export interface ContextMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: Json; name?: string; toolCallId?: ID; toolCalls?: Array<{ id: ID; name: string; args: JsonObject }> }
export interface BackendRequest { callId: ID; model: string; messages: ContextMessage[]; tools?: Array<{ name: string; description?: string; inputSchema: JsonObject }>; outputSchema?: JsonObject; params?: JsonObject; deadlineAtMs?: number }
export interface BackendResult { callId: ID; content?: Json; toolCalls?: Array<{ id: ID; name: string; args: JsonObject }>; finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error'; usage?: UsageRecord; raw?: JsonObject }
export interface ModelBackend { readonly id: ID; generate(req: BackendRequest, ctx: ProviderCallContext): Promise<BackendResult> }

// ---- Interceptor / Observer ----
export type InterceptorPayload =
  | { stage: 'before.verify'; invocation: { id: ID; revision: number; contract: ContractRef; args: JsonObject; handle: HandleView } }
  | { stage: 'after.verify' | 'before.execute'; invocation: AuthorizedInvocation }
  | { stage: 'after.execute'; invocation: AuthorizedInvocation; result: { output: Json; usage?: UsageRecord } };
export type InterceptorReturn = { args: JsonObject } | { reject: KernelErrorInit } | { result: { output: Json; usage?: UsageRecord } } | void;
export interface Interceptor { readonly id: ID; readonly points: ExtensionPoint[]; readonly priority: number; intercept(p: InterceptorPayload, ctx: ExtensionCallContext): Promise<InterceptorReturn> }

export interface LedgerEventView { seq: number; ts: ISODateTime; taskId: ID; principal: PrincipalChain; type: string; payload: JsonObject; hash: Digest; prevHash: Digest; schemaVersion: SemVer }
export interface Observer { readonly id: ID; onEvent(e: LedgerEventView): Promise<void> | void }

// ---- Controller ----
export interface TaskConfig { maxSteps: number; stepTimeoutMs: number; invokeTimeoutMs: number; onLimit?: 'final-step' | 'fail'; maxConcurrentInvocations?: number }
export type TaskStatus = 'created' | 'running' | 'suspended' | 'finished' | 'failed' | 'cancelled' | 'timeout';
export type InvocationStatus = 'requested' | 'revised' | 'authorized' | 'awaiting' | 'denied' | 'executed' | 'failed' | 'cancelled';
export interface InvocationRecord {
  id: ID; taskId: ID; handleId: HandleId; contract: ContractRef; revision: number; args: JsonObject; status: InvocationStatus;
  digest?: Digest; providerId?: ID; resultDigest?: Digest; output?: Json; error?: KernelErrorInit; usage?: UsageRecord; approvalId?: ID; denyReason?: string; denyCode?: string; retryable?: boolean;
}
export interface TaskView {
  task: { id: ID; parent?: ID; goal: Json; status: TaskStatus; budget: BudgetSlice; config: TaskConfig };
  step: { index: number; mustFinalize: boolean; reason?: 'maxSteps' | 'budget' };
  handles: HandleView[];
  invocations: InvocationRecord[];
  awaiting: ApprovalRequirement[];
  children: Array<{ id: ID; status: TaskStatus; goal: Json }>;
  lastBundleRef?: Digest;
  budgetRemaining: BudgetSlice;
  input?: Json;
}
export interface ComposeSpec { sources?: Array<{ handle: HandleId; args?: JsonObject; priority?: number; stability?: 'static' | 'session' | 'turn' }>; maxTokens?: number }
export interface ModelCallIntent {
  purpose: 'decide' | 'plan' | 'summarize' | 'extract' | 'custom'; instructions?: string; messages?: ContextMessage[];
  tools?: 'none' | 'held' | { handles: HandleId[] }; outputSchema?: JsonObject; params?: JsonObject; cache?: { stablePrefix?: boolean };
}
export interface ModelGenerateArgs { intent: ModelCallIntent; bundleRef?: Digest; model?: string }
export interface ModelGenerateOutput { content?: Json; toolCalls?: Array<{ id: ID; handle: HandleId; args: JsonObject }>; finishReason: BackendResult['finishReason']; usage?: UsageRecord }
export interface ControllerContext {
  view: TaskView; trace: TraceContext;
  invoke(handle: HandleId, args: JsonObject, opts?: { timeoutMs?: number; idempotencyKey?: string }): Promise<InvokeResult>;
  compose(spec?: ComposeSpec): Promise<{ bundleRef: Digest; stats: { estimatedTokens?: number } }>;
  /** 干跑（N-29）：不写账本地预判某句柄对这组 args 会 ok / needs-approval / denied；控制器用它在同契约多枚句柄间选择 */
  preview(handle: HandleId, args: JsonObject): { status: 'ok' | 'needs-approval' | 'denied'; reason?: string; code?: string };
  attenuate(handle: HandleId, addCaveats: Caveat[]): Promise<HandleId>;
  spawn(goal: Json, handles: HandleId[], budget: BudgetSlice, config?: Partial<TaskConfig>): Promise<{ taskId: ID }>;
  now(): ISODateTime;
}
export type StepOutcome =
  | { type: 'continue'; note?: string } | { type: 'finish'; output: Json; format?: string }
  | { type: 'fail'; error: KernelErrorInit } | { type: 'await'; reason: 'approval' | 'human' | 'child-task' | 'external' | 'timer'; until?: ISODateTime };
export interface Controller { readonly id: ID; decide(ctx: ControllerContext): Promise<StepOutcome> }

// ---- Agent Spec（v1beta1，与 07 schema 一致）----
export interface AgentSpec {
  apiVersion: 'agent.kernel/v1beta1'; kind: 'Agent'; metadata: { name: string; version: SemVer; labels?: Record<string, string> };
  spec: {
    principal: { org?: ID; agent: ID };
    controller: { provider: ID; config?: JsonObject };
    grants: Array<{ contract: string; version?: string; caveats?: Caveat[]; expiresAt?: ISODateTime }>;
    model: { backend: ID; model: string; caveats?: Caveat[] };
    context?: { sources: Array<{ contract: string; args?: JsonObject; priority?: number; stability?: 'static' | 'session' | 'turn' }> };
    minter?: { provider: ID; config?: JsonObject };
    ledger: { store: ID; blob?: ID };
    observers?: ID[]; interceptors?: ID[];
    task: TaskConfig; budget?: BudgetSlice;
    manifest?: { displayName?: string; description?: string; provides?: string[]; endpoints?: Array<{ type: 'in-process' | 'subprocess' | 'remote'; address?: string }> };
  };
}
/** Provider 角色：装配期铸句柄（策略只在这里跑） */
export interface PolicyMinter {
  readonly id: ID;
  mint(spec: AgentSpec, principal: PrincipalChain, resolve: (name: string, range?: string) => CapabilityContract | undefined): Promise<Array<{ contract: ContractRef; caveats: Caveat[]; expiresAt?: ISODateTime }>>;
}
