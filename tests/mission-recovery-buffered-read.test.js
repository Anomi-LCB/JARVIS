import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, open, readFile, rename, rm, writeFile, appendFile, unlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createMissionActionRecovery, recoverMissionAction, ensureMissionActionOperation,
  checkpointMissionActionDispatch } from '../packages/core/src/mission/mission-action-recovery.js';
import { TaskStatus } from '../packages/shared/src/types.js';

const KiB = 1024, MiB = 1024 * KiB;
const sha = value => createHash('sha256').update(value).digest('hex');

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-buffered-recovery-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('jarvis-buffered-recovery-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function requestFor(root, files, { readInput = false } = {}) {
  const calls = { verification: 0, execution: 0 };
  // This unit fixture models generic workflow artifact receipts, including
  // multiple binary/sparse outputs. Those are not a createTextFile request with
  // an omitted (empty) content argument. Exact text-write dispatch/receipt
  // binding is exercised separately in mission-recovery-receipt-binding.
  const toolName = readInput ? 'filesystem.readText' : 'workflow.execute';
  // Supply the newly required dispatch-bound workflow metadata. G remains a stub
  // here: these tests isolate bounded file reading, not workflow execution quality.
  const spec = { schemaVersion: 'jarvis-local-workflow-v1', workflowId: 'buffered-fixture',
    nodes: files.map((file, index) => ({ id: `file_${index}`, op: 'write.text', args: { path: file.path, text: 'read-test fixture' } })),
    outputs: [] };
  const workflow = { schemaVersion: spec.schemaVersion, workflowId: spec.workflowId, specSource: 'inline',
    specSha256: sha(JSON.stringify(spec)), nodeCount: spec.nodes.length,
    receipts: spec.nodes.map(node => ({ nodeId: node.id, op: node.op, status: 'success' })) };
  const taskId = 'buffered-read-fixture-task';
  const action = { actionId: 'fixture-action', taskId, command: '가상 파일 복구', expectedToolName: toolName,
    actualToolName: toolName, arguments: readInput ? { path: files[0].path } : { spec, workspaceRoot: root }, attempts: 1 };
  const execution = { taskId, status: TaskStatus.COMPLETED,
    executionResult: { taskId, executedBy: { toolName }, success: true, packetId: 'fixture-packet',
      outputPaths: readInput ? [] : files.map(file => file.path),
      ...(readInput ? { contentSha256: files[0].sha256 } : { evidence: { workflow } }) },
    evidence: { evidenceId: 'fixture-evidence', files } };
  const task = { taskId, status: TaskStatus.COMPLETED,
    plan: { action: { toolName, arguments: action.arguments } }, executionResult: execution };
  const worker = {
    async verifyExecution() { calls.verification++; return { status: 'passed', verificationId: 'fixture-g', checks: [] }; },
    async runTask() { calls.execution++; throw new Error('Recovery must not execute'); }
  };
  ensureMissionActionOperation('fixture-mission', action, [root]);
  checkpointMissionActionDispatch(action, task, worker, { mutatesSystem: !readInput, externalTransfer: false }, '2026-09-16T00:00:00.000Z');
  return { args: { missionId: 'fixture-mission', action, allowedRoots: [root], coreFacade: { getTask: () => task }, worker }, calls };
}

async function regularFixture(t, size, options) {
  const root = await temporaryRoot(t), path = join(root, 'fixture.bin');
  const content = Buffer.alloc(size, 0x61);
  await writeFile(path, content);
  return { root, path, content, ...requestFor(root, [{ path, sha256: sha(content) }], options) };
}

// Keep actual files, reads and hashing, but project filesystem metadata values
// that cannot be allocated portably on demand (64-bit IDs and sub-ms clocks).
async function withProjectedFileMetadata(path, { handleMetadata, publishedMetadata }, run) {
  const probe = await open(path, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalHandleStat = prototype.stat;
  const originalPathStat = fs.promises.stat;
  let handleStatCalls = 0;
  function project(stats, fields, options) {
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'mtimeNs' || key === 'ctimeNs') {
        stats[key.replace('Ns', 'Ms')] = options?.bigint ? value / 1_000_000n : Number(value) / 1_000_000;
        if (options?.bigint) stats[key] = value;
      } else stats[key] = options?.bigint ? value : Number(value);
    }
    return stats;
  }
  prototype.stat = async function (options) {
    const stats = await originalHandleStat.call(this, options);
    return project(stats, handleMetadata(handleStatCalls++), options);
  };
  fs.promises.stat = async function (target, options) {
    const stats = await originalPathStat.call(this, target, options);
    return resolve(target) === resolve(path) ? project(stats, publishedMetadata, options) : stats;
  };
  syncBuiltinESMExports();
  try { return await run(); }
  finally {
    prototype.stat = originalHandleStat;
    fs.promises.stat = originalPathStat;
    syncBuiltinESMExports();
  }
}

