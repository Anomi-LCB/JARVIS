import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { LocalWorkflowToolAdapter } from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';

async function inTemporaryWorkspace(operation) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'jarvis-sqlite-inferred-key-'));
  try { await operation(root, new LocalWorkflowToolAdapter({ allowedRoots: [root] })); }
  finally {
    const inside = relative(parent, resolve(root));
    assert.ok(inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
    await rm(root, { recursive: true, force: true });
  }
}

function ref(nodeId, pointer = '') { return { $ref: { nodeId, pointer } }; }
function spec(workflowId, nodes) { return { schemaVersion: 'jarvis-local-workflow-v1', workflowId, nodes }; }
function seed(items, table = 'records') {
  return { id: 'seed', op: 'sqlite.import', args: { databasePath: 'data.db', table, mode: 'replace', items } };
}
function upsert(items, { dependsOn = [], table = 'records' } = {}) {
  return { id: 'upsert', op: 'sqlite.import', dependsOn, args: { databasePath: 'data.db', table, mode: 'upsert', key: 'id', items } };
}
function queryRows(path, sql = 'SELECT id, value FROM records ORDER BY id') {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(sql).all().map((row) => ({ ...row })); }
  finally { db.close(); }
}
async function run(adapter, root, workflowId, nodes, extra = {}) {
  return adapter.execute({ spec: spec(workflowId, nodes), workspaceRoot: root, ...extra });
}

test('plain import followed by keyed upsert in one workflow infers a unique key without dropping rows', async () => {
  await inTemporaryWorkspace(async (root, adapter) => {
    const result = await run(adapter, root, 'inferred-key-dag', [
      seed([{ id: 'alpha', value: 11 }, { id: 'beta', value: 22 }]),
      upsert([{ id: 'beta', value: 220 }, { id: 'gamma', value: 33 }], { dependsOn: ['seed'] }),
      { id: 'read', op: 'sqlite.query', dependsOn: ['upsert'], args: { databasePath: ref('upsert'), sql: 'SELECT id, value FROM records ORDER BY id' } },
      { id: 'verify', op: 'assert.count', dependsOn: ['read'], args: { items: ref('read', '/items'), equals: 3 } }
    ]);
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.deepEqual(queryRows(join(root, 'data.db')), [
      { id: 'alpha', value: 11 }, { id: 'beta', value: 220 }, { id: 'gamma', value: 33 }
    ]);
    const db = new DatabaseSync(join(root, 'data.db'), { readOnly: true });
    try {
      const unique = db.prepare('PRAGMA index_list(records)').all().filter((row) => row.unique === 1);
      assert.ok(unique.some((index) => db.prepare(`PRAGMA index_info("${index.name}")`).all().map((row) => row.name).join(',') === 'id'));
    } finally { db.close(); }
    assert.equal(result.evidence.workflow.receipts.length, 4);
  });
});

test('a later workflow can upsert a published plain-import database and preserve its unrelated rows', async () => {
  await inTemporaryWorkspace(async (root, adapter) => {
    const original = await run(adapter, root, 'plain-publish', [seed([{ id: 'keep', value: 5 }, { id: 'change', value: 6 }])]);
    assert.equal(original.status, 'success', JSON.stringify(original));
    const updated = await run(adapter, root, 'later-keyed-update', [upsert([{ id: 'change', value: 66 }, { id: 'new', value: 7 }])], { allowOverwrite: true });
    assert.equal(updated.status, 'success', JSON.stringify(updated));
    assert.deepEqual(queryRows(join(root, 'data.db')), [
      { id: 'change', value: 66 }, { id: 'keep', value: 5 }, { id: 'new', value: 7 }
    ]);
    assert.equal(updated.changedItems[0].type, 'overwrite_file');
  });
});

test('existing duplicate or null keys reject inference and publish neither changed database nor prior staged output', async () => {
  for (const example of [
    { name: 'duplicate', rows: [{ id: 'same', value: 1 }, { id: 'same', value: 2 }], code: 'WORKFLOW_SQLITE_UPSERT_KEY_DUPLICATE' },
    { name: 'null', rows: [{ id: null, value: 1 }, { id: 'valid', value: 2 }], code: 'WORKFLOW_SQLITE_UPSERT_KEY_MISSING' }
  ]) {
    await inTemporaryWorkspace(async (root, adapter) => {
      const original = await run(adapter, root, `invalid-original-${example.name}`, [seed(example.rows)]);
      assert.equal(original.status, 'success', JSON.stringify(original));
      const originalBytes = await readFile(join(root, 'data.db'));
      const attempted = await run(adapter, root, `invalid-upsert-${example.name}`, [
        { id: 'stage-note', op: 'write.text', args: { path: 'should-not-publish.txt', text: 'must remain staged' } },
        upsert([{ id: 'new', value: 9 }], { dependsOn: ['stage-note'] })
      ], { allowOverwrite: true });
      assert.equal(attempted.status, 'failed', JSON.stringify(attempted));
      assert.equal(attempted.error.code, example.code);
      assert.deepEqual(await readFile(join(root, 'data.db')), originalBytes);
      await assert.rejects(readFile(join(root, 'should-not-publish.txt')), { code: 'ENOENT' });
      assert.equal((await readdir(root)).some((name) => name.startsWith('.jarvis-workflow-stage-')), false);
    });
  }
});

test('invalid keys in the update batch also leave the published database byte-identical', async () => {
  for (const updates of [
    [{ id: null, value: 4 }],
    [{ id: 'valid', value: 4 }, { value: 5 }]
  ]) {
    await inTemporaryWorkspace(async (root, adapter) => {
      assert.equal((await run(adapter, root, 'valid-seed', [seed([{ id: 'valid', value: 3 }])])).status, 'success');
      const before = await readFile(join(root, 'data.db'));
      const result = await run(adapter, root, 'invalid-update', [upsert(updates)], { allowOverwrite: true });
      assert.equal(result.status, 'failed', JSON.stringify(result));
      assert.equal(result.error.code, 'WORKFLOW_SQLITE_UPSERT_KEY_MISSING');
      assert.deepEqual(await readFile(join(root, 'data.db')), before);
    });
  }
});

test('key-only upsert ignores existing keys, inserts new keys and preserves existing payload columns', async () => {
  await inTemporaryWorkspace(async (root, adapter) => {
    const result = await run(adapter, root, 'key-only-with-existing-payload', [
      seed([{ id: 'kept', value: 'original' }]),
      upsert([{ id: 'kept' }, { id: 'added' }], { dependsOn: ['seed'] })
    ]);
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.deepEqual(queryRows(join(root, 'data.db')), [{ id: 'added', value: null }, { id: 'kept', value: 'original' }]);
  });
  await inTemporaryWorkspace(async (root, adapter) => {
    const result = await run(adapter, root, 'key-only-table', [
      seed([{ id: 'x' }]), upsert([{ id: 'x' }, { id: 'y' }], { dependsOn: ['seed'] })
    ]);
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.deepEqual(queryRows(join(root, 'data.db'), 'SELECT id FROM records ORDER BY id'), [{ id: 'x' }, { id: 'y' }]);
  });
});
