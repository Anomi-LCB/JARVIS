import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { LocalWorkflowToolAdapter } from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';
import { impossibleWorkflow30Cases } from '../scripts/impossible-workflow-30-cases.mjs';
import { materializeImpossibleWorkflow30Fixture } from '../scripts/impossible-workflow-30-fixtures.mjs';
import { verifyImpossibleWorkflow30Case } from '../scripts/impossible-workflow-30-oracle.mjs';

async function withTempRoot(prefix, operation) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try { return await operation(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

function spec(workflowId, nodes) {
  return { schemaVersion: 'jarvis-local-workflow-v1', workflowId, nodes };
}

function ref(nodeId, pointer = '', expectedType = undefined) {
  return { $ref: { nodeId, ...(pointer ? { pointer } : {}), ...(expectedType ? { expectedType } : {}) } };
}

for (const failurePhase of ['prepared', 'published']) {
  test(`publication journal ${failurePhase} write failure does not leave newly published outputs`, async () =>
    withTempRoot('jarvis-workflow-journal-failure-', async root => {
      const adapter = new LocalWorkflowToolAdapter({ allowedRoots: [root] });
      const record = adapter.recordPublicationBoundary.bind(adapter);
      let injected = false;
      adapter.recordPublicationBoundary = async (state, entry) => {
        if (entry.phase === failurePhase) {
          injected = true; throw Object.assign(new Error('synthetic journal I/O failure'), { code: 'EIO' });
        }
        return record(state, entry);
      };
      const result = await adapter.execute({ spec: spec('journal-failure', [
        { id: 'one', op: 'write.text', args: { path: 'one.txt', text: 'one' } },
        { id: 'two', op: 'write.text', args: { path: 'two.txt', text: 'two' } }
      ]) });
      assert.equal(injected, true); assert.equal(result.status, 'failed');
      assert.equal(result.error.code, 'EIO');
      for (const name of ['one.txt', 'two.txt']) await assert.rejects(readFile(join(root, name)), error => error.code === 'ENOENT');
    }));
}

test('Mission hash-pinned workflow files fail closed if bytes change after planning', async () => withTempRoot('jarvis-workflow-hash-pin-', async root => {
  const path = await writeJson(join(root, 'pinned.workflow.json'), spec('pinned', [
    { id: 'write', op: 'write.text', dependsOn: [], args: { path: 'result.txt', text: 'planned' } }
  ]));
  const plannedBytes = await readFile(path);
  const expectedSha256 = createHash('sha256').update(plannedBytes).digest('hex');
  await writeJson(path, spec('pinned-mutated', [
    { id: 'write', op: 'write.text', dependsOn: [], args: { path: 'result.txt', text: 'mutated' } }
  ]));
  const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root] }).execute({ specPath: path, expectedSha256 });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'WORKFLOW_SPEC_CHANGED_AFTER_PLANNING');
  await assert.rejects(readFile(join(root, 'result.txt')), error => error.code === 'ENOENT');
}));

test('workflow adapter executes a typed dependency DAG, publishes atomically, and is byte-idempotent', async () => {
  await withTempRoot('jarvis-local-workflow-dag-', async (root) => {
    await writeJson(join(root, 'input.json'), [
      { id: 'a', active: true, score: 2 },
      { id: 'b', active: false, score: 9 },
      { id: 'c', active: true, score: 7 }
    ]);
    const specPath = await writeJson(join(root, 'dag.workflow.json'), spec('dag-ref', [
      { id: 'read', op: 'data.readJson', args: { path: 'input.json' } },
      { id: 'filter', op: 'data.filter', dependsOn: ['read'], args: { items: ref('read', '/items', 'array'), field: 'active', operator: 'eq', value: true } },
      { id: 'sort', op: 'data.sort', dependsOn: ['filter'], args: { items: ref('filter', '/items', 'array'), by: 'score', order: 'desc' } },
      { id: 'assert', op: 'assert.count', dependsOn: ['sort'], args: { items: ref('sort', '/items'), equals: 2 } },
      { id: 'write', op: 'write.json', dependsOn: ['sort', 'assert'], args: { path: 'out/result.json', value: ref('sort') } }
    ]));
    const undoEntries = [];
    const adapter = new LocalWorkflowToolAdapter({ allowedRoots: [root], undoJournal: { record: (entry) => ({ ...entry, undoJournalId: `u${undoEntries.push(entry)}` }) } });
    const first = await adapter.execute({ specPath }, { taskId: 'dag-task' });
    assert.equal(first.status, 'success', JSON.stringify(first));
    assert.deepEqual(JSON.parse(await readFile(join(root, 'out/result.json'), 'utf8')).items.map((item) => item.id), ['c', 'a']);
    assert.match(first.evidence.workflow.specSha256, /^[a-f0-9]{64}$/u);
    assert.equal(first.evidence.workflow.receipts.length, 5);
    assert.deepEqual(first.evidence.manifest.map((file) => file.path), [join(root, 'out/result.json')]);
    assert.equal(undoEntries.length, 1);

    const second = await adapter.execute({ specPath }, { taskId: 'dag-task-repeat' });
    assert.equal(second.status, 'success', JSON.stringify(second));
    assert.equal(second.changedItems[0].type, 'unchanged_file');
    assert.equal(second.rollbackAvailable, false);
    assert.equal(undoEntries.length, 1);
  });
});

