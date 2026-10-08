import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { LocalWorkflowToolAdapter } from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';

async function withVerifiedRepeat(operation) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'jarvis-unchanged-publication-'));
  try {
    const undoEntries = [];
    const adapter = new LocalWorkflowToolAdapter({
      allowedRoots: [root],
      undoJournal: { record: (entry) => ({ ...entry, undoJournalId: `test_undo_${undoEntries.push(entry)}` }) }
    });
    const args = {
      workspaceRoot: root,
      spec: {
        schemaVersion: 'jarvis-local-workflow-v1', workflowId: 'unchanged-publication-proof',
        nodes: [
          { id: 'write-json', op: 'write.json', args: { path: 'result.json', value: [{ label: 'alpha', quantity: 2 }] } },
          { id: 'write-text', op: 'write.text', args: { path: 'note.txt', text: '확인된 동일 내용\n' } }
        ]
      }
    };
    const first = await adapter.execute(args, { taskId: 'first-publication' });
    assert.equal(first.status, 'success', JSON.stringify(first));
    assert.equal(undoEntries.length, 2);
    const repeated = await adapter.execute(args, { taskId: 'repeat-publication' });
    assert.equal(repeated.status, 'success', JSON.stringify(repeated));
    assert.equal(undoEntries.length, 2, 'unchanged outputs must not append fake undo entries');
    const files = [];
    for (const path of repeated.outputPaths) {
      const bytes = await readFile(path);
      files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const executionResult = {
      ...structuredClone(repeated), taskId: 'repeat-publication',
      startedAt: repeated.evidence.workflow.startedAt, finishedAt: repeated.evidence.workflow.endedAt,
      executedBy: { module: 'B_PC_AGENT', toolName: 'workflow.execute' }, readOnly: false,
      safety: { adapterContract: { toolName: 'workflow.execute', readOnly: false, rollback: true, evidence: ['workflow', 'manifest'], modes: ['shadow', 'execute'] } }
    };
    const evidence = {
      evidenceId: 'unchanged-publication-evidence', taskId: executionResult.taskId, status: 'success',
      outputPaths: [...executionResult.outputPaths], changedItems: structuredClone(executionResult.changedItems), files,
      undoJournalId: null, shadow: { expectedChangesCount: 2 },
      adapterEvidence: structuredClone(repeated.evidence),
      schemaValidation: { valid: true, schemaId: 'b-evidence-workflow.execute-v1', required: [], missing: [] }
    };
    const runtime = createAgRuntime({
      allowedRoots: [root], auditRoot: join(root, 'audit'),
      env: { JARVIS_TEST_MODE: '1' }, taskEnv: { JARVIS_TEST_MODE: '1' }, workerDaemonEnabled: false
    });
    let sequence = 0;
    const verify = (target) => runtime.verificationRuntime.verifyExecution({
      verificationId: `unchanged-verification-${++sequence}`, taskId: target.executionResult.taskId, target
    });
    await operation({ target: { executionResult, evidence }, first, verify });
  } finally {
    const inside = relative(parent, resolve(root));
    assert.ok(inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
    await rm(root, { recursive: true, force: true });
  }
}

function mutateProof(target, mutation) {
  mutation(target.executionResult.evidence.workflow.publication);
  target.evidence.adapterEvidence.workflow.publication = structuredClone(target.executionResult.evidence.workflow.publication);
}
function assertUndoRequired(report, label) {
  assert.equal(report.status, 'failed', `${label}: ${JSON.stringify(report)}`);
  assert.equal(report.checks.some((check) => check.checkId === 'workflow_unchanged_publication_verified' && check.status === 'passed'), false, label);
  assert.equal(report.checks.find((check) => check.checkId === 'undo_journal_present')?.status, 'failed', label);
  assert.equal(report.checks.find((check) => check.checkId === 'rollback_available')?.status, 'failed', label);
}

test('a real repeated workflow publishes unchanged proof and G passes without inventing undo or rollback', async () => {
  await withVerifiedRepeat(async ({ target, first, verify }) => {
    const proof = target.executionResult.evidence.workflow.publication;
    assert.equal(first.evidence.workflow.publication.changedFileCount, 2);
    assert.equal(proof.version, 'workflow-publication-v1');
    assert.equal(proof.changedFileCount, 0);
    assert.equal(proof.unchangedFileCount, 2);
    assert.equal(proof.files.length, 2);
    assert.ok(proof.files.every((file) => file.existedBefore === true && file.changed === false && file.beforeSha256 === file.afterSha256));
    assert.equal(target.executionResult.undoJournalId, null);
    assert.equal(target.executionResult.rollbackAvailable, false);
    assert.ok(target.executionResult.changedItems.every((item) => item.type === 'unchanged_file'));
    const report = await verify(target);
    assert.equal(report.status, 'passed', JSON.stringify(report));
    assert.equal(report.checks.find((check) => check.checkId === 'workflow_unchanged_publication_verified')?.status, 'passed');
    assert.equal(report.checks.some((check) => ['undo_journal_present', 'rollback_available'].includes(check.checkId)), false);
    for (const checkId of ['workflow_artifact_manifest_bound', 'workflow_node_receipts_complete', 'workflow_capability_package_verifier_passed']) {
      assert.equal(report.checks.find((check) => check.checkId === checkId)?.status, 'passed', checkId);
    }
  });
});

test('changed, corrupt, empty and miscounted publication proofs cannot waive undo', async () => {
  const mutations = [
    ['wrong version', (proof) => { proof.version = 'unknown'; }],
    ['changed count', (proof) => { proof.changedFileCount = 1; }],
    ['unchanged count', (proof) => { proof.unchangedFileCount = 1; }],
    ['empty files', (proof) => { proof.files = []; }],
    ['changed flag', (proof) => { proof.files[0].changed = true; }],
    ['new file', (proof) => { proof.files[0].existedBefore = false; }],
    ['before hash', (proof) => { proof.files[0].beforeSha256 = '0'.repeat(64); }],
    ['after hash', (proof) => { proof.files[0].afterSha256 = '0'.repeat(64); }],
    ['both forged hashes', (proof) => { proof.files[0].beforeSha256 = '0'.repeat(64); proof.files[0].afterSha256 = '0'.repeat(64); }],
    ['wrong size', (proof) => { proof.files[0].size += 1; }],
    ['duplicate proof paths', (proof) => { proof.files[1] = structuredClone(proof.files[0]); }]
  ];
  await withVerifiedRepeat(async ({ target, verify }) => {
    for (const [label, mutation] of mutations) {
      const changed = structuredClone(target);
      mutateProof(changed, mutation);
      assertUndoRequired(await verify(changed), label);
    }
  });
});

test('missing publication and changed execution items keep the existing undo requirements', async () => {
  await withVerifiedRepeat(async ({ target, verify }) => {
    const missing = structuredClone(target);
    delete missing.executionResult.evidence.workflow.publication;
    delete missing.evidence.adapterEvidence.workflow.publication;
    assertUndoRequired(await verify(missing), 'missing proof');
    for (const mutate of [
      (result) => { result.changedItems[0].type = 'create_file'; },
      (result) => { result.changedItems[0].sha256 = '0'.repeat(64); },
      (result) => { result.changedItems[0].size += 1; },
      (result) => { result.changedItems = []; },
      (result) => { result.changedItems[1] = structuredClone(result.changedItems[0]); },
      (result) => { result.outputPaths = []; }
    ]) {
      const changed = structuredClone(target);
      mutate(changed.executionResult);
      assertUndoRequired(await verify(changed), 'execution item mutation');
    }
  });
});

test('unchanged proof still requires matching file evidence, a manifest and complete node receipts', async () => {
  await withVerifiedRepeat(async ({ target, verify }) => {
    for (const mutate of [
      (value) => { value.evidence.files = []; },
      (value) => { value.evidence.files[0].sha256 = '0'.repeat(64); },
      (value) => { value.evidence.files[0].size += 1; },
      (value) => { value.executionResult.evidence.manifest = []; value.evidence.adapterEvidence.manifest = []; },
      (value) => { value.executionResult.evidence.workflow.receipts = []; value.evidence.adapterEvidence.workflow.receipts = []; },
      (value) => { value.executionResult.evidence.manifest[0].sha256 = '0'.repeat(64); value.evidence.adapterEvidence.manifest[0].sha256 = '0'.repeat(64); }
    ]) {
      const changed = structuredClone(target);
      mutate(changed);
      const report = await verify(changed);
      assert.equal(report.status, 'failed', JSON.stringify(report));
      assert.ok(report.checks.some((check) => check.status === 'failed' && ['workflow_artifact_manifest_bound', 'workflow_node_receipts_complete', 'workflow_capability_package_verifier_passed'].includes(check.checkId)), JSON.stringify(report));
    }
  });
});

test('a non-workflow tool cannot copy unchanged workflow proof to bypass its undo contract', async () => {
  await withVerifiedRepeat(async ({ target, verify }) => {
    const changed = structuredClone(target);
    changed.executionResult.executedBy.toolName = 'filesystem.createTextFile';
    changed.executionResult.safety.adapterContract.toolName = 'filesystem.createTextFile';
    assertUndoRequired(await verify(changed), 'non-workflow proof reuse');
  });
});
