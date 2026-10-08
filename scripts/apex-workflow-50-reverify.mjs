import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APEX_WORKFLOW_CORPUS_SHA256,
  APEX_WORKFLOW_CORPUS_VERSION,
  APEX_WORKFLOW_SCENARIO_VERSION,
  APEX_WORKFLOW_SEED,
  APEX_WORKFLOW_VIRTUAL_CLOCK,
  apexCases,
  createApexWorkflowCorpusFingerprint,
  stableStringifyApexWorkflow
} from './apex-workflow-50-cases.mjs';
import {
  APEX_SCENARIO_ENGINE_VERSION,
  APEX_VARIATION_NORMALIZATION_VERSION,
  computeApexBehavioralDigest,
  computeApexSemanticDigest,
  createApexVariationNormalizationEvidence,
  verifyApexStepJournal
} from './apex-workflow-scenario-engine.mjs';
import {
  inventoryTree,
  manifestDigest,
  verifyExpectedArtifacts
} from './apex-workflow-artifacts.mjs';
import {
  APEX_WORKFLOW_AUDIT_VERSION,
  APEX_WORKFLOW_COMPACTION_VERSION,
  APEX_WORKFLOW_IMPLEMENTATION_MANIFEST_VERSION,
  APEX_WORKFLOW_LEDGER_VERSION,
  APEX_WORKFLOW_VARIATION_PROFILE_COUNT,
  APEX_WORKFLOW_VARIATION_VERSION
} from './apex-workflow-50-audit.mjs';

export const APEX_WORKFLOW_REVERIFY_VERSION = 'jarvis-apex-workflow-50-reverify-v3';
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