test('workflow refuses to publish outputs when a file input changes after it was read', async () => withTempRoot('jarvis-workflow-input-race-', async root => {
  await writeJson(join(root, 'input.json'), { revision: 1, title: 'old' });
  const specPath = await writeJson(join(root, 'input-race.workflow.json'), spec('input-race', [
    { id: 'read', op: 'data.readJson', args: { path: 'input.json' } },
    { id: 'write', op: 'write.json', dependsOn: ['read'], args: { path: 'published/report.json', value: ref('read', '/value') } }
  ]));
  class CompetingRevisionAdapter extends LocalWorkflowToolAdapter {
    async executeNode(node, state, waveIndex) {
      const result = await super.executeNode(node, state, waveIndex);
      if (node.id === 'read') await writeJson(join(root, 'input.json'), { revision: 2, title: 'new' });
      return result;
    }
  }
  const result = await new CompetingRevisionAdapter({ allowedRoots: [root] }).execute({ specPath });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'WORKFLOW_SOURCE_CHANGED_DURING_EXECUTION');
  await assert.rejects(readFile(join(root, 'published', 'report.json')), error => error.code === 'ENOENT');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'input.json'), 'utf8')), { revision: 2, title: 'new' });
}));

test('workflow evidence records pinned file input revisions when publication succeeds', async () => withTempRoot('jarvis-workflow-input-snapshot-', async root => {
  const inputPath = join(root, 'input.txt');
  await writeFile(inputPath, 'stable source', 'utf8');
  const specPath = await writeJson(join(root, 'input-snapshot.workflow.json'), spec('input-snapshot', [
    { id: 'read', op: 'text.read', args: { path: 'input.txt' } },
    { id: 'write', op: 'write.text', dependsOn: ['read'], args: { path: 'published/report.txt', text: ref('read', '/text') } }
  ]));
  const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root] }).execute({ specPath });
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.deepEqual(result.evidence.workflow.inputSnapshots, [{
    path: inputPath,
    sourcePath: inputPath,
    sha256: createHash('sha256').update('stable source').digest('hex'),
    size: Buffer.byteLength('stable source'),
    staged: false
  }]);
  assert.equal(await readFile(join(root, 'published', 'report.txt'), 'utf8'), 'stable source');
}));

