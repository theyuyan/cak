import { expect } from 'vitest';
/** 断言抛出的 KernelErr 带指定 code（不靠 message 文本） */
export function expectCode(fn: () => unknown, code: string) {
  try { fn(); } catch (e: any) { expect(e?.code, `expected code ${code}, got ${e?.code}: ${e?.message}`).toBe(code); return; }
  throw new Error(`expected throw with code ${code}, but nothing thrown`);
}
export async function expectCodeAsync(fn: () => Promise<unknown>, code: string) {
  try { await fn(); } catch (e: any) { expect(e?.code, `expected code ${code}, got ${e?.code}: ${e?.message}`).toBe(code); return; }
  throw new Error(`expected throw with code ${code}, but nothing thrown`);
}
