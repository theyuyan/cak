// M3 · subprocess 传输：同一份 Provider 在子进程里跑 G1；敌意子进程；坏信封 / 未知方法显式拒绝
import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import { SubprocessProvider } from '../../kernel/boundary/subprocess.js';
import { MemoryContextProvider, TextSummarizeProvider } from '../../plugins/builtin/index.js';
import { build, loadFixture, mkEnv, taskEvents } from './harness.js';

const TSX = path.resolve('node_modules/.bin/tsx');
const started: SubprocessProvider[] = [];
afterAll(async () => { for (const p of started) await p.stop(); });

describe('M3 · subprocess transport', () => {
  it('G1 用子进程 fs-readonly（同一份 Provider 代码）：事件序列与进程内一致；Provider 收到 DTO；exit 0', async () => {
    const fx = loadFixture('G1'); const env = mkEnv(fx);
    const sub = new SubprocessProvider({ id: 'fs-readonly-sub', command: TSX, args: ['plugins/subprocess/fs-readonly.ts', env.ws] }); started.push(sub);
    await sub.start();
    expect(sub.hello?.['protocol']).toBe('cak/1'); expect(sub.listImplementations()[0]!.contract.name).toBe('file.read');
    const b = await build({ fx, env, providers: [sub, new MemoryContextProvider([{ content: 'CAK 记忆条目' }]), new TextSummarizeProvider()] });
    const res = await b.k.startTask(fx.input.user, { input: fx.input.user });
    expect(res.status).toBe('finished'); expect(String(res.output)).toContain('摘要');
    expect(taskEvents(b.k, res.taskId)).toEqual(fx.strictSequence);
    const auth = b.k.ledger.all().find(e => e.type === 'invocation.authorized' && (e.payload as any).providerId === 'fs-readonly-sub'); expect(auth).toBeTruthy();
    expect((await sub.health()).status).toBe('healthy');
  }, 30000);
  it('未知信封版本 → -32600；未知方法 → -32601（显式拒绝，不静默）', async () => {
    const env = mkEnv(loadFixture('G1'));
    const sub = new SubprocessProvider({ id: 's2', command: TSX, args: ['plugins/subprocess/fs-readonly.ts', env.ws] }); started.push(sub); await sub.start();
    const bad = await sub._rawRpc('plugin.health', {}, { cak: '9' }); expect(bad.error?.code).toBe(-32600);
    const unk = await sub._rawRpc('capability.teleport', {}); expect(unk.error?.code).toBe(-32601);
  }, 30000);
  it('敌意子进程：never resolve → 内核 TIMEOUT + cancel 消息；crash-on-execute → TRANSPORT_ERROR；主链不崩', async () => {
    const fx = loadFixture('G5'); const env = mkEnv(fx);
    const never = new SubprocessProvider({ id: 'hostile-never', command: TSX, args: ['plugins/subprocess/hostile.ts', 'never'] }); started.push(never); await never.start();
    const b = await build({ fx, env, providers: [never, new MemoryContextProvider(), new TextSummarizeProvider()] });
    const res = await b.k.startTask(fx.input.user, { input: fx.input.user, config: { invokeTimeoutMs: 500 } });
    expect(res.status).toBe('finished');
    const failed = b.k.ledger.all().find(e => e.type === 'invocation.failed'); expect((failed!.payload as any).error.code).toBe('TIMEOUT');
    const crash = new SubprocessProvider({ id: 'hostile-crash', command: TSX, args: ['plugins/subprocess/hostile.ts', 'crash-on-execute'] }); started.push(crash); await crash.start();
    const b2 = await build({ fx, env, providers: [crash, new MemoryContextProvider(), new TextSummarizeProvider()] });
    const res2 = await b2.k.startTask(fx.input.user, { input: fx.input.user, config: { invokeTimeoutMs: 3000 } });
    expect(res2.status).toBe('finished');
    const f2 = b2.k.ledger.all().find(e => e.type === 'invocation.failed'); expect((f2!.payload as any).error.code).toBe('TRANSPORT_ERROR');
  }, 60000);
  it('子进程发一行非 JSON → 内核忽略不崩，握手仍成功', async () => {
    const g = new SubprocessProvider({ id: 'garbage', command: TSX, args: ['plugins/subprocess/hostile.ts', 'garbage-line'] }); started.push(g);
    await g.start(); expect(g.hello?.['protocol']).toBe('cak/1');
  }, 30000);
});