test('workflow compensates its publication when a source changes during the commit window', async () => withTempRoot('jarvis-workflow-input-commit-race-', async root => {
  await writeJson(join(root, 'input.json'), { revision: 1 });
  await mkdir(join(root, 'published'), { recursive: true });
  await writeFile(join(root, 'published/report.json'), 'previous report', 'utf8');
  const specPath = await writeJson(join(root, 'input-commit-race.workflow.json'), spec('input-commit-race', [
    { id: 'read', op: 'data.readJson', args: { path: 'input.json' } },
    { id: 'write', op: 'write.json', dependsOn: ['read'], args: { path: 'published/report.json', value: ref('read', '/value') } }
  ]));
  class CommitWindowRaceAdapter extends LocalWorkflowToolAdapter {
    async publish(state) {
      const publication = await super.publish(state);
      await writeJson(join(root, 'input.json'), { revision: 2 });
      return publication;
    }
  }
  const result = await new CommitWindowRaceAdapter({ allowedRoots: [root] }).execute({ specPath, allowOverwrite: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'WORKFLOW_SOURCE_CHANGED_DURING_EXECUTION');
  assert.equal(await readFile(join(root, 'published/report.json'), 'utf8'), 'previous report');
}));

test('workflow adapter blocks lexical escapes and symlink traversal', async () => {
  await withTempRoot('jarvis-local-workflow-path-', async (root) => {
    const outside = await mkdtemp(join(tmpdir(), 'jarvis-local-workflow-outside-'));
    try {
      const escapeSpec = await writeJson(join(root, 'escape.workflow.json'), spec('escape', [
        { id: 'write', op: 'write.text', args: { path: '../escaped.txt', text: 'forbidden' } }
      ]));
      const adapter = new LocalWorkflowToolAdapter({ allowedRoots: [root] });
      const escaped = await adapter.execute({ specPath: escapeSpec });
      assert.equal(escaped.status, 'blocked');
      assert.match(escaped.error.code, /OUTSIDE_ALLOWED_ROOT/u);

      const linkPath = join(root, 'linked');
      try {
        await symlink(outside, linkPath, 'junction');
        const symlinkSpec = await writeJson(join(root, 'symlink.workflow.json'), spec('symlink', [
          { id: 'write', op: 'write.text', args: { path: 'linked/escaped.txt', text: 'forbidden' } }
        ]));
        const linked = await adapter.execute({ specPath: symlinkSpec });
        assert.equal(linked.status, 'blocked');
        assert.match(linked.error.code, /SYMLINK/u);
      } catch (error) {
        if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
      }
      await assert.rejects(readFile(join(outside, 'escaped.txt')));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('a downstream failure removes staging and leaves every prior output byte unchanged', async () => {
  await withTempRoot('jarvis-local-workflow-atomic-', async (root) => {
    const outputPath = join(root, 'out', 'sentinel.txt');
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, 'original-bytes', 'utf8');
    const specPath = await writeJson(join(root, 'atomic.workflow.json'), spec('atomic-failure', [
      { id: 'write', op: 'write.text', args: { path: 'out/sentinel.txt', text: 'replacement' } },
      { id: 'fail', op: 'assert.equals', dependsOn: ['write'], args: { actual: 1, expected: 2 } }
    ]));
    const adapter = new LocalWorkflowToolAdapter({ allowedRoots: [root] });
    const result = await adapter.execute({ specPath, allowOverwrite: true });
    assert.equal(result.status, 'failed');
    assert.equal(await readFile(outputPath, 'utf8'), 'original-bytes');
    await assert.rejects(readFile(join(root, '.jarvis-workflow-staging', 'atomic-failure')));
  });
});

test('a preclaimed fixed staging junction cannot redirect temporary writes outside the allowed root', async () => {
  await withTempRoot('jarvis-local-workflow-stage-guard-', async (root) => {
    const outside = await mkdtemp(join(tmpdir(), 'jarvis-local-workflow-stage-outside-'));
    try {
      try { await symlink(outside, join(root, '.jarvis-workflow-staging'), 'junction'); }
      catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
      const specPath = await writeJson(join(root, 'safe-stage.workflow.json'), spec('safe-stage', [
        { id: 'write', op: 'write.text', args: { path: 'outputs/result.txt', text: 'inside-only' } }
      ]));
      const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root] }).execute({ specPath });
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(await readFile(join(root, 'outputs/result.txt'), 'utf8'), 'inside-only');
      assert.deepEqual(await readdir(outside), []);
      assert.equal((await readdir(root)).some((name) => name.startsWith('.jarvis-workflow-stage-')), false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('an approved overwrite records a byte-restorable backup before publishing', async () => {
  await withTempRoot('jarvis-local-workflow-undo-', async (root) => {
    const outputPath = join(root, 'out', 'existing.txt');
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, 'original', 'utf8');
    const specPath = await writeJson(join(root, 'overwrite.workflow.json'), spec('overwrite', [
      { id: 'write', op: 'write.text', args: { path: 'out/existing.txt', text: 'replacement' } }
    ]));
    const recorded = [];
    const undoJournal = { record: (entry) => { recorded.push(entry); return { ...entry, undoJournalId: 'undo-1' }; } };
    const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root], undoJournal }).execute({ specPath, allowOverwrite: true }, { taskId: 'overwrite-task' });
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(await readFile(outputPath, 'utf8'), 'replacement');
    assert.equal(recorded[0].action, 'restore_backup_file');
    assert.equal(await readFile(recorded[0].backupPath, 'utf8'), 'original');
    assert.equal(result.undoJournalId, 'undo-1');
  });
});

test('an undo journal exception compensates every published file before reporting failure', async () => {
  await withTempRoot('jarvis-local-workflow-journal-fault-', async (root) => {
    await mkdir(join(root, 'outputs'), { recursive: true });
    await writeFile(join(root, 'outputs', 'existing.txt'), 'original', 'utf8');
    const specPath = await writeJson(join(root, 'journal-fault.workflow.json'), spec('journal-fault', [
      { id: 'existing', op: 'write.text', args: { path: 'outputs/existing.txt', text: 'replacement' } },
      { id: 'created', op: 'write.text', args: { path: 'outputs/created.txt', text: 'new-file' } }
    ]));
    const recorded = [];
    const compensated = [];
    const undoJournal = {
      record: (entry) => {
        if (recorded.length > 0) throw new Error('injected-journal-failure');
        const recordedEntry = { ...entry, undoJournalId: 'partial-entry' };
        recorded.push(recordedEntry);
        return recordedEntry;
      },
      markRolledBack: (entry, detail) => compensated.push({ entry, detail })
    };
    const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root], undoJournal }).execute({ specPath, allowOverwrite: true }, { taskId: 'journal-fault' });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'WORKFLOW_UNDO_JOURNAL_FAILED');
    assert.equal(await readFile(join(root, 'outputs', 'existing.txt'), 'utf8'), 'original');
    await assert.rejects(readFile(join(root, 'outputs', 'created.txt')));
    assert.deepEqual((await readdir(join(root, 'outputs'))).sort(), ['existing.txt']);
    assert.equal(recorded.length, 1);
    assert.equal(compensated[0].entry.undoJournalId, 'partial-entry');
  });
});

