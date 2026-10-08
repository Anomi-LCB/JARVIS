import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const reportScript = resolve('scripts/complex-workflow-50-report.mjs');

test('report keeps the execution baseline separate from reruns, read-only reverification, and corrections', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'jarvis-workflow-report-'));
  try {
    const initial = join(fixture, 'initial');
    const retestA = join(fixture, 'retest-a');
    const retestB = join(fixture, 'retest-b');
    const retestC = join(fixture, 'retest-c01-later');
    await writeRun(initial, [
      caseRecord('01', 'PARTIAL', { emailExpected: true }),
      caseRecord('05', 'PARTIAL'),
      caseRecord('47', 'EXPECTED_STOP', { durationMs: 299_506 }),
      caseRecord('50', 'PARTIAL', { emailExpected: true, emailAccepted: true })
    ]);
    await writeReverification(initial, '47', 'EXPECTED_STOP', {
      suffix: '-c47-stop-report-v1',
      at: '2026-09-03T13:02:00.000Z',
      correction: correction('c47-stop-report-v1', '47')
    });
    await writeReverification(initial, '47', 'EXPECTED_STOP', { at: '2026-09-03T13:36:00.000Z' });
    await writeReverification(initial, '50', 'PARTIAL', { at: '2026-09-03T13:36:00.000Z' });

    await writeRun(retestA, [caseRecord('05', 'PARTIAL')]);
    await writeReverification(retestA, '05', 'SUCCESS', { at: '2026-09-03T14:15:00.000Z' });

    const c45Correction = correction('c45-ranking-v1', '45');
    await writeRun(retestB, [caseRecord('45', 'PARTIAL')], c45Correction);
    await writeReverification(retestB, '45', 'SUCCESS', {
      suffix: '-c45-ranking-v1',
      at: '2026-09-03T14:32:00.000Z',
      correction: c45Correction
    });
    await writeRun(retestC, [caseRecord('01', 'PARTIAL', { emailExpected: true, emailAccepted: true })]);

    await execFileAsync(process.execPath, [
      reportScript,
      '--root', initial,
      '--retest-root', retestA,
      '--retest-root', retestB,
      '--retest-root', retestC
    ]);

    const diagnosis = JSON.parse(await readFile(join(initial, 'diagnosis.json'), 'utf8'));
    assert.deepEqual(diagnosis.initialRun.counts, {
      SUCCESS: 0,
      EXPECTED_STOP: 1,
      PARTIAL: 3,
      FAILED: 0,
      NOT_RUN: 0
    });
    assert.equal(diagnosis.initialRun.evidenceKind, 'IMMUTABLE_BASELINE_EXECUTION');
    assert.equal(diagnosis.retestRuns.length, 3);
    assert.ok(diagnosis.retestRuns.every((run) => run.evidenceKind === 'ACTUAL_RERUN'));

    const links = new Map(diagnosis.retestLinks.map((item) => [item.id, item]));
    assert.equal(links.get('05').latest.outcome, 'PARTIAL');
    assert.equal(links.get('05').effectiveVerification.outcome, 'SUCCESS');
    assert.equal(links.get('05').actualExecutionChange, 'STILL_FAILING');
    assert.equal(links.get('05').readOnlyVerificationChange, 'RESOLVED_BY_READ_ONLY_REVERIFY');
    assert.equal(links.get('45').latestCorrectedVerification.correctionSet.setId, 'c45-ranking-v1');
    assert.equal(diagnosis.retestRuns[1].correctionSet.setId, 'c45-ranking-v1');
    assert.equal(links.get('47').latestVerification.correctionSet, null);
    assert.equal(links.get('47').latestCorrectedVerification.correctionSet.setId, 'c47-stop-report-v1');
    assert.equal(links.get('47').effectiveVerification.outcome, 'EXPECTED_STOP');
    assert.equal(links.get('01').retests.length, 1);
    assert.equal(links.get('01').latest.outcome, 'PARTIAL');
    assert.equal(links.get('50').retests.length, 0);
    assert.equal(links.get('50').effectiveVerification.outcome, 'PARTIAL');
    assert.equal(links.get('50').actualExecutionChange, 'NOT_RETESTED');
    assert.deepEqual(diagnosis.closureAssessment.counts, {
      SUCCESS: 1,
      EXPECTED_STOP: 1,
      HISTORICAL_PARTIAL: 2,
      FAILED: 0
    });
    assert.deepEqual(diagnosis.closureAssessment.historicalPartialCaseIds, ['01', '50']);

    const report = await readFile(join(initial, 'report.md'), 'utf8');
    assert.match(report, /불변 기준선/u);
    assert.match(report, /실제 재시험 원시 판정 비통과/u);
    assert.match(report, /읽기 전용 재검증에서 통과/u);
    assert.match(report, /c45-ranking-v1/u);
    assert.match(report, /c47-stop-report-v1/u);
    assert.match(report, /실제 재시험이 없는 최초 비통과 사례\(C50\)/u);
    assert.match(report, /수정 후 종합 판정/u);
    assert.match(report, /감사 범위와 남은 설계 한계/u);
    assert.match(report, /역사적 전체 흐름 부분 성공 \| 2/u);
    assert.match(report, /\| 최초 실행 \| C50 \|[^\n]+\| 확인 \|/u);
    assert.match(report, /\| 실제 재시험 3 \| C01 \|[^\n]+\| 확인 \|/u);
    assert.match(report, /5분 0초/u);
    assert.doesNotMatch(report, /4분 60초/u);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

function caseRecord(id, outcome, { emailExpected = false, emailAccepted = false, durationMs = 1000 } = {}) {
  const emailAction = emailAccepted ? {
    actionId: `email-${id}`,
    order: 1,
    status: 'succeeded',
    expectedToolName: 'email.send',
    actualToolName: 'email.send',
    authorizationMode: 'trusted-owner-self-email',
    arguments: {
      recipientMode: 'self',
      attachments: [{
        attachmentRef: { rootIndex: 0, relativePath: `case-${id}.zip` },
        attachmentSha256: 'd'.repeat(64)
      }]
    }
  } : null;
  const emailObservation = emailAccepted ? {
    toolName: 'email.send',
    outcome: 'succeeded',
    data: {
      email: {
        passed: true,
        providerAccepted: true,
        recipientMatched: true,
        acceptedRecipientCount: 1,
        rejectedRecipientCount: 0,
        attachmentCount: 1,
        attachmentSha256s: ['d'.repeat(64)],
        providerMessageIdSha256: 'e'.repeat(64),
        deduplicated: false
      }
    }
  } : null;
  return {
    id,
    title: `case-${id}`,
    category: 'fixture',
    command: `run ${id}`,
    outcome,
    missionStatus: outcome === 'EXPECTED_STOP' ? 'WAITING_APPROVAL' : 'COMPLETED',
    startedAt: `2026-09-03T12:${id.padStart(2, '0')}:00.000Z`,
    finishedAt: `2026-09-03T12:${id.padStart(2, '0')}:01.000Z`,
    durationMs,
    assertions: [{ check: 'fixture', pass: outcome !== 'PARTIAL' }],
    mission: {
      status: outcome === 'EXPECTED_STOP' ? 'WAITING_APPROVAL' : 'COMPLETED',
      waves: emailAction ? [{ waveIndex: 1, actions: [emailAction] }] : [],
      observations: emailObservation ? [emailObservation] : []
    },
    tasks: [],
    artifacts: [],
    emailExpected
  };
}

async function writeRun(root, cases, correctionSet = null) {
  await mkdir(root, { recursive: true });
  const corpus = {
    corpusSha256: 'a'.repeat(64),
    cases: cases.map((item) => ({
      id: item.id,
      title: item.title,
      category: item.category,
      command: item.command,
      allowExternalSend: item.emailExpected === true,
      expected: {
        status: item.outcome === 'EXPECTED_STOP' ? 'EXPECTED_STOP' : 'SUCCESS',
        ...(item.emailExpected ? { email: { attachmentCount: 1 } } : {})
      }
    })),
    ...(correctionSet ? { correctionSet } : {})
  };
  const counts = { SUCCESS: 0, EXPECTED_STOP: 0, PARTIAL: 0, FAILED: 0 };
  for (const item of cases) counts[item.outcome] += 1;
  const summary = {
    summaryVersion: 'fixture-v1',
    corpusSha256: corpus.corpusSha256,
    corpusFileSha256: 'b'.repeat(64),
    selectedCaseCount: cases.length,
    completedResultCount: cases.length,
    pendingCaseIds: [],
    counts,
    results: cases.map((item) => ({ id: item.id, resultPath: `${item.id}/result.json` })),
    ...(correctionSet ? { correctionSet } : {})
  };
  await writeFile(join(root, 'corpus.json'), JSON.stringify(corpus), 'utf8');
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary), 'utf8');
  for (const item of cases) {
    await mkdir(join(root, item.id), { recursive: true });
    await writeFile(join(root, item.id, 'result.json'), JSON.stringify(item), 'utf8');
  }
}

