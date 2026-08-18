/**
 * Runtime（06_RUNTIME_LOOP.md）：Composition → Task/Step → invoke 管线（唯一执行路径）→ 账本。
 * 模型调用也是一次 invoke（model.generate@1 内置实现）；Controller 只经 ctx.* 与世界交互；一切先入账。
 */
import { randomUUID } from 'node:crypto';
import type {
  AgentSpec, AuthorizedInvocation, BudgetSlice, CapabilityContract, CapabilityProvider, Caveat, ContractRef, Controller, ControllerContext, ComposeSpec, HandleId, ID, ISODateTime,
  Interceptor, InvokeResult, Json, JsonObject, ModelBackend, ModelGenerateArgs, ModelGenerateOutput, Observer, PolicyMinter, PrincipalChain, StepOutcome, TaskConfig, TaskView, TraceContext, ProviderCallContext, ExtensionCallContext, InvocationRecord, ApprovalRequirement, ContextMessage, HandleView, UsageRecord,
} from '../../sdk/types.js';
import { Ledger, MemoryLedgerStore, MemoryBlobStore, digest, merkleRoot, type LedgerStore, type BlobStore, type Projections } from '../ledger/ledger.js';
import { createHmac } from 'node:crypto';
import { ContractRegistry, loadBuiltinContracts } from '../contract/registry.js';
import { Authority, type Grant, type Handle } from '../authority/authority.js';
import { HmacSigner } from '../identity/identity.js';
import { KernelErr, err, toErrorInit } from '../errors.js';

export interface Plugins {
  controllers: Record<ID, (config?: JsonObject) => Controller>;
  backends: Record<ID, ModelBackend>;
  providers: CapabilityProvider[];
  minters?: Record<ID, PolicyMinter>;
  interceptors?: Interceptor[];
  observers?: Observer[];
  contracts?: CapabilityContract[];       // 插件带来的契约定义（builtin 之外）
}
export interface KernelOptions { ledgerStore?: LedgerStore; blobStore?: BlobStore; now?: () => ISODateTime; signKey?: string; runtimeId?: ID; workspaceRoot?: string }
export interface TaskResult { taskId: ID; status: 'finished' | 'failed' | 'suspended' | 'cancelled' | 'timeout'; output?: Json; error?: JsonObject }

const RUNTIME_TASK = 'runtime';
const MODEL_CONTRACT = 'model.generate';
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
class Semaphore { private q: Array<() => void> = []; private n = 0; constructor(private max: number) {} async acquire() { if (this.n < this.max) { this.n++; return; } await new Promise<void>(r => this.q.push(r)); this.n++; } release() { this.n--; const r = this.q.shift(); if (r) r(); } }

/** 默认铸造策略（static-minter 语义）：Spec.grants + model + context sources 各铸一个根句柄 */
export const staticMinter: PolicyMinter = {
  id: 'static-minter',
  async mint(spec, _principal, resolve) {
    const out: Array<{ contract: ContractRef; caveats: Caveat[]; expiresAt?: ISODateTime }> = [];
    for (const g of spec.spec.grants) {
      const c = resolve(g.contract, g.version); if (!c) throw err('CONFIGURATION_ERROR', `grants: contract ${g.contract}${g.version ? '@' + g.version : ''} not found`);
      out.push({ contract: { name: c.name, version: c.version, schemaDigest: c.schemaDigest }, caveats: g.caveats ?? [], expiresAt: g.expiresAt });
    }
    const m = resolve(MODEL_CONTRACT); if (!m) throw err('CONFIGURATION_ERROR', 'model.generate contract missing');
    out.push({ contract: { name: m.name, version: m.version, schemaDigest: m.schemaDigest }, caveats: [...(spec.spec.model.caveats ?? [])] });
    for (const src of spec.spec.context?.sources ?? []) {
      if (out.some(o => o.contract.name === src.contract) || spec.spec.grants.some(g => g.contract === src.contract)) continue;
      const c = resolve(src.contract); if (!c) throw err('CONFIGURATION_ERROR', `context source contract ${src.contract} not found`);
      out.push({ contract: { name: c.name, version: c.version, schemaDigest: c.schemaDigest }, caveats: [] });
    }
    return out;
  },
};

export class Kernel {
  readonly registry = new ContractRegistry();
  readonly authority = new Authority();
  readonly ledger: Ledger;
  readonly blob: BlobStore;
  readonly signer: HmacSigner;
  readonly runtimeId: ID;
  readonly agentChain: PrincipalChain;
  readonly rootHandles: Handle[] = [];
  private controller!: Controller;
  private backend!: ModelBackend;
  private providersById = new Map<ID, CapabilityProvider>();
  private interceptors: Interceptor[] = [];
  private now: () => ISODateTime;
  private signKey: string;
  private inflight = new Map<ID, { cancel?: () => void }>();
  private taskWaiters = new Map<ID, Array<(r: TaskResult) => void>>();
  private beforeVerifyCalls = 0;   // 测试可读
  private beforeVerifyByInvocation = new Map<ID, number>();   // 测试可读：审批恢复后该调用的计数不得增加

