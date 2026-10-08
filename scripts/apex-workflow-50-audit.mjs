import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APEX_WORKFLOW_CORPUS_SHA256,
  APEX_WORKFLOW_CORPUS_VERSION,
  APEX_WORKFLOW_ISOLATION,
  APEX_WORKFLOW_SCENARIO_VERSION,
  APEX_WORKFLOW_SEED,
  APEX_WORKFLOW_VIRTUAL_CLOCK,
  apexCases,
  createApexWorkflowCorpusFingerprint,
  stableStringifyApexWorkflow
} from './apex-workflow-50-cases.mjs';
import {
  APEX_SCENARIO_ENGINE_VERSION,
  computeApexBehavioralDigest,
  computeApexSemanticDigest,
  runApexWorkflowCase
} from './apex-workflow-scenario-engine.mjs';
import { inventoryTree, manifestDigest } from './apex-workflow-artifacts.mjs';

export const APEX_WORKFLOW_AUDIT_VERSION = 'jarvis-apex-workflow-50-audit-v3';
export const APEX_WORKFLOW_LEDGER_VERSION = 'jarvis-apex-workflow-sequence-ledger-v3';
export const APEX_WORKFLOW_VARIATION_VERSION = 'jarvis-apex-cycle-variation-v2';
export const APEX_WORKFLOW_VARIATION_PROFILE_COUNT = 5;
export const APEX_WORKFLOW_COMPACTION_VERSION = 'jarvis-apex-compaction-seal-v2';
export const APEX_WORKFLOW_IMPLEMENTATION_MANIFEST_VERSION = 'jarvis-apex-implementation-manifest-v1';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = dirname(dirname(SCRIPT_PATH));
const IMPLEMENTATION_FILES = Object.freeze([
  { role: 'pc-agent-runtime', path: 'apps/pc-agent/src/pc-agent-runtime.js' },
  { role: 'policy-runtime', path: 'apps/policy-security/src/policy-runtime.js' },
  { role: 'apex-artifacts-wrapper', path: 'scripts/apex-workflow-artifacts.mjs' },
  { role: 'audit-runner', path: 'scripts/apex-workflow-50-audit.mjs' },
  { role: 'corpus', path: 'scripts/apex-workflow-50-cases.mjs' },
  { role: 'reverifier', path: 'scripts/apex-workflow-50-reverify.mjs' },
  { role: 'scenario-engine', path: 'scripts/apex-workflow-scenario-engine.mjs' },
  { role: 'artifact-implementation', path: 'scripts/extreme-workflow-artifacts.mjs' }
].sort((left, right) => left.path.localeCompare(right.path)));