test('a manifest-read race preserves external deletion and retains the original backup', async () => {
  await withTempRoot('jarvis-local-workflow-manifest-race-', async (root) => {
    await mkdir(join(root, 'outputs'), { recursive: true });
    await writeFile(join(root, 'outputs', 'existing.txt'), 'original', 'utf8');
    const specPath = await writeJson(join(root, 'manifest-race.workflow.json'), spec('manifest-race', [
      { id: 'existing', op: 'write.text', args: { path: 'outputs/existing.txt', text: 'replacement' } },
      { id: 'created', op: 'write.text', args: { path: 'outputs/created.txt', text: 'new-file' } }
    ]));
    class ManifestRaceAdapter extends LocalWorkflowToolAdapter {
      async buildManifest(publication) {
        await rm(publication.outputPaths[0], { force: true });
        return super.buildManifest(publication);
      }
    }
    const result = await new ManifestRaceAdapter({ allowedRoots: [root] }).execute({ specPath, allowOverwrite: true });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'WORKFLOW_POST_COMMIT_COMPENSATION_FAILED');
    assert.match(result.error.message, /current-version-conflict/);
    await assert.rejects(readFile(join(root, 'outputs', 'existing.txt')), error => error.code === 'ENOENT');
    await assert.rejects(readFile(join(root, 'outputs', 'created.txt')));
    assert.deepEqual(await readdir(join(root, 'outputs')), []);
    const stage = (await readdir(root)).find(name => name.startsWith('.jarvis-workflow-stage-'));
    assert.equal(await readFile(join(root, stage, 'backups/outputs/existing.txt'), 'utf8'), 'original');
  });
});

