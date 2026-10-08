import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  createComplexWorkflowCorpusFingerprint,
  evaluateExpectedContentMatch,
  normalizeEmailAttachmentHashEvidence,
  normalizeNewsItemsEvidence,
  verifyCase,
  verifyExpectedStopReport,
  verifyLiveWeb,
  verifyPreservedInputs,
  verifyVisualCards,
  workbookHeaderQuality,
  workbookSheetValidationPolicy
} from '../scripts/complex-workflow-50-audit.mjs';
import { cases } from '../scripts/complex-workflow-50-cases.mjs';
import { applyComplexWorkflowCorrectionSet } from '../scripts/complex-workflow-50-corrections.mjs';
import { ExcelWorkbookWorker } from '../apps/pc-agent/src/adapters/excel/excel-worker.js';

test('C45 correction is a separate hashed overlay and leaves the fixed 50-case corpus untouched', () => {
  const original = cases.find((item) => item.id === '45');
  const originalCommand = original.command;
  const originalExpected = structuredClone(original.expected);
  const originalInputs = structuredClone(original.inputs);
  const baseFingerprint = createComplexWorkflowCorpusFingerprint(cases);

  const application = applyComplexWorkflowCorrectionSet(cases, 'c45-ranking-v1');
  const corrected = application.cases.find((item) => item.id === '45');
  const correctedFingerprint = createComplexWorkflowCorpusFingerprint([corrected]);
  const baseCaseFingerprint = createComplexWorkflowCorpusFingerprint([original]);

  assert.equal(baseFingerprint.corpusSha256, '1ac2acf4b4a1f62e652a3d85eb3dcc8b2c43df9e8fe0c02d6e10cc36ed7e8d1a');
  assert.match(original.command, /공동 1위 두 옵션/);
  assert.equal(original.command, originalCommand);
  assert.match(corrected.command, /상위 두 옵션 A와 B/);
  assert.doesNotMatch(corrected.command, /공동 1위 두 옵션/);
  assert.deepEqual(corrected.expected, originalExpected);
  assert.deepEqual(corrected.inputs, originalInputs);
  assert.equal(application.metadata.setId, 'c45-ranking-v1');
  assert.deepEqual(application.metadata.appliedCaseIds, ['45']);
  assert.notEqual(correctedFingerprint.corpusSha256, baseCaseFingerprint.corpusSha256);
  assert.equal(correctedFingerprint.canonicalCases[0].correction.setId, 'c45-ranking-v1');
});

test('C45 correction refuses unknown sets and corpus drift instead of applying approximately', () => {
  assert.throws(
    () => applyComplexWorkflowCorrectionSet(cases, 'unknown-correction'),
    (error) => error.code === 'AUDIT_CORRECTION_SET_UNKNOWN'
  );
  const drifted = cases.map((item) => item.id === '45'
    ? { ...item, command: item.command.replace('공동 1위 두 옵션', '모순 표현 제거됨') }
    : item);
  assert.throws(
    () => applyComplexWorkflowCorrectionSet(drifted, 'c45-ranking-v1'),
    (error) => error.code === 'AUDIT_CORRECTION_PRECONDITION_FAILED'
  );
});

test('C47 stop-report correction is a hashed overlay with exact source preconditions', () => {
  const original = cases.find((item) => item.id === '47');
  const originalExpected = structuredClone(original.expected);
  const baseFingerprint = createComplexWorkflowCorpusFingerprint(cases);
  const application = applyComplexWorkflowCorrectionSet(cases, 'c47-stop-report-v1');
  const corrected = application.cases.find((item) => item.id === '47');

  assert.deepEqual(corrected.expected.stopReport.requiredFields, [
    'annex-sla.csv', 'uptime', 'response_minutes', 'penalty'
  ]);
  assert.deepEqual(original.expected, originalExpected);
  assert.equal(Object.hasOwn(original.expected, 'stopReport'), false);
  assert.equal(corrected.command, original.command);
  assert.deepEqual(corrected.inputs, original.inputs);
  assert.equal(application.metadata.setId, 'c47-stop-report-v1');
  assert.deepEqual(application.metadata.appliedCaseIds, ['47']);
  assert.equal(createComplexWorkflowCorpusFingerprint(cases).corpusSha256, baseFingerprint.corpusSha256);
  assert.equal(corrected.correction.sourceInputPath, 'approval-rule.txt');

  const drifted = cases.map((item) => item.id === '47'
    ? { ...item, inputs: { ...item.inputs, 'approval-rule.txt': `${item.inputs['approval-rule.txt']} 변경` } }
    : item);
  assert.throws(
    () => applyComplexWorkflowCorrectionSet(drifted, 'c47-stop-report-v1'),
    (error) => error.code === 'AUDIT_CORRECTION_PRECONDITION_FAILED'
  );
});

