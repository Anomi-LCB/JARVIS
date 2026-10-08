import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkMemory, WORK_MEMORY_VERSION } from '../packages/core/src/conversation-memory.js';

const scope = { workspaceId: 'project-alpha', conversationId: 'conversation-17', userId: 'owner-a' };
async function fixture(operation, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-work-memory-identity-'));
  const journalPath = join(root, 'journal.jsonl');
  const memory = new WorkMemory({ journalPath, scope, ...options });
  const file = async (name, text = name) => { const path = join(root, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text); return path; };
  try { await operation({ root, memory, journalPath, file }); } finally { await rm(root, { recursive: true, force: true }); }
}
function binding(resolution) { const { artifactId, path, sha256, size, version } = resolution.artifact; return { artifactId, path, sha256, size, version }; }

test('artifact IDs, byte hashes, sizes, versions and scope survive process reconstruction', async () => fixture(async ({ memory, file, journalPath }) => {
  const path = await file('보고서.txt', 'first bytes');
  const recorded = memory.record({ taskId: 'task1', missionId: 'mission1', operationId: 'op1', outputPaths: [path] });
  assert.equal(recorded.schemaVersion, WORK_MEMORY_VERSION);
  assert.deepEqual(recorded.scope, scope);
  assert.equal(recorded.missionId, 'mission1');
  assert.equal(recorded.operationId, 'op1');
  assert.match(recorded.artifacts[0].artifactId, /^artifact_[a-f0-9]{32}$/u);
  assert.equal(recorded.artifacts[0].sha256, createHash('sha256').update('first bytes').digest('hex'));
  assert.equal(recorded.artifacts[0].size, 11);
  assert.equal(recorded.artifacts[0].version, 1);
  assert.equal(recorded.artifacts[0].exists, true);
  const restored = new WorkMemory({ journalPath, scope });
  const hit = restored.resolveArtifactReference('방금 만든 파일을 열어줘');
  assert.equal(hit.status, 'resolved');
  assert.equal(hit.artifactId, recorded.artifacts[0].artifactId);
  assert.equal(restored.verifyArtifactReference(binding(hit), { scope }).status, 'resolved');
}));

test('same-path equal-byte reruns keep the ID and version; changed bytes create a new version', async () => fixture(async ({ memory, file }) => {
  const path = await file('stable.json', '{"v":1}');
  const first = memory.record({ outputPaths: [path] }).artifacts[0];
  const duplicate = memory.record({ outputPaths: [path] }).artifacts[0];
  assert.equal(duplicate.artifactId, first.artifactId);
  assert.equal(duplicate.version, 1);
  const firstHit = memory.resolveArtifactReference('그 파일 요약해줘');
  await writeFile(path, '{"v":2}');
  const changed = memory.record({ outputPaths: [path] }).artifacts[0];
  assert.equal(changed.artifactId, first.artifactId);
  assert.equal(changed.version, 2);
  assert.notEqual(changed.sha256, first.sha256);
  assert.equal(memory.resolveArtifactReference('그파일 읽어줘').artifact.version, 2);
  assert.equal(memory.verifyArtifactReference(binding(firstHit), { scope }).status, 'stale');
}));

test('workspace, conversation and user boundaries cannot resolve a same-name file from another scope', async () => fixture(async ({ memory, file }) => {
  const a = await file('project-a/report.txt', 'A');
  const b = await file('project-b/report.txt', 'B');
  const first = memory.record({ outputPaths: [a] });
  const second = memory.record({ outputPaths: [b], scope: { ...scope, workspaceId: 'project-beta' } });
  assert.notEqual(first.artifacts[0].artifactId, second.artifacts[0].artifactId);
  assert.equal(memory.resolveArtifactReference('그 파일 열어줘').path, a);
  assert.equal(memory.resolveArtifactReference('그 파일 열어줘', { scope: { ...scope, workspaceId: 'project-beta' } }).path, b);
  for (const otherScope of [{ ...scope, workspaceId: 'unknown' }, { ...scope, conversationId: 'other' }, { ...scope, userId: 'other' }, {}]) {
    const hit = memory.resolveArtifactReference('그 파일 열어줘', { scope: { workspaceId: null, conversationId: null, userId: null, ...otherScope } });
    assert.equal(hit.status, 'not_found');
    assert.deepEqual(hit.candidates, []);
    assert.equal(hit.path, undefined);
  }
}));