test('a staging cleanup fault after undo registration preserves successful commit semantics', async () => {
  await withTempRoot('jarvis-local-workflow-cleanup-fault-', async (root) => {
    await mkdir(join(root, 'outputs'), { recursive: true });
    await writeFile(join(root, 'outputs', 'existing.txt'), 'original', 'utf8');
    const specPath = await writeJson(join(root, 'cleanup-fault.workflow.json'), spec('cleanup-fault', [
      { id: 'write', op: 'write.text', args: { path: 'outputs/existing.txt', text: 'committed' } }
    ]));
    const recorded = [];
    const undoJournal = { record: (entry) => { const value = { ...entry, undoJournalId: 'cleanup-undo' }; recorded.push(value); return value; } };
    class CleanupFaultAdapter extends LocalWorkflowToolAdapter {
      async cleanupStage() {
        const error = new Error('injected-cleanup-failure');
        error.code = 'EACCES';
        throw error;
      }
    }
    const result = await new CleanupFaultAdapter({ allowedRoots: [root], undoJournal }).execute({ specPath, allowOverwrite: true }, { taskId: 'cleanup-fault' });
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(await readFile(join(root, 'outputs', 'existing.txt'), 'utf8'), 'committed');
    assert.equal(recorded.length, 1);
    assert.equal(await readFile(recorded[0].backupPath, 'utf8'), 'original');
    assert.equal(result.undoJournalId, 'cleanup-undo');
    assert.equal(result.evidence.workflow.stagingCleanup.status, 'warning');
    assert.equal(result.evidence.workflow.stagingCleanup.errorCode, 'EACCES');
    assert.equal(result.warnings.length, 1);
  });
});

test('process retry and pipelines use only Node scripts under the allowed root and capture hashes', async () => {
  await withTempRoot('jarvis-local-workflow-process-', async (root) => {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'flaky.mjs'), "import{existsSync,mkdirSync,writeFileSync}from'node:fs';import{dirname,resolve}from'node:path';const p=resolve('outputs/marker.txt');if(!existsSync(p)){mkdirSync(dirname(p),{recursive:true});writeFileSync(p,'1');process.exit(7)}process.stdout.write('recovered')", 'utf8');
    await writeFile(join(root, 'scripts', 'upper.mjs'), "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s.toUpperCase()))", 'utf8');
    const specPath = await writeJson(join(root, 'process.workflow.json'), spec('process-safe', [
      { id: 'retry', op: 'process.run', retry: { maxAttempts: 2, backoffMs: 1 }, args: { scriptPath: 'scripts/flaky.mjs', timeoutMs: 3000 } },
      { id: 'pipe', op: 'process.pipeline', args: { stdin: 'hello', stages: [{ scriptPath: 'scripts/upper.mjs' }] } },
      { id: 'assert', op: 'assert.equals', dependsOn: ['pipe'], args: { actual: ref('pipe', '/stdout'), expected: 'HELLO' } },
      { id: 'write', op: 'write.json', dependsOn: ['retry', 'pipe', 'assert'], args: { path: 'outputs/process.json', value: ref('retry') } }
    ]));
    const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root] }).execute({ specPath });
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.workflowOutputs.retry.attempts, 2);
    assert.match(result.workflowOutputs.retry.stdoutSha256, /^[a-f0-9]{64}$/u);
    assert.equal(await readFile(join(root, 'outputs', 'marker.txt'), 'utf8'), '1');
  });
});

test('the Node permission boundary prevents an allowed script from writing outside staging', async () => {
  await withTempRoot('jarvis-local-workflow-process-guard-', async (root) => {
    const outside = join(tmpdir(), `jarvis-forbidden-${Date.now()}.txt`);
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'escape.mjs'), "import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],'forbidden')", 'utf8');
    const specPath = await writeJson(join(root, 'process-guard.workflow.json'), spec('process-guard', [
      { id: 'escape', op: 'process.run', args: { scriptPath: 'scripts/escape.mjs', args: [outside] } }
    ]));
    const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root] }).execute({ specPath });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'WORKFLOW_PROCESS_FAILED');
    await assert.rejects(readFile(outside));
  });
});