test('sheet labels affect pass/fail only when the workbook creation step names them', () => {
  const explicit = workbookSheetValidationPolicy({
    command: '1) 원본을 읽어. 2) 행별 계산과 월별 요약을 두 시트로 나눈 sales.xlsx를 만들어.',
    workbookPath: 'sales.xlsx',
    expectedSheets: ['행별 계산', '월별 요약']
  });
  assert.equal(explicit.enforceExact, true);
  assert.equal(explicit.requestedSheetCount, 2);
  assert.deepEqual(explicit.informationalSheets, []);

  const hidden = workbookSheetValidationPolicy({
    command: '1) 원본을 읽어. 2) 로그 수준별 건수를 incident.xlsx에 작성해.',
    workbookPath: 'incident.xlsx',
    expectedSheets: ['로그 지표']
  });
  assert.equal(hidden.enforceExact, false);
  assert.deepEqual(hidden.explicitSheets, []);
  assert.deepEqual(hidden.informationalSheets, ['로그 지표']);
});

test('corpus hidden sheet labels stay informational while explicit labels remain enforced', () => {
  const hiddenCaseIds = new Set(['06', '10', '17', '21', '22', '23', '40']);
  const workbookPolicies = cases.flatMap((testCase) => (testCase.expected.files ?? [])
    .filter((file) => file.type === 'xlsx' && Array.isArray(file.sheets))
    .map((file) => ({
      id: testCase.id,
      policy: workbookSheetValidationPolicy({
        command: testCase.command,
        workbookPath: file.path,
        expectedSheets: file.sheets
      })
    })));
  assert.deepEqual(
    workbookPolicies.filter((item) => !item.policy.enforceExact).map((item) => item.id),
    [...hiddenCaseIds]
  );
  assert.equal(workbookPolicies.filter((item) => !hiddenCaseIds.has(item.id)).every((item) => item.policy.enforceExact), true);
});

test('a commanded workbook total may be proven by a coherent numeric column sum', () => {
  const command = cases.find((item) => item.id === '30')?.command;
  const match = evaluateExpectedContentMatch({
    searchableText: '43\n36\n43\n38\n47\n37',
    needle: '122',
    type: 'xlsx',
    command,
    zipInspection: {
      workbookTables: [
        {
          sheetName: '사람별',
          numericColumns: [{ column: 'B', values: [43, 36, 43], sum: 122 }]
        },
        {
          sheetName: '프로젝트별',
          numericColumns: [{ column: 'B', values: [38, 47, 37], sum: 122 }]
        }
      ]
    }
  });

  assert.equal(match.pass, true);
  assert.equal(match.details.matchMode, 'derived-workbook-column-sum');
  assert.equal(match.details.aggregateMatches.length, 2);
});

test('derived workbook sums cannot satisfy an unrequested or arithmetically wrong value', () => {
  const workbookTables = [{
    sheetName: '사람별',
    numericColumns: [{ column: 'B', values: [43, 36, 43], sum: 122 }]
  }];
  const unrequested = evaluateExpectedContentMatch({
    searchableText: '43\n36\n43',
    needle: '122',
    type: 'xlsx',
    command: '사람별 시간을 워크북에 작성해.',
    zipInspection: { workbookTables }
  });
  const wrongSum = evaluateExpectedContentMatch({
    searchableText: '43\n36\n43',
    needle: '123',
    type: 'xlsx',
    command: '총 123시간이 일치하는지 확인해.',
    zipInspection: { workbookTables }
  });

  assert.equal(unrequested.pass, false);
  assert.equal(unrequested.details.derivedAggregateEligible, false);
  assert.equal(wrongSum.pass, false);
  assert.equal(wrongSum.details.derivedAggregateEligible, true);
  assert.deepEqual(wrongSum.details.aggregateMatches, []);
});

test('XLSX numeric contains accepts decimal formatting equivalence only from typed finite cells', () => {
  const match = evaluateExpectedContentMatch({
    searchableText: '7.7',
    needle: '7.70',
    type: 'xlsx',
    zipInspection: {
      workbookTables: [{
        sheetName: '가중 결과',
        numericCells: [{ reference: 'F2', rawValue: '7.7', value: 7.7 }]
      }]
    }
  });

  assert.equal(match.pass, true);
  assert.equal(match.details.matchMode, 'xlsx-numeric-cell-equivalent');
  assert.equal(match.details.expectedNumericValue, 7.7);
  assert.deepEqual(match.details.numericCellMatches, [{
    sheetName: '가중 결과',
    reference: 'F2',
    rawValue: '7.7',
    value: 7.7
  }]);
});