export async function runApexWorkflowAudit(argv = []) {
  const options = parseArguments(argv);
  if (options.worker) return await runWorker(options);

  const runRoot = resolve(options.root ?? join(
    'artifacts',
    'apex-workflow-50-audit',
    new Date().toISOString().replace(/[:.]/gu, '-')
  ));
  const campaignPath = join(runRoot, 'campaign.json');
  const existingCampaign = options.resume && await pathExists(campaignPath)
    ? await readJson(campaignPath)
    : null;

  if (await pathExists(runRoot) && !options.resume) {
    const contents = await readdir(runRoot);
    if (contents.length > 0) {
      throw new Error(`Audit root already contains files: ${runRoot}. Use --resume or a new --root.`);
    }
  }

  const selected = existingCampaign
    ? selectResumeCases(existingCampaign, options)
    : selectCases(options.caseIds);
  const cycles = existingCampaign
    ? resolveResumeCycles(existingCampaign, options)
    : options.cycles;
  const fingerprint = createApexWorkflowCorpusFingerprint(selected);
  const canonicalCorpus = parseCanonicalCorpus(fingerprint);
  const cycleVariations = Array.from({ length: cycles }, (_, index) =>
    deriveApexCycleVariation(selected, index + 1, APEX_WORKFLOW_SEED));
  const implementationManifest = await createApexImplementationManifest();
  const retentionPolicy = existingCampaign
    ? resolveResumeRetentionPolicy(existingCampaign, options)
    : { compact: options.compact, keepWorkspacesThroughCycle: options.keepWorkspacesThroughCycle };

  let campaign;
  if (existingCampaign) {
    campaign = existingCampaign;
    await verifyResumeCampaign({ runRoot, campaign, selected, cycles, fingerprint, canonicalCorpus, cycleVariations, implementationManifest });
  } else {
    await mkdir(runRoot, { recursive: true });
    const campaignPayload = {
      auditVersion: APEX_WORKFLOW_AUDIT_VERSION,
      engineVersion: APEX_SCENARIO_ENGINE_VERSION,
      corpusVersion: APEX_WORKFLOW_CORPUS_VERSION,
      scenarioVersion: APEX_WORKFLOW_SCENARIO_VERSION,
      fullCorpusSha256: APEX_WORKFLOW_CORPUS_SHA256,
      selectedCorpusSha256: fingerprint.corpusSha256,
      seed: APEX_WORKFLOW_SEED,
      virtualClock: APEX_WORKFLOW_VIRTUAL_CLOCK,
      isolation: APEX_WORKFLOW_ISOLATION,
      cycles,
      selectedCaseIds: selected.map((item) => item.id),
      totalExecutions: selected.length * cycles,
      cycleVariations,
      retentionPolicy,
      implementationManifest,
      generatedAt: new Date().toISOString()
    };
    campaign = {
      ...campaignPayload,
      campaignSha256: sha256Json(campaignHashPayload(campaignPayload))
    };
    await atomicJson(campaignPath, campaign);
    await atomicJson(join(runRoot, 'corpus.json'), canonicalCorpus);
    await writeFile(join(runRoot, 'commands.md'), renderCommands(selected), 'utf8');
  }

  console.log(`APEX_AUDIT_ROOT ${runRoot}`);
  console.log(`CORPUS_SHA256 ${fingerprint.corpusSha256}`);
  console.log(`EXECUTIONS ${campaign.totalExecutions}`);

  const ledgerPath = join(runRoot, 'sequence-ledger.jsonl');
  if (!options.resume) await rm(ledgerPath, { force: true });
  const existingLedger = options.resume
    ? await readAndVerifyLedger(ledgerPath, campaign)
    : [];
  const plan = buildExecutionPlan(selected, cycleVariations);
  if (existingLedger.length > plan.length) {
    throw new Error(`Resume ledger has ${existingLedger.length} records for a ${plan.length}-execution campaign.`);
  }

  const results = [];
  let previousHash = 'GENESIS';
  for (const entry of plan) {
    const { sequence, cycle, orderIndex, testCase, variation } = entry;
    const caseRoot = join(runRoot, `cycle-${String(cycle).padStart(2, '0')}`, testCase.id);
    const resultPath = join(caseRoot, 'result.json');
    const recorded = existingLedger[sequence - 1] ?? null;
    let result;

    if (recorded) {
      verifyLedgerPlanIdentity(recorded, entry, campaign);
      const resultBytes = await readFile(resultPath);
      if (sha256(resultBytes) !== recorded.resultSha256) {
        throw new Error(`Resume result hash mismatch at sequence ${sequence} (${testCase.id}).`);
      }
      result = JSON.parse(resultBytes.toString('utf8'));
      verifyResultIdentity(result, entry);
      await finalizeRecordedCompaction(caseRoot, recorded);
      console.log(`RESUME ${sequence}/${campaign.totalExecutions} cycle=${cycle} ${testCase.id} ${result.outcome}`);
      previousHash = recorded.hash;
    } else {
      if (existingLedger.length !== sequence - 1) {
        throw new Error(`Resume ledger gap before sequence ${sequence}.`);
      }
      await mkdir(dirname(caseRoot), { recursive: true });
      result = options.resume ? await readResult(resultPath) : null;
      if (result) {
        verifyResultIdentity(result, entry);
        console.log(`RECOVER_RESULT ${sequence}/${campaign.totalExecutions} cycle=${cycle} ${testCase.id} ${result.outcome}`);
      } else {
        if (await pathExists(caseRoot)) await rm(caseRoot, { recursive: true, force: true });
        await mkdir(caseRoot, { recursive: true });
        console.log(`START ${sequence}/${campaign.totalExecutions} cycle=${cycle} order=${orderIndex} ${testCase.id} ${testCase.title}`);
        result = await executeChild({ entry, caseRoot, campaign });
        console.log(`RESULT ${sequence}/${campaign.totalExecutions} cycle=${cycle} ${testCase.id} ${result.outcome} ${result.wallElapsedMs ?? 0}ms`);
      }

      const resultBytes = await readFile(resultPath);
      const resultSha256 = sha256(resultBytes);
      const shouldCompact = retentionPolicy.compact && cycle > retentionPolicy.keepWorkspacesThroughCycle;
      const compaction = shouldCompact
        ? await createCompactionSeal({ caseRoot, result, resultSha256, entry })
        : null;
      const unsignedLedger = {
        ledgerVersion: APEX_WORKFLOW_LEDGER_VERSION,
        campaignSha256: campaign.campaignSha256,
        sequence,
        cycle,
        orderIndex,
        caseId: testCase.id,
        variationSha256: variation.variationSha256,
        workerLaunchId: result.auditExecution?.workerLaunchId ?? null,
        workerPid: result.auditExecution?.workerPid ?? null,
        outcome: result.outcome,
        terminalState: result.terminalState,
        resultSha256,
        semanticDigest: result.semanticDigest,
        behavioralDigest: result.behavioralDigest,
        stepJournalSha256: result.stepJournal?.byteSha256 ?? null,
        compaction,
        previousHash
      };
      const record = { ...unsignedLedger, hash: sha256Json(unsignedLedger) };
      await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
      existingLedger.push(record);
      previousHash = record.hash;
      if (compaction) await finalizeRecordedCompaction(caseRoot, record);
    }

    results.push(result);
    await writeSummary(runRoot, campaign, results, existingLedger);
  }

  const summary = await writeSummary(runRoot, campaign, results, existingLedger);
  console.log(`FINAL ${summary.contractPass}/${summary.totalExecutions} PASS ${summary.failed} FAILED`);
  console.log(`CONFIDENCE_99_LOWER_BOUND ${summary.statistics.oneSided99PercentSuccessRateLowerBound}`);
  if (summary.failed > 0) process.exitCode = 1;
  return { runRoot, campaign, summary, results };
}

