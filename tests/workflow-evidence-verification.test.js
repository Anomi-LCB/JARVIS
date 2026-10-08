import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionResultVerifier, VerificationRuntime } from '../apps/verification/src/verification-runtime.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { ModuleId } from '../packages/shared/src/types.js';

function executionResult(toolName) {
  return {
    taskId: `task_${toolName}`,
    startedAt: '2026-09-06T00:00:00.000Z',
    finishedAt: '2026-09-06T00:00:01.000Z',
    executedBy: { module: ModuleId.PC_AGENT, toolName },
    rollbackAvailable: false,
    readOnly: true,
    outputPaths: [],
    changedItems: [],
    safety: {
      adapterContract: {
        toolName,
        readOnly: true,
        rollback: false,
        evidence: ['result'],
        modes: ['shadow', 'execute']
      }
    }
  };
}

function evidence(taskId, schemaValidation) {
  const value = {
    evidenceId: `evidence_${taskId}`,
    taskId,
    status: 'success',
    outputPaths: [],
    shadow: { expectedChangesCount: 0 }
  };
  if (schemaValidation !== undefined) value.schemaValidation = schemaValidation;
  return value;
}

function workflowVerificationTarget(outputPath, bytes) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const workflow = {
    schemaVersion: 'jarvis-local-workflow-v1',
    workflowId: 'package-verifier-integration',
    specSha256: 'a'.repeat(64),
    nodeCount: 1,
    receipts: [{ nodeId: 'write', status: 'success', resultSha256: 'b'.repeat(64) }]
  };
  const manifest = [{ path: outputPath, sha256, size: bytes.length }];
  const result = executionResult('workflow.execute');
  result.outputPaths = [outputPath];
  result.evidence = {
    workflow: structuredClone(workflow),
    manifest: structuredClone(manifest)
  };
  return {
    executionResult: result,
    evidence: {
      evidenceId: 'evidence_package_verifier_integration',
      taskId: result.taskId,
      status: 'success',
      outputPaths: [outputPath],
      changedItems: [],
      files: [{ path: outputPath, sha256, size: bytes.length }],
      undoJournalId: null,
      shadow: { expectedChangesCount: 0 },
      adapterEvidence: {
        workflow: structuredClone(workflow),
        manifest: structuredClone(manifest)
      },
      schemaValidation: {
        valid: true,
        schemaId: 'b-evidence-workflow.execute-v1',
        required: [],
        missing: []
      }
    }
  };
}

test('legacy non-workflow evidence without schema metadata remains compatible', async () => {
  const result = executionResult('desktop.control');
  const checks = await new ExecutionResultVerifier().verify({
    executionResult: result,
    evidence: evidence(result.taskId)
  });

  assert.equal(checks.some((check) => check.checkId === 'execution_evidence_schema_valid'), false);
  assert.equal(checks.some((check) => check.checkId.startsWith('workflow_capability_package_')), false);
});

test('workflow evidence fails closed when schema metadata is missing', async () => {
  const result = executionResult('workflow.execute');
  const checks = await new ExecutionResultVerifier().verify({
    executionResult: result,
    evidence: evidence(result.taskId)
  });
  const schemaCheck = checks.find((check) => check.checkId === 'execution_evidence_schema_valid');

  assert.equal(schemaCheck?.status, 'failed');
  assert.equal(schemaCheck?.severity, 'critical');
});

test('workflow evidence honors an explicit schema validation result', async () => {
  const verifier = new ExecutionResultVerifier();
  const result = executionResult('workflow.execute');
  const passed = await verifier.verify({
    executionResult: result,
    evidence: evidence(result.taskId, { valid: true, schemaId: 'b-evidence-workflow.execute-v1', required: [], missing: [] })
  });
  const failed = await verifier.verify({
    executionResult: result,
    evidence: evidence(result.taskId, { valid: false, schemaId: 'b-evidence-workflow.execute-v1', required: ['adapterEvidence.workflow'], missing: ['adapterEvidence.workflow'] })
  });

  assert.equal(passed.find((check) => check.checkId === 'execution_evidence_schema_valid')?.status, 'passed');
  assert.equal(failed.find((check) => check.checkId === 'execution_evidence_schema_valid')?.status, 'failed');
});

test('VerificationRuntime fails closed when the workflow package verifier is missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-verifier-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, 'result.json');
  const bytes = Buffer.from('{"ok":true}\n');
  await writeFile(outputPath, bytes);
  const target = workflowVerificationTarget(outputPath, bytes);
  const runtime = new VerificationRuntime({ auditRoot: join(root, 'audit') });

  const report = await runtime.verifyExecution({
    verificationId: 'verification_missing_package_verifier',
    taskId: target.executionResult.taskId,
    target
  });

  assert.equal(report.status, 'failed');
  assert.equal(report.checks.find((check) => check.checkId === 'workflow_capability_package_verifier_bound')?.status, 'failed');
  assert.equal(report.checks.find((check) => check.checkId === 'workflow_capability_package_verifier_passed')?.status, 'failed');
});