export async function reverifyApexWorkflowAudit(runRoot) {
  const root = resolve(runRoot);
  const checks = [];
  const campaign = await readJson(join(root, 'campaign.json'));
  const storedCorpus = await readJson(join(root, 'corpus.json'));
  const currentImplementationManifest = await independentlyCreateImplementationManifest();
  const selected = campaign.selectedCaseIds?.map((id) => apexCases.find((item) => item.id === id)) ?? [];
  const selectedComplete = selected.length > 0 && selected.every(Boolean);
  add(checks, 'campaign selected case ids resolve exactly', selectedComplete, {
    ids: campaign.selectedCaseIds,
    unresolved: (campaign.selectedCaseIds ?? []).filter((id, index) => !selected[index])
  });

  const fingerprint = selectedComplete ? createApexWorkflowCorpusFingerprint(selected) : null;
  const canonicalCorpus = fingerprint ? parseCanonicalCorpus(fingerprint) : null;
  add(checks, 'audit version matches verifier contract', campaign.auditVersion === APEX_WORKFLOW_AUDIT_VERSION, {
    expected: APEX_WORKFLOW_AUDIT_VERSION,
    actual: campaign.auditVersion
  });
  add(checks, 'engine version matches verifier contract', campaign.engineVersion === APEX_SCENARIO_ENGINE_VERSION, {
    expected: APEX_SCENARIO_ENGINE_VERSION,
    actual: campaign.engineVersion
  });
  add(checks, 'corpus and scenario versions match',
    campaign.corpusVersion === APEX_WORKFLOW_CORPUS_VERSION
      && campaign.scenarioVersion === APEX_WORKFLOW_SCENARIO_VERSION,
    { corpusVersion: campaign.corpusVersion, scenarioVersion: campaign.scenarioVersion });
  add(checks, 'full corpus hash matches current source', campaign.fullCorpusSha256 === APEX_WORKFLOW_CORPUS_SHA256, {
    expected: APEX_WORKFLOW_CORPUS_SHA256,
    actual: campaign.fullCorpusSha256
  });
  add(checks, 'selected corpus hash matches campaign',
    Boolean(fingerprint) && campaign.selectedCorpusSha256 === fingerprint.corpusSha256,
    { expected: fingerprint?.corpusSha256 ?? null, actual: campaign.selectedCorpusSha256 });
  add(checks, 'stored corpus canonical payload matches source',
    Boolean(canonicalCorpus)
      && stableStringifyApexWorkflow(storedCorpus) === stableStringifyApexWorkflow(canonicalCorpus), {});
  add(checks, 'campaign hash authenticates immutable fields',
    campaign.campaignSha256 === sha256Json(campaignHashPayload(campaign)), {
      expected: sha256Json(campaignHashPayload(campaign)),
      actual: campaign.campaignSha256
    });
  const storedImplementationPayload = { ...(campaign.implementationManifest ?? {}) };
  delete storedImplementationPayload.manifestSha256;
  add(checks, 'implementation manifest self-hash is valid',
    campaign.implementationManifest?.version === APEX_WORKFLOW_IMPLEMENTATION_MANIFEST_VERSION
      && campaign.implementationManifest?.manifestSha256 === sha256Json(storedImplementationPayload), {
      expected: sha256Json(storedImplementationPayload),
      actual: campaign.implementationManifest?.manifestSha256
    });
  add(checks, 'implementation manifest paths are sorted project-relative paths',
    implementationPathsValid(campaign.implementationManifest), {
      files: campaign.implementationManifest?.files
    });
  add(checks, 'campaign implementation bytes match current execution dependencies',
    stableStringifyApexWorkflow(campaign.implementationManifest)
      === stableStringifyApexWorkflow(currentImplementationManifest), {
      expected: campaign.implementationManifest,
      actual: currentImplementationManifest
    });
  for (const current of currentImplementationManifest.files) {
    const stored = campaign.implementationManifest?.files?.find((item) => item.path === current.path);
    add(checks, `implementation ${current.path} byte hash`,
      stored?.role === current.role
        && stored?.size === current.size
        && stored?.sha256 === current.sha256,
      { expected: stored ?? null, actual: current });
  }
  add(checks, 'campaign execution count exact',
    selectedComplete
      && Number.isInteger(campaign.cycles)
      && campaign.totalExecutions === selected.length * campaign.cycles,
    { expected: selected.length * campaign.cycles, actual: campaign.totalExecutions });

  const expectedVariations = selectedComplete && Number.isInteger(campaign.cycles)
    ? Array.from({ length: campaign.cycles }, (_, index) =>
      deriveExpectedCycleVariation(selected, index + 1, APEX_WORKFLOW_SEED))
    : [];
  add(checks, 'cycle variations are deterministic and complete',
    stableStringifyApexWorkflow(campaign.cycleVariations ?? [])
      === stableStringifyApexWorkflow(expectedVariations), {
      expected: expectedVariations,
      actual: campaign.cycleVariations
    });
  const plan = buildExpectedPlan(selectedComplete ? selected : [], expectedVariations);

  const ledgerPath = join(root, 'sequence-ledger.jsonl');
  const ledgerRead = await readJsonLines(ledgerPath);
  for (const error of ledgerRead.errors) {
    add(checks, `ledger line ${error.line} parses as JSON`, false, error);
  }
  const ledger = ledgerRead.records;
  add(checks, 'sequence ledger record count exact', ledger.length === campaign.totalExecutions, {
    expected: campaign.totalExecutions,
    actual: ledger.length,
    parseErrors: ledgerRead.errors.length
  });

  let previousHash = 'GENESIS';
  const results = [];
  const workerLaunchIds = new Set();
  let retainedArtifactVerifications = 0;
  let compactedArtifactVerifications = 0;

  for (let index = 0; index < Math.max(plan.length, ledger.length); index += 1) {
    const expected = plan[index];
    const record = ledger[index];
    const sequence = index + 1;
    if (!expected || !record) {
      add(checks, `ledger ${sequence} plan record exists`, false, {
        hasExpectedPlan: Boolean(expected),
        hasRecord: Boolean(record)
      });
      if (record?.hash) previousHash = record.hash;
      continue;
    }

    const unsigned = { ...record };
    delete unsigned.hash;
    add(checks, `ledger ${sequence} version and campaign binding`,
      record.ledgerVersion === APEX_WORKFLOW_LEDGER_VERSION
        && record.campaignSha256 === campaign.campaignSha256,
      { ledgerVersion: record.ledgerVersion, campaignSha256: record.campaignSha256 });
    add(checks, `ledger ${sequence} deterministic plan identity`,
      record.sequence === sequence
        && record.caseId === expected.testCase.id
        && record.cycle === expected.cycle
        && record.orderIndex === expected.orderIndex
        && record.variationSha256 === expected.variation.variationSha256,
      {
        record: pick(record, ['sequence', 'caseId', 'cycle', 'orderIndex', 'variationSha256']),
        expected: {
          sequence,
          caseId: expected.testCase.id,
          cycle: expected.cycle,
          orderIndex: expected.orderIndex,
          variationSha256: expected.variation.variationSha256
        }
      });
    add(checks, `ledger ${sequence} previous hash`, record.previousHash === previousHash, {
      expected: previousHash,
      actual: record.previousHash
    });
    const computedRecordHash = sha256Json(unsigned);
    add(checks, `ledger ${sequence} record hash`, record.hash === computedRecordHash, {
      expected: record.hash,
      actual: computedRecordHash
    });
    previousHash = record.hash ?? previousHash;

    const caseRoot = join(root, `cycle-${String(expected.cycle).padStart(2, '0')}`, expected.testCase.id);
    const resultPath = join(caseRoot, 'result.json');
    const resultRead = await readBytes(resultPath);
    add(checks, `result ${sequence} exists`, resultRead.ok, resultRead.error ?? {});
    if (!resultRead.ok) continue;
    const resultBytes = resultRead.bytes;
    const resultByteSha256 = sha256(resultBytes);
    add(checks, `result ${sequence} byte hash`, resultByteSha256 === record.resultSha256, {
      expected: record.resultSha256,
      actual: resultByteSha256
    });
    let result;
    try {
      result = JSON.parse(resultBytes.toString('utf8'));
    } catch (error) {
      add(checks, `result ${sequence} parses as JSON`, false, { message: error.message });
      continue;
    }
    results.push(result);
    add(checks, `result ${sequence} identity and expected terminal`,
      result.caseId === expected.testCase.id
        && result.cycle === expected.cycle
        && result.command === expected.testCase.command
        && result.terminalState === expected.testCase.expected.terminalState
        && (result.stopCode ?? null) === (expected.testCase.expected.stopCode ?? null), {
        caseId: result.caseId,
        cycle: result.cycle,
        terminalState: result.terminalState,
        stopCode: result.stopCode
      });
    add(checks, `result ${sequence} behavioral contract passed`,
      result.behavioralPass === true && result.outcome !== 'FAILED', {
        behavioralPass: result.behavioralPass,
        outcome: result.outcome,
        failedAssertions: (result.assertions ?? []).filter((item) => !item.pass).map((item) => item.name)
      });

    const expectedLaunchId = sha256Json({
      campaignSha256: campaign.campaignSha256,
      sequence,
      cycle: expected.cycle,
      caseId: expected.testCase.id,
      variationSha256: expected.variation.variationSha256
    });
    const auditExecution = result.auditExecution ?? {};
    add(checks, `result ${sequence} fresh child and variation receipt`,
      auditExecution.auditVersion === APEX_WORKFLOW_AUDIT_VERSION
        && auditExecution.freshChildProcess === true
        && auditExecution.workerLaunchId === expectedLaunchId
        && auditExecution.workerPid === record.workerPid
        && Number.isInteger(auditExecution.workerPid)
        && auditExecution.sequence === sequence
        && auditExecution.orderIndex === expected.orderIndex
        && auditExecution.cycleVariationVersion === APEX_WORKFLOW_VARIATION_VERSION
        && auditExecution.cycleVariationSha256 === expected.variation.variationSha256
        && auditExecution.virtualClockStart === expected.variation.virtualClockStart
        && record.workerLaunchId === expectedLaunchId,
      auditExecution);
    add(checks, `result ${sequence} launch receipt is unique`,
      !workerLaunchIds.has(auditExecution.workerLaunchId), {
        workerLaunchId: auditExecution.workerLaunchId
      });
    workerLaunchIds.add(auditExecution.workerLaunchId);

    const semanticDigest = computeApexSemanticDigest(result);
    add(checks, `result ${sequence} semantic digest`,
      result.semanticDigest === semanticDigest && record.semanticDigest === semanticDigest, {
        result: result.semanticDigest,
        ledger: record.semanticDigest,
        computed: semanticDigest
      });
    const behavioralDigest = computeApexBehavioralDigest(result);
    add(checks, `result ${sequence} variation-normalized behavioral digest`,
      result.behavioralDigest === behavioralDigest && record.behavioralDigest === behavioralDigest, {
        result: result.behavioralDigest,
        ledger: record.behavioralDigest,
        computed: behavioralDigest
      });
    const normalization = independentlyVerifyVariationNormalization(result, expected);
    add(checks, `result ${sequence} variation normalization is strictly scoped`, normalization.pass, normalization);

    const journalPath = resolveCaseChild(caseRoot, result.stepJournal?.path ?? 'step-journal.jsonl');
    add(checks, `result ${sequence} step journal path stays inside case root`, Boolean(journalPath), {
      path: result.stepJournal?.path
    });
    let manualJournal = null;
    if (journalPath) {
      const exportedVerification = await verifyApexStepJournal(journalPath);
      manualJournal = await independentlyVerifyStepJournal(journalPath, result.caseId, result.cycle);
      add(checks, `result ${sequence} exported step journal verification`, exportedVerification.valid, {
        recordCount: exportedVerification.recordCount,
        errors: exportedVerification.errors
      });
      add(checks, `result ${sequence} independent step journal hash-chain`, manualJournal.valid, {
        recordCount: manualJournal.recordCount,
        errors: manualJournal.errors
      });
      add(checks, `result ${sequence} step journal metadata and byte hash`,
        manualJournal.byteSha256 === result.stepJournal?.byteSha256
          && manualJournal.byteSha256 === record.stepJournalSha256
          && manualJournal.finalHash === result.stepJournal?.finalHash
          && manualJournal.recordCount === result.stepJournal?.recordCount,
        {
          manual: pick(manualJournal, ['byteSha256', 'finalHash', 'recordCount']),
          result: result.stepJournal,
          ledgerSha256: record.stepJournalSha256
        });
    }

    const directFault = independentlyVerifyFaultConsumption(result, expected.testCase, manualJournal?.records ?? []);
    add(checks, `result ${sequence} fault plan directly consumed`, directFault.pass, directFault);
    const trace = independentlyVerifyTracePurity(result, expected.testCase, manualJournal?.records ?? []);
    add(checks, `result ${sequence} trace purity without synthetic supplementation`, trace.pass, trace);
    add(checks, `result ${sequence} no real external effect`,
      result.egress?.realAttempts === 0 && result.egress?.realCommits === 0,
      result.egress ?? {});

    const workspace = join(caseRoot, 'workspace');
    if (await pathExists(workspace)) {
      retainedArtifactVerifications += 1;
      const artifactChecks = await verifyExpectedArtifacts(workspace, expected.testCase);
      const inventory = await inventoryTree(workspace);
      const declaredInputPaths = new Set(Object.keys(expected.testCase.inputs ?? {}).map(normalizeRelativePath));
      const outputInventory = inventory.filter((item) => !declaredInputPaths.has(item.path));
      add(checks, `result ${sequence} independent retained artifact verification`,
        artifactChecks.every((item) => item.pass), {
          failed: artifactChecks.filter((item) => !item.pass)
        });
      let recomputedNormalization = null;
      let normalizationError = null;
      try {
        recomputedNormalization = await createApexVariationNormalizationEvidence({
          workspace,
          artifacts: result.artifacts ?? [],
          category: result.category,
          baseVirtualClockStart: result.variationNormalization?.baseVirtualClockStart,
          executionVirtualClockStart: result.variationNormalization?.executionVirtualClockStart
        });
      } catch (error) {
        normalizationError = { code: error.code ?? 'NORMALIZATION_RECOMPUTE_FAILED', message: error.message };
      }
      add(checks, `result ${sequence} retained behavioral artifact hashes match bytes`,
        Boolean(recomputedNormalization)
          && stableStringifyApexWorkflow(recomputedNormalization)
            === stableStringifyApexWorkflow(result.variationNormalization), {
          expected: result.variationNormalization,
          actual: recomputedNormalization,
          error: normalizationError
        });
      add(checks, `result ${sequence} retained artifact manifest matches bytes`,
        stableStringifyApexWorkflow(outputInventory)
          === stableStringifyApexWorkflow(result.artifacts ?? []), {
          expectedDigest: manifestDigest(result.artifacts ?? []),
          actualDigest: manifestDigest(outputInventory)
        });
      add(checks, `result ${sequence} retained input manifest matches bytes`,
        manifestDigest(inventory.filter((item) => declaredInputPaths.has(item.path)))
          === result.inputEvidence?.afterDigest, {
          expected: result.inputEvidence?.afterDigest,
          actual: manifestDigest(inventory.filter((item) => declaredInputPaths.has(item.path)))
        });
      add(checks, `result ${sequence} has no unexpected compaction record`, record.compaction === null, {
        compaction: record.compaction
      });
    } else {
      compactedArtifactVerifications += 1;
      const compaction = await verifyCompactionSeal({ caseRoot, record, result, resultByteSha256, testCase: expected.testCase });
      add(checks, `result ${sequence} compacted artifact seal verification`, compaction.pass, compaction);
    }
  }

  const expectedProfileCounts = countBy(expectedVariations, (item) => item.virtualClockStart);
  const exactGroups = summarizeDigestGroups(
    results,
    (result) => `${result.caseId}|${result.auditExecution?.virtualClockStart ?? 'UNKNOWN'}`,
    (result) => result.semanticDigest,
    (group) => expectedProfileCounts[group.virtualClockStart] ?? 0
  );
  const behavioralGroups = summarizeDigestGroups(
    results,
    (result) => result.caseId,
    (result) => result.behavioralDigest,
    () => campaign.cycles
  );
  const exactMismatches = exactGroups.filter((item) => !item.digestStable || !item.coverageComplete);
  const behavioralMismatches = behavioralGroups.filter((item) => !item.digestStable || !item.coverageComplete);
  add(checks, 'exact semantic digest stable within each repeated clock profile', exactMismatches.length === 0, {
    groups: exactGroups,
    mismatches: exactMismatches,
    repeatedGroups: exactGroups.filter((item) => item.executions > 1).length
  });
  add(checks, 'variation-normalized behavioral digest stable across all cycle profiles', behavioralMismatches.length === 0, {
    groups: behavioralGroups,
    mismatches: behavioralMismatches
  });
  add(checks, 'every planned result was parsed and verified', results.length === campaign.totalExecutions, {
    expected: campaign.totalExecutions,
    actual: results.length
  });

  const reportPayload = {
    reverificationVersion: APEX_WORKFLOW_REVERIFY_VERSION,
    auditVersion: APEX_WORKFLOW_AUDIT_VERSION,
    engineVersion: APEX_SCENARIO_ENGINE_VERSION,
    runRoot: root,
    checkedAt: new Date().toISOString(),
    status: checks.every((item) => item.pass) ? 'passed' : 'failed',
    checkCount: checks.length,
    passed: checks.filter((item) => item.pass).length,
    failed: checks.filter((item) => !item.pass).length,
    corpusSha256: fingerprint?.corpusSha256 ?? null,
    campaignSha256: campaign.campaignSha256,
    finalLedgerHash: previousHash,
    resultCount: results.length,
    retainedArtifactVerifications,
    compactedArtifactVerifications,
    exactSemanticDigestGroups: exactGroups,
    behavioralDigestGroups: behavioralGroups,
    checks
  };
  const report = {
    ...reportPayload,
    reportSha256: sha256Json({ ...reportPayload, checkedAt: undefined })
  };
  await writeJson(join(root, 'reverification.json'), report);
  await writeFile(join(root, 'reverification.md'), renderMarkdown(report), 'utf8');
  return report;
}