async function runWorker(options) {
  const testCase = apexCases.find((item) => item.id === options.workerCaseId);
  if (!testCase) throw new Error(`Unknown worker case: ${options.workerCaseId}`);
  if (!options.workerRoot) throw new Error('Worker requires --root.');
  const variationCases = options.workerSelectedCaseIds?.map((id) =>
    apexCases.find((item) => item.id === id)).filter(Boolean) ?? [testCase];
  const variation = deriveApexCycleVariation(variationCases, options.workerCycle, APEX_WORKFLOW_SEED);
  if (options.workerVariationSha256 && variation.variationSha256 !== options.workerVariationSha256) {
    throw new Error(`Worker variation mismatch for ${testCase.id} cycle ${options.workerCycle}.`);
  }
  const virtualClockStart = options.workerVirtualClockStart ?? variation.virtualClockStart;
  const caseRoot = resolve(options.workerRoot);
  await mkdir(caseRoot, { recursive: true });
  await writeFile(join(caseRoot, 'command.txt'), `${testCase.command}\n`, 'utf8');
  const result = await runApexWorkflowCase(testCase, {
    caseRoot,
    cycle: options.workerCycle,
    virtualClockStart
  });
  result.auditExecution = {
    auditVersion: APEX_WORKFLOW_AUDIT_VERSION,
    freshChildProcess: true,
    workerLaunchId: options.workerLaunchId,
    workerPid: process.pid,
    parentPid: process.ppid,
    sequence: options.workerSequence,
    orderIndex: options.workerOrderIndex,
    cycleVariationVersion: APEX_WORKFLOW_VARIATION_VERSION,
    cycleVariationSha256: variation.variationSha256,
    virtualClockStart
  };
  await atomicJson(join(caseRoot, 'result.json'), result);
  console.log(JSON.stringify({ caseId: testCase.id, outcome: result.outcome, workerPid: process.pid }));
  if (!hasPureTrace(result) || !hasDirectFaultConsumption(result, testCase) || !result.behavioralPass) {
    process.exitCode = 1;
  }
  return result;
}

async function executeChild({ entry, caseRoot, campaign }) {
  const { testCase, cycle, sequence, orderIndex, variation } = entry;
  const workerLaunchId = sha256Json({
    campaignSha256: campaign.campaignSha256,
    sequence,
    cycle,
    caseId: testCase.id,
    variationSha256: variation.variationSha256
  });
  const args = [
    SCRIPT_PATH, '--worker', '--case', testCase.id, '--cycle', String(cycle),
    '--root', caseRoot, '--sequence', String(sequence), '--order-index', String(orderIndex),
    '--launch-id', workerLaunchId, '--variation-sha256', variation.variationSha256,
    '--virtual-clock-start', variation.virtualClockStart,
    '--selected-cases', campaign.selectedCaseIds.join(',')
  ];
  const childResult = await new Promise((resolveChild) => {
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: sanitizedEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    const timeout = setTimeout(
      () => child.kill('SIGKILL'),
      Math.max(60_000, Number(testCase.budgets?.maxWallElapsedMs ?? 45_000) + 15_000)
    );
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { spawnError = normalizeError(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolveChild({ code, signal, pid: child.pid, stdout, stderr, spawnError });
    });
  });
  const resultPath = join(caseRoot, 'result.json');
  const result = await readResult(resultPath);
  if (result) {
    verifyResultIdentity(result, entry);
    if (result.auditExecution?.workerLaunchId !== workerLaunchId) {
      throw new Error(`Worker launch receipt mismatch for ${testCase.id}.`);
    }
    return result;
  }

  const failed = {
    resultVersion: APEX_WORKFLOW_AUDIT_VERSION,
    caseId: testCase.id,
    title: testCase.title,
    category: testCase.category,
    cycle,
    command: testCase.command,
    outcome: 'FAILED',
    behavioralPass: false,
    terminalState: null,
    stopCode: 'CHILD_PROCESS_FAILED',
    wallElapsedMs: null,
    semanticDigest: sha256Json({ caseId: testCase.id, cycle, childResult }),
    auditExecution: {
      auditVersion: APEX_WORKFLOW_AUDIT_VERSION,
      freshChildProcess: true,
      workerLaunchId,
      workerPid: childResult.pid ?? null,
      sequence,
      orderIndex,
      cycleVariationVersion: APEX_WORKFLOW_VARIATION_VERSION,
      cycleVariationSha256: variation.variationSha256,
      virtualClockStart: variation.virtualClockStart
    },
    engineError: {
      code: childResult.code,
      signal: childResult.signal,
      spawnError: childResult.spawnError,
      stdout: childResult.stdout.slice(-4000),
      stderr: childResult.stderr.slice(-4000)
    }
  };
  await atomicJson(resultPath, failed);
  return failed;
}

