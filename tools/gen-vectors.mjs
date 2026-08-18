// 生成测试向量（只用 canonicalize + node:crypto，不依赖内核代码）。
// 输出到 tests/vectors/*.json；check-vectors.mjs 用 Python 独立实现交叉校验其中可交叉的部分。
import fs from 'node:fs';
import path from 'node:path';
import { jcs, digest, contractDigest, eventHash, ZERO_HASH } from './jcs.mjs';

const OUT = path.resolve('tests/vectors');
fs.mkdirSync(OUT, { recursive: true });

const FILE_READ_REF = { name: 'file.read', version: '1.0.0', schemaDigest: 'sha256:' + 'ab'.repeat(32) };
const chain = [
  { kind: 'task', id: 't_01' },
  { kind: 'agent', id: 'minimal-file-agent' },
  { kind: 'org', id: 'acme' },
];

// ---------------------------------------------------------------- approval digest
const base = {
  schemaVersion: 'approval-subject/1',
  invocation: { id: 'inv_01', revision: 1, contract: FILE_READ_REF, args: { path: 'workspace/x.txt', maxBytes: 4096 }, handleId: 'h_01' },
  principalChain: chain,
  provider: { providerId: 'fs-readonly' },
};
// V2：同一内容、源对象键序打乱 —— 必须与 V1 摘要相同
const reordered = {
  provider: { providerId: 'fs-readonly' },
  principalChain: chain,
  invocation: { handleId: 'h_01', args: { maxBytes: 4096, path: 'workspace/x.txt' }, contract: { schemaDigest: FILE_READ_REF.schemaDigest, version: '1.0.0', name: 'file.read' }, revision: 1, id: 'inv_01' },
  schemaVersion: 'approval-subject/1',
};
const unicode = { ...base, invocation: { ...base.invocation, args: { path: 'workspace/合同/报价单.txt', 备注: '含"引号"与\n换行', 'é': 1, 'z': 2, 'a': 3 } } };
const noProvider = { schemaVersion: base.schemaVersion, invocation: base.invocation, principalChain: chain }; // 省略 provider 键（不写 null）
const rev2 = { ...base, invocation: { ...base.invocation, revision: 2 } };
const floats = { ...base, invocation: { ...base.invocation, args: { ratio: 1.0, big: 1e21, small: 0.000001, neg: -0.5, int: 10 } } };

const approval = {
  algorithm: 'sha256(RFC8785-JCS(ApprovalSubjectV1))；缺省字段省略键，不写 null',
  vectors: [
    { id: 'AD-1 base', crossCheck: true, subject: base, jcs: jcs(base), digest: digest(base) },
    { id: 'AD-2 reordered keys == AD-1', crossCheck: true, subject: reordered, jcs: jcs(reordered), digest: digest(reordered), mustEqual: 'AD-1 base' },
    { id: 'AD-3 unicode keys/values + escapes', crossCheck: true, subject: unicode, jcs: jcs(unicode), digest: digest(unicode) },
    { id: 'AD-4 provider omitted (different from AD-1)', crossCheck: true, subject: noProvider, jcs: jcs(noProvider), digest: digest(noProvider), mustDiffer: 'AD-1 base' },
    { id: 'AD-5 revision 2 (different from AD-1)', crossCheck: true, subject: rev2, jcs: jcs(rev2), digest: digest(rev2), mustDiffer: 'AD-1 base' },
    { id: 'AD-6 floats (JCS number rules; canonicalize-only)', crossCheck: false, subject: floats, jcs: jcs(floats), digest: digest(floats) },
  ],
  notInDigest: ['traceId', 'spanId', 'approvalId', 'ts/createdAt', 'summary', 'observer/audit metadata'],
};
fs.writeFileSync(path.join(OUT, 'approval-digest.json'), JSON.stringify(approval, null, 2));

// ---------------------------------------------------------------- ledger chain
const evs = [
  { ts: '2026-08-17T10:00:00.000Z', taskId: 't_01', principal: chain, type: 'handle.minted', schemaVersion: '1.0.0', payload: { handleId: 'h_00', contract: FILE_READ_REF, holder: chain.slice(1), caveats: [{ kind: 'args.prefix', path: 'path', prefix: 'workspace/' }] } },
  { ts: '2026-08-17T10:00:00.010Z', taskId: 't_01', principal: chain, type: 'handle.attenuated', schemaVersion: '1.0.0', payload: { handleId: 'h_01', parent: 'h_00', addCaveats: [{ kind: 'args.max', path: 'maxBytes', max: 4096 }], holder: chain } },
  { ts: '2026-08-17T10:00:00.020Z', taskId: 't_01', principal: chain, type: 'invocation.requested', schemaVersion: '1.0.0', payload: { invocationId: 'inv_01', handleId: 'h_01', contract: FILE_READ_REF, args: { path: 'workspace/x.txt', maxBytes: 4096 }, revision: 0 } },
  { ts: '2026-08-17T10:00:00.030Z', taskId: 't_01', principal: chain, type: 'invocation.authorized', schemaVersion: '1.0.0', payload: { invocationId: 'inv_01', revision: 0, digest: digest(base), effectiveArgs: { path: 'workspace/x.txt', maxBytes: 4096 }, providerId: 'fs-readonly' } },
];
let prev = ZERO_HASH; const chained = [];
evs.forEach((e, i) => { const seq = i + 1; const full = { seq, prevHash: prev, ...e }; const hash = eventHash(full); chained.push({ ...full, hash }); prev = hash; });
const ledger = {
  algorithm: 'hash = sha256(JCS({seq,prevHash,ts,taskId,principal,type,payload,schemaVersion}))；genesis prevHash = sha256:0×64',
  genesisPrevHash: ZERO_HASH,
  events: chained,
  headHash: prev,
  tamperTest: { description: '把 events[2].payload.args.path 改成 workspace/y.txt 后重算，events[2].hash 与之后全部 hash 必须变化', changedIndex: 2 },
};
fs.writeFileSync(path.join(OUT, 'ledger-chain.json'), JSON.stringify(ledger, null, 2));

// ---------------------------------------------------------------- contract digests（builtin）
const cdir = path.resolve('contracts/builtin'); const contracts = [];
if (fs.existsSync(cdir)) for (const f of fs.readdirSync(cdir).filter(x => x.endsWith('.json')).sort()) {
  const c = JSON.parse(fs.readFileSync(path.join(cdir, f), 'utf8'));
  contracts.push({ file: f, name: c.name, version: c.version, schemaDigest: contractDigest(c), semanticFields: ['name', 'version', 'inputSchema', 'outputSchema', 'sideEffects', 'idempotent', 'permissions'], notInDigest: ['description', 'defaultTimeoutMs', 'pricing', 'async', 'schemaDigest'] });
}
fs.writeFileSync(path.join(OUT, 'contract-digest.json'), JSON.stringify({ algorithm: 'sha256(JCS({name,version,inputSchema,outputSchema,sideEffects,idempotent,permissions??[]}))', contracts }, null, 2));

console.log(`approval vectors: ${approval.vectors.length}; ledger events: ${chained.length}; contracts: ${contracts.length}`);
console.log('AD-1 digest =', approval.vectors[0].digest);
console.log('ledger head =', prev);