function independentlyVerifyFaultConsumption(result, testCase, journalRecords) {
  const expectedFaults = new Map((testCase.faultPlan ?? []).map((fault) => [fault.faultId, fault]));
  const evidence = result.faultEvidence ?? [];
  const evidenceIds = evidence.map((fault) => fault.faultId);
  const receiptByFault = new Map();
  for (const receipt of result.operationReceipts ?? []) {
    for (const faultId of receipt.faultIds ?? []) {
      if (!receiptByFault.has(faultId)) receiptByFault.set(faultId, []);
      receiptByFault.get(faultId).push(receipt);
    }
  }
  const journalFaults = new Map();
  for (const record of journalRecords.filter((item) => String(item.event ?? '').startsWith('fault:'))) {
    const faultId = String(record.event).slice('fault:'.length);
    if (!journalFaults.has(faultId)) journalFaults.set(faultId, []);
    journalFaults.get(faultId).push(record);
  }
  const failures = [];
  if (evidence.length !== expectedFaults.size || new Set(evidenceIds).size !== expectedFaults.size) {
    failures.push('fault-evidence-cardinality-or-uniqueness');
  }
  for (const item of evidence) {
    const expected = expectedFaults.get(item.faultId);
    const receipts = receiptByFault.get(item.faultId) ?? [];
    const journal = journalFaults.get(item.faultId) ?? [];
    if (!expected) failures.push(`${item.faultId}:undeclared`);
    else if (item.target !== expected.target
      || item.phase !== expected.phase
      || item.effectKind !== expected.effect.kind
      || (item.effectCode ?? null) !== (expected.effect.code ?? null)) failures.push(`${item.faultId}:metadata-mismatch`);
    if (item.consumed !== 1 || item.applied !== true) failures.push(`${item.faultId}:not-consumed-once`);
    if (!Number.isInteger(item.consumedAtCall) || !item.consumedAtOperationId) failures.push(`${item.faultId}:missing-consumption-receipt`);
    if (receipts.length !== 1
      || receipts[0].operationId !== item.consumedAtOperationId
      || receipts[0].callNumber !== item.consumedAtCall
      || receipts[0].target !== item.target) failures.push(`${item.faultId}:operation-receipt-mismatch`);
    if (journal.length !== 1
      || journal[0].operationId !== item.consumedAtOperationId
      || journal[0].callNumber !== item.consumedAtCall
      || journal[0].target !== item.target) failures.push(`${item.faultId}:journal-receipt-mismatch`);
  }
  for (const faultId of expectedFaults.keys()) {
    if (!evidenceIds.includes(faultId)) failures.push(`${faultId}:missing`);
  }
  return { pass: failures.length === 0, declared: expectedFaults.size, evidenced: evidence.length, failures };
}