async function writeSummary(runRoot, campaign, results, ledger) {
  const selectedById = new Map(campaign.selectedCaseIds.map((id) => [id, apexCases.find((item) => item.id === id)]));
  const assessments = results.map((result) => assessResultContract(result, selectedById.get(result.caseId)));
  const terminalStates = countBy(results, (item) => item.terminalState ?? 'UNKNOWN');
  const outcomes = countBy(results, (item) => item.outcome ?? 'UNKNOWN');
  const expectedProfileCounts = countBy(campaign.cycleVariations ?? [], (item) => item.virtualClockStart);
  const exactSemanticDigestGroups = summarizeDigestGroups(
    results,
    (result) => `${result.caseId}|${result.auditExecution?.virtualClockStart ?? 'UNKNOWN'}`,
    (result) => result.semanticDigest,
    ({ caseId, virtualClockStart }) => expectedProfileCounts[virtualClockStart] ?? 0
  );
  const behavioralDigestGroups = summarizeDigestGroups(
    results,
    (result) => result.caseId,
    (result) => result.behavioralDigest,
    () => campaign.cycles
  );
  const exactSemanticDigestMismatches = exactSemanticDigestGroups.filter((item) => !item.digestStable);
  const behavioralDigestMismatches = behavioralDigestGroups.filter((item) => !item.digestStable);
  const exactMismatchKeys = new Set(exactSemanticDigestMismatches.map((item) => item.key));
  const behavioralMismatchIds = new Set(behavioralDigestMismatches.map((item) => item.caseId));
  for (const assessment of assessments) {
    const exactKey = `${assessment.result.caseId}|${assessment.result.auditExecution?.virtualClockStart ?? 'UNKNOWN'}`;
    if (exactMismatchKeys.has(exactKey)) {
      assessment.failures.push('exact-semantic-digest-unstable-within-clock-profile');
      assessment.pass = false;
    }
    if (behavioralMismatchIds.has(assessment.result.caseId)) {
      assessment.failures.push('variation-normalized-behavioral-digest-unstable');
      assessment.pass = false;
    }
  }
  const passed = assessments.filter((item) => item.pass);
  const failed = assessments.filter((item) => !item.pass);
  const n = results.length;
  const traceSupplements = results.reduce((totals, item) => {
    const supplements = item.scriptedTraceSupplements ?? {};
    totals.callKinds += Object.keys(supplements.calls ?? {}).length;
    totals.callUnits += Object.values(supplements.calls ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0);
    totals.faults += (supplements.faults ?? []).length;
    totals.events += (supplements.events ?? []).length;
    return totals;
  }, { callKinds: 0, callUnits: 0, faults: 0, events: 0 });
  const declaredFaultCount = results.reduce((sum, item) =>
    sum + Number(selectedById.get(item.caseId)?.faultPlan?.length ?? 0), 0);
  const consumedFaultCount = results.reduce((sum, item) =>
    sum + (item.faultEvidence ?? []).filter((fault) => fault.consumed === 1 && fault.applied === true).length, 0);
  const lowerBound = failed.length === 0 && n > 0 ? Math.pow(0.01, 1 / n) : null;
  const summaryPayload = {
    summaryVersion: 'jarvis-apex-workflow-50-summary-v3',
    auditVersion: APEX_WORKFLOW_AUDIT_VERSION,
    campaignSha256: campaign.campaignSha256,
    campaign,
    updatedAt: new Date().toISOString(),
    plannedExecutions: campaign.totalExecutions,
    totalExecutions: n,
    ledgerRecords: ledger.length,
    behavioralPass: results.filter((item) => item.behavioralPass === true).length,
    contractPass: passed.length,
    failed: failed.length,
    outcomes,
    terminalStates,
    freshChildProcessExecutions: results.filter((item) => item.auditExecution?.freshChildProcess === true).length,
    realExternalAttempts: results.reduce((sum, item) => sum + Number(item.egress?.realAttempts ?? 0), 0),
    realExternalCommits: results.reduce((sum, item) => sum + Number(item.egress?.realCommits ?? 0), 0),
    declaredFaultCount,
    consumedFaultCount,
    faultCount: results.reduce((sum, item) => sum + Number(item.faultEvidence?.length ?? 0), 0),
    scriptedTraceSupplements: traceSupplements,
    tracePurityPassed: results.filter(hasPureTrace).length,
    faultConsumptionFailures: assessments.flatMap((item) => item.faultFailures),
    semanticDigestMismatches: exactSemanticDigestMismatches,
    exactSemanticDigestMismatches,
    behavioralDigestMismatches,
    exactSemanticDigestGroups,
    behavioralDigestGroups,
    repeatedExactProfileGroups: exactSemanticDigestGroups.filter((item) => item.executions > 1).length,
    stabilityContract: {
      exactDigestScope: 'caseId + execution virtualClockStart; authenticates exact artifact bytes',
      behavioralDigestScope: 'caseId across all declared cycle variations; only engine-declared virtual-clock translation is normalized',
      virtualClockProfileCount: APEX_WORKFLOW_VARIATION_PROFILE_COUNT
    },
    cycleVariations: campaign.cycleVariations,
    finalLedgerHash: ledger.at(-1)?.hash ?? 'GENESIS',
    compactedExecutions: ledger.filter((item) => item.compaction?.mode === 'manifest-sealed').length,
    failedCases: failed.map((item) => ({
      cycle: item.result.cycle,
      caseId: item.result.caseId,
      terminalState: item.result.terminalState,
      stopCode: item.result.stopCode,
      contractFailures: item.failures,
      failedAssertions: (item.result.assertions ?? []).filter((assertion) => !assertion.pass).map((assertion) => assertion.name),
      engineError: item.result.engineError
    })),
    statistics: {
      model: 'nominal one-sided exact binomial lower confidence bound for zero observed failures',
      confidence: 0.99,
      sampleSize: n,
      observedFailures: failed.length,
      oneSided99PercentSuccessRateLowerBound: lowerBound === null ? null : Number(lowerBound.toFixed(9)),
      appliesTo: 'this fixed deterministic corpus, cycle-variation plan, and declared fault distribution only',
      independenceAssumption: 'treats each fresh-process isolated execution as a Bernoulli trial; deterministic repetition is not a random sample of every future environment'
    }
  };
  const summary = {
    ...summaryPayload,
    summarySha256: sha256Json({ ...summaryPayload, updatedAt: undefined })
  };
  await atomicJson(join(runRoot, 'summary.json'), summary);
  await writeFile(join(runRoot, 'summary.md'), renderSummary(summary), 'utf8');
  return summary;
}