test('multiple latest-task artifacts are ambiguous until an explicit ordinal is given', async () => fixture(async ({ memory, file }) => {
  const first = await file('a/report.json', '{"a":1}');
  const second = await file('b/report.json', '{"b":2}');
  memory.record({ taskId: 'same-task', outputPaths: [first, second] });
  const ambiguous = memory.resolveArtifactReference('그 파일 열어줘');
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.path, undefined);
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(memory.rewriteWithReference('그 파일 열어줘'), null);
  assert.equal(memory.resolveArtifactReference('첫 번째 파일 열어줘').path, first);
  assert.equal(memory.resolveArtifactReference('두번째파일 요약해줘').path, second);
  assert.equal(memory.resolveArtifactReference('3번째 파일 열어줘').status, 'not_found');
}));

test('the latest distinct single artifact wins immediately and type hints resolve only eligible outputs', async () => fixture(async ({ memory, file }) => {
  const first = await file('first.xlsx');
  const latest = await file('latest.docx');
  memory.record({ outputPaths: [first] });
  memory.record({ outputPaths: [latest] });
  assert.equal(memory.resolveArtifactReference('그거 열어줘').path, latest);
  assert.equal(memory.resolveArtifactReference('방금 만든 엑셀 열어줘').path, first);
  memory.record({ outputPaths: [latest, first] });
  assert.equal(memory.resolveArtifactReference('그 엑셀 열어줘').path, first);
}));

test('deleted latest output is not replaced by an older artifact', async () => fixture(async ({ memory, file }) => {
  memory.record({ outputPaths: [await file('old.json')] });
  const latest = await file('latest.json');
  memory.record({ outputPaths: [latest] });
  await unlink(latest);
  const hit = memory.resolveArtifactReference('그 파일 열어줘');
  assert.equal(hit.status, 'not_found');
  assert.equal(hit.reason, 'file_missing');
  assert.equal(hit.artifact.currentExists, false);
  assert.equal(hit.path, undefined);
}));

test('unrecorded same-size byte changes are stale even if filesystem timestamp is restored', async () => fixture(async ({ memory, file }) => {
  const path = await file('same-size.txt', 'AAAA');
  const record = memory.record({ outputPaths: [path] });
  const hit = memory.resolveArtifactReference('그 파일 열어줘');
  await writeFile(path, 'BBBB');
  await utimes(path, new Date(record.artifacts[0].mtimeMs), new Date(record.artifacts[0].mtimeMs));
  assert.equal(memory.resolveArtifactReference('그 파일 열어줘').status, 'stale');
  assert.equal(memory.verifyArtifactReference(binding(hit), { scope }).status, 'stale');
}));

test('explicit file operands keep their text while output destinations do not suppress a deictic input', async () => fixture(async ({ memory, file }) => {
  const path = await file('remembered.json', '[{"n":4}]');
  memory.record({ outputPaths: [path] });
  for (const text of ['그 파일 말고 explicit.json 열어줘', '그 파일 말고 "C:/folder/real.txt" 열어줘']) {
    assert.equal(memory.resolveArtifactReference(text).status, 'not_reference');
    assert.equal(memory.rewriteWithReference(text), null);
  }
  const text = "'그 파일' JSON을 '원본'으로 읽고; '원본'을 'outputs/second.json' JSON으로 저장해";
  const hit = memory.resolveArtifactReference(text);
  assert.equal(hit.status, 'resolved');
  assert.equal(text.slice(hit.start, hit.end), '그 파일');
  assert.equal(hit.path, path);
  assert.ok(hit.rewritten.includes('outputs/second.json'));
}));