test('64 KiB default and 1 MiB candidate return identical verified results with measured byte totals', async t => {
  const f = await regularFixture(t, 3 * MiB + 17);
  const observations = [];
  for (const readChunkBytes of [64 * KiB, MiB]) {
    const reads = [];
    const result = await createMissionActionRecovery({ readChunkBytes, onFileRead: event => reads.push(event) })(f.args);
    assert.equal(result.status, 'recovered');
    assert.equal(reads.length, Math.ceil(f.content.length / readChunkBytes) + 1);
    assert.equal(reads.reduce((sum, read) => sum + read.bytesRead, 0), f.content.length);
    assert.equal(reads.at(-1).bytesRead, 0);
    assert.ok(reads.every(read => read.requestedBytes === readChunkBytes));
    observations.push(result);
  }
  assert.deepEqual(observations[0], observations[1]);
  assert.deepEqual(await recoverMissionAction(f.args), observations[0]);
  assert.equal(f.calls.verification, 3);
  assert.equal(f.calls.execution, 0);
});

test('small-file buffers retain the 64 KiB floor and grow only to the actual file size', async t => {
  for (const size of [0, 7, 64 * KiB + 3]) {
    const f = await regularFixture(t, size), reads = [];
    const result = await createMissionActionRecovery({ readChunkBytes: MiB, onFileRead: read => reads.push(read) })(f.args);
    assert.equal(result.status, 'recovered');
    assert.ok(reads.every(read => read.requestedBytes === Math.max(64 * KiB, size)));
    assert.equal(reads.length, size === 0 ? 1 : 2);
  }
});

test('readText still hashes recorded input evidence and the current read input separately', async t => {
  const f = await regularFixture(t, 256 * KiB + 7, { readInput: true });
  for (const readChunkBytes of [64 * KiB, MiB]) {
    const reads = [];
    const result = await createMissionActionRecovery({ readChunkBytes, onFileRead: read => reads.push(read) })(f.args);
    assert.equal(result.status, 'recovered');
    assert.equal(reads.reduce((sum, read) => sum + read.bytesRead, 0), 2 * f.content.length);
    assert.equal(reads.filter(read => read.bytesRead === 0).length, 2);
  }
  assert.equal(f.calls.verification, 2);
  assert.equal(f.calls.execution, 0);
});

test('growth during the first read or EOF observation fails before G for both read sizes', async t => {
  for (const readChunkBytes of [64 * KiB, MiB]) {
    for (const boundary of ['first-read', 'eof']) {
      const f = await regularFixture(t, 2 * MiB), reads = [];
      let injected = false;
      const result = await createMissionActionRecovery({ readChunkBytes, onFileRead: async read => {
        reads.push(read);
        if (!injected && (boundary === 'first-read' || read.bytesRead === 0)) {
          injected = true;
          await appendFile(f.path, 'changed');
        }
      } })(f.args);
      assert.equal(injected, true);
      assert.equal(result.status, 'blocked');
      assert.equal(result.error.code, 'A_MISSION_RECOVERY_ARTIFACT_CHANGED');
      assert.equal(f.calls.verification, 0);
      assert.equal(f.calls.execution, 0);
    }
  }
});

test('deletion while the original file handle remains open cannot be recovered', async t => {
  for (const readChunkBytes of [64 * KiB, MiB]) {
    const f = await regularFixture(t, 2 * MiB);
    let injected = false;
    const result = await createMissionActionRecovery({ readChunkBytes, onFileRead: async () => {
      if (!injected) { await unlink(f.path); injected = true; }
    } })(f.args);
    assert.equal(injected, true, 'the deletion must actually occur while the file is open');
    assert.equal(result.status, 'blocked');
    assert.equal(result.error.code, 'A_MISSION_RECOVERY_ARTIFACT_UNAVAILABLE');
    assert.equal(f.calls.verification, 0);
  }
});

test('renaming the open file and replacing its published path is rejected before G for both read sizes', async t => {
  for (const readChunkBytes of [64 * KiB, MiB]) {
    const f = await regularFixture(t, 2 * MiB);
    const replacement = Buffer.alloc(f.content.length, 0x62);
    let injected = false;
    const result = await createMissionActionRecovery({ readChunkBytes, onFileRead: async () => {
      if (!injected) {
        await rename(f.path, join(f.root, 'original-moved.bin'));
        await writeFile(f.path, replacement);
        injected = true;
      }
    } })(f.args);
    assert.equal(injected, true);
    assert.equal(result.status, 'blocked');
    assert.equal(result.error.code, 'A_MISSION_RECOVERY_ARTIFACT_CHANGED');
    assert.notEqual(sha(await readFile(f.path)), sha(f.content));
    assert.equal(f.calls.verification, 0);
    assert.equal(f.calls.execution, 0);
  }
});