function independentlyVerifyTracePurity(result, testCase, journalRecords) {
  const supplements = result.scriptedTraceSupplements ?? {};
  const receiptCounts = countBy(result.operationReceipts ?? [], (item) => item.target);
  const expectedCounts = testCase.expected?.exactCallCounts ?? {};
  const journalEvents = journalRecords.map((item) => item.event);
  const eventTraceMatches = stableStringifyApexWorkflow(journalEvents)
    === stableStringifyApexWorkflow(result.events ?? []);
  const suspiciousEvents = (result.events ?? []).filter((event) => /synthetic|supplement|fabricat/iu.test(String(event)));
  const failures = [];
  if (Object.keys(supplements.calls ?? {}).length > 0
    || (supplements.faults ?? []).length > 0
    || (supplements.events ?? []).length > 0) failures.push('scripted-trace-supplement-present');
  if (stableStringifyApexWorkflow(receiptCounts) !== stableStringifyApexWorkflow(result.callCounts ?? {})) {
    failures.push('call-count-does-not-match-operation-receipts');
  }
  if (stableStringifyApexWorkflow(result.callCounts ?? {}) !== stableStringifyApexWorkflow(expectedCounts)) {
    failures.push('call-count-does-not-match-declared-program');
  }
  if (!eventTraceMatches) failures.push('result-events-do-not-match-journal');
  if (suspiciousEvents.length > 0) failures.push('synthetic-event-label-present');
  return {
    pass: failures.length === 0,
    failures,
    supplements,
    receiptCounts,
    expectedCounts,
    suspiciousEvents
  };
}

