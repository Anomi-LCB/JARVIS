import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  APEX_WORKFLOW_CORPUS_SHA256,
  apexCases,
  createApexWorkflowCorpusFingerprint
} from '../scripts/apex-workflow-50-cases.mjs';
import { parseApexReportArguments } from '../scripts/apex-workflow-50-report.mjs';

const execFileAsync = promisify(execFile);
const bundledPython = 'C:\\Users\\user\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
const failedIds = ['A01', 'A36'];
const probeIds = [
  'TASK_RETRY_TRANSITION_ATOMIC',
  'TASK_RETRY_BUDGET_VALIDATED',
  'QUEUE_RESERVED_METADATA_OWNED',
  'QUEUE_COLLECTION_SHAPE_FAILS_CLOSED',
  'REPORT_ID_PATH_CONFINED',
  'REPORT_RESERVED_ID_PROTECTED',
  'REPORT_SECRET_REDACTION_COMPLETE',
  'JSON_RESPONSE_HEADERS_NON_WEAKENABLE',
  'ROUTE_PARAM_ENCODED_SEPARATOR_REJECTED',
  'BULK_FILE_COMMAND_ROUTES_AS_MISSION'
];

test('APEX report aggregates degraded initial evidence, a preserved failed soak, documented fixes, 50 missions, and a bounded 99% claim', async () => {
  const fixtureParent = resolve('artifacts');
  await mkdir(fixtureParent, { recursive: true });
  const temp = await mkdtemp(join(fixtureParent, 'jarvis-apex-report-test-'));
  try {
    const initialRoot = join(temp, 'initial');
    const finalRoot = join(temp, 'final');
    const failedSoakRoot = join(temp, 'failed-soak');
    const soakRoot = join(temp, 'soak');
    const baselineRoot = join(temp, 'product-baseline');
    const retestRoot = join(temp, 'product-retest');
    const outputRoot = join(temp, 'output');
    const remediationPath = join(temp, 'remediation.json');
    const verificationPath = join(temp, 'final-verification.json');
    await writeCampaign(initialRoot, { cycles: 1, failureIds: failedIds, invalidCorpus: true, reverify: false });
    await writeCampaign(finalRoot, { cycles: 1, failureIds: [], invalidCorpus: false, reverify: true });
    await writeCampaign(failedSoakRoot, {
      cycles: 2,
      failureIds: [],
      contractFailureIds: ['A36', 'A37', 'A38', 'A39', 'A40'],
      invalidCorpus: false,
      reverify: true,
      reverifyFailed: 1
    });
    await writeCampaign(soakRoot, {
      cycles: 20,
      failureIds: [],
      invalidCorpus: false,
      reverify: true,
      dualDigestProfiles: 5
    });
    await writeProductProbe(baselineRoot, false);
    await writeProductProbe(retestRoot, true);
    await writeRemediation(remediationPath);
    await writeRepositoryVerification(temp, verificationPath);

    const reportArgs = [
      resolve('scripts/apex-workflow-50-report.mjs'),
      '--initial-root', initialRoot,
      '--final-root', finalRoot,
      '--soak-root', soakRoot,
      '--failed-soak-root', failedSoakRoot,
      '--product-baseline-root', baselineRoot,
      '--product-retest-root', retestRoot,
      '--output-root', outputRoot,
      '--remediation', remediationPath,
      '--verification', verificationPath
    ];
    const result = await execFileAsync(process.execPath, reportArgs, { cwd: resolve('.'), timeout: 30_000, windowsHide: true });
    assert.match(result.stdout, /APEX_REPORT_STATUS passed-with-explicit-scope/u);

    const data = JSON.parse(await readFile(join(outputRoot, 'report-data.json'), 'utf8'));
    const markdown = await readFile(join(outputRoot, 'report.md'), 'utf8');
    assert.equal(data.verdict.status, 'passed-with-explicit-scope');
    assert.equal(data.initialEvidenceIntegrity.status, 'degraded');
    assert.equal(data.initialEvidenceIntegrity.byteSha256, sha256(Buffer.from('undefined\n')));
    assert.equal(data.initialEvidenceIntegrity.currentSourceCorpusSha256, APEX_WORKFLOW_CORPUS_SHA256);
    assert.equal(data.evidenceDefects[0].id, 'INITIAL_CORPUS_PAYLOAD_NOT_SERIALIZED');
    assert.equal(data.evidenceDefects[0].status, 'resolved-in-final-run-original-preserved');
    assert.equal(data.progression.initial.behavioralPass, 48);
    assert.equal(data.progression.final.behavioralPass, 50);
    assert.equal(data.progression.soak.behavioralPass, 1000);
    assert.equal(data.progression.failedSoak.behavioralPass, 100);
    assert.equal(data.progression.failedSoak.contractPass, 90);
    assert.equal(data.failedSoakFinding.contractFailed, 10);
    assert.deepEqual(data.failedSoakFinding.affectedCases, ['A36', 'A37', 'A38', 'A39', 'A40']);
    assert.equal(data.failedSoakFinding.failedContract, 'semantic-digest-unstable-across-cycles');
    assert.equal(data.failedSoakFinding.reverification.failed, 1);
    assert.equal(data.failedSoakFinding.status, 'resolved-and-regression-covered');
    assert.equal(data.failedSoakFinding.documentationStatus, 'documented');
    assert.equal(data.failedSoakFinding.regressionPassed, true);
    assert.equal(data.corpus.commandCount, 50);
    assert.equal(data.corpus.categoryCount, 10);
    assert.equal(data.corpus.commands[0].id, 'A01');
    assert.equal(data.corpus.commands.at(-1).id, 'A50');
    assert.ok(data.corpus.commands.every((item) => item.stepCount >= 6 && item.faultCount >= 2));
    assert.deepEqual(data.initialFailureRepairs.map((item) => item.caseId), failedIds);
    assert.ok(data.initialFailureRepairs.every((item) => item.remediation.documentationStatus === 'documented'));
    assert.ok(data.initialFailureRepairs.every((item) => item.resolutionStatus === 'resolved-and-regression-covered'));
    assert.equal(data.productResilience.baseline.passed, 0);
    assert.equal(data.productResilience.retest.passed, 10);
    assert.equal(data.productResilience.resolvedCount, 10);
    assert.equal(data.repositoryVerification.status, 'passed');
    assert.equal(data.repositoryVerification.passed, 4);
    assert.deepEqual(data.repositoryVerification.gates.map((item) => item.id), [
      'focused-regression-tests',
      'product-resilience-probe-v2',
      'full-repository-tests',
      'production-build'
    ]);
    assert.equal(data.verdict.repositoryVerificationPassed, true);
    assert.equal(data.verdict.repositoryRegressionGroupsPassed, true);
    assert.equal(data.verdict.unresolvedRepositoryRegressionGroupCount, 0);
    assert.deepEqual(data.repositoryRegressionGroups.map((item) => item.id), [
      'WORKER_QUEUE_PARTIAL_SNAPSHOT_COMPAT',
      'REPORT_ID_UNICODE_STORAGE_COMPAT'
    ]);
    assert.ok(data.repositoryRegressionGroups.every((item) => item.status === 'resolved-and-regression-covered'));
    assert.deepEqual(data.repositoryRegressionGroups[0].verificationGateIds, ['focused-regression-tests', 'full-repository-tests']);
    assert.deepEqual(data.repositoryRegressionGroups[0].verificationGates.map((item) => item.status), ['passed', 'passed']);
    assert.equal(data.statistics.sampleSize, 1000);
    assert.ok(Math.abs(data.statistics.oneSided99PercentSuccessRateLowerBound - Math.pow(0.01, 1 / 1000)) < 1e-15);
    assert.equal(data.statistics.exceeds99PercentLowerBound, true);
    assert.equal(data.independentReverification.soak.retainedWorkspaceArtifactVerifications, 50);
    assert.equal(data.independentReverification.soak.compactedHashChainSealVerifications, 950);
    assert.equal(data.independentReverification.soak.artifactVerificationCoverageComplete, true);
    assert.ok(data.evidenceFiles.length >= 28);
    assert.ok(data.evidenceFiles.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256)));
    assert.match(markdown, /최초 corpus 증거 직렬화 결함/u);
    assert.match(markdown, /교정 전 반복 계약 실패와 솔루션/u);
    assert.match(markdown, /semantic-digest-unstable-across-cycles/u);
    assert.match(markdown, /저장소 전체 회귀 검증/u);
    assert.match(markdown, /저장소 회귀 원인·해결·재검증 추적/u);
    assert.match(markdown, /WORKER_QUEUE_PARTIAL_SNAPSHOT_COMPAT/u);
    assert.match(markdown, /REPORT_ID_UNICODE_STORAGE_COMPAT/u);
    assert.match(markdown, /retained workspace 직접 재검증/u);
    assert.match(markdown, /hash-chain-bound compacted seal/u);
    assert.match(markdown, /OS 전체 프로세스의 네트워크 무접속/u);
    assert.match(markdown, /### A50 —/u);
    assert.match(markdown, /유한하고 결정론적인 격리 시험/u);

    const docxPath = join(temp, 'apex-report.docx');
    const structureQaPath = join(temp, 'docx-structure-qa.json');
    await execFileAsync(bundledPython, [
      resolve('scripts/build-apex-workflow-50-docx.py'),
      join(outputRoot, 'report-data.json'),
      docxPath
    ], { cwd: resolve('.'), timeout: 60_000, windowsHide: true });
    await execFileAsync(bundledPython, [
      resolve('scripts/qa-apex-workflow-docx-structure.py'),
      docxPath,
      join(outputRoot, 'report-data.json'),
      structureQaPath
    ], { cwd: resolve('.'), timeout: 60_000, windowsHide: true });
    const structureQa = JSON.parse(await readFile(structureQaPath, 'utf8'));
    assert.equal(structureQa.status, 'passed');
    assert.equal(structureQa.appendixCommandCount, 50);
    assert.equal(structureQa.repeatingHeaderRows, structureQa.tableCount);

    const tamperedReportData = { ...data, verdict: { ...data.verdict, status: 'tampered' } };
    const tamperedReportDataPath = join(temp, 'tampered-report-data.json');
    await writeFile(tamperedReportDataPath, `${JSON.stringify(tamperedReportData, null, 2)}\n`, 'utf8');
    await assert.rejects(
      execFileAsync(bundledPython, [
        resolve('scripts/build-apex-workflow-50-docx.py'),
        tamperedReportDataPath,
        join(temp, 'tampered-report.docx')
      ], { cwd: resolve('.'), timeout: 60_000, windowsHide: true }),
      /Report data SHA-256 mismatch/u
    );

    const verificationBytes = await readFile(verificationPath);
    const verificationWithoutBuild = JSON.parse(verificationBytes.toString('utf8'));
    verificationWithoutBuild.gates.find((gate) => gate.id === 'production-build').command = 'node scripts/noop.mjs';
    verificationWithoutBuild.reportSha256 = sha256Json({
      ...verificationWithoutBuild,
      generatedAt: undefined,
      reportSha256: undefined
    });
    await writeFile(verificationPath, `${JSON.stringify(verificationWithoutBuild, null, 2)}\n`, 'utf8');
    await assert.rejects(
      execFileAsync(process.execPath, reportArgs, { cwd: resolve('.'), timeout: 30_000, windowsHide: true }),
      /missing the required production-build gate/u
    );
    await writeFile(verificationPath, verificationBytes);

    await writeFile(join(temp, 'verification-evidence', 'full-repository-tests.json'), '{"tampered":true}\n', 'utf8');
    await assert.rejects(
      execFileAsync(process.execPath, reportArgs, { cwd: resolve('.'), timeout: 30_000, windowsHide: true }),
      /gate full-repository-tests evidence SHA-256 mismatch/u
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('APEX report parser accepts every evidence root and the remediation ledger', () => {
  assert.deepEqual(parseApexReportArguments([
    '--initial-root', 'i',
    '--final-root', 'f',
    '--soak-root', 's',
    '--failed-soak-root', 'fs',
    '--product-baseline-root', 'pb',
    '--product-retest-root', 'pr',
    '--output-root', 'o',
    '--remediation', 'r',
    '--verification', 'v'
  ]), {
    initialRoot: 'i',
    finalRoot: 'f',
    soakRoot: 's',
    failedSoakRoot: 'fs',
    productBaselineRoot: 'pb',
    productRetestRoot: 'pr',
    outputRoot: 'o',
    remediationPath: 'r',
    verificationPath: 'v'
  });
  assert.throws(() => parseApexReportArguments(['--unknown', 'value']), /Unknown argument/u);
  assert.throws(() => parseApexReportArguments(['--final-root']), /Missing value/u);
});

test('APEX report fails clearly when required campaign evidence is missing', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'jarvis-apex-report-missing-'));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        resolve('scripts/apex-workflow-50-report.mjs'),
        '--initial-root', join(temp, 'missing-initial'),
        '--final-root', join(temp, 'missing-final'),
        '--soak-root', join(temp, 'missing-soak'),
        '--product-baseline-root', join(temp, 'missing-product-baseline'),
        '--product-retest-root', join(temp, 'missing-product-retest'),
        '--output-root', join(temp, 'output')
      ], { cwd: resolve('.'), timeout: 30_000, windowsHide: true }),
      /Required evidence file is missing/u
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

