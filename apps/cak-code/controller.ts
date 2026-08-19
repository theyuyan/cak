/**
 * cak-code · coding Controller：ReAct 循环 + 面向代码库的系统提示；工具 = 本 task 持有的句柄（内核渲染）。
 * 每 step：compose（session.history）→ 调模型（tools=held）→ 并行执行 toolCalls → 若有 awaiting（写 / shell / commit 要审批）→ await(approval)；否则 continue；模型给出文本 → finish。
 * 历史与工具结果由账本折叠（view.invocations）回喂；不维护第二份状态。
 */
import type { Controller, ControllerContext, StepOutcome, ContextMessage, ModelGenerateOutput, JsonObject, Json } from '../../sdk/types.js';

const SYSTEM_GENERAL = `你是一个跑在 CAK 内核上的通用助手。你能做的事取决于你此刻持有的工具（能力插件）；用户想要你没有的本事时，用 plugin.search 找、plugin.install 装（会要用户审批）。规则：
- 直接、简短、中文；不确定就问。
- 需要动文件 / 执行命令 / 上网 / 发通知等外部动作时用对应工具，用户可能审批或拒绝。
- 完成后用一两句话汇报做了什么、还有什么没做。`;
const SYSTEM = `你是 cak-code，一个在用户代码库里工作的编程助手（类似 Claude Code）。规则：
- 先读再改：改文件前用 file.read / file.search / file.list 弄清现状；改动尽量小、可回滚。大文件先 file.search（path 可以是单个文件）定位行号，再用 file.read 的 startLine/endLine 只读那一段；不要反复缩小 maxBytes 读文件头。
- 改局部内容一律用 file.edit（oldText 从 file.read 的原文里原样复制，必须唯一；newText 是替换后的内容）；file.write 会整文件覆盖，只用于新建文件或整体重写。
- 看提交历史用 git.log / git.show（只读、不问你），别用 shell 跑 git log。
- 跑测试 / 构建用 shell.exec，cwd 默认仓库根目录（测试文件通常在根目录的 tests/ 下）；不要用 sed -i / perl -pi 改文件（macOS 与 GNU 不兼容），改文件只走 file.edit。
- 工具的参数里 path 一律用相对 workspace 的路径（如 src/a.ts），不要用绝对路径。
- 需要写文件 / 执行命令 / 提交时直接调用对应工具；用户可能会审批或拒绝，被拒绝就换做法或停下解释。
- 每次只做用户要求的事；完成后用简短中文汇报：改了什么、怎么验证的、还有什么没做。
- 不确定就问，用 finish 直接给出问题。`;
const MEMORY_RULE = `
- 你有长期记忆：上下文里"memory"来源的条目是按本次输入自动检索出来的旧记忆，可直接用；用户说"记住…"或你发现值得跨会话保留的偏好/事实，用 memory.write 存一条简短中文（会要用户审批）。`;
const REGISTRY_RULE = `
- 你能替用户装插件：用户想要一种你现在没有的能力（查数据库、抓网页、记忆、浏览器…）时，先 plugin.search 找（用中文关键词或契约名），把候选用一两句人话讲给用户听，再 plugin.install（会要用户审批）；装完宿主会热加载，下一轮就能用。结果里若有 setup 说明，用人话一步步引导用户完成配置（涉及口令/密钥的字段让用户自己填进文件，绝不在对话里要）。找不到就直说没有。`;
const SIBLING_RULE = `
- 同一内核进程里可能还有别的 agent（比如 coding / review / 用户自定义的）。要把一件独立的子任务交给它们：调用 agent.invoke（target="<agent 名>"，contract={"name":"agent.task","version":"1.0.0"}，args={"intent":"<要它做什么，一句话>","context":"<必要的材料/路径/约束>"}），等它回报（output.report）。target 不对时错误信息会列出当前可用的 agent 名。别把自己能一步做完的事委派出去；别委派给自己。`;
const REVIEW_RULE = `
- 有独立的审查 agent 可用：在 git 提交之前，必须先调用 agent.invoke（target="cak-review"，contract={"name":"code.review"}，args={"intent":"<这次改动想达成什么，一句话>"}）把未提交改动送审。verdict 为 request_changes 时先按 findings 修改再重新送审；approve 或 comment 才可以提交。汇报时把审查结论带上。`;