function independentlyVerifyVariationNormalization(result, expected) {
  const normalization = result.variationNormalization ?? {};
  const testCase = expected.testCase;
  const baseValue = testCase.scenario?.profile?.virtualClock;
  const baseVirtualClockStart = typeof baseValue === 'object' ? baseValue?.start : baseValue;
  const executionVirtualClockStart = expected.variation.virtualClockStart;
  const expectedTranslationMs = Date.parse(executionVirtualClockStart) - Date.parse(baseVirtualClockStart);
  const allowed = testCase.category === 'privacy-lifecycle'
    ? ['/evidence/metrics/expiresAt']
    : [];
  const exactArtifacts = new Map((result.artifacts ?? []).map((item) => [item.path, item]));
  const normalizedArtifacts = normalization.artifacts ?? [];
  const failures = [];
  if (normalization.version !== APEX_VARIATION_NORMALIZATION_VERSION) failures.push('normalization-version');
  if (normalization.policy !== 'virtual-clock-translation-only') failures.push('normalization-policy');
  if (normalization.category !== testCase.category) failures.push('normalization-category');
  if (normalization.baseVirtualClockStart !== baseVirtualClockStart) failures.push('normalization-base-clock');
  if (normalization.executionVirtualClockStart !== executionVirtualClockStart) failures.push('normalization-execution-clock');
  if (normalization.translationMs !== expectedTranslationMs) failures.push('normalization-translation');
  if (stableStringifyApexWorkflow(normalization.allowedJsonPointers ?? []) !== stableStringifyApexWorkflow(allowed)) {
    failures.push('normalization-allowlist');
  }
  if (normalizedArtifacts.length !== exactArtifacts.size
    || new Set(normalizedArtifacts.map((item) => item.path)).size !== exactArtifacts.size) {
    failures.push('normalization-artifact-cardinality');
  }
  for (const artifact of normalizedArtifacts) {
    const exact = exactArtifacts.get(artifact.path);
    if (!exact
      || artifact.exactSize !== exact.size
      || artifact.exactSha256 !== exact.sha256
      || artifact.declaredExactSha256 !== exact.sha256
      || artifact.exactHashMatchesManifest !== true) failures.push(`${artifact.path}:exact-artifact-binding`);
    if (!Number.isInteger(artifact.behavioralSize)
      || artifact.behavioralSize < 0
      || !/^[a-f0-9]{64}$/u.test(String(artifact.behavioralSha256))) failures.push(`${artifact.path}:behavioral-artifact-shape`);
    const fields = artifact.normalizedFields ?? [];
    if (artifact.normalizationApplied !== (fields.length > 0)) failures.push(`${artifact.path}:normalization-applied-flag`);
    for (const field of fields) {
      if (testCase.category !== 'privacy-lifecycle'
        || !String(field).endsWith('#/evidence/metrics/expiresAt')) failures.push(`${artifact.path}:undeclared-normalized-field:${field}`);
    }
    if (fields.length === 0
      && (artifact.behavioralSize !== artifact.exactSize || artifact.behavioralSha256 !== artifact.exactSha256)) {
      failures.push(`${artifact.path}:unexplained-byte-normalization`);
    }
  }
  return {
    pass: failures.length === 0,
    failures,
    policy: normalization.policy,
    translationMs: normalization.translationMs,
    artifactCount: normalizedArtifacts.length,
    normalizedFieldCount: normalizedArtifacts.reduce((sum, item) => sum + Number(item.normalizedFields?.length ?? 0), 0)
  };
}