export function deriveApexCycleVariation(selected, cycle, seed = APEX_WORKFLOW_SEED) {
  if (!Number.isInteger(cycle) || cycle < 1) throw new Error('cycle must be a positive integer.');
  const ids = selected.map((item) => typeof item === 'string' ? item : item.id);
  if (ids.length === 0) throw new Error('At least one case is required for a cycle variation.');
  const offset = cycle === 1 ? 0 : deterministicInteger(`${seed}:cycle:${cycle}:offset`, ids.length);
  const direction = cycle === 1 || deterministicInteger(`${seed}:cycle:${cycle}:direction`, 2) === 0
    ? 'forward'
    : 'reverse';
  const rotated = [...ids.slice(offset), ...ids.slice(0, offset)];
  const executionOrder = direction === 'reverse' ? rotated.reverse() : rotated;
  const baseClockMs = Date.parse(APEX_WORKFLOW_VIRTUAL_CLOCK.start);
  const virtualClockProfileIndex = (cycle - 1) % APEX_WORKFLOW_VARIATION_PROFILE_COUNT;
  const virtualClockOffsetMs = virtualClockProfileIndex * 137_000;
  const payload = {
    version: APEX_WORKFLOW_VARIATION_VERSION,
    cycle,
    seed,
    orderOffset: offset,
    orderDirection: direction,
    executionOrder,
    virtualClockProfileId: `clock-profile-${virtualClockProfileIndex + 1}`,
    virtualClockProfileIndex,
    virtualClockOffsetMs,
    virtualClockStart: new Date(baseClockMs + virtualClockOffsetMs).toISOString()
  };
  return { ...payload, variationSha256: sha256Json(payload) };
}

export async function createApexImplementationManifest(projectRoot = PROJECT_ROOT) {
  const files = [];
  for (const entry of IMPLEMENTATION_FILES) {
    const bytes = await readFile(resolve(projectRoot, entry.path));
    files.push({
      role: entry.role,
      path: entry.path,
      size: bytes.length,
      sha256: sha256(bytes)
    });
  }
  const payload = {
    version: APEX_WORKFLOW_IMPLEMENTATION_MANIFEST_VERSION,
    files
  };
  return { ...payload, manifestSha256: sha256Json(payload) };
}

function buildExecutionPlan(selected, cycleVariations) {
  const byId = new Map(selected.map((item) => [item.id, item]));
  const plan = [];
  for (const variation of cycleVariations) {
    for (const [index, caseId] of variation.executionOrder.entries()) {
      plan.push({ sequence: plan.length + 1, cycle: variation.cycle, orderIndex: index + 1, testCase: byId.get(caseId), variation });
    }
  }
  return plan;
}

async function createCompactionSeal({ caseRoot, result, resultSha256, entry }) {
  const workspaceManifest = await inventoryTree(join(caseRoot, 'workspace'));
  const payload = {
    compactionVersion: APEX_WORKFLOW_COMPACTION_VERSION,
    caseId: entry.testCase.id,
    cycle: entry.cycle,
    sequence: entry.sequence,
    resultSha256,
    resultSemanticDigest: result.semanticDigest ?? null,
    resultBehavioralDigest: result.behavioralDigest ?? null,
    variationNormalizationSha256: sha256Json(result.variationNormalization ?? null),
    resultArtifactManifestSha256: manifestDigest(result.artifacts ?? []),
    resultInputManifestSha256: manifestDigest(result.inputEvidence?.after ?? []),
    workspaceManifest,
    workspaceManifestSha256: manifestDigest(workspaceManifest),
    stepJournalSha256: result.stepJournal?.byteSha256 ?? null
  };
  const seal = { ...payload, sealSha256: sha256Json(payload) };
  const sealPath = join(caseRoot, 'compaction-seal.json');
  await atomicJson(sealPath, seal);
  const sealBytes = await readFile(sealPath);
  return {
    mode: 'manifest-sealed',
    sealVersion: APEX_WORKFLOW_COMPACTION_VERSION,
    sealPath: 'compaction-seal.json',
    sealByteSha256: sha256(sealBytes),
    sealSha256: seal.sealSha256,
    workspaceManifestSha256: seal.workspaceManifestSha256
  };
}