async function writeCampaign(root, {
  cycles,
  failureIds,
  contractFailureIds = [],
  invalidCorpus,
  reverify,
  reverifyFailed = 0,
  dualDigestProfiles = 0
}) {
  await mkdir(root, { recursive: true });
  const fingerprint = createApexWorkflowCorpusFingerprint(apexCases);
  const corpus = JSON.parse(fingerprint.canonicalJson);
  const campaign = {
    auditVersion: 'jarvis-apex-workflow-50-audit-fixture-v1',
    corpusVersion: corpus.schemaVersion,
    fullCorpusSha256: fingerprint.corpusSha256,
    selectedCorpusSha256: fingerprint.corpusSha256,
    seed: corpus.seed,
    virtualClock: corpus.virtualClock,
    isolation: corpus.isolation,
    cycles,
    selectedCaseIds: apexCases.map((item) => item.id),
    totalExecutions: cycles * apexCases.length,
    generatedAt: '2026-09-04T00:00:00.000Z'
  };
  if (dualDigestProfiles > 0) {
    campaign.cycleVariations = Array.from({ length: cycles }, (_, index) => {
      const profileIndex = index % dualDigestProfiles;
      const variation = {
        cycle: index + 1,
        executionOrder: apexCases.map((item) => item.id),
        virtualClockProfileId: `clock-profile-${profileIndex + 1}`,
        virtualClockStart: new Date(Date.parse('2026-12-01T00:00:00.000Z') + profileIndex * 137_000).toISOString()
      };
      return { ...variation, variationSha256: sha256Json(variation) };
    });
  }

  const ledger = [];
  let previousHash = 'GENESIS';
  let sequence = 0;
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    for (const [orderIndex, item] of apexCases.entries()) {
      sequence += 1;
      const failed = cycle === 1 && failureIds.includes(item.id);
      const contractFailed = contractFailureIds.includes(item.id);
      const variation = campaign.cycleVariations?.[cycle - 1] ?? null;
      const exactProfile = variation?.virtualClockProfileId ?? null;
      let resultBytes = Buffer.from(JSON.stringify({ caseId: item.id, cycle, behavioralPass: !failed }));
      if (failed) {
        const result = {
          caseId: item.id,
          cycle,
          outcome: 'FAILED',
          behavioralPass: false,
          terminalState: item.expected.terminalState,
          stopCode: item.expected.stopCode,
          assertions: item.id === 'A01'
            ? [{ name: 'virtual time budget enforced', pass: false, detail: { elapsed: 420000, maximum: 120000 } }]
            : [{ name: 'category handler completed', pass: false, detail: {} }],
          engineError: item.id === 'A36'
            ? { name: 'Error', code: 'APEX_ERROR', message: 'apex-archive-input-missing:records.json' }
            : null
        };
        resultBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
        const resultPath = join(root, `cycle-${String(cycle).padStart(2, '0')}`, item.id, 'result.json');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, resultBytes);
      }
      const unsigned = {
        sequence,
        cycle,
        ...(variation ? { orderIndex: orderIndex + 1, variationSha256: variation.variationSha256 } : {}),
        caseId: item.id,
        outcome: failed ? 'FAILED' : item.expected.outcome,
        terminalState: item.expected.terminalState,
        resultSha256: sha256(resultBytes),
        semanticDigest: contractFailed
          ? `semantic-${item.id}-cycle-${cycle}`
          : exactProfile
            ? `semantic-${item.id}-${exactProfile}`
            : `semantic-${item.id}`,
        ...(dualDigestProfiles > 0 ? { behavioralDigest: `behavioral-${item.id}` } : {}),
        previousHash
      };
      const record = { ...unsigned, hash: sha256Json(unsigned) };
      ledger.push(record);
      previousHash = record.hash;
    }
  }

  const failedCases = failureIds.map((caseId) => {
    const item = apexCases.find((candidate) => candidate.id === caseId);
    return {
      cycle: 1,
      caseId,
      terminalState: item.expected.terminalState,
      stopCode: item.expected.stopCode,
      failedAssertions: caseId === 'A01' ? ['virtual time budget enforced'] : ['category handler completed'],
      engineError: caseId === 'A36' ? { name: 'Error', code: 'APEX_ERROR', message: 'apex-archive-input-missing:records.json' } : null
    };
  });
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    for (const caseId of contractFailureIds) {
      const item = apexCases.find((candidate) => candidate.id === caseId);
      failedCases.push({
        cycle,
        caseId,
        terminalState: item.expected.terminalState,
        stopCode: item.expected.stopCode,
        contractFailures: ['semantic-digest-unstable-across-cycles'],
        failedAssertions: [],
        engineError: null
      });
    }
  }
  const failed = failedCases.length;
  const behavioralFailures = failureIds.length;
  const total = campaign.totalExecutions;
  const summary = {
    summaryVersion: 'jarvis-apex-workflow-50-summary-fixture-v1',
    auditVersion: campaign.auditVersion,
    campaign,
    updatedAt: '2026-09-04T00:01:00.000Z',
    totalExecutions: total,
    behavioralPass: total - behavioralFailures,
    contractPass: total - failed,
    failed,
    outcomes: countBy(ledger, (item) => item.outcome),
    terminalStates: countBy(ledger, (item) => item.terminalState),
    realExternalAttempts: 0,
    realExternalCommits: 0,
    faultCount: apexCases.reduce((sum, item) => sum + item.faultPlan.length, 0) * cycles,
    scriptedTraceSupplements: { callKinds: 0, callUnits: 0, faults: 0, events: 0 },
    faultConsumptionFailures: [],
    semanticDigestMismatches: contractFailureIds.map((caseId) => ({
      caseId,
      digests: Array.from({ length: cycles }, (_, index) => `semantic-${caseId}-cycle-${index + 1}`)
    })),
    ...(dualDigestProfiles > 0 ? {
      exactSemanticDigestMismatches: [],
      behavioralDigestMismatches: [],
      stabilityContract: {
        exactDigestScope: 'caseId + execution virtualClockStart; authenticates exact artifact bytes',
        behavioralDigestScope: 'caseId across all declared cycle variations; only engine-declared virtual-clock translation is normalized',
        virtualClockProfileCount: dualDigestProfiles
      }
    } : {}),
    failedCases,
    statistics: {
      confidence: 0.99,
      sampleSize: total,
      observedFailures: failed,
      oneSided99PercentSuccessRateLowerBound: failed === 0 ? Math.pow(0.01, 1 / total) : null
    }
  };
  summary.summarySha256 = sha256Json({ ...summary, updatedAt: undefined, summarySha256: undefined });

  await Promise.all([
    writeFile(join(root, 'campaign.json'), `${JSON.stringify(campaign, null, 2)}\n`, 'utf8'),
    writeFile(join(root, 'corpus.json'), invalidCorpus ? 'undefined\n' : `${JSON.stringify(corpus, null, 2)}\n`, 'utf8'),
    writeFile(join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
    writeFile(join(root, 'sequence-ledger.jsonl'), `${ledger.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8')
  ]);
  if (reverify) {
    const checkCount = total * 10 + 5;
    const retainedArtifactVerifications = Math.min(50, total);
    const compactedArtifactVerifications = Math.max(0, total - 50);
    const checks = Array.from({ length: checkCount }, (_, index) => ({
      name: index < retainedArtifactVerifications
        ? `result ${index + 1} independent retained artifact verification`
        : index < retainedArtifactVerifications + compactedArtifactVerifications
          ? `result ${index + 1} compacted artifact seal verification`
          : `fixture check ${index + 1}`,
      pass: index < checkCount - reverifyFailed,
      detail: { fixture: true }
    }));
    const report = {
      reverificationVersion: 'jarvis-apex-workflow-50-reverify-fixture-v1',
      runRoot: root,
      checkedAt: '2026-09-04T00:02:00.000Z',
      status: reverifyFailed === 0 ? 'passed' : 'failed',
      checkCount,
      passed: checkCount - reverifyFailed,
      failed: reverifyFailed,
      corpusSha256: fingerprint.corpusSha256,
      finalLedgerHash: ledger.at(-1).hash,
      resultCount: total,
      retainedArtifactVerifications,
      compactedArtifactVerifications,
      checks
    };
    report.reportSha256 = sha256Json({ ...report, checkedAt: undefined, reportSha256: undefined });
    await writeFile(join(root, 'reverification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
}

async function writeProductProbe(root, passed) {
  await mkdir(root, { recursive: true });
  const report = {
    probeVersion: 'jarvis-apex-product-resilience-probe-v1',
    generatedAt: '2026-09-04T00:03:00.000Z',
    total: probeIds.length,
    passed: passed ? probeIds.length : 0,
    failed: passed ? 0 : probeIds.length,
    probes: probeIds.map((id) => ({ id, passed, observed: { fixture: id, state: passed ? 'after' : 'before' } }))
  };
  report.reportSha256 = sha256Json({ ...report, generatedAt: undefined, reportSha256: undefined });
  await writeFile(join(root, 'product-probe.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function writeRemediation(path) {
  const report = {
    remediationVersion: 'fixture-remediation-v1',
    initialMissionRun: {
      corpusPayload: {
        status: 'invalid',
        cause: 'The runner serialized a missing fingerprint field.',
        solution: 'The fixed runner parses canonicalJson and verifies the stored payload.'
      }
    },
    missionFailureGroups: [
      {
        id: 'MONOTONIC_TIME_ACCOUNTING',
        cases: ['A01'],
        rootCause: 'Wall clock correction consumed monotonic time.',
        solution: 'Separate wall clock jumps from elapsed time.',
        regression: 'A01 final and soak passed.'
      },
      {
        id: 'ARCHIVE_INTERNAL_ENTRY_RENDERING',
        cases: ['A36'],
        rootCause: 'The ZIP builder assumed every entry existed on disk.',
        solution: 'Render internal entries before archive assembly.',
        regression: 'A36 final and soak passed.'
      }
    ],
    soakFailureGroups: [
      {
        id: 'SEMANTIC_DIGEST_VARIATION_CONTRACT',
        cases: ['A36', 'A37', 'A38', 'A39', 'A40'],
        affectedExecutions: 10,
        symptom: 'Behavior passed while cross-cycle semantic digest equality failed.',
        rootCause: 'The contract compared clock-derived privacy expiry bytes across allowed virtual clock profiles.',
        solution: 'The semantic digest excludes profile-dependent expiry bytes and keeps invariant lifecycle semantics.',
        regression: 'The corrected soak has one stable digest per affected case and independent reverification passes.'
      }
    ],
    productProbe: {
      fixes: [{ probeIds, files: ['fixture.js'], solution: 'Apply the ten product corrections.' }]
    },
    repositoryRegressionGroups: [
      {
        id: 'WORKER_QUEUE_PARTIAL_SNAPSHOT_COMPAT',
        component: 'FileWorkerQueueStore',
        symptom: 'Legacy snapshots without queue or runs were treated as corrupt.',
        rootCause: 'Collection-shape hardening did not distinguish a missing legacy field from an explicitly malformed value.',
        solution: 'Migrate only missing queue or runs to an empty array while continuing to reject explicit non-array values.',
        files: ['packages/core/src/runtime/worker-queue-store.js'],
        regression: 'Focused compatibility probes and the full repository test suite pass.',
        verificationGateIds: ['focused-regression-tests', 'full-repository-tests']
      },
      {
        id: 'REPORT_ID_UNICODE_STORAGE_COMPAT',
        component: 'VerificationReportStore',
        symptom: 'A Korean logical report ID was rejected by an ASCII-only validator.',
        rootCause: 'The path-confinement fix coupled logical identifier validity to the physical filename alphabet.',
        solution: 'Preserve the logical ID, keep legacy ASCII filenames, and map other safe IDs to SHA-256 physical keys with confined index, cleanup, and WORM paths.',
        files: ['apps/verification/src/reports/report-store.js'],
        regression: 'Focused Unicode storage probes and the full repository test suite pass.',
        gateIds: ['focused-regression-tests', 'product-resilience-probe-v2', 'full-repository-tests']
      }
    ]
  };
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function writeRepositoryVerification(root, path) {
  const gateDefinitions = [
    {
      id: 'focused-regression-tests',
      command: 'node --test tests/worker-queue-store-regression.test.js tests/apex-product-resilience.test.js',
      summary: { tests: 61, pass: 61, fail: 0, skipped: 0 }
    },
    {
      id: 'product-resilience-probe-v2',
      command: 'node scripts/apex-product-resilience-probe.mjs',
      summary: { total: 10, pass: 10, fail: 0 }
    },
    {
      id: 'full-repository-tests',
      command: 'npm test',
      summary: { tests: 500, pass: 500, fail: 0, skipped: 0 }
    },
    {
      id: 'production-build',
      command: 'npm run build',
      summary: { outputs: 3, warnings: 0 }
    }
  ];
  const evidenceRoot = join(root, 'verification-evidence');
  await mkdir(evidenceRoot, { recursive: true });
  const gates = [];
  for (const definition of gateDefinitions) {
    const evidencePath = join(evidenceRoot, `${definition.id}.json`);
    const evidenceBytes = Buffer.from(`${JSON.stringify({ id: definition.id, status: 'passed', summary: definition.summary }, null, 2)}\n`);
    await writeFile(evidencePath, evidenceBytes);
    gates.push({
      ...definition,
      status: 'passed',
      exitCode: 0,
      evidencePath: relative(resolve('.'), evidencePath),
      evidenceSha256: sha256(evidenceBytes)
    });
  }
  const report = {
    verificationVersion: 'jarvis-apex-final-verification-v1',
    generatedAt: '2026-09-04T00:05:00.000Z',
    status: 'passed',
    total: gates.length,
    passed: gates.length,
    failed: 0,
    gates
  };
  report.reportSha256 = sha256Json({ ...report, generatedAt: undefined, reportSha256: undefined });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function countBy(items, selector) {
  const output = {};
  for (const item of items) {
    const key = selector(item);
    output[key] = (output[key] ?? 0) + 1;
  }
  return output;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(canonicalize(value)), 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