async function independentlyVerifyStepJournal(path, caseId, cycle) {
  const read = await readBytes(path);
  if (!read.ok) return { valid: false, byteSha256: null, finalHash: 'GENESIS', recordCount: 0, records: [], errors: [read.error] };
  const lines = read.bytes.toString('utf8').split(/\r?\n/gu).filter(Boolean);
  const records = [];
  const errors = [];
  let previousHash = 'GENESIS';
  for (const [index, line] of lines.entries()) {
    let record;
    try { record = JSON.parse(line); }
    catch (error) { errors.push({ line: index + 1, code: 'INVALID_JSON', message: error.message }); continue; }
    records.push(record);
    const unsigned = { ...record };
    delete unsigned.hash;
    if (record.sequence !== index + 1) errors.push({ line: index + 1, code: 'SEQUENCE_MISMATCH' });
    if (record.caseId !== caseId || record.cycle !== cycle) errors.push({ line: index + 1, code: 'IDENTITY_MISMATCH' });
    if (record.previousHash !== previousHash) errors.push({ line: index + 1, code: 'PREVIOUS_HASH_MISMATCH' });
    if (record.hash !== sha256Json(unsigned)) errors.push({ line: index + 1, code: 'RECORD_HASH_MISMATCH' });
    previousHash = record.hash ?? previousHash;
  }
  return {
    valid: errors.length === 0 && records.length > 0,
    byteSha256: sha256(read.bytes),
    finalHash: previousHash,
    recordCount: records.length,
    records,
    errors
  };
}

