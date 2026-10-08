import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  COMPLEX_WORKFLOW_50_AUDIT_VERSION,
  createComplexWorkflowCorpusFingerprint
} from '../scripts/complex-workflow-50-audit.mjs';
import {
  REVERIFICATION_VALIDATOR_VERSION,
  reverifyRun
} from '../scripts/complex-workflow-50-reverify.mjs';
import { cases } from '../scripts/complex-workflow-50-cases.mjs';
import { applyComplexWorkflowCorrectionSet } from '../scripts/complex-workflow-50-corrections.mjs';

test('reverification independently writes new evidence while preserving source result bytes', async () => {
  const fixture = await createSourceRun('25');
  try {
    const originalBytes = await readFile(fixture.resultPath);
    const summary = await reverifyRun({
      root: fixture.root,
      caseIds: ['25'],
      now: () => new Date('2026-09-03T10:00:00.000Z')
    });
    const reverified = JSON.parse(await readFile(join(fixture.root, '25', 'result-reverified.json'), 'utf8'));
    const storedSummary = JSON.parse(await readFile(join(fixture.root, 'reverification-summary.json'), 'utf8'));

    assert.deepEqual(await readFile(fixture.resultPath), originalBytes);
    assert.equal(reverified.originalResultSha256, digest(originalBytes));
    assert.equal(reverified.validatorVersion, REVERIFICATION_VALIDATOR_VERSION);
    assert.equal(reverified.assertionEngineVersion, COMPLEX_WORKFLOW_50_AUDIT_VERSION);
    assert.equal(reverified.sourceRun.resultPath, '25/result.json');
    assert.equal(reverified.evidenceSource.missionExecuted, false);
    assert.equal(reverified.evidenceSource.externalCallsMade, false);
    assert.equal(reverified.evidenceSource.emailActionsExecuted, false);
    assert.equal(reverified.assertions.some((item) => item.code === 'REVERIFY_WORKSPACE_IMMUTABLE' && item.pass), true);
    assert.deepEqual(summary.selectedCaseIds, ['25']);
    assert.deepEqual(storedSummary.results, summary.results);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('reverification rejects a corpus definition mismatch before writing outputs', async () => {
  const fixture = await createSourceRun('25');
  try {
    const corpusPath = join(fixture.root, 'corpus.json');
    const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
    corpus.cases[0].command += ' tampered';
    const bytes = Buffer.from(`${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
    await writeFile(corpusPath, bytes);
    await writeFile(join(fixture.root, 'corpus.sha256'), `${digest(bytes)}  corpus.json\n`);

    await assert.rejects(
      reverifyRun({ root: fixture.root, caseIds: ['25'] }),
      (error) => error.code === 'REVERIFY_COMMAND_MISMATCH'
    );
    await assert.rejects(stat(join(fixture.root, '25', 'result-reverified.json')), { code: 'ENOENT' });
    await assert.rejects(stat(join(fixture.root, 'reverification-summary.json')), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('C47 correction revalidates exact stop fields without changing source evidence', async () => {
  const actions = [
    provenAction('read-main', 'filesystem.readText', { path: 'contract-main.txt' }, 1),
    provenAction('read-rule', 'filesystem.readText', { path: 'approval-rule.txt' }, 2),
    provenAction('search-annex', 'filesystem.searchFiles', { directory: '.', query: 'annex-sla.csv' }, 3)
  ];
  const mission = {
    status: 'WAITING_APPROVAL',
    stopReason: 'clarification-required',
    waves: [{ waveIndex: 1, actions }],
    observations: actions.map((action) => ({
      observationId: action.observationId,
      actionId: action.actionId,
      toolName: action.actualToolName,
      outcome: 'success'
    })),
    gates: [{
      type: 'clarification',
      status: 'pending',
      question: 'annex-sla.csv를 제공해 주세요. 필수 필드: uptime, response_minutes, penalty.'
    }]
  };
  const fixture = await createSourceRun('47', { mission, outcome: 'EXPECTED_STOP' });
  try {
    const corpusBytes = await readFile(join(fixture.root, 'corpus.json'));
    const resultBytes = await readFile(fixture.resultPath);
    const summary = await reverifyRun({
      root: fixture.root,
      caseIds: ['47'],
      correctionSet: 'c47-stop-report-v1',
      now: () => new Date('2026-09-03T13:00:00.000Z')
    });
    const resultName = 'result-reverified-c47-stop-report-v1.json';
    const summaryName = 'reverification-summary-c47-stop-report-v1.json';
    const reverified = JSON.parse(await readFile(join(fixture.root, '47', resultName), 'utf8'));

    assert.deepEqual(await readFile(join(fixture.root, 'corpus.json')), corpusBytes);
    assert.deepEqual(await readFile(fixture.resultPath), resultBytes);
    assert.equal(summary.counts.EXPECTED_STOP, 1);
    assert.equal(summary.specificationCorrection.setId, 'c47-stop-report-v1');
    assert.equal(summary.outputFiles.summaryPath, summaryName);
    assert.equal(summary.results[0].resultPath, `47/${resultName}`);
    assert.equal(reverified.outcome, 'EXPECTED_STOP');
    const fieldCheck = reverified.assertions.find((item) => item.check === 'expected stop reports every declared required field');
    assert.equal(fieldCheck.pass, true);
    assert.deepEqual(fieldCheck.details.requiredFields, [
      'annex-sla.csv', 'uptime', 'response_minutes', 'penalty'
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a correction-root is authenticated from the base corpus and is not corrected twice', async () => {
  const fixture = await createSourceRun('45', { correctionSet: 'c45-ranking-v1' });
  try {
    const corpusBytes = await readFile(join(fixture.root, 'corpus.json'));
    const resultBytes = await readFile(fixture.resultPath);
    const summary = await reverifyRun({
      root: fixture.root,
      caseIds: ['45'],
      correctionSet: 'c45-ranking-v1',
      now: () => new Date('2026-09-03T14:00:00.000Z')
    });

    assert.deepEqual(await readFile(join(fixture.root, 'corpus.json')), corpusBytes);
    assert.deepEqual(await readFile(fixture.resultPath), resultBytes);
    assert.equal(summary.specificationCorrection.setId, 'c45-ranking-v1');
    assert.equal(summary.specificationCorrection.sourceAlreadyCorrected, true);
    assert.equal(summary.specificationCorrection.baseCorpusSha256,
      createComplexWorkflowCorpusFingerprint([cases.find((item) => item.id === '45')]).corpusSha256);
    assert.match(summary.results[0].resultPath, /result-reverified-c45-ranking-v1\.json$/u);
    const reverified = JSON.parse(await readFile(join(fixture.root, summary.results[0].resultPath), 'utf8'));
    assert.match(reverified.command, /상위 두 옵션 A와 B/u);
    assert.doesNotMatch(reverified.command, /공동 1위 두 옵션/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a correction-root rejects a conflicting requested set and tampered correction metadata', async () => {
  const wrongSetFixture = await createSourceRun('45', { correctionSet: 'c45-ranking-v1' });
  try {
    await assert.rejects(
      reverifyRun({ root: wrongSetFixture.root, caseIds: ['45'], correctionSet: 'c47-stop-report-v1' }),
      (error) => error.code === 'REVERIFY_CORRECTION_SET_MISMATCH'
    );
    await assert.rejects(stat(join(wrongSetFixture.root, '45', 'result-reverified-c47-stop-report-v1.json')), { code: 'ENOENT' });
  } finally {
    await rm(wrongSetFixture.root, { recursive: true, force: true });
  }

  const metadataFixture = await createSourceRun('45', { correctionSet: 'c45-ranking-v1' });
  try {
    const corpusPath = join(metadataFixture.root, 'corpus.json');
    const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
    corpus.correctionSet.description += ' tampered';
    const bytes = Buffer.from(`${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
    await writeFile(corpusPath, bytes);
    await writeFile(join(metadataFixture.root, 'corpus.sha256'), `${digest(bytes)}  corpus.json\n`);

    await assert.rejects(
      reverifyRun({ root: metadataFixture.root, caseIds: ['45'], correctionSet: 'c45-ranking-v1' }),
      (error) => error.code === 'REVERIFY_CORRECTION_METADATA_MISMATCH'
    );
    await assert.rejects(stat(join(metadataFixture.root, '45', 'result-reverified-c45-ranking-v1.json')), { code: 'ENOENT' });
  } finally {
    await rm(metadataFixture.root, { recursive: true, force: true });
  }

  const caseFixture = await createSourceRun('45', { correctionSet: 'c45-ranking-v1' });
  try {
    const corpusPath = join(caseFixture.root, 'corpus.json');
    const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
    corpus.cases[0].expected.files[0].contains.push('tampered');
    const bytes = Buffer.from(`${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
    await writeFile(corpusPath, bytes);
    await writeFile(join(caseFixture.root, 'corpus.sha256'), `${digest(bytes)}  corpus.json\n`);

    await assert.rejects(
      reverifyRun({ root: caseFixture.root, caseIds: ['45'], correctionSet: 'c45-ranking-v1' }),
      (error) => error.code === 'REVERIFY_CASE_DEFINITION_MISMATCH'
    );
    await assert.rejects(stat(join(caseFixture.root, '45', 'result-reverified-c45-ranking-v1.json')), { code: 'ENOENT' });
  } finally {
    await rm(caseFixture.root, { recursive: true, force: true });
  }
});

async function createSourceRun(id, { mission: suppliedMission = null, outcome = 'PARTIAL', correctionSet = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-reverify-'));
  const baseTestCase = cases.find((item) => item.id === id);
  const correctionApplication = applyComplexWorkflowCorrectionSet([baseTestCase], correctionSet);
  const testCase = correctionApplication.cases[0];
  const fingerprint = createComplexWorkflowCorpusFingerprint([testCase]);
  const corpus = {
    corpusVersion: COMPLEX_WORKFLOW_50_AUDIT_VERSION,
    generatedAt: '2026-09-03T09:00:00.000Z',
    totalCaseCount: 50,
    selectedCaseCount: 1,
    corpusSha256: fingerprint.corpusSha256,
    ...(correctionApplication.metadata ? { correctionSet: correctionApplication.metadata } : {}),
    cases: fingerprint.canonicalCases
  };
  const corpusBytes = Buffer.from(`${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'corpus.json'), corpusBytes);
  await writeFile(join(root, 'corpus.sha256'), `${digest(corpusBytes)}  corpus.json\n`);

  const workspace = join(root, id, 'workspace');
  await mkdir(workspace, { recursive: true });
  for (const [path, value] of Object.entries(testCase.inputs ?? {})) {
    const destination = join(workspace, path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  const mission = suppliedMission ?? {
    status: 'BLOCKED',
    stopReason: 'transactions-september.csv missing; required input is needed',
    waves: [],
    observations: [],
    gates: []
  };
  const result = {
    resultVersion: COMPLEX_WORKFLOW_50_AUDIT_VERSION,
    id,
    title: testCase.title,
    category: testCase.category,
    command: testCase.command,
    startedAt: '2026-09-03T09:00:00.000Z',
    finishedAt: '2026-09-03T09:01:00.000Z',
    outcome,
    missionStatus: mission.status,
    stopReason: mission.stopReason,
    ...(testCase.correction ? { correction: testCase.correction } : {}),
    inputManifest: fingerprint.canonicalCases[0].inputManifest,
    mission,
    tasks: []
  };
  const resultPath = join(root, id, 'result.json');
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return { root, resultPath };
}

function provenAction(actionId, actualToolName, args, order) {
  return {
    actionId,
    observationId: `observation-${actionId}`,
    actualToolName,
    expectedToolName: actualToolName,
    status: 'succeeded',
    arguments: args,
    order
  };
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