test('an obfuscated loopback socket attempt is denied at runtime before any connection', async () => {
  await withTempRoot('jarvis-local-workflow-network-guard-', async (root) => {
    const server = createServer();
    let connections = 0;
    server.on('connection', (socket) => { connections += 1; socket.destroy(); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const port = server.address().port;
      await mkdir(join(root, 'scripts'), { recursive: true });
      await writeFile(join(root, 'scripts', 'network.mjs'), `const moduleName=['node','net'].join(':');const network=await import(moduleName);try{await new Promise((ok,no)=>{const socket=network.createConnection({host:'127.0.0.1',port:${port}},ok);socket.on('error',no)})}catch{}process.stdout.write('caught')`, 'utf8');
      const specPath = await writeJson(join(root, 'network.workflow.json'), spec('network-block', [
        { id: 'network', op: 'process.run', args: { scriptPath: 'scripts/network.mjs', timeoutMs: 3000 } }
      ]));
      const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root] }).execute({ specPath });
      assert.equal(result.status, 'blocked');
      assert.equal(result.error.code, 'WORKFLOW_PROCESS_NETWORK_BLOCKED');
      assert.equal(connections, 0);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});

test('SQLite import, same-transaction staged upsert, and read-only query publish a real database', async () => {
  await withTempRoot('jarvis-local-workflow-sqlite-', async (root) => {
    const specPath = await writeJson(join(root, 'sqlite.workflow.json'), spec('sqlite-upsert', [
      { id: 'seed', op: 'sqlite.import', args: { databasePath: 'out/data.db', table: 'items', items: [{ id: 'a', value: 1 }, { id: 'b', value: 2 }], mode: 'replace', key: 'id' } },
      { id: 'upsert', op: 'sqlite.import', dependsOn: ['seed'], args: { databasePath: ref('seed', '/databasePath'), table: 'items', items: [{ id: 'b', value: 9 }, { id: 'c', value: 3 }], mode: 'upsert', key: 'id' } },
      { id: 'query', op: 'sqlite.query', dependsOn: ['upsert'], args: { databasePath: ref('upsert', '/databasePath'), sql: 'SELECT id, value FROM items ORDER BY id' } },
      { id: 'assert', op: 'assert.count', dependsOn: ['query'], args: { items: ref('query', '/items'), equals: 3 } },
      { id: 'write', op: 'write.json', dependsOn: ['query', 'assert'], args: { path: 'out/query.json', value: ref('query') } }
    ]));
    const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root] }).execute({ specPath });
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.deepEqual(JSON.parse(await readFile(join(root, 'out/query.json'), 'utf8')).items, [{ id: 'a', value: 1 }, { id: 'b', value: 9 }, { id: 'c', value: 3 }]);
    assert.equal((await readFile(join(root, 'out/data.db'))).subarray(0, 15).toString('ascii'), 'SQLite format 3');
  });
});

test('declared workflow outputs must be produced by the declared node', async () => {
  await withTempRoot('jarvis-local-workflow-declared-output-', async (root) => {
    const workflow = spec('declared-output-binding', [
      { id: 'write-actual', op: 'write.text', args: { path: 'outputs/actual.txt', text: 'actual' } },
      { id: 'other-node', op: 'assert.equals', args: { actual: 1, expected: 1 } }
    ]);
    workflow.outputs = [{ nodeId: 'other-node', path: 'outputs/actual.txt', mediaType: 'text/plain' }];
    const specPath = await writeJson(join(root, 'declared-output.workflow.json'), workflow);

    const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root] }).execute({ specPath });

    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'WORKFLOW_DECLARED_OUTPUT_MISMATCH');
    await assert.rejects(readFile(join(root, 'outputs', 'actual.txt')), { code: 'ENOENT' });
  });
});

test('workflow property paths cannot traverse inherited prototype properties', async () => {
  await withTempRoot('jarvis-local-workflow-property-path-', async (root) => {
    const specPath = await writeJson(join(root, 'unsafe-property.workflow.json'), spec('unsafe-property', [
      { id: 'filter', op: 'data.filter', args: { items: [{ id: 1 }], field: 'constructor.name', operator: 'eq', value: 'Object' } }
    ]));

    const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root] }).execute({ specPath });

    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'WORKFLOW_PROPERTY_PATH_UNSAFE');
  });
});