async function writeReverification(root, id, outcome, { suffix = '', at, correction: correctionSet = null }) {
  const original = JSON.parse(await readFile(join(root, id, 'result.json'), 'utf8'));
  const document = {
    validatorVersion: 'fixture-validator-v1',
    assertionEngineVersion: 'fixture-assertions-v1',
    reverifiedAt: at,
    id,
    originalOutcome: original.outcome,
    outcome,
    outcomeChanged: original.outcome !== outcome,
    evidenceSource: {
      missionExecuted: false,
      externalCallsMade: false,
      emailActionsExecuted: false
    },
    specificationCorrection: correctionSet
  };
  await writeFile(join(root, id, `result-reverified${suffix}.json`), JSON.stringify(document), 'utf8');
  const summary = {
    reverifiedAt: at,
    selectedCaseIds: [id],
    counts: {
      SUCCESS: outcome === 'SUCCESS' ? 1 : 0,
      EXPECTED_STOP: outcome === 'EXPECTED_STOP' ? 1 : 0,
      PARTIAL: outcome === 'PARTIAL' ? 1 : 0,
      FAILED: outcome === 'FAILED' ? 1 : 0
    },
    executionPolicy: {
      sourceResultsReadOnly: true,
      missionExecuted: false,
      externalCallsMade: false,
      emailActionsExecuted: false
    },
    specificationCorrection: correctionSet
  };
  await writeFile(join(root, `reverification-summary${suffix}.json`), JSON.stringify(summary), 'utf8');
}

function correction(setId, id) {
  return {
    setId,
    description: `${id} fixture correction`,
    appliedCaseIds: [id],
    definitionSha256: 'c'.repeat(64)
  };
}
