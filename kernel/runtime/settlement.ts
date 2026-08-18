/** 结算适配（M5）：账本 usage × 契约 pricing → 对账单；双方回执 usage 对账。内核只保证可对账，怎么付钱是适配器。 */
import type { Kernel } from './kernel.js';
import type { Json } from '../../sdk/types.js';

export interface StatementLine { contract: string; providerId?: string; calls: number; inputTokens: number; outputTokens: number; unit?: string; amount?: number; currency?: string }
export interface Statement { agent: string; generatedAt: string; lines: StatementLine[]; total: Record<string, number>; events: number }

export function statement(k: Kernel, opts: { fromSeq?: number } = {}): Statement {
  const proj = k.ledger.projections();
  const lines = new Map<string, StatementLine>();
  for (const inv of Object.values(proj.invocations)) {
    if (inv.status !== 'executed') continue;
    const key = `${inv.contract.name}|${inv.providerId ?? ''}`;
    const l = lines.get(key) ?? { contract: inv.contract.name, providerId: inv.providerId, calls: 0, inputTokens: 0, outputTokens: 0 };
    l.calls++; l.inputTokens += Number((inv.usage?.units as any)?.inputTokens ?? 0); l.outputTokens += Number((inv.usage?.units as any)?.outputTokens ?? 0);
    lines.set(key, l);
  }
  const total: Record<string, number> = {};
  for (const l of lines.values()) {
    const c = k.registry.resolve(l.contract)?.contract; const p = c?.pricing;
    if (p?.amount !== undefined) {
      const units = p.unit === 'call' ? l.calls : p.unit === 'token' ? l.inputTokens + l.outputTokens : 0;
      l.unit = p.unit; l.amount = Math.round(units * p.amount * 1e6) / 1e6; l.currency = p.currency ?? 'CREDIT';
      total[l.currency] = Math.round(((total[l.currency] ?? 0) + l.amount) * 1e6) / 1e6;
    }
  }
  return { agent: k.spec.metadata.name, generatedAt: new Date().toISOString(), lines: [...lines.values()], total, events: k.ledger.head().seq };
}
/** 对账：本方记录的对端调用 usage 与对端回执 usage 是否一致 */
export function reconcile(localUsage: { calls?: number; inputTokens?: number; outputTokens?: number } | undefined, remoteUsage: { calls?: number; inputTokens?: number; outputTokens?: number } | undefined): { ok: boolean; diff: Record<string, number> } {
  const keys = ['calls', 'inputTokens', 'outputTokens'] as const; const diff: Record<string, number> = {};
  for (const k of keys) { const d = Number(localUsage?.[k] ?? 0) - Number(remoteUsage?.[k] ?? 0); if (d !== 0) diff[k] = d; }
  return { ok: Object.keys(diff).length === 0, diff };
}
export type { Json };
