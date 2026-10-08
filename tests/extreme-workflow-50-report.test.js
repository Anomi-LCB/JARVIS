import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { extremeCases, extremeCorpus } from '../scripts/extreme-workflow-50-cases.mjs';
import { parseReportArguments } from '../scripts/extreme-workflow-50-report.mjs';

const execFileAsync = promisify(execFile);
const failedIds = ['E30', 'E36', 'E37', 'E45', 'E49'];

test('report CLI aggregates all 50 commands, repairs, probes, and the bounded 99% claim', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'jarvis-extreme-report-'));
  try {
    const initialRoot = join(temp, 'initial');
    const intermediateRoot = join(temp, 'intermediate');
    const finalRoot = join(temp, 'final-v2');
    const soakRoot = join(temp, 'soak');
    const outputDir = join(temp, 'output');
    const baselinePath = join(temp, 'bridge-baseline.json');
    const retestPath = join(temp, 'bridge-retest.json');
    await writeCampaign(initialRoot, campaignSummary({ cycles: 1, passed: 45, failureIds: failedIds }), { reverify: false });
    await writeCampaign(intermediateRoot, campaignSummary({ cycles: 1, passed: 49, failureIds: ['E43'] }), { reverify: false });
    await writeCampaign(finalRoot, campaignSummary({ cycles: 1, passed: 50, failed: 0 }), { reverify: true });
    await writeCampaign(soakRoot, campaignSummary({ cycles: 10, passed: 500, failed: 0 }), { reverify: true });
    await writeBridgeEvidence(baselinePath, retestPath);

    await execFileAsync(process.execPath, [
      resolve('scripts/extreme-workflow-50-report.mjs'),
      '--initial-root', initialRoot,
      '--intermediate-root', intermediateRoot,
      '--final-root', finalRoot,
      '--soak-root', soakRoot,
      '--bridge-baseline', baselinePath,
      '--bridge-retest', retestPath,
      '--output-dir', outputDir
    ], { cwd: resolve('.'), timeout: 30_000, windowsHide: true });

    const data = JSON.parse(await readFile(join(outputDir, 'report-data.json'), 'utf8'));
    const markdown = await readFile(join(outputDir, 'report.md'), 'utf8');
    assert.equal(data.verdict.status, 'passed-with-explicit-scope');
    assert.equal(data.corpus.commandCount, 50);
    assert.equal(data.corpus.commands.at(-1).id, 'E50');
    assert.equal(data.corpus.faultCountPerCycle, 58);
    assert.equal(data.progression.initial.behavioralPass, 45);
    assert.equal(data.progression.final.behavioralPass, 50);
    assert.equal(data.progression.soak.behavioralPass, 500);
    assert.deepEqual(data.initialFailureRepairs.map((item) => item.caseId), failedIds);
    assert.equal(data.initialFailureRepairs.every((item) => item.finalRetest.passed === 1 && item.soakRetest.passed === 10), true);
    assert.equal(data.bridge.repairedProbeCount, 6);
    assert.equal(data.productDefects.length, 11);
    assert.equal(data.intermediatePerformanceRepair.beforeWallElapsedMs, 30283);
    assert.equal(data.intermediatePerformanceRepair.afterWallElapsedMs, 422);
    assert.equal(data.repositoryVerification.total, 727);
    assert.equal(data.statistics.exceeds99PercentLowerBound, true);
    assert.ok(Math.abs(data.statistics.oneSided99PercentSuccessRateLowerBound - 0.9908319448927676) < 1e-12);
    assert.match(data.statistics.independenceQualification, /독립 무작위 표본으로 해석하면 안 된다/u);
    assert.match(data.verdict.unsupportedClaim, /영구적으로 무결함을 보장하지 않는다/u);
    assert.match(markdown, /최초 실행: \*\*45\/50\*\*/u);
    assert.match(markdown, /10회 반복: \*\*500\/500\*\*/u);
    assert.match(markdown, /### E50 —/u);
    assert.match(markdown, /실제 Gmail 발송/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('report argument parser supports every evidence root and rejects unknown flags', () => {
  assert.deepEqual(parseReportArguments([
    '--initial-root', 'i', '--intermediate-root', 'm', '--final-root', 'f', '--soak-root', 's',
    '--bridge-baseline', 'b', '--bridge-retest', 'r', '--output-dir', 'o'
  ]), {
    initialRoot: 'i', intermediateRoot: 'm', finalRoot: 'f', soakRoot: 's',
    bridgeBaselinePath: 'b', bridgeRetestPath: 'r', outputDir: 'o'
  });
  assert.throws(() => parseReportArguments(['--unknown', 'value']), /Unknown argument/u);
  assert.throws(() => parseReportArguments(['--final-root']), /Missing value/u);
});

function campaignSummary({ cycles, passed, failureIds = [] }) {
  const total = cycles * 50;
  const failed = failureIds.length;
  const corpusSha256 = failureIds.length === 5 ? 'initial-corpus-fixture-sha' : 'final-corpus-fixture-sha';
  return {
    summaryVersion: 'fixture-summary-v1',
    auditVersion: 'fixture-audit-v1',
    campaign: {
      auditVersion: 'fixture-audit-v1',
      corpusVersion: extremeCorpus.schemaVersion,
      fullCorpusSha256: corpusSha256,
      selectedCorpusSha256: corpusSha256,
      seed: extremeCorpus.seed,
      virtualClock: extremeCorpus.virtualClock,
      isolation: extremeCorpus.isolation,
      cycles,
      selectedCaseIds: extremeCases.map((item) => item.id),
      totalExecutions: total,
      generatedAt: '2026-09-04T00:00:00.000Z'
    },
    updatedAt: '2026-09-04T00:01:00.000Z',
    totalExecutions: total,
    behavioralPass: passed,
    failed,
    outcomes: failed > 0
      ? { EXPECTED_STOP: 12, FAILED: failed, SUCCESS: total - 12 - failed }
      : { EXPECTED_STOP: 12 * cycles, SUCCESS: 38 * cycles },
    terminalStates: { BLOCKED: 12 * cycles, COMPLETED: 34 * cycles, ROLLED_BACK: 4 * cycles },
    realExternalAttempts: 0,
    realExternalCommits: 0,
    faultCount: 58 * cycles,
    faultConsumptionFailures: [],
    semanticDigestMismatches: [],
    failedCases: failureIds.map((caseId) => ({
      cycle: 1,
      caseId,
      terminalState: extremeCases.find((item) => item.id === caseId).expected.terminalState,
      stopCode: extremeCases.find((item) => item.id === caseId).expected.stopCode,
      failedAssertions: [`fixture assertion for ${caseId}`],
      engineError: null
    })),
    statistics: {
      model: 'one-sided exact binomial lower confidence bound for zero observed failures',
      confidence: 0.99,
      sampleSize: total,
      observedFailures: failed,
      oneSided99PercentSuccessRateLowerBound: failed === 0 ? Math.pow(0.01, 1 / total) : null,
      appliesTo: 'fixture'
    },
    summarySha256: `${cycles}`.repeat(64).slice(0, 64)
  };
}

async function writeCampaign(root, summary, { reverify }) {
  await mkdir(root, { recursive: true });
  const ledger = [];
  let sequence = 0;
  for (let cycle = 1; cycle <= summary.campaign.cycles; cycle += 1) {
    for (const item of extremeCases) {
      sequence += 1;
      const failed = summary.failedCases.some((failure) => failure.caseId === item.id);
      ledger.push({
        sequence,
        cycle,
        caseId: item.id,
        outcome: failed ? 'FAILED' : item.expected.outcome,
        terminalState: item.expected.terminalState,
        semanticDigest: `digest-${item.id}`,
        resultSha256: `result-${sequence}`,
        previousHash: sequence === 1 ? 'GENESIS' : `hash-${sequence - 1}`,
        hash: `hash-${sequence}`
      });
    }
  }
  await Promise.all([
    writeFile(join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
    writeFile(join(root, 'corpus.json'), `${JSON.stringify(extremeCorpus, null, 2)}\n`, 'utf8'),
    writeFile(join(root, 'sequence-ledger.jsonl'), `${ledger.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8')
  ]);
  if (reverify) {
    const checksPerResult = 10;
    const checkCount = summary.totalExecutions * checksPerResult + 5;
    await writeFile(join(root, 'reverification.json'), `${JSON.stringify({
      reverificationVersion: 'fixture-reverify-v1',
      status: 'passed',
      checkCount,
      passed: checkCount,
      failed: 0,
      resultCount: summary.totalExecutions,
      corpusSha256: summary.campaign.selectedCorpusSha256,
      finalLedgerHash: ledger.at(-1).hash,
      reportSha256: 'a'.repeat(64)
    }, null, 2)}\n`, 'utf8');
  }
  for (let cycle = 1; cycle <= summary.campaign.cycles; cycle += 1) {
    const resultRoot = join(root, `cycle-${String(cycle).padStart(2, '0')}`, 'E43');
    await mkdir(resultRoot, { recursive: true });
    const failed = summary.failedCases.some((failure) => failure.caseId === 'E43');
    await writeFile(join(resultRoot, 'result.json'), `${JSON.stringify({
      caseId: 'E43', cycle, outcome: failed ? 'FAILED' : 'SUCCESS', behavioralPass: !failed,
      terminalState: 'COMPLETED', wallElapsedMs: failed ? 30283 : summary.campaign.cycles === 1 ? 422 : 430 + cycle,
      assertions: [{ name: 'wall time budget enforced', pass: !failed, detail: { wallElapsedMs: failed ? 30283 : 422, maximum: 30000 } }]
    }, null, 2)}\n`, 'utf8');
  }
}

async function writeBridgeEvidence(baselinePath, retestPath) {
  const ids = [
    'BRIDGE_429_RETRY_AFTER',
    'BRIDGE_AUTH_REFRESH_SINGLE_FLIGHT',
    'BRIDGE_UNSAFE_RETRY_REQUIRES_IDEMPOTENCY_KEY',
    'BRIDGE_PUBLIC_REQUEST_SKIPS_TOKEN_PROVIDER',
    'BRIDGE_AUTH_AND_TRANSPORT_RETRY_BUDGETS',
    'BRIDGE_ABORTABLE_BACKOFF',
    'BRIDGE_204_EMPTY_BODY'
  ];
  const baseline = {
    reportVersion: 'fixture-bridge-v1', executionMode: 'deterministic-in-memory-fetch',
    realExternalCalls: 0, passed: 1, failed: 6,
    probes: ids.map((id) => ({ id, passed: id === 'BRIDGE_204_EMPTY_BODY', detail: { expected: id } }))
  };
  const retest = {
    ...baseline, passed: 7, failed: 0,
    probes: ids.map((id) => ({ id, passed: true, detail: { expected: id } }))
  };
  await Promise.all([
    writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8'),
    writeFile(retestPath, `${JSON.stringify(retest, null, 2)}\n`, 'utf8')
  ]);
}
