import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, createReadStream, openSync, writeSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm, truncate } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureMissionActionOperation, checkpointMissionActionDispatch, createMissionActionRecovery,
  DEFAULT_MISSION_RECOVERY_READ_CHUNK_BYTES } from '../../packages/core/src/mission/mission-action-recovery.js';
import { ExecutionResultVerifier } from '../../apps/verification/src/verification-runtime.js';
import { ActionType, ModuleId, TaskStatus } from '../../packages/shared/src/types.js';

const adapterVersion = 'jarvis-recovery-comparison-adapter-v1';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const scenarioNames = new Set([
  'completed-core', 'durable-remote', 'never-dispatched', 'missing-receipt', 'receipt-unavailable',
  'changed-artifact', 'deleted-artifact', 'wrong-task', 'dry-run', 'verification-failed',
  'verification-unavailable', 'external-transfer', 'multi-action', 'changed-roots', 'changed-command',
  'missing-file-evidence', 'duplicate-file-evidence', 'read-input-changed',
  'hash-empty', 'hash-small', 'hash-boundary', 'hash-large', 'hash-tail-mismatch',
  'hash-over-budget', 'hash-input-evidence', 'hash-mutation-during-read'
]);
const digest = value => createHash('sha256').update(value).digest('hex');
async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const errorWithCode = code => Object.assign(new Error(code), { code });

function validateArm(arm) {
  if (!['current', 'reference-64k', 'buffered-read', 'negative-control'].includes(arm)) throw errorWithCode('RECOVERY_COMPARISON_ARM_INVALID');
}

function scenarioName(scenario) {
  // The adapter reads stimulus identity only. Expected outcomes belong to the
  // independently authored evaluator and must never influence execution here.
  const name = typeof scenario === 'string' ? scenario : scenario?.scenario ?? scenario?.kind ?? scenario?.id;
  if (!scenarioNames.has(name)) throw errorWithCode('RECOVERY_COMPARISON_SCENARIO_INVALID');
  return name;
}

export async function candidateIdentity(arm = 'current') {
  validateArm(arm);
  const paths = [
    'scripts/lib/recovery-comparison-adapter.mjs',
    'packages/core/src/mission/mission-action-recovery.js',
    'apps/verification/src/verification-runtime.js',
    'packages/shared/src/types.js'
  ];
  const sourceFiles = await Promise.all(paths.map(async path => ({ path, sha256: digest(await readFile(join(repositoryRoot, path))) })));
  return {
    adapterVersion, arm, sourceFiles, sourceCoverage: 'direct-adapter-recovery-verifier-and-contract-files',
    sha256: digest(JSON.stringify({ adapterVersion, arm, sourceFiles })),
    negativeControl: arm === 'negative-control', productOptimizationCandidate: arm === 'buffered-read',
    readChunkBytes: arm === 'buffered-read' ? 1024 * 1024 : arm === 'reference-64k' ? 64 * 1024 : DEFAULT_MISSION_RECOVERY_READ_CHUNK_BYTES,
    role: arm === 'buffered-read' ? 'bounded-1mib-file-read-candidate' : arm === 'negative-control'
      ? 'deliberately-invalid-evaluator-sensitivity-control' : arm === 'reference-64k' ? '64kib-reference' : 'current-product-default'
  };
}

async function removeFixture(directory) {
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('jarvis-recovery-comparison-')) {
    throw errorWithCode('RECOVERY_COMPARISON_CLEANUP_OUTSIDE_TEMP');
  }
  await rm(target, { recursive: true, force: true });
}