test('workflow rejects output paths that alias on a case-insensitive filesystem', { skip: process.platform !== 'win32' }, async () => {
  await withTempRoot('jarvis-local-workflow-case-alias-', async (root) => {
    const specPath = await writeJson(join(root, 'case-alias.workflow.json'), spec('case-alias', [
      { id: 'upper', op: 'write.text', args: { path: 'outputs/Result.txt', text: 'upper' } },
      { id: 'lower', op: 'write.text', args: { path: 'outputs/result.txt', text: 'lower' } }
    ]));

    const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root] }).execute({ specPath });

    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'WORKFLOW_OUTPUT_DUPLICATE');
    await assert.rejects(readFile(join(root, 'outputs', 'Result.txt')), { code: 'ENOENT' });
  });
});

test('schedule rejects non-integer resources and negative durations', async () => {
  await withTempRoot('jarvis-local-workflow-schedule-validation-', async (root) => {
    const badResources = await writeJson(join(root, 'bad-resources.workflow.json'), spec('bad-resources', [
      { id: 'schedule', op: 'solver.schedule', args: { resources: 'many', tasks: [{ id: 'a', duration: 1 }] } }
    ]));
    const badDuration = await writeJson(join(root, 'bad-duration.workflow.json'), spec('bad-duration', [
      { id: 'schedule', op: 'solver.schedule', args: { resources: 1, tasks: [{ id: 'a', duration: -1 }] } }
    ]));
    const adapter = new LocalWorkflowToolAdapter({ allowedRoots: [root] });

    assert.equal((await adapter.execute({ specPath: badResources })).error.code, 'WORKFLOW_SCHEDULE_RESOURCE_COUNT_INVALID');
    assert.equal((await adapter.execute({ specPath: badDuration })).error.code, 'WORKFLOW_SCHEDULE_DURATION_INVALID');
  });
});

test('SQLite upsert preserves rows from a database published by an earlier workflow', async () => {
  await withTempRoot('jarvis-local-workflow-sqlite-existing-', async (root) => {
    const initialSpec = await writeJson(join(root, 'sqlite-initial.workflow.json'), spec('sqlite-initial', [
      { id: 'seed', op: 'sqlite.import', args: { databasePath: 'out/data.db', table: 'items', items: [{ id: 'a', value: 1 }, { id: 'b', value: 2 }], mode: 'replace', key: 'id' } }
    ]));
    const updateSpec = await writeJson(join(root, 'sqlite-update.workflow.json'), spec('sqlite-update', [
      { id: 'upsert', op: 'sqlite.import', args: { databasePath: 'out/data.db', table: 'items', items: [{ id: 'b', value: 9 }, { id: 'c', value: 3 }], mode: 'upsert', key: 'id' } },
      { id: 'query', op: 'sqlite.query', dependsOn: ['upsert'], args: { databasePath: ref('upsert', '/databasePath'), sql: 'SELECT id, value FROM items ORDER BY id' } },
      { id: 'write', op: 'write.json', dependsOn: ['query'], args: { path: 'out/query.json', value: ref('query') } }
    ]));
    const adapter = new LocalWorkflowToolAdapter({ allowedRoots: [root] });

    assert.equal((await adapter.execute({ specPath: initialSpec })).status, 'success');
    const updated = await adapter.execute({ specPath: updateSpec, allowOverwrite: true });

    assert.equal(updated.status, 'success', JSON.stringify(updated));
    assert.deepEqual(JSON.parse(await readFile(join(root, 'out/query.json'), 'utf8')).items, [
      { id: 'a', value: 1 },
      { id: 'b', value: 9 },
      { id: 'c', value: 3 }
    ]);
  });
});

test('all 30 frozen impossible-command workflows execute and pass their independent semantic oracle', { timeout: 120_000 }, async () => {
  await withTempRoot('jarvis-local-workflow-corpus-', async (root) => {
    const failures = [];
    for (const testCase of impossibleWorkflow30Cases) {
      const caseDir = join(root, testCase.id);
      const fixture = await materializeImpossibleWorkflow30Fixture(testCase, caseDir);
      const result = await new LocalWorkflowToolAdapter({ allowedRoots: [caseDir] }).execute({ specPath: fixture.specPath });
      const oracle = result.status === 'success' ? await verifyImpossibleWorkflow30Case(testCase.id, caseDir) : null;
      if (result.status !== 'success' || oracle?.passed !== true) failures.push({ id: testCase.id, result, oracle });
    }
    assert.deepEqual(failures, []);
  });
});