async function verifyCompactionSeal({ caseRoot, record, result, resultByteSha256, testCase }) {
  const failures = [];
  const descriptor = record.compaction;
  if (descriptor?.mode !== 'manifest-sealed'
    || descriptor.sealVersion !== APEX_WORKFLOW_COMPACTION_VERSION
    || descriptor.sealPath !== 'compaction-seal.json') {
    return { pass: false, failures: ['missing-or-invalid-compaction-descriptor'] };
  }
  const sealRead = await readBytes(join(caseRoot, descriptor.sealPath));
  if (!sealRead.ok) return { pass: false, failures: ['compaction-seal-missing'], error: sealRead.error };
  if (sha256(sealRead.bytes) !== descriptor.sealByteSha256) failures.push('seal-byte-hash-mismatch');
  let seal;
  try { seal = JSON.parse(sealRead.bytes.toString('utf8')); }
  catch (error) { return { pass: false, failures: ['compaction-seal-invalid-json'], message: error.message }; }
  const unsigned = { ...seal };
  delete unsigned.sealSha256;
  if (sha256Json(unsigned) !== seal.sealSha256 || seal.sealSha256 !== descriptor.sealSha256) failures.push('seal-payload-hash-mismatch');
  if (seal.compactionVersion !== APEX_WORKFLOW_COMPACTION_VERSION
    || seal.caseId !== result.caseId
    || seal.cycle !== result.cycle
    || seal.sequence !== result.auditExecution?.sequence) failures.push('seal-identity-mismatch');
  if (seal.resultSha256 !== resultByteSha256) failures.push('seal-result-hash-mismatch');
  if (seal.resultSemanticDigest !== result.semanticDigest) failures.push('seal-semantic-digest-mismatch');
  if (seal.resultBehavioralDigest !== result.behavioralDigest) failures.push('seal-behavioral-digest-mismatch');
  if (seal.variationNormalizationSha256 !== sha256Json(result.variationNormalization ?? null)) {
    failures.push('seal-variation-normalization-mismatch');
  }
  if (seal.stepJournalSha256 !== result.stepJournal?.byteSha256) failures.push('seal-journal-hash-mismatch');
  if (seal.resultArtifactManifestSha256 !== manifestDigest(result.artifacts ?? [])) failures.push('seal-artifact-manifest-mismatch');
  if (seal.resultInputManifestSha256 !== manifestDigest(result.inputEvidence?.after ?? [])) failures.push('seal-input-manifest-mismatch');
  if (seal.workspaceManifestSha256 !== manifestDigest(seal.workspaceManifest ?? [])
    || seal.workspaceManifestSha256 !== descriptor.workspaceManifestSha256) failures.push('seal-workspace-manifest-mismatch');
  const declaredInputPaths = new Set(Object.keys(testCase.inputs ?? {}).map(normalizeRelativePath));
  const sealedOutputs = (seal.workspaceManifest ?? []).filter((item) => !declaredInputPaths.has(item.path));
  if (stableStringifyApexWorkflow(sealedOutputs) !== stableStringifyApexWorkflow(result.artifacts ?? [])) {
    failures.push('sealed-artifacts-do-not-match-result');
  }
  const expectedPaths = (testCase.expected?.files ?? []).filter((item) => !item.absent && !item.mustBeAbsent).map((item) => normalizeRelativePath(item.path));
  const absentPaths = (testCase.expected?.files ?? []).filter((item) => item.absent || item.mustBeAbsent).map((item) => normalizeRelativePath(item.path));
  const sealedPaths = new Set((seal.workspaceManifest ?? []).map((item) => item.path));
  if (!expectedPaths.every((path) => sealedPaths.has(path))) failures.push('expected-sealed-artifact-path-missing');
  if (!absentPaths.every((path) => !sealedPaths.has(path))) failures.push('forbidden-sealed-artifact-path-present');
  if ((seal.workspaceManifest ?? []).some((item) => !isSafeRelative(item.path) || !/^[a-f0-9]{64}$/u.test(String(item.sha256)))) {
    failures.push('unsafe-or-unhashed-sealed-artifact');
  }
  return {
    pass: failures.length === 0,
    failures,
    sealSha256: seal.sealSha256,
    workspaceManifestSha256: seal.workspaceManifestSha256,
    artifactCount: sealedOutputs.length,
    verificationMode: 'hash-chain-bound-compaction-manifest'
  };
}

function deriveExpectedCycleVariation(selected, cycle, seed) {
  const ids = selected.map((item) => item.id);
  const offset = cycle === 1 ? 0 : deterministicInteger(`${seed}:cycle:${cycle}:offset`, ids.length);
  const direction = cycle === 1 || deterministicInteger(`${seed}:cycle:${cycle}:direction`, 2) === 0 ? 'forward' : 'reverse';
  const rotated = [...ids.slice(offset), ...ids.slice(0, offset)];
  const executionOrder = direction === 'reverse' ? rotated.reverse() : rotated;
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
    virtualClockStart: new Date(Date.parse(APEX_WORKFLOW_VIRTUAL_CLOCK.start) + virtualClockOffsetMs).toISOString()
  };
  return { ...payload, variationSha256: sha256Json(payload) };
}