function fixturePath(directory, ...parts) {
  const path = resolve(directory, ...parts);
  const suffix = relative(resolve(directory), path);
  if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`) || resolve(directory, suffix) !== path) {
    throw errorWithCode('RECOVERY_COMPARISON_PATH_INVALID');
  }
  return path;
}

export async function evaluateRecoveryScenario({ scenario, arm = 'current' } = {}) {
  validateArm(arm);
  const name = scenarioName(scenario);
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-recovery-comparison-'));
  const calls = { runTask: 0, receiveExecutionPacket: 0, taskLookup: 0, receiptLookup: 0, verification: 0 };
  const limitations = [
    'Each case uses a new temporary workspace, synthetic task/receipt metadata, and real local fixture files.',
    'The production recovery function and independent G ExecutionResultVerifier run; no full Core, B service, policy approval, F memory, or personal profile is loaded.',
    'Remote receipt behavior is represented by a local durable JSON fixture, not an actual remote PC service or process crash.',
    'No model, network, external transfer, or real user task is executed; timing includes fixture preparation and cleanup.',
    'Dispatch methods are throwing spies: duplicateExecutionCount counts attempted redispatches, not completed duplicate side effects.'
  ];
  if (name === 'verification-unavailable') limitations.push('The unavailable G transport is an explicitly injected exception; this case does not call the G verifier.');
  if (name === 'receipt-unavailable') limitations.push('Receipt transport unavailability is an explicitly injected exception.');
  if (arm === 'negative-control') limitations.push('NEGATIVE CONTROL ONLY: a blocked product result is deliberately relabeled recovered; this is not an optimization candidate and executes no tools.');
  let verificationSummary = { implementation: 'ExecutionResultVerifier', stub: false, checkCount: 0, failedCheckIds: [] };
  try {
    const workspace = fixturePath(directory, 'workspace');
    await mkdir(workspace);
    const inputPath = fixturePath(directory, 'workspace', 'input.txt');
    const outputPath = fixturePath(directory, 'workspace', 'output.txt');
    const sizes = { 'hash-empty': 0, 'hash-small': 4096, 'hash-boundary': 1024 * 1024 + 17,
      'hash-large': 16 * 1024 * 1024, 'hash-tail-mismatch': 1024 * 1024 + 17,
      'hash-over-budget': 129 * 1024 * 1024, 'hash-input-evidence': 2 * 1024 * 1024,
      'hash-mutation-during-read': 4 * 1024 * 1024 };
    const fixtureSize = sizes[name];
    const reading = ['read-input-changed', 'hash-input-evidence', 'hash-mutation-during-read', 'hash-over-budget'].includes(name);
    const toolName = reading ? 'filesystem.readText' : 'filesystem.createTextFile';
    const taskId = 'recovery-comparison-task';
    const missionId = 'recovery-comparison-mission';
    const content = name === 'hash-empty' ? ''
      : fixtureSize !== undefined && name !== 'hash-over-budget' ? 'a'.repeat(fixtureSize)
        : 'Synthetic published output for recovery evaluation.\n';
    await writeFile(inputPath, 'Synthetic input before recovery.\n', { flag: 'wx' });
    if (['hash-input-evidence', 'hash-mutation-during-read'].includes(name)) await writeFile(inputPath, content);
    if (name === 'hash-over-budget') await truncate(inputPath, fixtureSize);
    const inputSha256 = await digestFile(inputPath);
    if (!reading && name !== 'never-dispatched') await writeFile(outputPath, content, { flag: 'wx' });
    const outputs = reading || name === 'never-dispatched' ? [] : [outputPath];
    const files = await Promise.all(outputs.map(async path => ({ path,
      sha256: await digestFile(path) })));
    if (reading) files.push({ path: inputPath, sha256: inputSha256 });
    const profile = { readOnly: reading, mutatesSystem: !reading, externalTransfer: name === 'external-transfer' };
    const taskAction = {
      toolName, actionType: reading ? ActionType.SEARCH_FILES : ActionType.CREATE_FILE,
      arguments: reading ? { path: inputPath, maxChars: 1000 } : { path: outputPath,
        content: typeof content === 'string' ? content : '[synthetic binary fixture]' }
    };
    const action = {
      actionId: 'recovery-comparison-action', taskId, actualToolName: toolName, expectedToolName: toolName,
      command: reading ? 'input.txt 파일을 읽어줘' : 'output.txt 테스트 파일을 만들어줘',
      arguments: structuredClone(taskAction.arguments), attempts: name === 'never-dispatched' ? 0 : 1
    };
    const task = { taskId, status: TaskStatus.COMPLETED, plan: { action: taskAction } };
    const receipt = {
      taskId, status: TaskStatus.COMPLETED,
      executionResult: {
        taskId, packetId: 'synthetic-recovery-packet', status: 'success', success: true,
        startedAt: '2026-09-15T00:00:00.000Z', finishedAt: '2026-09-15T00:00:01.000Z',
        executedBy: { module: ModuleId.PC_AGENT, toolName }, outputPaths: outputs,
        rollbackAvailable: !reading, ...(reading ? { readOnly: true, contentSha256: inputSha256 } : { undoJournalId: 'synthetic-undo-record' }),
        safety: { adapterContract: { toolName, readOnly: reading, rollback: !reading, evidence: ['files', 'sha256'] } }
      },
      evidence: { evidenceId: 'synthetic-recovery-evidence', taskId, status: 'success', outputPaths: outputs,
        files, shadow: { expectedChangesCount: reading ? 0 : 1 } }
    };
    const verifier = new ExecutionResultVerifier();
    const noRedispatch = method => async () => { calls[method]++; throw errorWithCode('RECOVERY_COMPARISON_REDISPATCH_ATTEMPTED'); };
    const receiptPath = fixturePath(directory, 'receipt.json');
    const executor = {
      receiveExecutionPacket: noRedispatch('receiveExecutionPacket'),
      async taskResult() {
        calls.receiptLookup++;
        if (name === 'receipt-unavailable') throw errorWithCode('SYNTHETIC_RECEIPT_TRANSPORT_UNAVAILABLE');
        if (name === 'missing-receipt') return { error: { code: 'B_TASK_NOT_FOUND' } };
        return JSON.parse(await readFile(receiptPath, 'utf8'));
      }
    };
    const worker = {
      pcAgent: executor, runTask: noRedispatch('runTask'),
      actionNodesForTask: () => name === 'multi-action' ? [{ nodeId: 'first' }, { nodeId: 'second' }] : [{ nodeId: 'only' }],
      async verifyExecution(recoveredTask, execution) {
        calls.verification++;
        if (name === 'verification-unavailable') throw errorWithCode('SYNTHETIC_G_TRANSPORT_UNAVAILABLE');
        const checks = await verifier.verify({ executionResult: execution.executionResult, evidence: execution.evidence });
        const failed = checks.filter(check => check.status === 'failed');
        verificationSummary = { implementation: 'ExecutionResultVerifier', stub: false, checkCount: checks.length, failedCheckIds: failed.map(check => check.checkId) };
        return { verificationId: 'synthetic-recovery-verification', taskId: recoveredTask.taskId,
          status: failed.length ? 'failed' : 'passed', checks };
      }
    };
    ensureMissionActionOperation(missionId, action, [workspace]);
    if (name !== 'never-dispatched') checkpointMissionActionDispatch(action, task, worker, profile, '2026-09-15T00:00:00.000Z');
    const checkpointPath = fixturePath(directory, 'checkpoint.json');
    await writeFile(checkpointPath, JSON.stringify(action), { flag: 'wx' });
    const restoredAction = JSON.parse(await readFile(checkpointPath, 'utf8'));

    // These mutations define the stimulus; no expected status/error is selected.
    if (name === 'changed-artifact') await writeFile(outputPath, 'Changed after receipt was recorded.\n');
    if (name === 'deleted-artifact') await unlink(outputPath);
    if (name === 'wrong-task') receipt.executionResult.taskId = 'unrelated-task';
    if (name === 'dry-run') receipt.executionResult.dryRun = true;
    if (name === 'verification-failed') receipt.evidence.status = 'failed';
    if (name === 'changed-command') restoredAction.command = '변경된 명령으로 다른 파일을 만들어줘';
    if (name === 'missing-file-evidence') receipt.evidence.files = [];
    if (name === 'duplicate-file-evidence') receipt.evidence.files.push(structuredClone(receipt.evidence.files[0]));
    if (name === 'read-input-changed') await writeFile(inputPath, 'Changed input after the original read.\n');
    if (name === 'hash-tail-mismatch') {
      const changed = Buffer.from(content); changed[changed.length - 1] = 0x62;
      await writeFile(outputPath, changed);
    }
    await writeFile(receiptPath, JSON.stringify(receipt), { flag: 'wx' });
    task.executionResult = receipt;
    const coreFacade = { getTask() { calls.taskLookup++; return name === 'completed-core' ? structuredClone(task) : undefined; } };
    let allowedRoots = [workspace];
    if (name === 'changed-roots') {
      const changedRoot = fixturePath(directory, 'different-workspace');
      await mkdir(changedRoot);
      allowedRoots = [changedRoot];
    }
    const ioMetrics = { readCalls: 0, bytesRead: 0, maxRequestedBytes: 0,
      configuredChunkBytes: arm === 'buffered-read' ? 1024 * 1024 : arm === 'reference-64k' ? 64 * 1024 : DEFAULT_MISSION_RECOVERY_READ_CHUNK_BYTES };
    let mutatedDuringRead = false;
    let mutationBytesWritten = 0;
    const recover = createMissionActionRecovery({ readChunkBytes: ioMetrics.configuredChunkBytes,
      onFileRead: ({ bytesRead, requestedBytes }) => {
        ioMetrics.readCalls++; ioMetrics.bytesRead += bytesRead;
        ioMetrics.maxRequestedBytes = Math.max(ioMetrics.maxRequestedBytes, requestedBytes);
        if (name === 'hash-mutation-during-read' && bytesRead > 0 && !mutatedDuringRead) {
          mutatedDuringRead = true;
          const mutationHandle = openSync(inputPath, 'r+');
          try { mutationBytesWritten = writeSync(mutationHandle, Buffer.from([0x62]), 0, 1, fixtureSize - 1); }
          finally { closeSync(mutationHandle); }
          appendFileSync(inputPath, '!');
        }
      } });
    let outcome;
    const recoveryStart = performance.now();
    try { outcome = await recover({ missionId, action: restoredAction, allowedRoots, coreFacade, worker, pcAgent: executor }); }
    catch (error) { outcome = { status: 'error', error: { code: error.code ?? 'RECOVERY_COMPARISON_UNEXPECTED_ERROR' } }; }
    const recoveryElapsedMs = performance.now() - recoveryStart;
    const rawStatus = outcome.status;
    // This deliberate invalid result mutation exists only to prove the evaluator
    // rejects false successes. It is never installed in the product recovery path.
    const overridden = arm === 'negative-control' && rawStatus === 'blocked';
    return {
      adapterVersion, scenario: name, arm, status: overridden ? 'recovered' : rawStatus,
      errorCode: overridden ? null : outcome.error?.code ?? null,
      duplicateExecutionCount: calls.runTask + calls.receiveExecutionPacket,
      metrics: { externalModelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costBasis: 'local-no-model' },
      ioMetrics, recoveryElapsedMs,
      negativeControl: arm === 'negative-control', productOptimizationCandidate: arm === 'buffered-read',
      controlMutationApplied: overridden, observedProductStatus: rawStatus, source: outcome.source ?? null,
      evidence: { realFixtureFiles: true, persistedCheckpointRead: true, fixtureReceipts: true,
        runTask: calls.runTask, receiveExecutionPacket: calls.receiveExecutionPacket,
        taskLookup: calls.taskLookup, receiptLookup: calls.receiptLookup,
        verificationCalls: calls.verification, verification: verificationSummary,
        ...(name === 'hash-mutation-during-read' ? { duringReadMutation: {
          applied: mutatedDuringRead, originalTailBytesWritten: mutationBytesWritten,
          appendedBytes: mutatedDuringRead ? 1 : 0
        } } : {}) },
      limitations
    };
  } finally { await removeFixture(directory); }
}
