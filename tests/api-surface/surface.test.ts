// 内核接口面守卫（16_KERNEL_API_FREEZE）：sdk 导出 / Kernel 公开方法 / 事件类型 / 错误码 / caveat 种类 / 传输协议 任一变化 → 红。
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
describe('kernel api surface (16 冻结)', () => {
  it('与 tests/api-surface/surface.json 一致；变了必须先走 16 §3 流程再 --update', () => {
    const r = spawnSync(process.execPath, ['tools/api-surface.mjs'], { encoding: 'utf8' });
    expect(r.status, r.stderr || r.stdout).toBe(0);
  });
  it('反向：篡改快照里 Kernel.startTask 的指纹 → 工具报「接口面变化」并退出 1（守卫真会咬人）', () => {
    const snap = JSON.parse(fs.readFileSync('tests/api-surface/surface.json', 'utf8')); snap.kernel.startTask = 'sha256:0000000000000000'; snap.errorCodes = snap.errorCodes.slice(0, -1);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'surface-')), 'surface.json'); fs.writeFileSync(tmp, JSON.stringify(snap));
    const r = spawnSync(process.execPath, ['tools/api-surface.mjs', '--snapshot', tmp], { encoding: 'utf8' });
    expect(r.status).toBe(1); expect(r.stderr).toContain('kernel.startTask'); expect(r.stderr).toContain('errorCodes');
  });
});
