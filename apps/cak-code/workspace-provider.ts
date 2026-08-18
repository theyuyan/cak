/**
 * cak-code · WorkspaceProvider：file.read / file.list / file.search / file.write / shell.exec / git.diff / git.commit / session.history。
 * 纵深防御：所有路径解析到 root 之内（越界 → CAPABILITY_ERROR），但真正的治理在句柄 caveat（写 / shell / commit 默认要审批）。
 * shell.exec 用 argv 数组 spawn，不经 shell。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, JsonObject, Json } from '../../sdk/types.js';

const C = (name: string, digest: string): ContractRef => ({ name, version: '1.0.0', schemaDigest: digest });
export const CONTRACTS = {
  read: C('file.read', 'sha256:5cbc0231e59c1b4ba3303bcd582e14e6a058569c01aac342babc8ec2a4eace25'),
  list: C('file.list', 'sha256:441f8e6d5ff44c5de704350aa1aec324cc7e9d8c0a254f9dc390086ec0671b46'), search: C('file.search', 'sha256:0bc8334dbbe699eb1ee810e843322fcab39b3ad1b45bf3aa876adc130ab9b36c'), write: C('file.write', 'sha256:7899a7d69110b45bc0a12ad232ba12a3c6c6706629202176a2a7202606800084'),
  shell: C('shell.exec', 'sha256:7b3fa347f6d77ebf7b1abe57c277f5d9c4d4c9f3fcd77589c9a2765d72536ceb'), gitDiff: C('git.diff', 'sha256:2116f92041771d93d4a732b3b1f0e6ba454c0708cdb697de81d3a4b97b91d15d'), gitCommit: C('git.commit', 'sha256:54e117c2d9f13cdc12fab72c6e23136cfe3cf7ec3714b405bea08fafa02de132'), history: C('session.history', 'sha256:afea697bc2434a97869703b45a690691620849611010d131f47b92336a3c1ded'),
};
const IGNORE = new Set(['node_modules', '.git', 'dist', '.cak']);
const sha = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');

export class WorkspaceProvider implements CapabilityProvider {
  readonly id = 'workspace';
  calls: AuthorizedInvocation[] = [];
  constructor(private root: string, private opts: { sessionFile?: string; allowShell?: boolean } = {}) { this.root = path.resolve(root); }
  listImplementations(): CapabilityImplementation[] { return Object.values(CONTRACTS).map(c => ({ providerId: this.id, contract: c, priority: 20 })); }
  private resolve(p: string): string { const abs = path.resolve(this.root, p || '.'); const rel = path.relative(this.root, abs); if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path ${p} escapes workspace`); return abs; }
  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    this.calls.push(inv); const a = inv.args as JsonObject;
    try {
      switch (inv.contract.name) {
        case 'file.read': { const abs = this.resolve(String(a['path'])); if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return { error: { code: 'CAPABILITY_ERROR', message: `not a file: ${a['path']}`, retryable: false } }; const buf = fs.readFileSync(abs); const max = Number(a['maxBytes'] ?? 262144); return { output: { content: buf.subarray(0, max).toString('utf8'), bytes: buf.length, truncated: buf.length > max } }; }
        case 'file.list': { const abs = this.resolve(String(a['path'] ?? '.')); const max = Number(a['maxEntries'] ?? 500); const entries: Json[] = []; let truncated = false; const walk = (d: string, depth: number) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (IGNORE.has(e.name)) continue; if (entries.length >= max) { truncated = true; return; } const full = path.join(d, e.name); const rel = path.relative(this.root, full); if (e.isDirectory()) { entries.push({ path: rel, type: 'dir' }); if (a['recursive']) walk(full, depth + 1); } else entries.push({ path: rel, type: 'file', bytes: fs.statSync(full).size }); } }; walk(abs, 0); return { output: { entries, truncated } }; }
        case 'file.search': { const abs = this.resolve(String(a['path'] ?? '.')); const max = Number(a['maxResults'] ?? 200); const pat = String(a['pattern']); const re = a['regex'] ? new RegExp(pat) : null; const glob = a['glob'] ? new RegExp('^' + String(a['glob']).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$') : null; const matches: Json[] = []; let truncated = false; const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (IGNORE.has(e.name)) continue; const full = path.join(d, e.name); const rel = path.relative(this.root, full); if (e.isDirectory()) { walk(full); continue; } if (glob && !glob.test(rel)) continue; if (fs.statSync(full).size > 2_000_000) continue; const lines = fs.readFileSync(full, 'utf8').split('\n'); for (let i = 0; i < lines.length; i++) { const l = lines[i]!; if (re ? re.test(l) : l.includes(pat)) { if (matches.length >= max) { truncated = true; return; } matches.push({ path: rel, line: i + 1, text: l.slice(0, 400) }); } } } }; walk(abs); return { output: { matches, truncated } }; }
        case 'file.write': { const abs = this.resolve(String(a['path'])); const existed = fs.existsSync(abs); if (a['expectedOldDigest'] && existed && sha(fs.readFileSync(abs, 'utf8')) !== a['expectedOldDigest']) return { error: { code: 'CAPABILITY_ERROR', message: 'file changed since read (digest mismatch)', retryable: false } }; if (a['createDirs'] !== false) fs.mkdirSync(path.dirname(abs), { recursive: true }); const content = String(a['content']); fs.writeFileSync(abs, content); return { output: { path: path.relative(this.root, abs), bytes: Buffer.byteLength(content), created: !existed, digest: sha(content) } }; }
        case 'shell.exec': { const argv = (a['argv'] as string[]); const cwd = this.resolve(String(a['cwd'] ?? '.')); const timeout = Number(a['timeoutMs'] ?? 60000); const t0 = Date.now(); return await new Promise<ProviderExecuteResult>(res => { const child = spawn(argv[0]!, argv.slice(1), { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', errS = '', timedOut = false; child.stdout.on('data', d => { out += d; if (out.length > 200_000) out = out.slice(-200_000); }); child.stderr.on('data', d => { errS += d; if (errS.length > 50_000) errS = errS.slice(-50_000); }); const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout); child.on('error', e => { clearTimeout(timer); res({ error: { code: 'CAPABILITY_ERROR', message: e.message, retryable: false } }); }); child.on('close', code => { clearTimeout(timer); res({ output: { exitCode: code ?? -1, stdout: out, stderr: errS, timedOut, durationMs: Date.now() - t0 } }); }); if (a['stdin']) child.stdin.write(String(a['stdin'])); child.stdin.end(); }); }
        case 'git.diff': { const staged = !!a['staged']; const max = Number(a['maxBytes'] ?? 200000); const status = await run(['git', 'status', '--short'], this.root); const diff = await run(['git', 'diff', ...(staged ? ['--cached'] : []), ...(a['path'] ? ['--', String(a['path'])] : [])], this.root); return { output: { status: status.stdout, diff: diff.stdout.slice(0, max), truncated: diff.stdout.length > max } }; }
        case 'git.commit': { const paths = (a['paths'] as string[] | undefined) ?? ['-A']; const add = await run(['git', 'add', ...paths], this.root); if (add.code !== 0) return { error: { code: 'CAPABILITY_ERROR', message: add.stderr, retryable: false } }; const c = await run(['git', 'commit', ...(a['signoff'] === false ? [] : ['-s']), '-m', String(a['message'])], this.root); if (c.code !== 0) return { error: { code: 'CAPABILITY_ERROR', message: c.stderr || c.stdout, retryable: false } }; const h = await run(['git', 'rev-parse', '--short', 'HEAD'], this.root); return { output: { commit: h.stdout.trim(), summary: c.stdout.split('\n')[0] ?? '' } }; }
        case 'session.history': { const f = this.opts.sessionFile; const limit = Number(a['limit'] ?? 20); if (!f || !fs.existsSync(f)) return { output: { items: [] } }; const items = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((l, i) => ({ content: JSON.parse(l), cacheKey: `h${i}` })); return { output: { items } }; }
        default: return { error: { code: 'ROUTING_ERROR', message: `unknown contract ${inv.contract.name}`, retryable: false } };
      }
    } catch (e) { return { error: { code: 'CAPABILITY_ERROR', message: e instanceof Error ? e.message : String(e), retryable: false } }; }
  }
}
function run(argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(res => { const c = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); let o = '', e = ''; c.stdout.on('data', d => o += d); c.stderr.on('data', d => e += d); c.on('close', code => res({ code: code ?? -1, stdout: o, stderr: e })); c.on('error', err => res({ code: -1, stdout: '', stderr: err.message })); });
}
