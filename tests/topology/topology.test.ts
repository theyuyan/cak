// 拓扑代码扫描（02 forbidden_edges 的可静态检查部分）+ yaml 自洽（tools/check-topology.mjs）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
const read = (p: string) => fs.readFileSync(p, 'utf8');
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []);

describe('topology · 代码扫描', () => {
  it('plugins/ 与 sdk/ 不 import kernel/（插件只见 SDK 边界类型）', () => {
    for (const f of [...walk('plugins'), ...walk('sdk')]) expect(read(f), f).not.toMatch(/from ['"][^'"]*kernel\//);
  });
  it('ModelBackend.generate 只在 kernel/runtime/kernel.ts 的 model.generate 内置实现里被调用（模型是契约）', () => {
    const hits = walk('kernel').filter(f => /\.backend\.generate\(|backend\.generate\(/.test(read(f)));
    expect(hits).toEqual(['kernel/runtime/kernel.ts']);
  });
  it('CapabilityProvider.execute 只在 kernel/runtime/kernel.ts 的 Execute 阶段被调用（唯一 Provider 调用点）', () => {
    const hits = walk('kernel').filter(f => /providersById\.get\([^)]*\)!?\.execute\(/.test(read(f)));
    expect(hits).toEqual(['kernel/runtime/kernel.ts']);
    expect((read('kernel/runtime/kernel.ts').match(/providersById\.get\([^)]*\)!?\.execute\(/g) ?? []).length).toBe(1);
  });
  it('内核 proof 符号不从 sdk 导出；sdk 无 Handle 类型', () => {
    expect(read('sdk/types.ts')).not.toMatch(/cak\.kernel\.proof|interface Handle\b/);
  });
  it('Controller 只经 ctx.* 触达世界：ControllerContext 无 provider/backend/ledger 字段', () => {
    const m = read('sdk/types.ts').match(/export interface ControllerContext \{[\s\S]*?\n\}/)![0];
    expect(m).not.toMatch(/provider|backend|ledger|authority/i);
  });
  it('02_TOPOLOGY.yaml 自洽（tools/check-topology.mjs）', () => {
    const r = spawnSync('node', ['tools/check-topology.mjs'], { encoding: 'utf8' }); expect(r.stdout).toContain('topology OK'); expect(r.status).toBe(0);
  });
});