test('large files are identified as bounded-unverified rather than silently trusted', async () => fixture(async ({ memory, file }) => {
  const path = await file('large.txt', 'x'.repeat(65));
  const entry = memory.record({ outputPaths: [path] });
  assert.equal(entry.artifacts[0].size, 65);
  assert.equal(entry.artifacts[0].sha256, null);
  assert.equal(entry.artifacts[0].identityStatus, 'hash_size_limit');
  const hit = memory.resolveArtifactReference('그 파일 열어줘');
  assert.equal(hit.status, 'unverified');
  assert.equal(hit.path, undefined);
}, { maxHashBytes: 64, maxTotalHashBytes: 64 }));

test('legacy unscoped entries remain readable only in the legacy scope and report snapshot provenance', async () => fixture(async ({ journalPath, file }) => {
  const path = await file('legacy.txt', 'legacy');
  await appendFile(journalPath, `${JSON.stringify({ at: '2020-01-01T00:00:00Z', taskId: 'old', rawText: 'old', status: 'success', outputPaths: [path] })}\n{bad line}\n`);
  const memory = new WorkMemory({ journalPath });
  const hit = memory.resolveArtifactReference('그 파일 열어줘');
  assert.equal(hit.status, 'resolved');
  assert.equal(hit.artifact.legacySnapshot, true);
  assert.match(hit.artifact.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(memory.resolveArtifactReference('그 파일 열어줘', { scope }).status, 'not_found');
}));

test('pre-execution bindings are scoped and must retain all recorded identity fields', async () => fixture(async ({ memory, file }) => {
  memory.record({ outputPaths: [await file('valid.json')] });
  const resolution = memory.resolveArtifactReference('그 파일 읽어줘');
  const valid = binding(resolution);
  assert.equal(memory.verifyArtifactReference(valid, { scope }).status, 'resolved');
  assert.equal(memory.verifyArtifactReference(valid, { scope: { ...scope, userId: 'foreign' } }).status, 'not_found');
  for (const change of [{ sha256: '0'.repeat(64) }, { artifactId: 'artifact_fake' }, { size: valid.size + 1 }, { version: valid.version + 1 }]) {
    assert.notEqual(memory.verifyArtifactReference({ ...valid, ...change }, { scope }).status, 'resolved');
  }
}));

test('nonreferences, multiple references and failed tasks never produce an automatic target', async () => fixture(async ({ memory, file }) => {
  memory.record({ outputPaths: [await file('failed.txt')], status: 'failed' });
  assert.equal(memory.resolveArtifactReference('그 파일 열어줘').status, 'not_found');
  for (const text of ['새 보고서 만들어줘', '방금 목록 보여줘', '파일 정리해줘']) assert.equal(memory.resolveArtifactReference(text).status, 'not_reference');
  assert.equal(memory.resolveArtifactReference('그 파일과 두번째 파일 비교해줘').status, 'ambiguous');
}));

test('truncated output sets are explicit ambiguity and incomplete versioned identities never become legacy trust', async () => fixture(async ({ memory, file, journalPath }) => {
  const paths = [];
  for (let index = 0; index < 11; index += 1) paths.push(await file(`many-${index}.txt`));
  const entry = memory.record({ outputPaths: paths });
  assert.equal(entry.outputCount, 11);
  assert.equal(entry.outputsTruncated, true);
  assert.equal(memory.resolveArtifactReference('그 파일 열어줘').reason, 'recorded_output_limit');
  await appendFile(journalPath, `${JSON.stringify({ schemaVersion: WORK_MEMORY_VERSION, scope, status: 'success', outputPaths: [paths[0]], artifacts: {} })}\n`);
  const incomplete = memory.resolveArtifactReference('그 파일 열어줘');
  assert.equal(incomplete.status, 'unverified');
  assert.equal(incomplete.reason, 'recorded_identity_unverified');
}));

test('typed input format hints narrow a multi-output task without confusing a destination format', async () => fixture(async ({ memory, file }) => {
  const json = await file('data.json', '[1]');
  const text = await file('readme.txt', 'notes');
  memory.record({ outputPaths: [json, text] });
  const command = "'그 파일' JSON을 '입력'으로 읽고; '입력'을 'output.txt' 텍스트로 저장해";
  assert.equal(memory.resolveArtifactReference(command).path, json);
}));