  private constructor(readonly spec: AgentSpec, private plugins: Plugins, opts: KernelOptions) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.signKey = opts.signKey ?? 'dev-key';
    this.runtimeId = opts.runtimeId ?? 'rt_' + randomUUID().slice(0, 8);
    this.agentChain = [{ kind: 'agent', id: spec.spec.principal.agent }, ...(spec.spec.principal.org ? [{ kind: 'org' as const, id: spec.spec.principal.org }] : [])];
    this.ledger = Ledger.open(opts.ledgerStore ?? new MemoryLedgerStore(), this.now);
    this.blob = opts.blobStore ?? new MemoryBlobStore();
    this.signer = new HmacSigner(this.signKey);
  }

  /** Composition（01 §4）：契约 → 实现 → 绑定 → 铸句柄（或从账本重建）→ runtime.composed */
  static async compose(spec: AgentSpec, plugins: Plugins, opts: KernelOptions = {}): Promise<Kernel> {
    const k = new Kernel(spec, plugins, opts);
    for (const c of loadBuiltinContracts()) k.registry.registerContract(c, 'builtin');
    for (const c of plugins.contracts ?? []) k.registry.registerContract(c, 'plugin');
    for (const p of plugins.providers) { k.providersById.set(p.id, p); const supplied = p.listContracts?.() ?? []; for (const impl of p.listImplementations()) k.registry.registerImplementation(impl, supplied.find(c => c.name === impl.contract.name && c.version === impl.contract.version)); }
    const mkController = plugins.controllers[spec.spec.controller.provider]; if (!mkController) throw err('COMPONENT_NOT_FOUND', `controller ${spec.spec.controller.provider}`);
    k.controller = mkController(spec.spec.controller.config);
    const be = plugins.backends[spec.spec.model.backend]; if (!be) throw err('COMPONENT_NOT_FOUND', `model backend ${spec.spec.model.backend}`);
    k.backend = be;
    k.interceptors = [...(plugins.interceptors ?? [])].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    for (const o of plugins.observers ?? []) k.ledger.subscribe(o);
    const minter = spec.spec.minter ? (plugins.minters?.[spec.spec.minter.provider] ?? (spec.spec.minter.provider === 'static-minter' ? staticMinter : undefined)) : staticMinter;
    if (!minter) throw err('COMPONENT_NOT_FOUND', `minter ${spec.spec.minter?.provider}`);

    const proj = k.ledger.projections();
    if (Object.keys(proj.handles).length === 0) {
      const grants = await minter.mint(spec, k.agentChain, (n, r) => k.registry.resolve(n, r)?.contract);
      for (const g of grants) {
        const h = k.authority.mint(g.contract, k.agentChain, g.caveats, k.now(), { expiresAt: g.expiresAt });
        k.rootHandles.push(h);
        k.ledger.append({ taskId: RUNTIME_TASK, principal: k.agentChain, type: 'handle.minted', payload: { handleId: h.id, contract: h.contract as any, holder: h.holder as any, caveats: [...h.caveats] as any, ...(h.expiresAt ? { expiresAt: h.expiresAt } : {}) } });
      }
      k.ledger.append({ taskId: RUNTIME_TASK, principal: k.agentChain, type: 'runtime.composed', payload: { runtimeId: k.runtimeId, agent: spec.metadata.name, version: spec.metadata.version, handles: k.rootHandles.map(h => h.id) } });
    } else {
      // 重启：句柄表由账本折叠重建（04 §4.1）
      k.authority.rebuildFromProjections(proj);
      for (const h of Object.values(proj.handles)) if (!h.parent) k.rootHandles.push(k.authority.get(h.id)!);
    }
    for (const e of k.registry.drainEvents()) k.ledger.append({ taskId: RUNTIME_TASK, principal: k.agentChain, type: e.type, payload: e.payload as any });
    k.ledger.append({ taskId: RUNTIME_TASK, principal: k.agentChain, type: 'runtime.started', payload: { runtimeId: k.runtimeId } });
    return k;
  }

  // ------------------------------------------------------------ Task API
  async startTask(goal: Json, opts: { input?: Json; handles?: HandleId[]; budget?: BudgetSlice; config?: Partial<TaskConfig>; taskId?: ID } = {}): Promise<TaskResult> {
    const taskId = opts.taskId ?? 't_' + randomUUID().slice(0, 8);
    const chain: PrincipalChain = [{ kind: 'task', id: taskId }, ...this.agentChain];
    const config: TaskConfig = { ...this.spec.spec.task, ...(opts.config ?? {}) };
    const handles = opts.handles ?? this.rootHandles.map(h => h.id);
    this.ledger.append({ taskId, principal: chain, type: 'task.spawned', payload: { taskId, goal, handles, budget: (opts.budget ?? this.spec.spec.budget ?? {}) as any, config: config as any, ...(opts.input !== undefined ? { input: opts.input } : {}) } });
    return this.runLoop(taskId);
  }
  /** 恢复：先完成待审批 / 待唤醒的调用（不重跑 before.verify），再继续 step 循环 */
  async resume(taskId: ID): Promise<TaskResult> {
    const t = this.ledger.projections().tasks[taskId]; if (!t) throw err('COMPONENT_NOT_FOUND', `task ${taskId}`);
    if (t.status !== 'suspended') throw err('CONFIGURATION_ERROR', `task ${taskId} is ${t.status}, not suspended`);
    const chain = t.principal;
    this.ledger.append({ taskId, principal: chain, type: 'task.resumed', payload: {} });
    for (const inv of Object.values(this.ledger.projections().invocations).filter(i => i.taskId === taskId && i.status === 'awaiting')) await this.reverifyAndExecute(taskId, chain, inv);
    return this.runLoop(taskId);
  }
  /** 审批方写入 grant（human.approve@1 提供方 / 系统 / 测试夹具） */
  grant(approvalId: string, grantedBy: { kind: 'user' | 'agent' | 'org' | 'runtime' | 'task'; id: ID }, opts: { expiresAt?: ISODateTime } = {}): { invocationId: ID; taskId: ID } {
    const pend = Object.values(this.ledger.projections().pendingApprovals).find(p => p.approvalId === approvalId);
    if (!pend) throw err('APPROVAL_INVALID', `no pending approval ${approvalId}`);
    const inv = this.ledger.projections().invocations[pend.invocationId]!;
    this.ledger.append({ taskId: inv.taskId, principal: [grantedBy], type: 'grant.issued', payload: { approvalId, invocationDigest: pend.invocationDigest, grantedBy: grantedBy as any, ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}) } });
    return { invocationId: inv.id, taskId: inv.taskId };
  }
  pendingApprovals(taskId?: ID): ApprovalRequirement[] { return Object.values(this.ledger.projections().pendingApprovals).filter(p => !taskId || this.ledger.projections().invocations[p.invocationId]?.taskId === taskId); }
  receipt(invocationId: ID) { return this.ledger.receipt(invocationId, this.signKey); }
  get stats() { return { beforeVerifyCalls: this.beforeVerifyCalls, beforeVerifyFor: (id: ID) => this.beforeVerifyByInvocation.get(id) ?? 0 }; }
  resetStats() { this.beforeVerifyCalls = 0; }
  taskView(taskId: ID): TaskView { return this.buildView(taskId, this.ledger.projections()); }

  // ------------------------------------------------------------ Step loop
  private async runLoop(taskId: ID): Promise<TaskResult> {
    for (;;) {
      const proj = this.ledger.projections(); const t = proj.tasks[taskId]!; const chain = t.principal;
      if (t.status !== 'running') break;
      const index = t.steps; const cfg = t.config;
      // Guard-pre
      if (index >= cfg.maxSteps) { this.ledger.append({ taskId, principal: chain, type: 'task.failed', payload: { error: { code: 'STEP_LIMIT', message: `maxSteps=${cfg.maxSteps} exhausted` } } }); break; }
      const mustFinalize = index === cfg.maxSteps - 1 && (cfg.onLimit ?? 'final-step') === 'final-step';
      const view = this.buildView(taskId, proj, mustFinalize);
      const ctx = this.makeCtx(taskId, chain, view, mustFinalize);
      let outcome: StepOutcome;
      try {
        outcome = await Promise.race([this.controller.decide(ctx), sleep(cfg.stepTimeoutMs).then(() => { throw err('TIMEOUT', `step ${index} exceeded ${cfg.stepTimeoutMs}ms`); })]);
      } catch (e) {
        const init = toErrorInit(e);
        this.ledger.append({ taskId, principal: chain, type: 'task.step', payload: { index, outcome: 'fail', mustFinalize } }, { taskId, principal: chain, type: init.code === 'TIMEOUT' ? 'task.timeout' : 'task.failed', payload: { error: init as any } });
        break;
      }
      this.ledger.append({ taskId, principal: chain, type: 'task.step', payload: { index, outcome: outcome.type, mustFinalize } });
      if (outcome.type === 'finish') { const outputRef = this.blob.put(JSON.stringify(outcome.output), 'application/json'); this.ledger.append({ taskId, principal: chain, type: 'task.finished', payload: { outputRef } }); break; }
      if (outcome.type === 'fail') { this.ledger.append({ taskId, principal: chain, type: 'task.failed', payload: { error: outcome.error as any } }); break; }
      if (outcome.type === 'await') {
        this.ledger.append({ taskId, principal: chain, type: 'task.suspended', payload: { reason: outcome.reason, ...(outcome.until ? { until: outcome.until } : {}) } });
        // 竞态：子任务可能在父挂起前就已结束 → 挂起后立刻检查，全部子任务已终态则直接唤醒
        if (outcome.reason === 'child-task') {
          const kids = Object.values(this.ledger.projections().tasks).filter(x => x.parent === taskId);
          if (kids.length > 0 && kids.every(x => x.status !== 'running' && x.status !== 'suspended')) { this.ledger.append({ taskId, principal: chain, type: 'task.resumed', payload: { reason: 'child-task-already-done' } }); continue; }
        }
        break;
      }
      if (mustFinalize) { this.ledger.append({ taskId, principal: chain, type: 'task.failed', payload: { error: { code: 'STEP_LIMIT', message: 'controller returned continue on the final step' } } }); break; }
    }
    const t = this.ledger.projections().tasks[taskId]!;
    const out = t.outputRef ? JSON.parse(this.blob.get(t.outputRef)!.bytes) as Json : undefined;
    const result: TaskResult = { taskId, status: t.status as TaskResult['status'], ...(out !== undefined ? { output: out } : {}) };
    if (t.status !== 'suspended') {
      for (const w of this.taskWaiters.get(taskId) ?? []) w(result); this.taskWaiters.delete(taskId);
      // 子任务结束 → 父任务若在 await(child-task) 则唤醒（06 §6）
      const parent = t.parent ? this.ledger.projections().tasks[t.parent] : undefined;
      if (parent && parent.status === 'suspended' && parent.suspendedReason === 'child-task') void this.resume(parent.id);
    }
    return result;
  }
  /** 等待任务到达终态（suspended 不算）；用于父任务 / 调用方拿最终结果 */
  waitFor(taskId: ID): Promise<TaskResult> {
    const t = this.ledger.projections().tasks[taskId];
    if (t && t.status !== 'running' && t.status !== 'suspended' && t.status !== 'created') { const out = t.outputRef ? JSON.parse(this.blob.get(t.outputRef)!.bytes) as Json : undefined; return Promise.resolve({ taskId, status: t.status as TaskResult['status'], ...(out !== undefined ? { output: out } : {}) }); }
    return new Promise(res => { const l = this.taskWaiters.get(taskId) ?? []; l.push(res); this.taskWaiters.set(taskId, l); });
  }

  // ------------------------------------------------------------ Agent as Capability（01 §9 ③；M2 同进程）
  /** 名片：我是谁、提供什么契约、怎么找到我（可签名） */
  card(): { principal: PrincipalChain[0]; displayName?: string; description?: string; provides: ContractRef[]; accepts: { handleProofs: Array<'in-process' | 'token'> }; endpoints: Array<{ type: string; address?: string }>; sig: { scheme: string; keyId: string; value: string } } {
    const m = this.spec.spec.manifest ?? {};
    const provides = (m.provides ?? []).map(n => this.registry.resolve(n)?.contract).filter((c): c is CapabilityContract => !!c).map(c => ({ name: c.name, version: c.version, schemaDigest: c.schemaDigest }));
    const body = { principal: this.agentChain[0]!, displayName: m.displayName, description: m.description, provides, accepts: { handleProofs: ['in-process' as const] }, endpoints: (m.endpoints ?? [{ type: 'in-process' }]) as Array<{ type: string; address?: string }> };
    return { ...body, sig: this.signer.sign(body, this.agentChain[0]!) };
  }
  /**
   * 对外服务一次来访调用：为来访者铸窄句柄（once）→ 以来访者名义开任务 → 入账来访调用 → 跑完 → 记 executed + 回执。
   * 来访者链：[task, agent:caller, ...我的链]（"由我执行、以来访者名义"）。
   */
  async serve(caller: { agentId: ID }, contract: { name: string; version?: string }, args: JsonObject, opts: { budget?: BudgetSlice } = {}): Promise<{ output: Json; usage: { calls: number; inputTokens: number; outputTokens: number }; receipt: ReturnType<Ledger['receipt']> & { taskId: ID }; taskId: ID } | { error: import('../../sdk/types.js').KernelErrorInit }> {
    const provides = this.spec.spec.manifest?.provides ?? [];
    if (!provides.includes(contract.name)) return { error: { code: 'ROUTING_ERROR', message: `${this.spec.metadata.name} does not provide ${contract.name}`, retryable: false } };
    const c = this.registry.resolve(contract.name, contract.version)?.contract; if (!c) return { error: { code: 'COMPONENT_NOT_FOUND', message: `contract ${contract.name} unknown here`, retryable: false } };
    const taskId = 't_' + randomUUID().slice(0, 8);
    const callerP = { kind: 'agent' as const, id: caller.agentId };
    const chain: PrincipalChain = [{ kind: 'task', id: taskId }, callerP, ...this.agentChain];
    // 为来访者铸窄句柄（持有者链 = [caller, ...我]；once）—— 每次来访一次性授权
    const visitor = this.authority.mint({ name: c.name, version: c.version, schemaDigest: c.schemaDigest }, [callerP, ...this.agentChain], [{ kind: 'once' }], this.now());
    this.ledger.append({ taskId, principal: chain, type: 'handle.minted', payload: { handleId: visitor.id, contract: visitor.contract as any, holder: visitor.holder as any, caveats: [...visitor.caveats] as any } });
    const handles = [...this.rootHandles.map(h => h.id), visitor.id];
    this.ledger.append({ taskId, principal: chain, type: 'task.spawned', payload: { taskId, goal: { contract: c.name, args } as any, handles, budget: (opts.budget ?? this.spec.spec.budget ?? {}) as any, config: this.spec.spec.task as any, input: args } });
    // 来访调用入账 + 验证（一次性句柄：第二次同一来访者会被拒 —— 但每次 serve 都铸新句柄；once 的意义是"这张句柄只用一次"）
    const invId = 'inv_' + randomUUID().slice(0, 12);
    this.ledger.append({ taskId, principal: chain, type: 'invocation.requested', payload: { invocationId: invId, handleId: visitor.id, contract: visitor.contract as any, args, revision: 0 } });
    const v = this.authority.verify(visitor.id, chain, args, { id: invId, revision: 0 }, [], this.ledger.projections(), this.now(), 'self');
    if (!v.ok) { const reason = v.kind === 'denied' ? v.reason : 'needs approval'; const code = v.kind === 'denied' ? v.code : 'APPROVAL_INVALID'; this.ledger.append({ taskId, principal: chain, type: 'invocation.denied', payload: { invocationId: invId, revision: 0, code, reason, retryable: false } }, { taskId, principal: chain, type: 'task.failed', payload: { error: { code, message: reason } } }); return { error: { code: code as any, message: reason, retryable: false } }; }
    this.ledger.append({ taskId, principal: chain, type: 'invocation.authorized', payload: { invocationId: invId, revision: 0, digest: v.digest, effectiveArgs: v.effectiveArgs, providerId: 'self' } });
    const r = await this.runLoop(taskId);
    if (r.status !== 'finished') { this.ledger.append({ taskId, principal: chain, type: 'invocation.failed', payload: { invocationId: invId, error: { code: 'CAPABILITY_ERROR', message: `served task ${r.status}` } } }); return { error: { code: 'CAPABILITY_ERROR', message: `served task ${r.status}`, retryable: false } }; }
    const usage = this.ledger.projections().usageByTask[taskId] ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
    const resultDigest = this.blob.put(JSON.stringify(r.output ?? null), 'application/json');
    this.ledger.append({ taskId, principal: chain, type: 'invocation.executed', payload: { invocationId: invId, resultDigest, output: r.output ?? null, usage: { units: { calls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } } } });
    const receipt = this.taskReceipt(taskId);
    return { output: r.output ?? null, usage, receipt, taskId };
  }
  /** 任务回执：该任务全部事件的 Merkle 根 + 签名；入账 receipt.issued */
  taskReceipt(taskId: ID) {
    const evs = this.ledger.all().filter(e => e.taskId === taskId);
    const root = merkleRoot(evs.map(e => e.hash));
    const sig = { scheme: 'hmac-sha256', keyId: 'runtime', value: createHmac('sha256', this.signKey).update(root).digest('hex') };
    const t = this.ledger.projections().tasks[taskId]!;
    this.ledger.append({ taskId, principal: t.principal, type: 'receipt.issued', payload: { invocationId: taskId, root, sig } });
    return { invocationId: taskId, taskId, events: evs, merklePath: [] as string[], root, sig };
  }

  private buildView(taskId: ID, proj: Projections, mustFinalize = false): TaskView {
    const t = proj.tasks[taskId]!;
    const handles = t.handles.map(id => this.authority.view(id)).filter((h): h is HandleView => !!h);
    const usage = proj.usageByTask[taskId] ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
    const b = t.budget;
    return {
      task: { id: t.id, parent: t.parent, goal: t.goal, status: t.status, budget: b, config: t.config },
      step: { index: t.steps, mustFinalize, ...(mustFinalize ? { reason: 'maxSteps' as const } : {}) },
      handles,
      invocations: Object.values(proj.invocations).filter(i => i.taskId === taskId),
      awaiting: Object.values(proj.pendingApprovals).filter(p => proj.invocations[p.invocationId]?.taskId === taskId),
      children: Object.values(proj.tasks).filter(x => x.parent === taskId).map(x => ({ id: x.id, status: x.status, goal: x.goal })),
      lastBundleRef: t.lastBundleRef,
      budgetRemaining: { ...(b.calls !== undefined ? { calls: b.calls - usage.calls } : {}), ...(b.inputTokens !== undefined ? { inputTokens: b.inputTokens - usage.inputTokens } : {}), ...(b.outputTokens !== undefined ? { outputTokens: b.outputTokens - usage.outputTokens } : {}) },
      input: t.input,
    };
  }

  private makeCtx(taskId: ID, chain: PrincipalChain, view: TaskView, mustFinalize: boolean): ControllerContext {
    const trace: TraceContext = { traceId: 'tr_' + randomUUID().slice(0, 8), spanId: 'sp_' + randomUUID().slice(0, 8) };
    const sem = new Semaphore(view.task.config.maxConcurrentInvocations ?? 8);
    const self = this;
    return {
      view, trace,
      now: () => self.now(),
      async invoke(handleId, args, opts) {
        await sem.acquire();
        try { return await self.invoke(taskId, chain, handleId, args, { ...opts, mustFinalize, trace }); } finally { sem.release(); }
      },
      async compose(spec) { return self.compose(taskId, chain, view, spec, trace, mustFinalize); },
      async attenuate(handleId, add) {
        const t = self.ledger.projections().tasks[taskId]!;
        if (!t.handles.includes(handleId)) throw err('HANDLE_INVALID', 'task does not hold this handle');
        const h = self.authority.attenuate(handleId, add, chain, self.now());
        self.ledger.append({ taskId, principal: chain, type: 'handle.attenuated', payload: { handleId: h.id, parent: handleId, addCaveats: add as any, holder: chain as any } });
        return h.id;
      },
      async spawn(goal, handles, budget, config) {
        const t = self.ledger.projections().tasks[taskId]!;
        for (const h of handles) if (!t.handles.includes(h)) throw err('HANDLE_INVALID', `task does not hold handle ${h}`);
        const childId = 't_' + randomUUID().slice(0, 8);
        const childChain: PrincipalChain = [{ kind: 'task', id: childId }, ...chain];
        self.ledger.append({ taskId: childId, principal: childChain, type: 'task.spawned', payload: { taskId: childId, parent: taskId, goal, handles, budget: budget as any, config: { ...t.config, ...(config ?? {}) } as any } });
        void self.runLoop(childId);
        return { taskId: childId };
      },
    };
  }

  // ------------------------------------------------------------ Invoke pipeline（唯一执行路径）
  private async invoke(taskId: ID, chain: PrincipalChain, handleId: HandleId, args: JsonObject, o: { timeoutMs?: number; idempotencyKey?: string; mustFinalize: boolean; trace: TraceContext; fromComposer?: boolean }): Promise<InvokeResult> {
    const proj = this.ledger.projections();
    const hv = this.authority.view(handleId);
    const invocationId = 'inv_' + randomUUID().slice(0, 12);
    if (!hv) { const reason = '句柄不存在或非内核铸造'; this.ledger.append({ taskId, principal: chain, type: 'invocation.requested', payload: { invocationId, handleId, contract: { name: '?', version: '?', schemaDigest: 'sha256:' + '0'.repeat(64) }, args, revision: 0 } }, { taskId, principal: chain, type: 'invocation.denied', payload: { invocationId, revision: 0, code: 'HANDLE_INVALID', reason, retryable: false } }); return { status: 'denied', invocationId, reason, retryable: false, code: 'HANDLE_INVALID' }; }
    this.ledger.append({ taskId, principal: chain, type: 'invocation.requested', payload: { invocationId, handleId, contract: hv.contract as any, args, revision: 0 } });
    // Guard：收尾轮只许模型（06 §7 / 10 N-9）；Composer 的上下文读取除外（收尾也需要上下文）
    if (o.mustFinalize && !o.fromComposer && hv.contract.name !== MODEL_CONTRACT) { const reason = '收尾轮只允许模型调用；请返回 finish'; this.ledger.append({ taskId, principal: chain, type: 'invocation.denied', payload: { invocationId, revision: 0, code: 'STEP_LIMIT', reason, retryable: false } }); return { status: 'denied', invocationId, reason, retryable: false, code: 'STEP_LIMIT' }; }
    // before.verify（可改窄；每次改动 = 新 revision）
    let revision = 0; let curArgs = args;
    for (const ic of this.interceptors.filter(i => i.points.includes('before.verify'))) {
      this.beforeVerifyCalls++; this.beforeVerifyByInvocation.set(invocationId, (this.beforeVerifyByInvocation.get(invocationId) ?? 0) + 1);
      const ectx: ExtensionCallContext = { principal: chain, trace: o.trace, stage: 'before.verify' };
      let r; try { r = await ic.intercept({ stage: 'before.verify', invocation: { id: invocationId, revision, contract: hv.contract, args: structuredClone(curArgs), handle: hv } }, ectx); } catch (e) { r = { reject: toErrorInit(e) }; }
      if (r && 'reject' in r) { this.ledger.append({ taskId, principal: chain, type: 'invocation.denied', payload: { invocationId, revision, code: r.reject.code, reason: r.reject.message, retryable: !!r.reject.retryable } }); return { status: 'denied', invocationId, reason: r.reject.message, retryable: !!r.reject.retryable, code: r.reject.code }; }
      if (r && 'args' in r && JSON.stringify(r.args) !== JSON.stringify(curArgs)) {
        revision++; curArgs = r.args;
        if (revision > 8) { const reason = 'revision_limit'; this.ledger.append({ taskId, principal: chain, type: 'invocation.denied', payload: { invocationId, revision, code: 'POLICY_INTEGRITY_ERROR', reason, retryable: false } }); return { status: 'denied', invocationId, reason, retryable: false, code: 'POLICY_INTEGRITY_ERROR' }; }
        this.ledger.append({ taskId, principal: chain, type: 'invocation.revised', payload: { invocationId, revision, args: curArgs, by: ic.id } });
      }
    }
    return this.verifyAndExecute(taskId, chain, { id: invocationId, handleId, contract: hv.contract, revision, args: curArgs }, o);
  }

  /** 审批恢复：同 revision、同 args，不重跑 before.verify（02 forbidden: resume_reruns_before_verify） */
  private async reverifyAndExecute(taskId: ID, chain: PrincipalChain, inv: InvocationRecord) {
    return this.verifyAndExecute(taskId, chain, { id: inv.id, handleId: inv.handleId, contract: inv.contract, revision: inv.revision, args: inv.args }, { mustFinalize: false, trace: { traceId: 'tr_resume', spanId: 'sp_' + randomUUID().slice(0, 8) } });
  }

  private async verifyAndExecute(taskId: ID, chain: PrincipalChain, inv: { id: ID; handleId: HandleId; contract: ContractRef; revision: number; args: JsonObject }, o: { timeoutMs?: number; idempotencyKey?: string; mustFinalize: boolean; trace: TraceContext }): Promise<InvokeResult> {
    const proj = this.ledger.projections();
    const grants: Grant[] = Object.values(proj.grants).map(g => ({ approvalId: g.approvalId, invocationDigest: g.invocationDigest, expiresAt: g.expiresAt }));
    // 路由（provider caveat 锁定由 verify 用 providerId 检查）
    let providerId: ID; let isModel = inv.contract.name === MODEL_CONTRACT;
    try { providerId = isModel ? 'kernel:model.generate' : this.registry.route(inv.contract).providerId; } catch (e) { const init = toErrorInit(e); this.ledger.append({ taskId, principal: chain, type: 'invocation.denied', payload: { invocationId: inv.id, revision: inv.revision, code: init.code, reason: init.message, retryable: false } }); return { status: 'denied', invocationId: inv.id, reason: init.message, retryable: false, code: init.code }; }
    const v = this.authority.verify(inv.handleId, chain, inv.args, { id: inv.id, revision: inv.revision }, grants, proj, this.now(), providerId);
    if (!v.ok && v.kind === 'needs-approval') {
      const expiresAt = v.caveat.ttlMs ? new Date(Date.parse(this.now()) + v.caveat.ttlMs).toISOString() : undefined;
      this.ledger.append({ taskId, principal: chain, type: 'invocation.awaiting', payload: { invocationId: inv.id, revision: inv.revision, digest: v.digest, approvalId: v.approvalId, ...(expiresAt ? { expiresAt } : {}), summary: `${inv.contract.name} ${JSON.stringify(inv.args)}` } });
      const req = this.ledger.projections().pendingApprovals[inv.id]!;
      return { status: 'awaiting', invocationId: inv.id, requirement: req };
    }
    if (!v.ok) { this.ledger.append({ taskId, principal: chain, type: 'invocation.denied', payload: { invocationId: inv.id, revision: inv.revision, code: v.code, reason: v.reason, retryable: v.retryable } }); return { status: 'denied', invocationId: inv.id, reason: v.reason, retryable: v.retryable, code: v.code }; }
    const approvalId = grants.find(g => g.invocationDigest === v.digest)?.approvalId;
    this.ledger.append({ taskId, principal: chain, type: 'invocation.authorized', payload: { invocationId: inv.id, revision: inv.revision, digest: v.digest, effectiveArgs: v.effectiveArgs, providerId, ...(approvalId ? { approvalId } : {}), ...(v.budgetCharge ? { budgetCharge: v.budgetCharge as any } : {}) } });
    // 冻结（Mutation Boundary）
    const frozenArgs = deepFreeze(structuredClone(v.effectiveArgs));
    const auth: AuthorizedInvocation = Object.freeze({ id: inv.id, revision: inv.revision, contract: inv.contract, args: frozenArgs, handle: this.authority.view(inv.handleId)!, principal: chain, digest: v.digest, ...(approvalId ? { approvalId } : {}), idempotencyKey: o.idempotencyKey ?? inv.id });
    const argsSnapshot = JSON.stringify(auth.args);
    // after.verify / before.execute：只读；返回 {args} → POLICY_INTEGRITY_ERROR
    for (const stage of ['after.verify', 'before.execute'] as const) for (const ic of this.interceptors.filter(i => i.points.includes(stage))) {
      let r; try { r = await ic.intercept({ stage, invocation: auth }, { principal: chain, trace: o.trace, stage }); } catch (e) { r = { reject: toErrorInit(e) }; }
      if (r && 'args' in r) { this.ledger.append({ taskId, principal: chain, type: 'plugin.degraded', payload: { pluginId: ic.id, reason: 'post-verify mutation attempt' } }, { taskId, principal: chain, type: 'invocation.failed', payload: { invocationId: inv.id, error: { code: 'POLICY_INTEGRITY_ERROR', message: `interceptor ${ic.id} attempted to modify a verified invocation` } } }); return { status: 'failed', invocationId: inv.id, error: err('POLICY_INTEGRITY_ERROR', 'post-verify mutation').toJSON() }; }
      if (r && 'reject' in r) { this.ledger.append({ taskId, principal: chain, type: 'invocation.failed', payload: { invocationId: inv.id, error: r.reject as any } }); return { status: 'failed', invocationId: inv.id, error: err(r.reject.code, r.reject.message).toJSON() }; }
    }
    if (JSON.stringify(auth.args) !== argsSnapshot) { this.ledger.append({ taskId, principal: chain, type: 'invocation.failed', payload: { invocationId: inv.id, error: { code: 'POLICY_INTEGRITY_ERROR', message: 'args changed after verify' } } }); return { status: 'failed', invocationId: inv.id, error: err('POLICY_INTEGRITY_ERROR', 'args changed after verify').toJSON() }; }
    // Execute（唯一 Provider 调用点）
    const contract = this.registry.resolveRef(inv.contract)?.contract;
    const timeoutMs = Math.min(o.timeoutMs ?? Infinity, contract?.defaultTimeoutMs ?? Infinity, this.ledger.projections().tasks[taskId]!.config.invokeTimeoutMs);
    const cancellationId = 'cx_' + randomUUID().slice(0, 8);
    const pctx: ProviderCallContext = { principal: chain, trace: o.trace, deadlineAtMs: Date.now() + timeoutMs, cancellationId };
    const started = Date.now();
    let done = false;
    // 同步 throw 也要变成 rejection：Provider 抛什么内核都不崩
    const exec = (async () => isModel ? this.modelGenerate(taskId, auth, pctx) : this.providersById.get(providerId)!.execute(auth, pctx))();
    let result: { output: Json; usage?: UsageRecord } | { error: import('../../sdk/types.js').KernelErrorInit };
    try {
      result = await Promise.race([exec.then(r => { if (done) return { error: { code: 'TIMEOUT' as const, message: 'late result dropped' } }; return r; }), sleep(timeoutMs).then(() => ({ error: { code: 'TIMEOUT' as const, message: `invoke exceeded ${timeoutMs}ms`, retryable: true } }))]);
    } catch (e) { result = { error: toErrorInit(e) }; }
    done = true;
    if ('error' in result && result.error.code === 'TIMEOUT') { const p = this.providersById.get(providerId); try { await p?.cancel?.(cancellationId); } catch { /* ignore */ } exec.catch(() => {}); }
    if ('error' in result) { this.ledger.append({ taskId, principal: chain, type: 'invocation.failed', payload: { invocationId: inv.id, error: result.error as any, ...(result.error.code === 'TIMEOUT' ? { late: false } : {}) } }); return { status: 'failed', invocationId: inv.id, error: err(result.error.code, result.error.message, { retryable: result.error.retryable, detail: result.error.detail }).toJSON() }; }
    // after.execute：只能改结果
    let out = result;
    for (const ic of this.interceptors.filter(i => i.points.includes('after.execute'))) {
      let r; try { r = await ic.intercept({ stage: 'after.execute', invocation: auth, result: out }, { principal: chain, trace: o.trace, stage: 'after.execute' }); } catch { r = undefined; }
      if (r && 'result' in r) out = r.result;
      if (r && 'args' in r) { this.ledger.append({ taskId, principal: chain, type: 'plugin.degraded', payload: { pluginId: ic.id, reason: 'post-execute mutation attempt' } }); }
    }
    const resultDigest = this.blob.put(JSON.stringify(out.output), 'application/json');
    this.ledger.append({ taskId, principal: chain, type: 'invocation.executed', payload: { invocationId: inv.id, resultDigest, output: out.output, ...(out.usage ? { usage: out.usage as any } : {}), durationMs: Date.now() - started } });
    return { status: 'executed', invocationId: inv.id, output: out.output, ...(out.usage ? { usage: out.usage } : {}) };
  }

  // ------------------------------------------------------------ model.generate@1 内置实现（原 ModelGateway）
  private async modelGenerate(taskId: ID, auth: AuthorizedInvocation, pctx: ProviderCallContext): Promise<{ output: Json; usage?: UsageRecord }> {
    const a = auth.args as unknown as ModelGenerateArgs;
    const t = this.ledger.projections().tasks[taskId]!;
    const messages: ContextMessage[] = [{ role: 'system', content: `You are ${this.spec.metadata.name}. Use tools only via the provided tool list.` }];
    if (a.intent.instructions) messages.push({ role: 'system', content: a.intent.instructions });
    if (a.bundleRef) { const b = this.blob.get(a.bundleRef); if (b) for (const it of JSON.parse(b.bytes).items as Array<{ kind: string; content: Json; source: string }>) messages.push({ role: it.kind === 'system' ? 'system' : 'user', content: it.content, name: it.source }); }
    for (const m of a.intent.messages ?? []) messages.push(m);
    // 工具 = 句柄目录（不含 model.generate 自身）
    const toolsMode = a.intent.tools ?? 'held';
    let toolHandles: HandleView[] = [];
    if (toolsMode === 'held') toolHandles = t.handles.map(id => this.authority.view(id)).filter((h): h is HandleView => !!h && h.contract.name !== MODEL_CONTRACT);
    else if (typeof toolsMode === 'object') toolHandles = toolsMode.handles.map(id => this.authority.view(id)).filter((h): h is HandleView => !!h);
    const tools = toolHandles.map(h => { const c = this.registry.resolveRef(h.contract)?.contract; return { name: h.id, description: `${h.contract.name}@${h.contract.version}${c?.description ? ': ' + c.description : ''}`, inputSchema: c?.inputSchema ?? { type: 'object' } }; });
    const req = { callId: auth.id, model: a.model ?? this.spec.spec.model.model, messages, ...(tools.length ? { tools } : {}), ...(a.intent.outputSchema ? { outputSchema: a.intent.outputSchema } : {}), ...(a.intent.params ? { params: a.intent.params } : {}), deadlineAtMs: pctx.deadlineAtMs };
    const r = await this.backend.generate(req, pctx);
    const output: ModelGenerateOutput = { finishReason: r.finishReason, ...(r.content !== undefined ? { content: r.content } : {}), ...(r.toolCalls ? { toolCalls: r.toolCalls.map(tc => ({ id: tc.id, handle: tc.name, args: tc.args })) } : {}), ...(r.usage ? { usage: r.usage } : {}) };
    return { output: output as unknown as Json, ...(r.usage ? { usage: r.usage } : {}) };
  }

  // ------------------------------------------------------------ Composer（非授权路径的内核服务；上下文源仍走 invoke）
  private async compose(taskId: ID, chain: PrincipalChain, view: TaskView, spec: ComposeSpec | undefined, trace: TraceContext, mustFinalize: boolean) {
    const items: Array<{ source: string; kind: string; content: Json; priority: number; stability: string }> = [];
    if (view.input !== undefined) items.push({ source: 'input', kind: 'message', content: view.input, priority: 0, stability: 'turn' });
    const sources = spec?.sources ?? (this.spec.spec.context?.sources ?? []).map(s => { const h = view.handles.find(x => x.contract.name === s.contract); return h ? { handle: h.id, args: s.args, priority: s.priority, stability: s.stability } : undefined; }).filter((x): x is NonNullable<typeof x> => !!x);
    for (const s of sources) {
      const r = await this.invoke(taskId, chain, s.handle, s.args ?? {}, { mustFinalize, trace, fromComposer: true });
      if (r.status === 'executed') { const out = r.output as any; const arr: any[] = Array.isArray(out?.items) ? out.items : [out]; for (const it of arr) items.push({ source: s.handle, kind: 'memory', content: it?.content ?? it, priority: s.priority ?? 50, stability: s.stability ?? 'turn' }); }
    }
    const order = { static: 0, session: 1, turn: 2 } as Record<string, number>;
    items.sort((a, b) => (order[a.stability] ?? 2) - (order[b.stability] ?? 2) || a.priority - b.priority || a.source.localeCompare(b.source));
    const bytes = JSON.stringify({ items });
    const bundleRef = this.blob.put(bytes, 'application/json');
    this.ledger.append({ taskId, principal: chain, type: 'bundle.composed', payload: { bundleRef, stats: { items: items.length }, sources: sources.map(s => s.handle) } });
    return { bundleRef, stats: { estimatedTokens: Math.ceil(bytes.length / 4) } };
  }
}
function deepFreeze<T>(o: T): T { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o as any)) deepFreeze(v); } return o; }
export { KernelErr };