async function finalizeRecordedCompaction(caseRoot, record) {
  if (record.compaction?.mode !== 'manifest-sealed') return;
  const sealPath = join(caseRoot, record.compaction.sealPath);
  const sealBytes = await readFile(sealPath);
  if (sha256(sealBytes) !== record.compaction.sealByteSha256) {
    throw new Error(`Compaction seal byte hash mismatch for sequence ${record.sequence}.`);
  }
  await rm(join(caseRoot, 'workspace'), { recursive: true, force: true });
}

function assessResultContract(result, testCase) {
  const failures = [];
  if (result.behavioralPass !== true) failures.push('behavioral-pass-false');
  if (result.outcome === 'FAILED') failures.push('failed-outcome');
  if (result.semanticDigest !== computeApexSemanticDigest(result)) failures.push('exact-semantic-digest-invalid');
  if (result.behavioralDigest !== computeApexBehavioralDigest(result)) failures.push('behavioral-digest-invalid');
  if (!hasPureTrace(result)) failures.push('trace-supplement-present');
  if (!hasDirectFaultConsumption(result, testCase)) failures.push('fault-not-directly-consumed');
  if (result.egress?.realAttempts !== 0 || result.egress?.realCommits !== 0) failures.push('real-external-effect');
  if (result.auditExecution?.freshChildProcess !== true) failures.push('fresh-child-process-unproven');
  return {
    result,
    pass: failures.length === 0,
    failures,
    faultFailures: hasDirectFaultConsumption(result, testCase)
      ? []
      : [{ caseId: result.caseId, cycle: result.cycle, faults: result.faultEvidence ?? [] }]
  };
}

function hasPureTrace(result) {
  const supplements = result.scriptedTraceSupplements ?? {};
  return Object.keys(supplements.calls ?? {}).length === 0
    && (supplements.faults ?? []).length === 0
    && (supplements.events ?? []).length === 0;
}

function hasDirectFaultConsumption(result, testCase) {
  if (!testCase) return false;
  const expectedIds = (testCase.faultPlan ?? []).map((fault) => fault.faultId).sort();
  const evidence = result.faultEvidence ?? [];
  const actualIds = evidence.map((fault) => fault.faultId).sort();
  const receiptFaultIds = new Set((result.operationReceipts ?? []).flatMap((receipt) => receipt.faultIds ?? []));
  return stableStringifyApexWorkflow(expectedIds) === stableStringifyApexWorkflow(actualIds)
    && evidence.every((fault) => fault.consumed === 1
      && fault.applied === true
      && typeof fault.consumedAtOperationId === 'string'
      && Number.isInteger(fault.consumedAtCall)
      && receiptFaultIds.has(fault.faultId));
}

async function readAndVerifyLedger(path, campaign) {
  if (!(await pathExists(path))) return [];
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/gu).filter(Boolean);
  const records = [];
  let previousHash = 'GENESIS';
  for (const [index, line] of lines.entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`Resume ledger line ${index + 1} is invalid JSON: ${error.message}`);
    }
    const unsigned = { ...record };
    delete unsigned.hash;
    if (record.sequence !== index + 1
      || record.previousHash !== previousHash
      || record.hash !== sha256Json(unsigned)
      || record.campaignSha256 !== campaign.campaignSha256) {
      throw new Error(`Resume ledger integrity failure at sequence ${index + 1}.`);
    }
    records.push(record);
    previousHash = record.hash;
  }
  return records;
}

function verifyLedgerPlanIdentity(record, entry, campaign) {
  if (record.ledgerVersion !== APEX_WORKFLOW_LEDGER_VERSION
    || record.campaignSha256 !== campaign.campaignSha256
    || record.sequence !== entry.sequence
    || record.cycle !== entry.cycle
    || record.orderIndex !== entry.orderIndex
    || record.caseId !== entry.testCase.id
    || record.variationSha256 !== entry.variation.variationSha256) {
    throw new Error(`Resume ledger plan mismatch at sequence ${entry.sequence}.`);
  }
}

function verifyResultIdentity(result, entry) {
  if (result.caseId !== entry.testCase.id
    || result.cycle !== entry.cycle
    || result.command !== entry.testCase.command
    || result.auditExecution?.sequence !== entry.sequence
    || result.auditExecution?.orderIndex !== entry.orderIndex
    || result.auditExecution?.cycleVariationSha256 !== entry.variation.variationSha256
    || result.auditExecution?.virtualClockStart !== entry.variation.virtualClockStart) {
    throw new Error(`Result identity mismatch at sequence ${entry.sequence} (${entry.testCase.id}).`);
  }
}

