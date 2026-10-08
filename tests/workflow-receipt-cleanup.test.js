import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalWorkflowToolAdapter } from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';
import { ExecutionPacketJournal } from '../apps/pc-agent/src/pc-agent-runtime.js';
import { beginJsonlBatchSync, discardJsonlBatchSync } from '../packages/shared/src/jsonl.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new LocalWorkflowToolAdapter({ allowedRoots: [root] });
  const args = { spec: { schemaVersion: 'jarvis-local-workflow-v1', workflowId: 'cleanup',
    nodes: [{ id: 'write', op: 'write.text', args: { path: 'result.txt', text: 'preserved' } }] } };
  return { root, adapter, args, packet: { taskId: 'cleanup-task', packetId: 'cleanup-packet' } };
}

test('deferred stage cleanup needs the original in-process result and packet identity', async t => {
  const f = await fixture(t), result = await f.adapter.execute(f.args, f.packet, { deferCleanup: true });
  assert.equal(result.status, 'success');
  assert.equal(result.evidence.workflow.stagingCleanup.status, 'deferred-until-packet-receipt');
  assert.equal((await f.adapter.finalizePublicationCleanup(structuredClone(result), f.packet)).status, 'not-owned');
  assert.equal((await f.adapter.finalizePublicationCleanup(result, { ...f.packet, taskId: 'other' })).status, 'not-owned');
  assert.equal((await readdir(f.root)).filter(name => name.startsWith('.jarvis-workflow-stage-')).length, 1);
  assert.equal((await f.adapter.finalizePublicationCleanup(result, f.packet)).status, 'removed');
  assert.equal((await readdir(f.root)).filter(name => name.startsWith('.jarvis-workflow-stage-')).length, 0);
  assert.equal(await readFile(join(f.root, 'result.txt'), 'utf8'), 'preserved');
});

test('post-commit failed compensation retains publication intent and staged recovery bytes', async t => {
  const f = await fixture(t);
  f.adapter.buildManifest = async () => { throw new Error('synthetic post-commit validation failure'); };
  f.adapter.revertPublication = async () => ({ success: false, failures: ['synthetic restore failure'] });
  const result = await f.adapter.execute(f.args, f.packet);
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'WORKFLOW_POST_COMMIT_COMPENSATION_FAILED');
  assert.equal(result.evidence.workflow.recoveryStageRetained, true);
  const observation = await f.adapter.inspectPublication(f.packet.taskId);
  assert.equal(observation.status, 'observed'); assert.equal(observation.files[0].state, 'after');
  assert.equal(observation.files[0].stagedValid, true); assert.equal(observation.completedReceipt, false);
});

test('uncertain overwrite retains original backup and refuses automatic resume without a supported contract', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'result.txt'), 'original user document');
  f.adapter.buildManifest = async () => { throw new Error('synthetic post-commit failure'); };
  f.adapter.revertPublication = async () => ({ success: false, failures: ['synthetic restore failure'] });
  const result = await f.adapter.execute({ ...f.args, allowOverwrite: true }, f.packet);
  assert.equal(result.error.code, 'WORKFLOW_POST_COMMIT_COMPENSATION_FAILED');
  const stage = (await readdir(f.root)).find(name => name.startsWith('.jarvis-workflow-stage-'));
  const intent = JSON.parse((await readFile(join(f.root, stage, 'publication-journal.jsonl'), 'utf8')).split('\n')[0]);
  assert.equal(intent.files[0].existedBefore, true);
  assert.equal(await readFile(intent.files[0].backupPath, 'utf8'), 'original user document');
  assert.equal(intent.recoveryRecipe, undefined);
  const observation = await f.adapter.inspectPublication(f.packet.taskId);
  assert.equal(observation.status, 'observed');
  assert.equal(observation.resumable, false);
  await writeFile(join(f.root, 'result.txt'), 'later user edit');
  let authorityCalls = 0;
  const resumed = await f.adapter.execute({ ...f.args, allowOverwrite: true }, f.packet, {
    resumeIntent: intent, beforePublication: async () => { authorityCalls++; throw new Error('must not claim'); }
  });
  assert.notEqual(resumed.status, 'success');
  assert.equal(authorityCalls, 0);
  assert.equal(await readFile(join(f.root, 'result.txt'), 'utf8'), 'later user edit');
  assert.equal(await readFile(intent.files[0].backupPath, 'utf8'), 'original user document');
});

test('packet journal append failure cannot index a receipt as persisted', async t => {
  const f = await fixture(t), path = join(f.root, 'journal.jsonl');
  const journal = new ExecutionPacketJournal({ journalPath: path });
  await mkdir(path);
  assert.throws(() => journal.append({ recordType: 'packet_result', idempotencyKey: 'op', result: {} }, { immediate: true }));
  assert.equal(journal.records.length, 0); assert.equal(journal.results.size, 0);
});

test('immediate packet receipt append reaches the file even inside an unrelated JSONL batch', async t => {
  const f = await fixture(t), path = join(f.root, 'journal.jsonl');
  const journal = new ExecutionPacketJournal({ journalPath: path });
  const batch = beginJsonlBatchSync({ operation: 'receipt-cleanup-test' });
  try {
    journal.append({ recordType: 'test-receipt', idempotencyKey: 'op' }, { immediate: true });
    assert.equal(JSON.parse((await readFile(path, 'utf8')).trim()).recordType, 'test-receipt');
  } finally { discardJsonlBatchSync(batch); }
});
