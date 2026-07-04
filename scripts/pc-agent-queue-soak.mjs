import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { PcAgentServiceSupervisor } from '../apps/pc-agent/src/service-daemon.js';
import { ActionType } from '../packages/shared/src/types.js';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function hashJson(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function summarizeQueue(queue = {}) {
  return {
    total: queue.total ?? 0,
    queued: queue.queued ?? 0,
    running: queue.running ?? 0,
    retryScheduled: queue.retryScheduled ?? 0,
    succeeded: queue.succeeded ?? 0,
    quarantined: queue.quarantined ?? 0,
    ignored: queue.ignored ?? 0
  };
}

function containsQueueSoakRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"path"\s*:|"content"\s*:|"arguments"\s*:|"capabilityToken"\s*:|"allowedPaths"\s*:|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function check(checkId, passed, detail = {}) {
  return {
    checkId,
    status: passed ? 'pass' : 'fail',
    detail
  };
}

async function pathExists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export async function runPcAgentQueueSoak({
  reportPath = 'dist/pc-agent-queue-soak-report.json',
  labRoot = 'dist/pc-agent-queue-soak-lab',
  packetCount = 24,
  batchLimit = 6,
  maxCycles = 20
} = {}) {
  const generatedAt = new Date().toISOString();
  const safeRunId = generatedAt.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '');
  const runRoot = resolve(labRoot, safeRunId);
  const workspaceRoot = join(runRoot, 'workspace');
  const outputRoot = join(workspaceRoot, 'queue-soak-output');
  const auditRoot = join(runRoot, 'logs');
  await mkdir(outputRoot, { recursive: true });
  await mkdir(auditRoot, { recursive: true });

  const { policyRuntime, pcAgent } = createAgRuntime({
    allowedRoots: [workspaceRoot],
    auditRoot
  });

  const packetEvidence = [];
  for (let index = 0; index < packetCount; index += 1) {
    const taskId = `task_pc_queue_soak_${index}`;
    const packetId = `packet_pc_queue_soak_${index}`;
    const targetPath = join(outputRoot, `soak-${String(index).padStart(3, '0')}.txt`);
    const content = `queue-soak:${index}:${generatedAt}`;
    const action = {
      actionType: ActionType.CREATE_FILE,
      toolName: 'filesystem.createTextFile',
      skillId: 'jarvis.local.mvp'
    };
    const capabilityToken = policyRuntime.capabilities.issue({
      taskId,
      planId: `plan_pc_queue_soak_${index}`,
      approvalId: `approval_pc_queue_soak_${index}`,
      action,
      allowedPaths: [workspaceRoot]
    });
    const queued = pcAgent.queueExecutionPacket({
      taskId,
      packetId,
      capabilityToken,
      userConfirmation: { confirmed: true },
      action: {
        ...action,
        arguments: { path: targetPath, content }
      }
    });
    packetEvidence.push({
      taskIdHash: sha256(taskId),
      packetIdHash: sha256(packetId),
      queueIdHash: sha256(queued.queueId),
      targetPathHash: sha256(targetPath),
      contentHash: sha256(content),
      status: queued.status
    });
  }

  const firstQueued = [...pcAgent.executionQueue.items.values()][0]?.packet ?? null;
  const duplicate = firstQueued ? pcAgent.queueExecutionPacket(firstQueued) : null;
  const supervisor = new PcAgentServiceSupervisor({
    pcAgent,
    enabled: true,
    intervalMs: 50,
    batchLimit,
    maxConsecutiveFailures: 2,
    setTimer: () => 1,
    clearTimer: () => {}
  });

  const cycles = [];
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const tick = await supervisor.tick({ reason: `queue-soak-cycle-${cycle + 1}` });
    cycles.push({
      cycle: cycle + 1,
      success: tick.success === true,
      status: tick.status,
      processed: tick.drain?.processed ?? 0,
      watchdogStatus: tick.watchdog?.status ?? null,
      queue: summarizeQueue(tick.drain?.status ?? pcAgent.executionQueueStatus())
    });
    const queue = pcAgent.executionQueueStatus();
    if (queue.queued === 0 && queue.retryScheduled === 0 && queue.running === 0) break;
  }

  const outputChecks = [];
  for (let index = 0; index < packetCount; index += 1) {
    const targetPath = join(outputRoot, `soak-${String(index).padStart(3, '0')}.txt`);
    const expectedContent = `queue-soak:${index}:${generatedAt}`;
    const exists = await pathExists(targetPath);
    const content = exists ? await readFile(targetPath, 'utf8') : '';
    outputChecks.push({
      index,
      targetPathHash: sha256(targetPath),
      exists,
      contentHash: sha256(content),
      expectedContentHash: sha256(expectedContent),
      matched: exists && content === expectedContent
    });
  }

  const restored = createAgRuntime({
    allowedRoots: [workspaceRoot],
    auditRoot
  });
  const finalQueue = pcAgent.executionQueueStatus();
  const restoredQueue = restored.pcAgent.executionQueueStatus();
  const productGate = pcAgent.executionPacketProductGate();
  const cycleProcessedTotal = cycles.reduce((sum, cycle) => sum + cycle.processed, 0);
  const rawLeakProbe = {
    reportVersion: 'b-pc-agent-queue-soak-v1',
    packetEvidence,
    cycles,
    finalQueue: summarizeQueue(finalQueue),
    restoredQueue: summarizeQueue(restoredQueue),
    productGateHash: hashJson({
      productGateVersion: productGate.productGateVersion,
      status: productGate.status,
      checks: productGate.checks.map((item) => ({ checkId: item.checkId, passed: item.passed }))
    }),
    workspaceRootHash: sha256(workspaceRoot),
    auditRootHash: sha256(auditRoot),
    runRootHash: sha256(runRoot)
  };
  const checks = [
    check('queue_soak_packets_enqueued', packetEvidence.length === packetCount && packetEvidence.every((item) => item.status === 'queued'), {
      packetCount,
      queuedCount: packetEvidence.filter((item) => item.status === 'queued').length
    }),
    check('queue_soak_duplicate_suppressed', duplicate?.duplicate === true, {
      duplicate: duplicate?.duplicate === true
    }),
    check('queue_soak_supervisor_processed_all_packets', cycleProcessedTotal === packetCount, {
      packetCount,
      processed: cycleProcessedTotal,
      cycles: cycles.length
    }),
    check('queue_soak_final_queue_clean', finalQueue.queued === 0
      && finalQueue.retryScheduled === 0
      && finalQueue.running === 0
      && finalQueue.quarantined === 0
      && finalQueue.succeeded === packetCount, summarizeQueue(finalQueue)),
    check('queue_soak_outputs_verified', outputChecks.every((item) => item.matched), {
      expected: packetCount,
      matched: outputChecks.filter((item) => item.matched).length
    }),
    check('queue_soak_watchdog_remained_healthy', cycles.length > 0 && cycles.every((cycle) => cycle.watchdogStatus === 'healthy'), {
      watchdogStatuses: [...new Set(cycles.map((cycle) => cycle.watchdogStatus))]
    }),
    check('queue_soak_replay_restores_queue_state', restoredQueue.succeeded === packetCount && restoredQueue.queued === 0 && restoredQueue.quarantined === 0, summarizeQueue(restoredQueue)),
    check('queue_soak_execution_packet_product_gate_passed', productGate.status === 'passed'
      && productGate.checks.every((item) => item.passed), {
      productGateVersion: productGate.productGateVersion,
      status: productGate.status
    }),
    check('queue_soak_report_is_hash_only', containsQueueSoakRawLeak(rawLeakProbe) === false, {
      rawLeakDetected: containsQueueSoakRawLeak(rawLeakProbe)
    })
  ];
  const failed = checks.filter((item) => item.status === 'fail');
  const report = {
    reportVersion: 'b-pc-agent-queue-soak-v1',
    generatedAt,
    status: failed.length ? 'failed' : 'passed',
    mode: 'user-process-supervisor-queue-soak',
    parameters: {
      packetCount,
      batchLimit,
      maxCycles
    },
    summary: {
      processed: cycleProcessedTotal,
      cycles: cycles.length,
      finalQueue: summarizeQueue(finalQueue),
      restoredQueue: summarizeQueue(restoredQueue),
      productGateStatus: productGate.status,
      rawReportPathStored: false,
      rawFilePathStored: false,
      rawFileContentStored: false,
      rawCapabilityTokenStored: false
    },
    checks,
    packetEvidence,
    outputEvidence: outputChecks.map((item) => ({
      index: item.index,
      targetPathHash: item.targetPathHash,
      contentHash: item.contentHash,
      expectedContentHash: item.expectedContentHash,
      matched: item.matched
    })),
    cycles,
    productGate: {
      productGateVersion: productGate.productGateVersion,
      status: productGate.status,
      checks: productGate.checks.map((item) => ({ checkId: item.checkId, passed: item.passed }))
    },
    hashes: {
      runRootHash: sha256(runRoot),
      workspaceRootHash: sha256(workspaceRoot),
      auditRootHash: sha256(auditRoot),
      packetEvidenceHash: hashJson(packetEvidence),
      outputEvidenceHash: hashJson(outputChecks.map((item) => ({
        targetPathHash: item.targetPathHash,
        matched: item.matched
      }))),
      productGateHash: rawLeakProbe.productGateHash
    }
  };

  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output' || arg === '--json') args.reportPath = argv[++index];
    else if (arg === '--lab-root') args.labRoot = argv[++index];
    else if (arg === '--packets') args.packetCount = Number(argv[++index]);
    else if (arg === '--batch-limit') args.batchLimit = Number(argv[++index]);
    else if (arg === '--max-cycles') args.maxCycles = Number(argv[++index]);
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reportPath = parseArgs(process.argv.slice(2)).reportPath ?? 'dist/pc-agent-queue-soak-report.json';
  const report = await runPcAgentQueueSoak(parseArgs(process.argv.slice(2)));
  console.log(`# PC Agent queue soak: ${report.status}`);
  console.log(`Packets: ${report.parameters.packetCount}`);
  console.log(`Processed: ${report.summary.processed}`);
  console.log(`Report: ${resolve(reportPath)}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