function toolResult(inv: import('../../sdk/types.js').InvocationRecord): ContextMessage {
  const head = `${inv.contract.name}(${JSON.stringify(inv.args).slice(0, 300)})`;
  if (inv.status === 'executed') return { role: 'tool', content: { call: head, result: inv.output ?? null } as unknown as Json, toolCallId: inv.id };
  if (inv.status === 'denied') return { role: 'tool', content: { call: head, denied: inv.denyReason ?? inv.denyCode ?? 'denied', retryable: inv.retryable ?? false } as unknown as Json, toolCallId: inv.id };
  if (inv.status === 'failed') return { role: 'tool', content: { call: head, failed: inv.error?.message ?? 'failed' } as unknown as Json, toolCallId: inv.id };
  return { role: 'tool', content: { call: head, status: inv.status } as unknown as Json, toolCallId: inv.id };
}
export function codingController(config: JsonObject = {}): Controller {
  const maxToolCallsPerStep = Number(config['maxToolCallsPerStep'] ?? 6);
  return {
    id: 'cak-code',
    async decide(ctx: ControllerContext): Promise<StepOutcome> {
      const v = ctx.view;
      const model = v.handles.find(h => h.contract.name === 'model.generate');
      if (!model) return { type: 'fail', error: { code: 'CONFIGURATION_ERROR', message: 'no model handle' } };
      const { bundleRef } = await ctx.compose();
      const messages: ContextMessage[] = [{ role: 'system', content: (config['persona'] === 'general' ? SYSTEM_GENERAL : SYSTEM) + (config['reviewer'] ? REVIEW_RULE : '') + (config['siblings'] ? SIBLING_RULE : '') + (config['memory'] ? MEMORY_RULE : '') + (config['registry'] ? REGISTRY_RULE : '') }];
      if (v.input !== undefined) messages.push({ role: 'user', content: v.input as Json });
      // 从账本重建正规线程：每次模型调用 → assistant(content + tool_calls)；其后的工具调用 → tool 结果（用模型给的 call id 配对）
      // 模型 toolCalls 的 id 与我们 invoke 的 invocationId 不同：按顺序配对（模型每轮 toolCalls[i] ↔ 随后第 i 个非模型 invocation）
      // 线程只由「模型调用 + 紧随其后的工具结果」构成；composer 发起的上下文源调用（session.history / memory.search）不进线程——按位置配对，不按契约名猜（模型也可能自己调 session.history）
      const invs = v.invocations;
      let cursor = 0;
      while (cursor < invs.length) {
        const inv = invs[cursor]!;
        if (inv.contract.name === 'model.generate') {
          const out = (inv.output ?? {}) as unknown as ModelGenerateOutput; const calls = out.toolCalls ?? [];
          const following = invs.slice(cursor + 1, cursor + 1 + calls.length).filter(x => x.contract.name !== 'model.generate');
          messages.push({ role: 'assistant', content: (out.content as Json) ?? '', ...(calls.length ? { toolCalls: calls.map((c, i) => ({ id: following[i]?.id ?? c.id, name: c.handle, args: c.args })) } : {}) });
          for (const f of following) messages.push(toolResult(f));
          cursor += 1 + following.length; continue;
        }
        cursor++;   // 不在任何模型 tool_calls 之后的调用 = composer 的上下文源调用，跳过
      }
      // 护栏：连续 3 次完全相同的工具调用 → 提醒模型换做法（并给出它已经拿到的结果）
      const tail = invs.filter(i => i.contract.name !== 'model.generate').slice(-3).map(i => `${i.contract.name}:${JSON.stringify(i.args)}`);
      if (tail.length === 3 && new Set(tail).size === 1) messages.push({ role: 'system', content: `你已连续 3 次调用同一个工具且参数相同（${tail[0]}），结果已在上文。不要再重复调用；请基于已有结果继续下一步或直接汇报。` });
      if (v.step.mustFinalize) messages.push({ role: 'system', content: '步数已到上限：不要再调工具，直接汇报当前进展与未完成事项。' });
      // 模型每个契约只看到一个工具（带审批的那枚"宽"句柄）；用户铸的窄常设句柄（N-28）不露给模型，由下面按 preview 自动选用
      const byContract = new Map<string, typeof v.handles>(); for (const h of v.handles) { if (h.contract.name === 'model.generate') continue; const arr = byContract.get(h.contract.name) ?? []; arr.push(h); byContract.set(h.contract.name, arr); }
      const visible = [...byContract.values()].map(arr => arr.find(h => h.caveats.some(c => c.kind === 'requires-approval')) ?? arr[0]!).map(h => h.id);
      const pick = (handleId: string, args: JsonObject) => { const h = v.handles.find(x => x.id === handleId); if (!h) return handleId; if (ctx.preview(handleId, args).status !== 'needs-approval') return handleId; const alt = (byContract.get(h.contract.name) ?? []).find(x => x.id !== handleId && ctx.preview(x.id, args).status === 'ok'); return alt?.id ?? handleId; };
      const r = await ctx.invoke(model.id, { intent: { purpose: 'decide', tools: v.step.mustFinalize ? 'none' : { handles: visible }, messages, params: { temperature: 0.2, maxOutputTokens: 2048 } }, bundleRef } as unknown as JsonObject);
      if (r.status !== 'executed') return { type: 'fail', error: { code: 'CAPABILITY_ERROR', message: `model: ${'reason' in r ? r.reason : 'error' in r ? r.error.message : r.status}` } };
      const out = r.output as unknown as ModelGenerateOutput;
      if (out.toolCalls?.length && !v.step.mustFinalize) {
        const results = await Promise.all(out.toolCalls.slice(0, maxToolCallsPerStep).map(tc => ctx.invoke(pick(tc.handle, tc.args), tc.args)));
        if (results.some(x => x.status === 'awaiting')) return { type: 'await', reason: 'approval' };
        return { type: 'continue' };
      }
      return { type: 'finish', output: out.content ?? '（模型没有给出内容）' };
    },
  };
}