test('XLSX numeric contains rejects text coercion, identifiers, units, non-finite literals, and wrong values', () => {
  const evaluate = ({ needle, searchableText = '', numericCells = [] }) => evaluateExpectedContentMatch({
    searchableText,
    needle,
    type: 'xlsx',
    zipInspection: { workbookTables: [{ sheetName: '결과', numericCells }] }
  });

  assert.equal(evaluate({ needle: '7.70', searchableText: '7.7', numericCells: [{ reference: 'A2', rawValue: '7.7', value: '7.7' }] }).pass, false);
  assert.equal(evaluate({ needle: '7.70', searchableText: '7.71', numericCells: [{ reference: 'A2', rawValue: '7.71', value: 7.71 }] }).pass, false);
  assert.equal(evaluate({ needle: '007', searchableText: '7', numericCells: [{ reference: 'A2', rawValue: '7', value: 7 }] }).pass, false);
  assert.equal(evaluate({ needle: '7.70점', searchableText: '7.7', numericCells: [{ reference: 'A2', rawValue: '7.7', value: 7.7 }] }).pass, false);
  assert.equal(evaluate({ needle: 'NaN', numericCells: [{ reference: 'A2', rawValue: 'NaN', value: Number.NaN }] }).pass, false);
  assert.equal(evaluate({ needle: 'Infinity', numericCells: [{ reference: 'A2', rawValue: 'Infinity', value: Number.POSITIVE_INFINITY }] }).pass, false);
  assert.equal(evaluate({
    needle: '9007199254740993',
    searchableText: '9007199254740992',
    numericCells: [{ reference: 'A2', rawValue: '9007199254740992', value: 9007199254740992 }]
  }).pass, false);

  const exactTextIdentifier = evaluate({ needle: '007', searchableText: '007', numericCells: [] });
  assert.equal(exactTextIdentifier.pass, true);
  assert.equal(exactTextIdentifier.details.matchMode, 'literal-content');
});

test('HWPX label-count checks accept bounded notation variants commanded with the same count', () => {
  const command = '일반 3개·채식 2개를 meal-safety.hwpx에 작성해.';
  const searchableText = '식단별 준비 수량\n일반 식단: 3명\n채식식단 - 2개';

  const regular = evaluateExpectedContentMatch({ searchableText, needle: '일반 3', type: 'hwpx', command });
  const vegetarian = evaluateExpectedContentMatch({ searchableText, needle: '채식 2', type: 'hwpx', command });

  assert.equal(regular.pass, true);
  assert.equal(regular.details.matchMode, 'commanded-label-count-notation');
  assert.equal(regular.details.labelSupplement, '식단');
  assert.equal(regular.details.countUnit, '명');
  assert.equal(vegetarian.pass, true);
  assert.equal(vegetarian.details.countUnit, '개');
});

test('HWPX label-count notation fallback rejects wrong, unrelated, or distant evidence', () => {
  const command = '일반 3개를 meal-safety.hwpx에 작성해.';
  const rejected = [
    '일반 식단: 30개',
    '일반 식단: 2명',
    '비일반 식단: 3개',
    '일반 대상: 3명',
    '일반 식단 안내\n3개'
  ];

  for (const searchableText of rejected) {
    const match = evaluateExpectedContentMatch({ searchableText, needle: '일반 3', type: 'hwpx', command });
    assert.equal(match.pass, false, searchableText);
  }
  assert.equal(evaluateExpectedContentMatch({
    searchableText: '일반 식단: 3명',
    needle: '일반 3',
    type: 'hwpx',
    command: '일반 2개를 작성해.'
  }).pass, false);
  assert.equal(evaluateExpectedContentMatch({
    searchableText: '일반 식단: 3명',
    needle: '일반 3',
    type: 'docx',
    command
  }).pass, false);
});

test('workbook header quality rejects object stringification placeholders', () => {
  const invalid = workbookHeaderQuality([{
    sheetName: '사람별',
    headers: [
      { column: 'A', value: '[object Object]' },
      { column: 'B', value: '[object Object]' }
    ]
  }]);
  const valid = workbookHeaderQuality([{
    sheetName: '사람별',
    headers: [
      { column: 'A', value: '이름' },
      { column: 'B', value: '총시간(h)' }
    ]
  }]);

  assert.equal(invalid.pass, false);
  assert.equal(invalid.invalidHeaders.length, 2);
  assert.equal(invalid.invalidHeaders[0].reason, 'object-stringification-placeholder');
  assert.equal(valid.pass, true);
  assert.deepEqual(valid.invalidHeaders, []);
});