test('distinct 64-bit file IDs cannot match merely because Number rounds them to the same value', async t => {
  const originalId = 2n ** 53n, replacementId = originalId + 1n;
  assert.equal(Number(originalId), Number(replacementId));
  for (const readChunkBytes of [64 * KiB, MiB]) {
    const f = await regularFixture(t, 7);
    const result = await withProjectedFileMetadata(f.path, {
      handleMetadata: () => ({ ino: originalId }),
      publishedMetadata: { ino: replacementId }
    }, () => createMissionActionRecovery({ readChunkBytes })(f.args));
    assert.equal(result.status, 'blocked');
    assert.equal(result.error.code, 'A_MISSION_RECOVERY_ARTIFACT_CHANGED');
    assert.equal(f.calls.verification, 0);
    assert.equal(f.calls.execution, 0);
  }
});

test('sub-millisecond modification and change timestamps remain distinct during a read', async t => {
  const earlier = 1_789_603_504_000_000_000n, later = earlier + 100n;
  assert.equal(Number(earlier) / 1_000_000, Number(later) / 1_000_000);
  for (const field of ['mtimeNs', 'ctimeNs']) {
    for (const readChunkBytes of [64 * KiB, MiB]) {
      const f = await regularFixture(t, 7);
      const result = await withProjectedFileMetadata(f.path, {
        handleMetadata: call => ({ [field]: call === 0 ? earlier : later }),
        publishedMetadata: { [field]: later }
      }, () => createMissionActionRecovery({ readChunkBytes })(f.args));
      assert.equal(result.status, 'blocked', field);
      assert.equal(result.error.code, 'A_MISSION_RECOVERY_ARTIFACT_CHANGED', field);
      assert.equal(f.calls.verification, 0);
      assert.equal(f.calls.execution, 0);
    }
  }
});

test('invalid chunk options and observer values are rejected before use', () => {
  for (const readChunkBytes of [0, 64 * KiB - 1, MiB + 1, 64 * KiB + 0.5, NaN, Infinity, '65536', null]) {
    assert.throws(() => createMissionActionRecovery({ readChunkBytes }), { code: 'A_MISSION_RECOVERY_INVALID_READ_CHUNK' });
  }
  for (const onFileRead of [true, 1, {}, 'observer']) {
    assert.throws(() => createMissionActionRecovery({ onFileRead }), { code: 'A_MISSION_RECOVERY_INVALID_READ_OBSERVER' });
  }
});

test('synchronous and asynchronous observer failures block verification instead of escaping or recovering', async t => {
  for (const observer of [() => { throw new Error('observer failed'); }, async () => { throw new Error('observer rejected'); }]) {
    const f = await regularFixture(t, 7);
    const result = await createMissionActionRecovery({ onFileRead: observer })(f.args);
    assert.equal(result.status, 'blocked');
    assert.equal(result.error.code, 'A_MISSION_RECOVERY_ARTIFACT_UNAVAILABLE');
    assert.equal(f.calls.verification, 0);
    assert.equal(f.calls.execution, 0);
  }
});

test('the 128 MiB per-file cap still rejects oversized files before reading', async t => {
  const root = await temporaryRoot(t), path = join(root, 'oversized.bin');
  const handle = await open(path, 'w');
  try { await handle.truncate(128 * MiB + 1); } finally { await handle.close(); }
  const f = requestFor(root, [{ path, sha256: '0'.repeat(64) }]);
  let reads = 0;
  const result = await createMissionActionRecovery({ readChunkBytes: MiB, onFileRead: () => reads++ })(f.args);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'A_MISSION_RECOVERY_ARTIFACT_BUDGET_EXCEEDED');
  assert.equal(reads, 0);
  assert.equal(f.calls.verification, 0);
});

test('the 512 MiB cumulative cap counts actual complete file passes before refusing the next file', async t => {
  const root = await temporaryRoot(t), files = [], zero = Buffer.alloc(MiB), digest = createHash('sha256');
  for (let index = 0; index < 128; index++) digest.update(zero);
  const expected = digest.digest('hex');
  for (let index = 0; index < 4; index++) {
    const path = join(root, `large-${index}.bin`), handle = await open(path, 'w');
    try { await handle.truncate(128 * MiB); } finally { await handle.close(); }
    files.push({ path, sha256: expected });
  }
  const extraPath = join(root, 'extra.bin');
  await writeFile(extraPath, 'x');
  files.push({ path: extraPath, sha256: sha('x') });
  const f = requestFor(root, files);
  let bytes = 0, reads = 0;
  const result = await createMissionActionRecovery({ readChunkBytes: MiB, onFileRead: read => { bytes += read.bytesRead; reads++; } })(f.args);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'A_MISSION_RECOVERY_ARTIFACT_BUDGET_EXCEEDED');
  assert.equal(bytes, 512 * MiB);
  assert.equal(reads, 4 * (128 + 1));
  assert.equal(f.calls.verification, 0);
  assert.equal(f.calls.execution, 0);
});