async function verifyResumeCampaign({ runRoot, campaign, selected, cycles, fingerprint, canonicalCorpus, cycleVariations, implementationManifest }) {
  const storedCorpus = await readJson(join(runRoot, 'corpus.json'));
  const expectedHash = sha256Json(campaignHashPayload(campaign));
  if (campaign.auditVersion !== APEX_WORKFLOW_AUDIT_VERSION
    || campaign.engineVersion !== APEX_SCENARIO_ENGINE_VERSION
    || campaign.corpusVersion !== APEX_WORKFLOW_CORPUS_VERSION
    || campaign.selectedCorpusSha256 !== fingerprint.corpusSha256
    || campaign.fullCorpusSha256 !== APEX_WORKFLOW_CORPUS_SHA256
    || campaign.cycles !== cycles
    || campaign.totalExecutions !== selected.length * cycles
    || campaign.campaignSha256 !== expectedHash
    || stableStringifyApexWorkflow(campaign.cycleVariations) !== stableStringifyApexWorkflow(cycleVariations)
    || stableStringifyApexWorkflow(campaign.implementationManifest) !== stableStringifyApexWorkflow(implementationManifest)
    || stableStringifyApexWorkflow(storedCorpus) !== stableStringifyApexWorkflow(canonicalCorpus)) {
    throw new Error('Resume campaign does not match the current APEX contract.');
  }
}

function campaignHashPayload(campaign) {
  const payload = { ...campaign };
  delete payload.campaignSha256;
  delete payload.generatedAt;
  return payload;
}

function parseCanonicalCorpus(fingerprint) {
  if (fingerprint.canonicalJson) return JSON.parse(fingerprint.canonicalJson);
  if (fingerprint.canonicalPayload) return fingerprint.canonicalPayload;
  throw new Error('APEX corpus fingerprint did not provide canonicalJson or canonicalPayload.');
}

function renderSummary(summary) {
  return `# JARVIS 어나더 레벨 복합 미션 감사 요약\n\n- 실행: ${summary.totalExecutions}/${summary.plannedExecutions}\n- 계약 통과: ${summary.contractPass}\n- 실패: ${summary.failed}\n- fresh child process: ${summary.freshChildProcessExecutions}\n- 실제 외부 호출: ${summary.realExternalAttempts}\n- 실제 외부 commit: ${summary.realExternalCommits}\n- 선언/직접 소비 장애: ${summary.declaredFaultCount}/${summary.consumedFaultCount}\n- scripted trace 보충: call ${summary.scriptedTraceSupplements.callUnits}, event ${summary.scriptedTraceSupplements.events}, fault ${summary.scriptedTraceSupplements.faults}\n- 같은 clock profile exact digest 반복 그룹: ${summary.repeatedExactProfileGroups}\n- exact digest 불일치: ${summary.exactSemanticDigestMismatches.length}\n- variation-normalized behavioral digest 불일치: ${summary.behavioralDigestMismatches.length}\n- compacted execution: ${summary.compactedExecutions}\n- terminal: ${JSON.stringify(summary.terminalStates)}\n- outcome: ${JSON.stringify(summary.outcomes)}\n- 명목 99% 단측 성공률 하한: ${summary.statistics.oneSided99PercentSuccessRateLowerBound ?? '계산 불가'}\n\n이 하한은 fresh process 실행을 Bernoulli 시행으로 간주했을 때의 명목값이며, 고정 코퍼스·cycle variation·선언 장애 분포에만 적용됩니다.\n`;
}

function renderCommands(cases) {
  return `# JARVIS 어나더 레벨 복합 미션 50건\n\n${cases.map((item) => `## ${item.id} — ${item.title}\n\n${item.command}\n\n- 범주: ${item.category}\n- 기대: ${item.expected.terminalState}${item.expected.stopCode ? ` / ${item.expected.stopCode}` : ''}`).join('\n\n')}\n`;
}

