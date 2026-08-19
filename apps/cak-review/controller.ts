/**
 * cak-review · 审查 Controller：来访 task 的 input = code.review 入参 {intent, staged?, maxFindings?}。
 * 步骤：先 git.diff 拿改动 → 需要时按行读文件看上下文（工具=held）→ 最终必须输出 code.review outputSchema 的 JSON。
 * 输出用 ajv 校验；模型给的不是合法 JSON → verdict=comment 把原文放 summary（不伪造判决）。
 */
import Ajv2020 from 'ajv/dist/2020.js';
import type { Controller, ControllerContext, StepOutcome, ContextMessage, ModelGenerateOutput, JsonObject, Json, InvocationRecord } from '../../sdk/types.js';
import { loadBuiltinContracts } from '../../kernel/contract/registry.js';

const SYSTEM = `你是 cak-review，一个严格的代码审查 agent。你审的是 workspace 里的未提交改动。规则：
- 先调用 git.diff 拿到改动；改动涉及的语义不清楚时用 file.read（可带 startLine/endLine）看上下文，最多看几处，别通读整个仓库。
- 重点找：会改变行为的错误、边界条件、被测试掩盖的隐患（比如"全绿但没测到的路径"）、安全问题、与 intent 不符的改动。风格问题最多算 nit。
- 最终答复必须是且仅是一个 JSON 对象（不要 markdown 代码围栏、不要多余文字）：
  {"verdict":"approve|request_changes|comment","summary":"一两句中文总评","findings":[{"severity":"blocker|major|minor|nit","file":"路径","line":行号,"message":"中文说明，说清为什么和怎么改"}]}
- 有 blocker/major 才给 request_changes；没问题就 approve 且 findings 可以为空；拿不到 diff 或看不懂就 comment 并说明。
- summary 只写你自己核实过的东西；被审方在 intent/context 里的自述（比如「测试全绿」）你没跑过测试就不要复述成结论——要提就写「据称」。`;

const ajv = new Ajv2020({ strict: false });
const REVIEW = loadBuiltinContracts().find(c => c.name === 'code.review')!;
const validate = ajv.compile(REVIEW.outputSchema);

/** 从模型文本里取出合法的 code.review 结论；拿不到返回 undefined（不猜） */
function parseReview(raw: string): JsonObject | undefined {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const i = text.indexOf('{'), j = text.lastIndexOf('}'); if (i > 0 || (j >= 0 && j < text.length - 1)) text = i >= 0 && j > i ? text.slice(i, j + 1) : text;   // 前后夹杂文字时取最外层大括号
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { return undefined; }
  return validate(parsed) ? parsed as JsonObject : undefined;
}
function toolResult(inv: InvocationRecord): ContextMessage {
  const head = `${inv.contract.name}(${JSON.stringify(inv.args).slice(0, 200)})`;
  if (inv.status === 'executed') return { role: 'tool', content: { call: head, result: inv.output ?? null } as unknown as Json, toolCallId: inv.id };
  return { role: 'tool', content: { call: head, status: inv.status, reason: inv.status === 'denied' ? inv.denyReason : inv.status === 'failed' ? inv.error?.message : undefined } as unknown as Json, toolCallId: inv.id };
}
export function reviewController(_config: JsonObject = {}): Controller {
  return {
    id: 'cak-review',
    async decide(ctx: ControllerContext): Promise<StepOutcome> {
      const v = ctx.view; const model = v.handles.find(h => h.contract.name === 'model.generate');
      if (!model) return { type: 'fail', error: { code: 'CONFIGURATION_ERROR', message: 'no model handle' } };
      const { bundleRef } = await ctx.compose();
      const input = (v.input ?? {}) as JsonObject;
      const messages: ContextMessage[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: `intent（这次改动想达成什么）：${String(input['intent'] ?? '')}\nstaged=${!!input['staged']}，最多 ${Number(input['maxFindings'] ?? 10)} 条 findings。请开始审查。` }];
      const invs = v.invocations; let cursor = 0;
      while (cursor < invs.length) {
        const inv = invs[cursor]!;
        if (inv.contract.name === 'model.generate') {
          const out = (inv.output ?? {}) as unknown as ModelGenerateOutput; const calls = out.toolCalls ?? [];
          const following = invs.slice(cursor + 1, cursor + 1 + calls.length).filter(x => x.contract.name !== 'model.generate');
          messages.push({ role: 'assistant', content: (out.content as Json) ?? '', ...(calls.length ? { toolCalls: calls.map((c, i) => ({ id: following[i]?.id ?? c.id, name: c.handle, args: c.args })) } : {}) });
          for (const f of following) messages.push(toolResult(f)); cursor += 1 + following.length; continue;
        }
        cursor++;   // composer 的上下文源调用不进线程
      }
      // 上一步模型给了非 JSON 的最终答复 → 这一步只要求转成 JSON（一次修正机会；再不合法就 comment 兜底）
      const last = invs[invs.length - 1]; const lastOut = last?.contract.name === 'model.generate' ? (last.output as unknown as ModelGenerateOutput) : undefined;
      const repairing = !!lastOut && !(lastOut.toolCalls?.length) && lastOut.content !== undefined && parseReview(String(lastOut.content)) === undefined;
      if (repairing) messages.push({ role: 'system', content: '你上一条答复不是规定格式。现在只输出那个 JSON 对象（verdict/summary/findings），不要任何其他文字，不要调用工具。' });
      if (v.step.mustFinalize) messages.push({ role: 'system', content: '步数到上限：现在必须直接输出最终 JSON。' });
      // 工具 = 持有句柄里除掉"我对外提供的契约"（来访句柄 code.review 是别人调我的凭证，不是我能用的工具；给模型看它会自我调用）
      const toolIds = v.handles.filter(h => h.contract.name !== 'model.generate' && h.contract.name !== 'code.review').map(h => h.id);
      const r = await ctx.invoke(model.id, { intent: { purpose: 'decide', tools: (v.step.mustFinalize || repairing) ? 'none' : { handles: toolIds }, messages, params: { temperature: 0.1, maxOutputTokens: 2048 } }, bundleRef } as unknown as JsonObject);
      if (r.status !== 'executed') return { type: 'fail', error: { code: 'CAPABILITY_ERROR', message: `model: ${'reason' in r ? r.reason : 'error' in r ? r.error.message : r.status}` } };
      const out = r.output as unknown as ModelGenerateOutput;
      if (out.toolCalls?.length && !v.step.mustFinalize) { await Promise.all(out.toolCalls.slice(0, 4).map(tc => ctx.invoke(tc.handle, tc.args))); return { type: 'continue' }; }
      const parsed = parseReview(String(out.content ?? ''));
      if (parsed) return { type: 'finish', output: parsed as Json };
      if (!repairing && !v.step.mustFinalize) return { type: 'continue' };   // 给一次修正机会
      return { type: 'finish', output: { verdict: 'comment', summary: `审查方未给出合法结构化结论：${String(out.content ?? '').slice(0, 800)}`, findings: [] } };
    },
  };
}