test('C30-style structured workbook passes headers and derived total through the integrated verifier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-audit-c30-workbook-'));
  try {
    const outputPath = join(root, 'timesheet-analysis.xlsx');
    const workbookArguments = {
      outputPath,
      sheets: [
        {
          sheetName: '사람별',
          columns: [{ name: '이름' }, { name: '총시간(h)' }, { name: '초과여부' }],
          rows: [['김하늘', 43, '초과'], ['이지민', 36, '정상'], ['박서준', 43, '초과']]
        },
        {
          sheetName: '프로젝트별',
          columns: [{ name: '프로젝트' }, { name: '총시간(h)' }],
          rows: [['A', 38], ['B', 47], ['C', 37]]
        },
        {
          sheetName: '초과',
          columns: [{ name: '이름' }, { name: '총시간(h)' }, { name: '초과시간(h)' }],
          rows: [['김하늘', 43, 3], ['박서준', 43, 3]]
        }
      ]
    };
    await new ExcelWorkbookWorker().writeWorkbook(workbookArguments);

    const createAction = verifiedAction('create', 'excel.createWorkbook', workbookArguments, 1);
    const searchAction = verifiedAction('search', 'filesystem.searchFiles', {
      directory: root,
      query: 'timesheet-analysis.xlsx'
    }, 2);
    const mission = {
      status: 'COMPLETED',
      waves: [{ waveIndex: 1, actions: [createAction, searchAction] }],
      observations: [createAction, searchAction].map((action) => ({
        observationId: action.observationId,
        actionId: action.actionId,
        toolName: action.actualToolName,
        outcome: 'success'
      }))
    };
    const testCase = {
      command: '사람별·프로젝트별·초과 세 시트의 timesheet-analysis.xlsx를 만들고 총 122시간이 결과와 일치하는지 확인해.',
      inputs: {},
      expected: {
        status: 'COMPLETED',
        files: [{
          path: 'timesheet-analysis.xlsx',
          type: 'xlsx',
          contains: ['43', '36', '122'],
          sheets: ['사람별', '프로젝트별', '초과']
        }]
      }
    };
    const checks = await verifyCase(testCase, root, {}, mission, []);

    assert.deepEqual(checks.filter((item) => !item.pass), []);
    assert.equal(checks.find((item) => item.check === 'contains: 122')?.details.matchMode, 'derived-workbook-column-sum');
    assert.equal(checks.find((item) => item.check === 'workbook column headers are readable text')?.pass, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('integrated XLSX inspection distinguishes a numeric 7.7 cell from text when expecting 7.70', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-audit-xlsx-numeric-cell-'));
  try {
    const verifyWorkbook = async ({ fileName, score }) => {
      const outputPath = join(root, fileName);
      const workbookArguments = {
        outputPath,
        sheets: [{
          sheetName: '가중 결과',
          columns: [{ name: '옵션' }, { name: '점수' }],
          rows: [['A', score]]
        }]
      };
      await new ExcelWorkbookWorker().writeWorkbook(workbookArguments);
      const createAction = verifiedAction(`create-${fileName}`, 'excel.createWorkbook', workbookArguments, 1);
      const mission = {
        status: 'COMPLETED',
        waves: [{ waveIndex: 1, actions: [createAction] }],
        observations: [{
          observationId: createAction.observationId,
          actionId: createAction.actionId,
          toolName: createAction.actualToolName,
          outcome: 'success'
        }]
      };
      const checks = await verifyCase({
        command: `가중 결과 시트의 ${fileName}를 만들어.`,
        inputs: {},
        expected: {
          status: 'COMPLETED',
          files: [{ path: fileName, type: 'xlsx', contains: ['7.70'], sheets: ['가중 결과'] }]
        }
      }, root, {}, mission, []);
      return checks.find((item) => item.check === 'contains: 7.70');
    };

    const numericCell = await verifyWorkbook({ fileName: 'numeric.xlsx', score: 7.7 });
    const textCell = await verifyWorkbook({ fileName: 'text.xlsx', score: '7.7' });

    assert.equal(numericCell.pass, true);
    assert.equal(numericCell.details.matchMode, 'xlsx-numeric-cell-equivalent');
    assert.deepEqual(numericCell.details.numericCellMatches.map((item) => ({
      sheetName: item.sheetName,
      reference: item.reference,
      rawValue: item.rawValue
    })), [{ sheetName: '가중 결과', reference: 'B2', rawValue: '7.7' }]);
    assert.equal(textCell.pass, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retained input files are hash-checked generically from expected.files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-audit-preserve-'));
  try {
    await mkdir(join(root, 'inbox'), { recursive: true });
    const original = Buffer.from('metric,value\n완료,2\n');
    await writeFile(join(root, 'inbox', 'metrics.csv'), original);
    const inputManifest = {
      'inbox/metrics.csv': { size: original.length, sha256: digest(original) }
    };
    const expected = { files: [{ path: 'inbox/metrics.csv', type: 'csv' }] };
    let checks = await verifyPreservedInputs({ expected, inputManifest, workspace: root });
    assert.equal(checks.length, 1);
    assert.equal(checks[0].pass, true);
    assert.equal(checks[0].details.source, 'expected.files-retained-input');

    await writeFile(join(root, 'inbox', 'metrics.csv'), 'tampered');
    checks = await verifyPreservedInputs({ expected, inputManifest, workspace: root });
    assert.equal(checks[0].pass, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('visual card evidence binds expected path, meaningful arguments, observation, and file hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-audit-card-'));
  try {
    const cardsDir = join(root, 'cards');
    await mkdir(cardsDir, { recursive: true });
    const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(40, 7)]);
    const cardPath = join(cardsDir, 'promise-all.png');
    await writeFile(cardPath, bytes);
    const hash = digest(bytes);
    const action = {
      actionId: 'a1', observationId: 'o1', actualToolName: 'visual.createCards', status: 'succeeded',
      arguments: {
        outputDirectory: cardsDir,
        cards: [{ fileName: 'promise-all.png', title: 'Promise.all 선택', body: ['모두 성공해야 결과를 반환'] }]
      }
    };
    const mission = {
      waves: [{ actions: [action] }],
      observations: [{
        observationId: 'o1', actionId: 'a1', toolName: 'visual.createCards', outcome: 'success',
        artifacts: [{ relativePath: 'cards/promise-all.png', contentSha256: hash }]
      }]
    };
    const testCase = {
      command: 'Promise.all의 선택 기준을 cards/promise-all.png 카드로 만들어.',
      expected: { files: [{ path: 'cards/promise-all.png', type: 'png' }] }
    };
    let checks = await verifyVisualCards({ testCase, mission, workspace: root });
    assert.equal(checks[0].pass, true);
    assert.deepEqual(checks[0].details.evidence[0].matches[0].matchingSemanticTokens, ['promise', 'all']);

    action.arguments.cards[0].title = '일반 작업 요약';
    action.arguments.cards[0].body = ['모든 항목을 처리했습니다'];
    checks = await verifyVisualCards({ testCase, mission, workspace: root });
    assert.equal(checks[0].pass, false);
    assert.equal(checks[0].details.evidence[0].matches[0].meaningfulContent, true);
    assert.equal(checks[0].details.evidence[0].matches[0].semanticTokensSatisfied, false);

    action.arguments.cards[0].title = '';
    action.arguments.cards[0].body = [];
    checks = await verifyVisualCards({ testCase, mission, workspace: root });
    assert.equal(checks[0].pass, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('visual card semantics exclude directory and file path identifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-audit-card-topics-'));
  try {
    const cardsDir = join(root, 'cards');
    await mkdir(cardsDir, { recursive: true });
    const definitions = [
      { fileName: 'closure-results.png', title: '교육 성과 요약', body: ['수료 46명, 만족도 4.5'] },
      { fileName: 'closure-response.png', title: '운영 대응 결과', body: ['장소 변경에 2시간 내 대응'] }
    ];
    const artifacts = [];
    for (const [index, definition] of definitions.entries()) {
      const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(40, index + 1)]);
      await writeFile(join(cardsDir, definition.fileName), bytes);
      artifacts.push({ relativePath: `cards/${definition.fileName}`, contentSha256: digest(bytes) });
    }
    const action = {
      actionId: 'a-topics', observationId: 'o-topics', actualToolName: 'visual.createCards', status: 'succeeded',
      arguments: { outputDirectory: cardsDir, cards: definitions }
    };
    const mission = {
      waves: [{ actions: [action] }],
      observations: [{
        observationId: 'o-topics', actionId: 'a-topics', toolName: 'visual.createCards', outcome: 'success', artifacts
      }]
    };
    const testCase = {
      command: '성과와 대응을 cards/closure-results.png와 cards/closure-response.png로 만들어.',
      expected: { files: [
        { path: 'cards/closure-results.png', type: 'png' },
        { path: 'cards/closure-response.png', type: 'png' }
      ] }
    };

    let checks = await verifyVisualCards({ testCase, mission, workspace: root });
    assert.equal(checks[0].pass, true);
    assert.deepEqual(checks[0].details.evidence[0].matches[0].commandTokens, []);
    assert.deepEqual(checks[0].details.evidence[1].matches[0].commandTokens, []);
    assert.equal(checks[0].details.evidence.flatMap((item) => item.matches)
      .some((item) => item.commandTokens.includes('closure')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('visual card semantics map an ordered Korean topic list to ordered PNG paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-audit-card-ordered-topics-'));
  try {
    const cardsDir = join(root, 'cards');
    await mkdir(cardsDir, { recursive: true });
    const definitions = [
      { fileName: 'ops-deploy.png', title: '배포 성공', body: ['버전 4.2.0 배포 완료'] },
      { fileName: 'ops-latency.png', title: '지연 780ms → 410ms 회복', body: ['SLA 30분 이내 회복'] },
      { fileName: 'ops-payment.png', title: '결제 오류 12건 → 0건 회복', body: ['SLA 15분 이내 회복'] }
    ];
    const artifacts = [];
    for (const [index, definition] of definitions.entries()) {
      const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(40, index + 1)]);
      await writeFile(join(cardsDir, definition.fileName), bytes);
      artifacts.push({ relativePath: `cards/${definition.fileName}`, contentSha256: digest(bytes) });
    }
    const mission = {
      waves: [{ actions: [{
        actionId: 'a-ordered-topics', observationId: 'o-ordered-topics',
        actualToolName: 'visual.createCards', status: 'succeeded',
        arguments: { outputDirectory: cardsDir, cards: definitions }
      }] }],
      observations: [{
        observationId: 'o-ordered-topics', actionId: 'a-ordered-topics',
        toolName: 'visual.createCards', outcome: 'success', artifacts
      }]
    };
    const testCase = {
      command: '다음 작업을 순서대로 완료해줘. 5) 배포·성능 회복·결제 회복을 cards/ops-deploy.png, cards/ops-latency.png, cards/ops-payment.png로 만들어.',
      expected: { files: definitions.map(({ fileName }) => ({ path: `cards/${fileName}`, type: 'png' })) }
    };

    let checks = await verifyVisualCards({ testCase, mission, workspace: root });
    assert.equal(checks[0].pass, true);
    assert.deepEqual(checks[0].details.evidence.map((item) => item.matches[0].commandTokens), [
      ['배포'], ['성능', '회복'], ['결제', '회복']
    ]);

    definitions[1].title = '일반 운영 현황';
    definitions[1].body = ['SLA 30분'];
    checks = await verifyVisualCards({ testCase, mission, workspace: root });
    assert.equal(checks[0].pass, false);
    assert.equal(checks[0].details.evidence[1].matches[0].semanticTokensSatisfied, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expected-stop required fields use declarative schema and require every field', () => {
  const checks = verifyExpectedStopReport(
    { requiredFields: ['uptime', 'response_minutes', 'penalty'] },
    'annex-sla.csv가 필요합니다. uptime 및 response_minutes 필드는 확인했지만 penalty 정보도 제공해 주세요.'
  );
  assert.equal(checks[0].pass, true);
  assert.deepEqual(checks[0].details.reportedFields, ['uptime', 'response_minutes', 'penalty']);

  const missing = verifyExpectedStopReport(
    { requiredFields: ['uptime', 'response_minutes', 'penalty'] },
    'uptime만 확인할 수 없습니다.'
  );
  assert.equal(missing[0].pass, false);
  assert.deepEqual(missing[0].details.missingFields, ['response_minutes', 'penalty']);

  const undeclared = verifyExpectedStopReport(undefined, 'anything');
  assert.equal(undeclared[0].pass, true);
  assert.equal(undeclared[0].details.informational, true);
  assert.equal(undeclared[0].details.enforced, false);
});

test('expected-stop fields and file names require exact term boundaries', () => {
  const stopReport = { requiredFields: ['annex-sla.csv', 'uptime', 'response_minutes', 'penalty'] };
  const exact = verifyExpectedStopReport(
    stopReport,
    'annex-sla.csv를 제공해 주세요. 필수 필드: uptime, response_minutes, penalty.'
  );
  const lookalikes = verifyExpectedStopReport(
    stopReport,
    'old-annex-sla.csv.bak의 downtime, response_minutes_old, penaltyRate를 확인했습니다.'
  );

  assert.equal(exact[0].pass, true);
  assert.equal(lookalikes[0].pass, false);
  assert.deepEqual(lookalikes[0].details.reportedFields, []);
  assert.deepEqual(lookalikes[0].details.missingFields, stopReport.requiredFields);
});

test('direct official-read identity preserves URL anchors while resource matching may ignore them', async () => {
  const capturedAt = new Date().toISOString();
  const base = 'https://docs.python.org/3/library/asyncio-task.html';
  const urls = [`${base}#task-cancellation`, `${base}#timeouts`];
  const actions = urls.map((query, index) => ({
    actionId: `a${index + 1}`,
    observationId: `o${index + 1}`,
    actualToolName: 'browser.search',
    status: 'succeeded',
    arguments: { query }
  }));
  const observations = urls.map((url, index) => ({
    observationId: `o${index + 1}`,
    actionId: `a${index + 1}`,
    toolName: 'browser.search',
    outcome: 'success',
    data: {
      webProvenance: { live: true, capturedAt, driver: 'python-playwright-system-chrome', navigationStatus: 200 },
      searchResults: [{ url, snippet: 'x'.repeat(160) }]
    }
  }));
  const checks = await verifyLiveWeb({
    requiredTool: 'browser.search',
    minUrls: 2,
    minDomains: 1,
    requiredDomains: ['docs.python.org'],
    minDirectOfficialReads: 2
  }, { waves: [{ actions }], observations }, resolve('.'));
  const direct = checks.find((item) => item.check.includes('proven direct official-document read(s)'));
  assert.equal(direct.pass, true);
  assert.equal(direct.details.actual, 2);
  assert.deepEqual(direct.details.directOfficialReads.map((item) => item.queryUrl), urls);
});

test('direct official-read identity accepts canonical query parameters only for the same HTTPS host and path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-audit-direct-canonical-url-'));
  const capturedAt = new Date().toISOString();
  const requestedUrls = [
    'https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/get-filehash',
    'https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/get-content'
  ];
  const observedUrls = requestedUrls.map((url) => `${url}?view=powershell-7.6`);
  const actions = requestedUrls.map((query, index) => ({
    actionId: `learn-a${index + 1}`,
    observationId: `learn-o${index + 1}`,
    actualToolName: 'browser.search',
    status: 'succeeded',
    arguments: { query }
  }));
  const observationsFor = (urls) => urls.map((url, index) => ({
    observationId: `learn-o${index + 1}`,
    actionId: `learn-a${index + 1}`,
    toolName: 'browser.search',
    outcome: 'success',
    data: {
      webProvenance: { live: true, capturedAt, driver: 'python-playwright-system-chrome', navigationStatus: 200 },
      searchResults: [{ url, snippet: 'Microsoft Learn direct document body '.repeat(8) }]
    }
  }));
  const spec = {
    requiredTool: 'browser.search',
    minUrls: 2,
    minDomains: 1,
    requiredDomains: ['learn.microsoft.com'],
    artifactPath: 'guide.md',
    minArtifactObservedUrls: 2,
    minDirectOfficialReads: 2
  };

  try {
    await writeFile(join(root, 'guide.md'), observedUrls.join('\n'), 'utf8');
    let checks = await verifyLiveWeb(spec, { waves: [{ actions }], observations: observationsFor(observedUrls) }, root);
    const direct = checks.find((item) => item.check.includes('proven direct official-document read(s)'));
    const citations = checks.find((item) => item.check.includes('artifact cites at least 2 URL(s)'));
    assert.equal(direct.pass, true);
    assert.equal(direct.details.actual, 2);
    assert.deepEqual(direct.details.directOfficialReads.map((item) => item.queryUrl), requestedUrls);
    assert.deepEqual(direct.details.directOfficialReads.map((item) => item.matchedResultUrl), observedUrls);
    assert.deepEqual(direct.details.directOfficialReads.map((item) => item.comparableResourceUrl), requestedUrls);
    assert.equal(citations.pass, true);

    for (const mismatchedUrl of [
      'https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/get-content?view=powershell-7.6',
      'https://evil.example/en-us/powershell/module/microsoft.powershell.utility/get-filehash?view=powershell-7.6',
      'http://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/get-filehash?view=powershell-7.6'
    ]) {
      checks = await verifyLiveWeb({ ...spec, minUrls: 1, minDirectOfficialReads: 1, artifactPath: null, minArtifactObservedUrls: 0 }, {
        waves: [{ actions: [actions[0]] }],
        observations: observationsFor([mismatchedUrl])
      }, root);
      assert.equal(
        checks.find((item) => item.check.includes('proven direct official-document read(s)')).pass,
        false,
        mismatchedUrl
      );
    }

    await writeFile(join(root, 'guide.md'), requestedUrls.join('\n'), 'utf8');
    checks = await verifyLiveWeb(spec, { waves: [{ actions }], observations: observationsFor(observedUrls) }, root);
    assert.equal(checks.find((item) => item.check.includes('artifact cites at least 2 URL(s)')).pass, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('live-news verification recovers bounded task evidence and reports malformed collections without throwing', async () => {
  const capturedAt = '2026-09-03T08:56:28.733Z';
  const newsItem = {
    title: '검증 뉴스',
    url: 'https://news.google.com/rss/articles/verified',
    publishedAt: '2026-09-03T08:40:00.000Z',
    source: '검증 언론사',
    sourceUrl: 'https://publisher.example/'
  };
  const news = {
    feedVersion: 'jarvis-google-news-rss-v1',
    sourceProvider: 'Google News RSS',
    sourceUrl: 'https://news.google.com/rss',
    retrievedAt: capturedAt,
    httpStatus: 200,
    category: 'top',
    itemCount: 1,
    live: true,
    replay: false,
    fixture: false,
    fetched: true,
    items: '[circular]'
  };
  const mission = {
    observations: [{
      observationId: 'news-observation',
      actionId: 'news-action',
      toolName: 'news.fetchHeadlines',
      outcome: 'success',
      data: { news }
    }]
  };
  const taskNews = { ...news, items: { values: [newsItem] } };
  const tasks = [{
    execution: {
      executionResult: {
        evidence: {
          executionEvidence: {
            adapterEvidence: { news: taskNews }
          }
        }
      }
    }
  }];
  const spec = {
    requiredTool: 'news.fetchHeadlines',
    minUrls: 1,
    minDomains: 1,
    minNewsItems: 1,
    publishedOnLocalDate: true
  };
  const checks = await verifyLiveWeb(spec, mission, resolve('.'), {
    referenceTime: capturedAt,
    tasks
  });
  const shape = checks.find((item) => item.check === 'live news item evidence has a valid object or array shape');
  assert.equal(shape.pass, true);
  assert.equal(shape.details.newsItemEvidence[0].observation.valid, false);
  assert.equal(shape.details.newsItemEvidence[0].selectedSource, 'task-execution-adapter-evidence');
  assert.equal(checks.find((item) => item.check.includes('live news evidence includes at least 1 item'))?.pass, true);

  const malformedChecks = await verifyLiveWeb(spec, mission, resolve('.'), {
    referenceTime: capturedAt,
    tasks: []
  });
  const malformedShape = malformedChecks.find((item) => item.check === 'live news item evidence has a valid object or array shape');
  assert.equal(malformedShape.pass, false);
  assert.equal(malformedShape.details.newsItemEvidence[0].observation.reason, 'expected-object-or-array');
});

test('news item evidence normalization accepts bounded object and array shapes', () => {
  const item = { title: '뉴스' };
  assert.deepEqual(normalizeNewsItemsEvidence([item]), {
    valid: true,
    items: [item],
    inputType: 'array',
    shape: 'array',
    reason: null
  });
  assert.deepEqual(normalizeNewsItemsEvidence({ articles: [item] }), {
    valid: true,
    items: [item],
    inputType: 'object',
    shape: 'object.articles',
    reason: null
  });
  assert.equal(normalizeNewsItemsEvidence('[circular]').valid, false);
  assert.equal(normalizeNewsItemsEvidence({ unrelated: [item] }).reason, 'unsupported-object-shape');
});

test('email hash evidence normalizes bounded object and array representations', () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  assert.deepEqual(normalizeEmailAttachmentHashEvidence([first, { attachmentSha256: second }]), {
    valid: true,
    hashes: [first, second],
    inputType: 'array',
    shape: 'array',
    reason: null
  });
  assert.deepEqual(normalizeEmailAttachmentHashEvidence({ values: [first, second] }), {
    valid: true,
    hashes: [first, second],
    inputType: 'object',
    shape: 'object.values',
    reason: null
  });
  assert.equal(normalizeEmailAttachmentHashEvidence('[circular]').valid, false);
  assert.equal(normalizeEmailAttachmentHashEvidence({ unrelated: [first] }).reason, 'unsupported-object-shape');
});

test('email verification uses valid execution evidence when compact observation hashes are malformed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-audit-email-evidence-'));
  try {
    const attachment = Buffer.from('verified attachment', 'utf8');
    const attachmentHash = digest(attachment);
    const idempotencyKey = 'jarvis-email-evidence-v1';
    await writeFile(join(root, 'report.txt'), attachment);
    const emailAction = {
      actionId: 'send',
      observationId: 'observation-send',
      expectedToolName: 'email.send',
      actualToolName: 'email.send',
      authorizationMode: 'trusted-owner-self-email',
      status: 'succeeded',
      arguments: {
        to: '',
        recipientMode: 'self',
        subject: '[EMAIL-EVIDENCE] report',
        idempotencyKey: '[redacted]',
        attachments: [{
          attachmentRef: { rootIndex: 0, relativePath: 'report.txt' },
          attachmentSha256: attachmentHash
        }]
      }
    };
    const accepted = {
      passed: true,
      providerAccepted: true,
      recipientMatched: true,
      attachmentCount: 1,
      attachmentSha256s: '[circular]',
      deduplicated: false
    };
    const mission = {
      status: 'COMPLETED',
      waves: [{ actions: [emailAction] }],
      observations: [{
        observationId: emailAction.observationId,
        actionId: emailAction.actionId,
        toolName: 'email.send',
        outcome: 'success',
        data: { email: accepted }
      }]
    };
    const executionResult = {
      status: 'success',
      subject: emailAction.arguments.subject,
      attachmentCount: 1,
      attachmentSha256s: { items: [{ sha256: attachmentHash }] },
      idempotencyKeySha256: digest(idempotencyKey),
      deduplicated: false,
      verification: accepted
    };
    const testCase = {
      command: 'report.txt를 내 구글 메일로 제목 [EMAIL-EVIDENCE] report로 보내.',
      allowExternalSend: true,
      expected: {
        status: 'COMPLETED',
        files: [{ path: 'report.txt', type: 'text' }],
        email: {
          subjectContains: '[EMAIL-EVIDENCE]',
          attachmentCount: 1,
          attachmentPaths: ['report.txt'],
          idempotencyKey
        }
      }
    };
    const checks = await verifyCase(testCase, root, {}, mission, [{
      execution: { executionResult }
    }]);
    assert.equal(checks.find((item) => item.check === 'accepted email attachment hash evidence has a valid object or array shape')?.pass, true);
    assert.equal(checks.find((item) => item.check === 'every emailed attachment hash matches the current file bytes and accepted evidence')?.pass, true);
    const idempotency = checks.find((item) => item.check === 'email used the fixed corpus idempotency key');
    assert.equal(idempotency.pass, true);
    assert.equal(idempotency.details.evidenceSource, 'task-execution-result-sha256');
    assert.equal(idempotency.details.actualIdempotencyKeySha256, digest(idempotencyKey));
    assert.equal(idempotency.details.missionActionValueRedacted, true);

    executionResult.attachmentSha256s = '[circular]';
    const malformedChecks = await verifyCase(testCase, root, {}, mission, [{
      execution: { executionResult }
    }]);
    const shape = malformedChecks.find((item) => item.check === 'accepted email attachment hash evidence has a valid object or array shape');
    assert.equal(shape.pass, false);
    assert.equal(shape.details.attachmentHashEvidence.every((item) => item.valid === false), true);
    assert.equal(malformedChecks.find((item) => item.check === 'every emailed attachment hash matches the current file bytes and accepted evidence')?.pass, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function verifiedAction(id, toolName, args, order) {
  return {
    actionId: `action_${id}`,
    observationId: `observation_${id}`,
    expectedToolName: toolName,
    actualToolName: toolName,
    arguments: args,
    order,
    status: 'succeeded'
  };
}