function buildExpectedPlan(selected, variations) {
  const byId = new Map(selected.map((item) => [item.id, item]));
  const plan = [];
  for (const variation of variations) {
    for (const [index, caseId] of variation.executionOrder.entries()) {
      plan.push({ sequence: plan.length + 1, cycle: variation.cycle, orderIndex: index + 1, testCase: byId.get(caseId), variation });
    }
  }
  return plan;
}

function campaignHashPayload(campaign) {
  const payload = { ...campaign };
  delete payload.campaignSha256;
  delete payload.generatedAt;
  return payload;
}

async function independentlyCreateImplementationManifest() {
  const files = [];
  for (const entry of IMPLEMENTATION_FILES) {
    const bytes = await readFile(resolve(PROJECT_ROOT, entry.path));
    files.push({ role: entry.role, path: entry.path, size: bytes.length, sha256: sha256(bytes) });
  }
  const payload = { version: APEX_WORKFLOW_IMPLEMENTATION_MANIFEST_VERSION, files };
  return { ...payload, manifestSha256: sha256Json(payload) };
}

function implementationPathsValid(manifest) {
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length !== IMPLEMENTATION_FILES.length) return false;
  const paths = manifest.files.map((item) => item.path);
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  return stableStringifyApexWorkflow(paths) === stableStringifyApexWorkflow(sorted)
    && new Set(paths).size === paths.length
    && manifest.files.every((item) => isSafeRelative(item.path)
      && !item.path.includes('\\')
      && /^[a-f0-9]{64}$/u.test(String(item.sha256))
      && Number.isInteger(item.size)
      && item.size > 0);
}

function parseCanonicalCorpus(fingerprint) {
  if (fingerprint.canonicalJson) return JSON.parse(fingerprint.canonicalJson);
  if (fingerprint.canonicalPayload) return fingerprint.canonicalPayload;
  throw new Error('APEX corpus fingerprint did not provide canonical payload.');
}

function renderMarkdown(report) {
  const failed = report.checks.filter((item) => !item.pass);
  return `# JARVIS 어나더 레벨 복합 미션 독립 재검증\n\n- 상태: ${report.status}\n- 검사: ${report.passed}/${report.checkCount}\n- 결과 수: ${report.resultCount}\n- retained artifact 재검증: ${report.retainedArtifactVerifications}\n- compacted artifact seal 재검증: ${report.compactedArtifactVerifications}\n- corpus SHA-256: \`${report.corpusSha256}\`\n- campaign SHA-256: \`${report.campaignSha256}\`\n- ledger 마지막 hash: \`${report.finalLedgerHash}\`\n- 보고서 hash: \`${report.reportSha256}\`\n\n## 실패 검사\n\n${failed.length ? failed.map((item) => `- ${item.name}: ${JSON.stringify(item.detail)}`).join('\n') : '- 없음'}\n`;
}

function resolveCaseChild(caseRoot, relativePath) {
  const root = resolve(caseRoot);
  const target = resolve(root, String(relativePath));
  const rel = relative(root, target).replaceAll('\\', '/');
  return isSafeRelative(rel) ? target : null;
}

function isSafeRelative(value) {
  const normalized = String(value).replaceAll('\\', '/');
  return normalized !== '..'
    && !normalized.startsWith('../')
    && !normalized.includes('/../')
    && !/^[A-Za-z]:\//u.test(normalized)
    && !normalized.startsWith('/');
}

function normalizeRelativePath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//u, '');
}

function deterministicInteger(material, maximum) {
  if (maximum <= 1) return 0;
  return createHash('sha256').update(material).digest().readUInt32BE(0) % maximum;
}

function add(checks, name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value?.[key]]));
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

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
async function readJsonLines(path) {
  const read = await readBytes(path);
  if (!read.ok) return { records: [], errors: [{ line: 0, ...read.error }] };
  const records = [];
  const errors = [];
  for (const [index, line] of read.bytes.toString('utf8').split(/\r?\n/gu).filter(Boolean).entries()) {
    try { records.push(JSON.parse(line)); }
    catch (error) { errors.push({ line: index + 1, code: 'INVALID_JSON', message: error.message }); }
  }
  return { records, errors };
}
async function readBytes(path) {
  try { return { ok: true, bytes: await readFile(path) }; }
  catch (error) { return { ok: false, error: { code: error.code ?? 'READ_FAILED', message: error.message } }; }
}
async function pathExists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.argv[2];
  if (!root) throw new Error('Usage: node scripts/apex-workflow-50-reverify.mjs --root <audit-root>');
  const report = await reverifyApexWorkflowAudit(root);
  console.log(`REVERIFY ${report.status.toUpperCase()} ${report.passed}/${report.checkCount}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