function parseArguments(argv) {
  const options = {
    cycles: 1, cyclesExplicit: false, caseIds: null, root: null, resume: false,
    compact: false, compactExplicit: false, keepWorkspacesThroughCycle: 1,
    keepWorkspacesThroughCycleExplicit: false, worker: false,
    workerCaseId: null, workerCycle: 1, workerRoot: null, workerSequence: null,
    workerOrderIndex: null, workerLaunchId: null, workerVariationSha256: null,
    workerVirtualClockStart: null, workerSelectedCaseIds: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--worker') options.worker = true;
    else if (arg === '--root') options.root = argv[++index];
    else if (arg === '--cases' || arg === '--selected-cases') {
      const ids = String(argv[++index] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
      if (arg === '--cases') options.caseIds = ids;
      else options.workerSelectedCaseIds = ids;
    } else if (arg === '--case') options.workerCaseId = argv[++index];
    else if (arg === '--cycle') options.workerCycle = positiveInteger(argv[++index], '--cycle');
    else if (arg === '--cycles') {
      options.cycles = positiveInteger(argv[++index], '--cycles');
      options.cyclesExplicit = true;
    } else if (arg === '--resume') options.resume = true;
    else if (arg === '--compact') {
      options.compact = true;
      options.compactExplicit = true;
    } else if (arg === '--keep-workspaces-through-cycle') {
      options.keepWorkspacesThroughCycle = nonnegativeInteger(argv[++index], '--keep-workspaces-through-cycle');
      options.keepWorkspacesThroughCycleExplicit = true;
    }
    else if (arg === '--sequence') options.workerSequence = positiveInteger(argv[++index], '--sequence');
    else if (arg === '--order-index') options.workerOrderIndex = positiveInteger(argv[++index], '--order-index');
    else if (arg === '--launch-id') options.workerLaunchId = argv[++index];
    else if (arg === '--variation-sha256') options.workerVariationSha256 = argv[++index];
    else if (arg === '--virtual-clock-start') options.workerVirtualClockStart = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.worker) options.workerRoot = options.root;
  if (options.cycles > 100) throw new Error('--cycles must not exceed 100.');
  return options;
}

function selectCases(caseIds) {
  if (!caseIds?.length) return apexCases;
  const requested = new Set(caseIds);
  if (requested.size !== caseIds.length) throw new Error('--cases must not contain duplicate ids.');
  const selected = caseIds.map((id) => apexCases.find((item) => item.id === id));
  const missing = caseIds.filter((id, index) => !selected[index]);
  if (missing.length) throw new Error(`Unknown cases: ${missing.join(', ')}`);
  return selected;
}

function selectResumeCases(campaign, options) {
  if (options.caseIds && stableStringifyApexWorkflow(options.caseIds) !== stableStringifyApexWorkflow(campaign.selectedCaseIds)) {
    throw new Error('--cases does not match the saved resume campaign.');
  }
  return selectCases(campaign.selectedCaseIds);
}

function resolveResumeCycles(campaign, options) {
  if (options.cyclesExplicit && options.cycles !== campaign.cycles) {
    throw new Error('--cycles does not match the saved resume campaign.');
  }
  return campaign.cycles;
}

function resolveResumeRetentionPolicy(campaign, options) {
  const saved = campaign.retentionPolicy;
  if (!saved || typeof saved.compact !== 'boolean' || !Number.isInteger(saved.keepWorkspacesThroughCycle)) {
    throw new Error('Saved resume campaign has no valid retention policy.');
  }
  if (options.compactExplicit && options.compact !== saved.compact) {
    throw new Error('--compact does not match the saved resume campaign.');
  }
  if (options.keepWorkspacesThroughCycleExplicit
    && options.keepWorkspacesThroughCycle !== saved.keepWorkspacesThroughCycle) {
    throw new Error('--keep-workspaces-through-cycle does not match the saved resume campaign.');
  }
  return saved;
}

function sanitizedEnvironment() {
  const allowed = [
    'ALLUSERSPROFILE', 'APPDATA', 'CommonProgramFiles', 'CommonProgramFiles(x86)',
    'CommonProgramW6432', 'ComSpec', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA',
    'NUMBER_OF_PROCESSORS', 'OS', 'Path', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
    'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'SystemDrive',
    'SystemRoot', 'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'windir'
  ];
  return Object.fromEntries(allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

function deterministicInteger(material, maximum) {
  if (maximum <= 1) return 0;
  return createHash('sha256').update(material).digest().readUInt32BE(0) % maximum;
}

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer.`);
  return parsed;
}

function nonnegativeInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${option} must be a nonnegative integer.`);
  return parsed;
}

async function readResult(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rm(path, { force: true });
  await import('node:fs/promises').then(({ rename }) => rename(temp, path));
}

async function pathExists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function summarizeDigestGroups(results, keySelector, digestSelector, expectedExecutions) {
  const groups = new Map();
  for (const result of results) {
    const key = keySelector(result);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        caseId: result.caseId,
        virtualClockStart: result.auditExecution?.virtualClockStart ?? null,
        executions: 0,
        cycles: [],
        digests: new Set()
      });
    }
    const group = groups.get(key);
    group.executions += 1;
    group.cycles.push(result.cycle);
    group.digests.add(digestSelector(result) ?? null);
  }
  return [...groups.values()].map((group) => {
    const digests = [...group.digests];
    const expected = expectedExecutions(group);
    return {
      key: group.key,
      caseId: group.caseId,
      virtualClockStart: group.virtualClockStart,
      executions: group.executions,
      expectedExecutions: expected,
      coverageComplete: group.executions === expected,
      cycles: group.cycles.sort((left, right) => left - right),
      digestCount: digests.length,
      digestStable: digests.length === 1 && typeof digests[0] === 'string' && /^[a-f0-9]{64}$/u.test(digests[0]),
      digests
    };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function sha256Json(value) { return sha256(Buffer.from(JSON.stringify(canonicalize(value)), 'utf8')); }
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function normalizeError(error) {
  return {
    name: String(error?.name ?? 'Error'),
    code: String(error?.code ?? 'APEX_CHILD_SPAWN_ERROR'),
    message: String(error?.message ?? error).slice(0, 1000)
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  await runApexWorkflowAudit(process.argv.slice(2));
}
