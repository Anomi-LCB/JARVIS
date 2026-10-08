import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { LocalWorkflowToolAdapter } from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-user-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new LocalWorkflowToolAdapter({ allowedRoots: [root] });
  const args = { spec: { schemaVersion: 'jarvis-local-workflow-v1', workflowId: 'user-edit',
    nodes: [{ id: 'write', op: 'write.text', args: { path: 'result.txt', text: 'agent output' } }] } };
  return { root, adapter, args, target: join(root, 'result.txt') };
}

test('new-file publication cannot overwrite a file created after the prepared contract', async t => {
  const f = await fixture(t), record = f.adapter.recordPublicationBoundary.bind(f.adapter);
  f.adapter.recordPublicationBoundary = async (state, entry) => {
    await record(state, entry);
    if (entry.phase === 'publishing') await writeFile(f.target, 'concurrent user file');
  };
  const result = await f.adapter.execute(f.args);
  assert.equal(await readFile(f.target, 'utf8'), 'concurrent user file');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EEXIST');
  assert.equal(result.evidence.workflow.recoveryStageRetained, true);
  assert.equal((await readdir(f.root)).some(name => name.includes('.jarvis-publish-')), false);
});

for (const overwrite of [false, true]) for (const phase of ['published', 'manifest']) {
  test(`compensation preserves a later user edit (${overwrite ? 'overwrite' : 'new'}, ${phase})`, async t => {
    const f = await fixture(t);
    if (overwrite) await writeFile(f.target, 'original user file');
    const record = f.adapter.recordPublicationBoundary.bind(f.adapter);
    if (phase === 'published') f.adapter.recordPublicationBoundary = async (state, entry) => {
      await record(state, entry);
      if (entry.phase === 'published') {
        await writeFile(f.target, 'later user edit');
        throw Object.assign(new Error('synthetic journal boundary failure'), { code: 'EIO' });
      }
    };
    else f.adapter.buildManifest = async () => {
      await writeFile(f.target, 'later user edit');
      throw new Error('synthetic manifest failure');
    };
    const result = await f.adapter.execute({ ...f.args, allowOverwrite: overwrite });
    assert.equal(await readFile(f.target, 'utf8'), 'later user edit');
    assert.equal(result.status, 'failed');
    assert.match(result.error.code, /COMPENSATION_FAILED/);
    assert.match(result.error.message, /current-version-conflict/);
    assert.equal(result.evidence.workflow.recoveryStageRetained, true);
    if (overwrite) {
      const stage = (await readdir(f.root)).find(name => name.startsWith('.jarvis-workflow-stage-'));
      const intent = JSON.parse((await readFile(join(f.root, stage, 'publication-journal.jsonl'), 'utf8')).split('\n')[0]);
      assert.equal(await readFile(intent.files[0].backupPath, 'utf8'), 'original user file');
    }
  });
}

test('overwrite detects a changed destination before replacement and keeps its backup', async t => {
  const f = await fixture(t), record = f.adapter.recordPublicationBoundary.bind(f.adapter);
  await writeFile(f.target, 'original user file');
  f.adapter.recordPublicationBoundary = async (state, entry) => {
    await record(state, entry);
    if (entry.phase === 'publishing') await writeFile(f.target, 'changed before replace');
  };
  const result = await f.adapter.execute({ ...f.args, allowOverwrite: true });
  assert.equal(result.error.code, 'WORKFLOW_OUTPUT_CHANGED_BEFORE_PUBLICATION');
  assert.equal(await readFile(f.target, 'utf8'), 'changed before replace');
  const stage = (await readdir(f.root)).find(name => name.startsWith('.jarvis-workflow-stage-'));
  const intent = JSON.parse((await readFile(join(f.root, stage, 'publication-journal.jsonl'), 'utf8')).split('\n')[0]);
  assert.equal(await readFile(intent.files[0].backupPath, 'utf8'), 'original user file');
});

test('partial undo registration cannot report rolled back when compensation conflicts', async t => {
  const f = await fixture(t);
  await writeFile(f.target, 'original user file');
  f.args.spec.nodes.push({ id: 'second', op: 'write.text', args: { path: 'second.txt', text: 'second agent output' } });
  const recorded = [], marked = [];
  f.adapter.undoJournal = {
    record: entry => {
      if (recorded.length) { writeFileSync(f.target, 'edit during undo registration'); throw new Error('synthetic second undo failure'); }
      const value = { ...entry, undoJournalId: 'first-undo' }; recorded.push(value); return value;
    },
    markRolledBack: entry => marked.push(entry)
  };
  const result = await f.adapter.execute({ ...f.args, allowOverwrite: true });
  assert.equal(result.error.code, 'WORKFLOW_POST_COMMIT_COMPENSATION_FAILED');
  assert.deepEqual(marked, []);
  assert.equal(await readFile(f.target, 'utf8'), 'edit during undo registration');
  assert.equal(await readFile(recorded[0].backupPath, 'utf8'), 'original user file');
  await assert.rejects(readFile(join(f.root, 'second.txt')), error => error.code === 'ENOENT');
});
