// 把准备阶段的全部检查挂到 vitest：一条 `npm test` 跑完。判据全部来自 docs/design 与 tests/vectors，不来自实现。
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import YAML from 'yaml';

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' });

describe('prep · 测试向量', () => {
  it('approval/ledger/contract 向量与 Python 交叉校验全通过', () => {
    const r = run('node', ['tools/check-vectors.mjs']);
    expect(r.stdout).toContain('all vectors OK');
    expect(r.status).toBe(0);
  });
  it('契约 schemaDigest 与文件一致（幂等）', () => {
    const r = run('node', ['tools/digest.mjs', '--check']);
    expect(r.stdout).toContain('mismatched 0');
    expect(r.status).toBe(0);
  });
});
describe('prep · Schema 与拓扑', () => {
  it('AgentSpec/PluginManifest/事件/契约 schema 全通过', () => {
    const r = run('node', ['tools/check-schemas.mjs']);
    expect(r.stdout).toContain('all schemas OK');
    expect(r.status).toBe(0);
  });
  it('02_TOPOLOGY.yaml 自洽且三条主张有边可查', () => {
    const r = run('node', ['tools/check-topology.mjs']);
    expect(r.stdout).toContain('topology OK');
    expect(r.status).toBe(0);
  });
  it('03_INTERFACE_CONTRACTS.ts 与 spike 通过 tsc --strict', () => {
    const r = run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json']);
    expect(r.stdout + r.stderr).not.toMatch(/error TS/);
    expect(r.status).toBe(0);
  });
});
describe('prep · spike（抛弃式原型）', () => {
  it('句柄向量 / 收窄单调性 / 端到端 / 崩溃恢复 / 篡改检测 全通过', () => {
    const r = run('npx', ['tsx', 'spike/run.ts']);
    expect(r.stdout).toMatch(/SPIKE: \d+ passed, 0 failed/);
    expect(r.status).toBe(0);
  });
});
describe('prep · Golden fixtures 结构', () => {
  const files = fs.readdirSync('tests/golden').filter(f => /^G\d\.yaml$/.test(f)).sort();
  it('G1–G8 齐全', () => expect(files).toEqual(['G1.yaml','G2.yaml','G3.yaml','G4.yaml','G5.yaml','G6.yaml','G7.yaml','G8.yaml']));
  for (const f of files) it(`${f} 可解析且含 id/title/expect/repeatable`, () => {
    const d = YAML.parse(fs.readFileSync(`tests/golden/${f}`, 'utf8'));
    expect(d.id).toBe(f.replace('.yaml',''));
    expect(typeof d.title).toBe('string');
    expect(d.expect).toBeTruthy();
    expect(d.repeatable).toBe(true);
    const seq = d.strictSequence ?? d.strictSequenceA ?? d.strictSequenceAfterRestart;
    expect(Array.isArray(seq) && seq.length > 3).toBe(true);
    // 事件类型必须都在事件 schema 的枚举里
    const ev = JSON.parse(fs.readFileSync('sdk/schemas/events/ledger-event.schema.json','utf8')).$defs.eventType.enum as string[];
    for (const s of [...(d.strictSequence ?? []), ...(d.strictSequenceA ?? []), ...(d.strictSequenceB ?? []), ...(d.strictSequenceAfterRestart ?? [])]) expect(ev).toContain(s);
  });
});