test('createAgRuntime binds the active package verifier and rejects tampered workflow evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-verifier-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, 'result.json');
  const bytes = Buffer.from('{"ok":true}\n');
  await writeFile(outputPath, bytes);
  const runtime = createAgRuntime({
    allowedRoots: [root],
    auditRoot: join(root, 'audit'),
    env: { JARVIS_TEST_MODE: '1' },
    taskEnv: { JARVIS_TEST_MODE: '1' },
    workerDaemonEnabled: false
  });
  const target = workflowVerificationTarget(outputPath, bytes);

  const valid = await runtime.verificationRuntime.verifyExecution({
    verificationId: 'verification_active_package_verifier',
    taskId: target.executionResult.taskId,
    target
  });
  const bound = valid.checks.find((check) => check.checkId === 'workflow_capability_package_verifier_bound');
  assert.equal(valid.status, 'passed');
  assert.equal(bound?.status, 'passed');
  assert.equal(bound?.severity, 'critical');
  assert.equal(bound?.evidence?.verifierId, 'g-local-workflow-proof-v1');
  assert.match(bound?.evidence?.verifierFingerprint, /^[a-f0-9]{64}$/u);
  assert.match(bound?.evidence?.packageDigest, /^[a-f0-9]{64}$/u);
  assert.equal(valid.checks.find((check) => check.checkId === 'workflow_capability_package_verifier_passed')?.status, 'passed');

  const tamperedTarget = structuredClone(target);
  tamperedTarget.evidence.adapterEvidence.workflow.receipts = [];
  const tampered = await runtime.verificationRuntime.verifyExecution({
    verificationId: 'verification_tampered_package_evidence',
    taskId: tamperedTarget.executionResult.taskId,
    target: tamperedTarget
  });
  assert.equal(tampered.status, 'failed');
  assert.equal(tampered.checks.find((check) => check.checkId === 'workflow_capability_package_verifier_bound')?.status, 'passed');
  assert.equal(tampered.checks.find((check) => check.checkId === 'workflow_capability_package_verifier_passed')?.status, 'failed');
  assert.equal(tampered.checks.find((check) => check.checkId === 'workflow_node_receipts_complete')?.status, 'passed');
});

test('workflow verification rejects duplicate receipt identities and duplicate manifest paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-verifier-duplicates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstPath = join(root, 'first.json');
  const secondPath = join(root, 'second.json');
  const firstBytes = Buffer.from('{"first":true}\n');
  const secondBytes = Buffer.from('{"second":true}\n');
  await writeFile(firstPath, firstBytes);
  await writeFile(secondPath, secondBytes);
  const runtime = createAgRuntime({
    allowedRoots: [root],
    auditRoot: join(root, 'audit'),
    env: { JARVIS_TEST_MODE: '1' },
    taskEnv: { JARVIS_TEST_MODE: '1' },
    workerDaemonEnabled: false
  });

  const duplicateReceipts = workflowVerificationTarget(firstPath, firstBytes);
  duplicateReceipts.executionResult.evidence.workflow.nodeCount = 2;
  duplicateReceipts.evidence.adapterEvidence.workflow.nodeCount = 2;
  duplicateReceipts.executionResult.evidence.workflow.receipts.push(structuredClone(duplicateReceipts.executionResult.evidence.workflow.receipts[0]));
  duplicateReceipts.evidence.adapterEvidence.workflow.receipts.push(structuredClone(duplicateReceipts.evidence.adapterEvidence.workflow.receipts[0]));
  const receiptReport = await runtime.verificationRuntime.verifyExecution({
    verificationId: 'verification_duplicate_receipts',
    taskId: duplicateReceipts.executionResult.taskId,
    target: duplicateReceipts
  });
  assert.equal(receiptReport.status, 'failed');
  assert.equal(receiptReport.checks.find((check) => check.checkId === 'workflow_capability_package_verifier_passed')?.status, 'failed');
  assert.equal(receiptReport.checks.find((check) => check.checkId === 'workflow_node_receipts_complete')?.status, 'failed');

  const duplicateManifest = workflowVerificationTarget(firstPath, firstBytes);
  duplicateManifest.executionResult.outputPaths.push(secondPath);
  duplicateManifest.evidence.outputPaths.push(secondPath);
  duplicateManifest.evidence.files.push({
    path: secondPath,
    sha256: createHash('sha256').update(secondBytes).digest('hex'),
    size: secondBytes.length
  });
  duplicateManifest.executionResult.evidence.manifest.push(structuredClone(duplicateManifest.executionResult.evidence.manifest[0]));
  duplicateManifest.evidence.adapterEvidence.manifest.push(structuredClone(duplicateManifest.evidence.adapterEvidence.manifest[0]));
  const manifestReport = await runtime.verificationRuntime.verifyExecution({
    verificationId: 'verification_duplicate_manifest',
    taskId: duplicateManifest.executionResult.taskId,
    target: duplicateManifest
  });
  assert.equal(manifestReport.status, 'failed');
  assert.equal(manifestReport.checks.find((check) => check.checkId === 'workflow_capability_package_verifier_passed')?.status, 'failed');
  assert.equal(manifestReport.checks.find((check) => check.checkId === 'workflow_artifact_manifest_bound')?.status, 'failed');
});
