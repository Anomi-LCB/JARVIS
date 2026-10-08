import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { verifyWorkflowActionProcess } from '../scripts/complex-workflow-process-verifier.mjs';
import { cases as workflowCases } from '../scripts/complex-workflow-50-cases.mjs';

const workspace = resolve('synthetic-workflow-verifier-workspace');

test('workflow process verifier proves input reads, search, dedicated writers, and post-create reread order', () => {
  const testCase = {
    command: 'a.csv와 b.json을 읽고 결과를 만들고 workspace에서 검색한 뒤 report.md를 다시 읽어.',
    inputs: { 'a.csv': 'a', 'b.json': '{}' },
    expected: {
      status: 'COMPLETED',
      files: [
        { path: 'a.csv', type: 'csv' },
        { path: 'moved/b.json', type: 'json' },
        { path: 'report.md', type: 'text' },
        { path: 'table.csv', type: 'csv' },
        { path: 'data.json', type: 'json' },
        { path: 'page.html', type: 'html' },
        { path: 'book.xlsx', type: 'xlsx' },
        { path: 'brief.docx', type: 'docx' },
        { path: 'deck.pptx', type: 'pptx' },
        { path: 'native.hwpx', type: 'hwpx' },
        { path: 'cards/card.png', type: 'png' },
        { path: 'bundle.zip', type: 'zip' }
      ]
    }
  };
  const actions = [
    action('filesystem.readText', { path: resolve(workspace, 'a.csv') }),
    action('filesystem.readText', { path: resolve(workspace, 'b.json') }),
    action('filesystem.searchFiles', { directory: workspace, query: 'report.md' }),
    action('filesystem.moveFiles', { moves: [{ from: resolve(workspace, 'b.json'), to: resolve(workspace, 'moved/b.json') }] }),
    action('filesystem.createTextFile', { path: resolve(workspace, 'report.md') }),
    action('filesystem.listFiles', { directory: workspace }),
    action('filesystem.createTextFile', { path: resolve(workspace, 'table.csv') }),
    action('filesystem.createTextFile', { path: resolve(workspace, 'data.json') }),
    action('filesystem.createTextFile', { path: resolve(workspace, 'page.html') }),
    action('excel.createWorkbook', { outputPath: resolve(workspace, 'book.xlsx') }),
    action('word.create', { path: resolve(workspace, 'brief.docx') }),
    action('powerpoint.create', { path: resolve(workspace, 'deck.pptx') }),
    action('hwp.create', { path: resolve(workspace, 'native.hwpx') }),
    action('visual.createCards', { outputDirectory: resolve(workspace, 'cards'), cards: [{ fileName: 'card.png' }] }),
    action('archive.createZip', { path: resolve(workspace, 'bundle.zip') }),
    action('filesystem.readText', { path: resolve(workspace, 'report.md') })
  ];
  const mission = missionFor(actions);
  const checks = verifyWorkflowActionProcess({
    testCase,
    workspace,
    inputManifest: { 'a.csv': {}, 'b.json': {} },
    mission
  });

  assert.equal(checks.length > 10, true);
  assert.deepEqual(checks.filter((item) => !item.pass), []);
  assert.equal(checks.find((item) => item.code === 'PROCESS_CREATED_TEXT_REREAD')?.details.qualifyingPairs[0].path, 'report.md');
});

test('workflow process verifier rejects early reread, fake completion tools, and route mismatches', () => {
  const testCase = {
    command: 'input.txt를 읽고 report.md를 만든 뒤 report.md를 다시 읽어.',
    expected: { status: 'COMPLETED', files: [{ path: 'report.md', type: 'text' }] }
  };
  const actions = [
    action('filesystem.readText', { path: resolve(workspace, 'input.txt') }),
    action('filesystem.listFiles', { directory: workspace }),
    action('filesystem.readText', { path: resolve(workspace, 'report.md') }),
    action('filesystem.createTextFile', { path: resolve(workspace, 'report.md') }, 'browser.search'),
    action('shell.execute', { command: 'Write-Output fake' })
  ];
  const checks = verifyWorkflowActionProcess({
    testCase,
    workspace,
    inputManifest: { 'input.txt': {} },
    mission: missionFor(actions)
  });

  assert.equal(checks.find((item) => item.code === 'PROCESS_CREATED_TEXT_REREAD')?.pass, false);
  assert.equal(checks.find((item) => item.code === 'PROCESS_OUTPUT_REDISCOVERY_ORDER')?.pass, false);
  assert.equal(checks.find((item) => item.code === 'PROCESS_NO_FAKE_COMPLETION_TOOLS')?.pass, false);
  assert.equal(checks.find((item) => item.code === 'PROCESS_NO_ROUTE_MISMATCH')?.pass, false);
});

test('workflow process verifier keeps expected-stop inputs and search mandatory while excluding absent outputs', () => {
  const testCase = {
    command: 'readme.txt를 읽고 missing.csv를 검색한 뒤 없으면 멈춰.',
    expected: {
      status: 'EXPECTED_STOP',
      liveWeb: false,
      files: [{ path: 'must-not-exist.xlsx', type: 'xlsx', absent: true }]
    }
  };
  const actions = [
    action('filesystem.readText', { path: resolve(workspace, 'readme.txt') }),
    action('filesystem.listFiles', { directory: workspace }, 'filesystem.searchFiles', {
      allowed: true,
      policy: 'a-mission-route-adaptation-v1',
      reason: 'equivalent-local-file-read',
      privilegeChange: 'same'
    })
  ];
  const checks = verifyWorkflowActionProcess({
    testCase,
    workspace,
    inputManifest: { 'readme.txt': {} },
    mission: missionFor(actions)
  });

  assert.deepEqual(checks.filter((item) => !item.pass), []);
  assert.equal(checks.some((item) => item.code === 'PROCESS_DEDICATED_OUTPUT_TOOL'), false);
  assert.equal(checks.find((item) => item.code === 'PROCESS_OUTPUT_REDISCOVERY_ORDER')?.details.required, false);
  assert.equal(checks.find((item) => item.code === 'PROCESS_ALLOWED_ROUTE_ADAPTATIONS')?.details.allowedAdaptationCount, 1);
  assert.deepEqual(checks.find((item) => item.code === 'PROCESS_ALLOWED_ROUTE_ADAPTATIONS')?.details.reasons, ['equivalent-local-file-read']);
});

test('workflow process verifier follows a proven exact move before accepting a destination read for an input', () => {
  const originalPath = resolve(workspace, 'drop/a.txt');
  const movedPath = resolve(workspace, 'sorted/text/a.txt');
  const actions = [
    action('filesystem.listFiles', { directory: resolve(workspace, 'drop') }),
    action('filesystem.moveFiles', { moves: [{ from: originalPath, to: movedPath }] }),
    action('filesystem.readText', { path: movedPath })
  ];
  const checks = verifyWorkflowActionProcess({
    testCase: { command: '파일을 이동한 뒤 다시 읽어.', expected: { status: 'EXPECTED_STOP', files: [] } },
    workspace,
    inputManifest: { 'drop/a.txt': {} },
    mission: missionFor(actions)
  });

  const inputReadCheck = checks.find((item) => item.code === 'PROCESS_INPUT_READS');
  assert.equal(inputReadCheck?.pass, true);
  assert.deepEqual(inputReadCheck?.details.missingInputReads, []);
  assert.deepEqual(inputReadCheck?.details.movedInputReads, [{
    inputPath: 'drop/a.txt',
    readPath: 'sorted/text/a.txt',
    readSequence: 2,
    moves: [{ from: 'drop/a.txt', to: 'sorted/text/a.txt', sequence: 1 }]
  }]);
});

test('workflow process verifier rejects early, unrelated, and unproven destination reads', () => {
  const originalPath = resolve(workspace, 'drop/a.txt');
  const movedPath = resolve(workspace, 'sorted/text/a.txt');
  const unrelatedPath = resolve(workspace, 'drop/other.txt');
  const scenarios = [
    missionFor([
      action('filesystem.listFiles', { directory: resolve(workspace, 'drop') }),
      action('filesystem.readText', { path: movedPath }),
      action('filesystem.moveFiles', { moves: [{ from: originalPath, to: movedPath }] })
    ]),
    missionFor([
      action('filesystem.listFiles', { directory: resolve(workspace, 'drop') }),
      action('filesystem.moveFiles', { moves: [{ from: unrelatedPath, to: movedPath }] }),
      action('filesystem.readText', { path: movedPath })
    ]),
    missionFor([
      action('filesystem.listFiles', { directory: resolve(workspace, 'drop') }),
      action('filesystem.moveFiles', { moves: [{ from: originalPath, to: movedPath }] }),
      action('filesystem.readText', { path: movedPath })
    ])
  ];
  scenarios[2].observations = scenarios[2].observations.filter((item) => item.toolName !== 'filesystem.moveFiles');

  for (const mission of scenarios) {
    const checks = verifyWorkflowActionProcess({
      testCase: { command: '파일 이동 뒤 읽기를 검증해.', expected: { status: 'EXPECTED_STOP', files: [] } },
      workspace,
      inputManifest: { 'drop/a.txt': {} },
      mission
    });
    const inputReadCheck = checks.find((item) => item.code === 'PROCESS_INPUT_READS');
    assert.equal(inputReadCheck?.pass, false);
    assert.deepEqual(inputReadCheck?.details.missingInputReads, ['drop/a.txt']);
    assert.deepEqual(inputReadCheck?.details.movedInputReads, []);
  }
});

test('workflow process verifier applies the exact C26 meeting*.txt selection and exempts its later manifest from reread', () => {
  const sourceCase = workflowCase('26');
  const originalA = resolve(workspace, 'inbox/meeting-a.txt');
  const originalB = resolve(workspace, 'inbox/meeting-b.txt');
  const reviewedA = resolve(workspace, 'reviewed/meeting-a.txt');
  const reviewedB = resolve(workspace, 'reviewed/meeting-b.txt');
  const actions = [
    action('filesystem.searchFiles', { directory: resolve(workspace, 'inbox'), query: 'meeting*.txt' }),
    action('filesystem.moveFiles', { moves: [
      { from: originalA, to: reviewedA },
      { from: originalB, to: reviewedB }
    ] }),
    action('filesystem.listFiles', { directory: resolve(workspace, 'reviewed') }),
    action('filesystem.listFiles', { directory: resolve(workspace, 'inbox') }),
    action('filesystem.readText', { path: reviewedA }),
    action('filesystem.readText', { path: reviewedB }),
    action('filesystem.createTextFile', { path: resolve(workspace, 'move-manifest.md') })
  ];
  const checks = verifyWorkflowActionProcess({
    testCase: processOnlyCase(sourceCase, [{ path: 'move-manifest.md', type: 'text' }]),
    workspace,
    inputManifest: sourceCase.inputs,
    mission: missionFor(actions)
  });

  assert.deepEqual(checks.filter((item) => !item.pass), []);
  const inputReadCheck = checks.find((item) => item.code === 'PROCESS_INPUT_READS');
  assert.equal(inputReadCheck?.details.declaredInputCount, 4);
  assert.equal(inputReadCheck?.details.expectedInputCount, 2);
  assert.deepEqual(inputReadCheck?.details.missingInputReads, []);
  assert.deepEqual(inputReadCheck?.details.excludedInputPaths, [
    'inbox/metrics.csv',
    'inbox/photo-note.md'
  ]);
  const rereadCheck = checks.find((item) => item.code === 'PROCESS_CREATED_TEXT_REREAD');
  assert.equal(rereadCheck?.details.required, false);
  assert.equal(rereadCheck?.details.exemptReason, 'reread-targets-do-not-include-generated-text');
  assert.deepEqual(rereadCheck?.details.generatedTextPaths, ['move-manifest.md']);
});

test('workflow process verifier recognizes C27 explicit reads without requiring collision-review.md reread', () => {
  const sourceCase = workflowCase('27');
  const archived = resolve(workspace, 'archive/report.txt');
  const incoming = resolve(workspace, 'inbox/report.txt');
  const movedIncoming = resolve(workspace, 'archive/report-incoming.txt');
  const actions = [
    action('filesystem.readText', { path: archived }),
    action('filesystem.readText', { path: incoming }),
    action('filesystem.moveFiles', { from: incoming, to: movedIncoming }),
    action('filesystem.searchFiles', { directory: resolve(workspace, 'archive'), query: 'report*.txt' }),
    action('filesystem.readText', { path: archived }),
    action('filesystem.readText', { path: movedIncoming }),
    action('filesystem.createTextFile', { path: resolve(workspace, 'collision-review.md') })
  ];
  const checks = verifyWorkflowActionProcess({
    testCase: processOnlyCase(sourceCase, [{ path: 'collision-review.md', type: 'text' }]),
    workspace,
    inputManifest: sourceCase.inputs,
    mission: missionFor(actions)
  });

  assert.deepEqual(checks.filter((item) => !item.pass), []);
  assert.equal(checks.find((item) => item.code === 'PROCESS_INPUT_READS')?.details.expectedInputCount, 2);
  const rereadCheck = checks.find((item) => item.code === 'PROCESS_CREATED_TEXT_REREAD');
  assert.equal(rereadCheck?.details.required, false);
  assert.equal(rereadCheck?.details.exemptReason, 'reread-targets-do-not-include-generated-text');
});

test('workflow process verifier follows all three C28 moves but does not invent a sort-manifest.csv reread', () => {
  const sourceCase = workflowCase('28');
  const moves = [
    ['drop/a.txt', 'sorted/text/a.txt'],
    ['drop/b.csv', 'sorted/data/b.csv'],
    ['drop/c.json', 'sorted/data/c.json']
  ].map(([from, to]) => ({ from: resolve(workspace, from), to: resolve(workspace, to) }));
  const actions = [
    action('filesystem.listFiles', { directory: resolve(workspace, 'drop') }),
    action('filesystem.moveFiles', { moves }),
    action('filesystem.searchFiles', { directory: resolve(workspace, 'sorted'), query: '*' }),
    ...moves.map((move) => action('filesystem.readText', { path: move.to })),
    action('filesystem.createTextFile', { path: resolve(workspace, 'sort-manifest.csv') })
  ];
  const checks = verifyWorkflowActionProcess({
    testCase: processOnlyCase(sourceCase, [{ path: 'sort-manifest.csv', type: 'csv' }]),
    workspace,
    inputManifest: sourceCase.inputs,
    mission: missionFor(actions)
  });

  assert.deepEqual(checks.filter((item) => !item.pass), []);
  const inputReadCheck = checks.find((item) => item.code === 'PROCESS_INPUT_READS');
  assert.equal(inputReadCheck?.details.expectedInputCount, 3);
  assert.equal(inputReadCheck?.details.movedInputReads.length, 3);
  const rereadCheck = checks.find((item) => item.code === 'PROCESS_CREATED_TEXT_REREAD');
  assert.equal(rereadCheck?.details.required, false);
  assert.equal(rereadCheck?.details.exemptReason, 'reread-targets-do-not-include-generated-text');
});

test('workflow process verifier still fails when one command-selected C26 input was not read', () => {
  const sourceCase = workflowCase('26');
  const originalA = resolve(workspace, 'inbox/meeting-a.txt');
  const originalB = resolve(workspace, 'inbox/meeting-b.txt');
  const reviewedA = resolve(workspace, 'reviewed/meeting-a.txt');
  const reviewedB = resolve(workspace, 'reviewed/meeting-b.txt');
  const actions = [
    action('filesystem.searchFiles', { directory: resolve(workspace, 'inbox'), query: 'meeting*.txt' }),
    action('filesystem.moveFiles', { moves: [
      { from: originalA, to: reviewedA },
      { from: originalB, to: reviewedB }
    ] }),
    action('filesystem.readText', { path: reviewedA })
  ];
  const checks = verifyWorkflowActionProcess({
    testCase: processOnlyCase(sourceCase),
    workspace,
    inputManifest: sourceCase.inputs,
    mission: missionFor(actions)
  });

  const inputReadCheck = checks.find((item) => item.code === 'PROCESS_INPUT_READS');
  assert.equal(inputReadCheck?.pass, false);
  assert.deepEqual(inputReadCheck?.details.missingInputReads, ['inbox/meeting-b.txt']);
  assert.deepEqual(inputReadCheck?.details.excludedInputPaths, ['inbox/metrics.csv', 'inbox/photo-note.md']);
});

test('workflow process verifier accepts unrequested materialized inputs without pretending they were read', () => {
  const testCase = {
    command: 'inbox를 나열해 파일명만 inventory.md에 저장해.',
    inputs: { 'inbox/a.txt': 'a', 'inbox/b.txt': 'b' },
    expected: { status: 'EXPECTED_STOP', files: [{ path: 'inventory.md', type: 'text' }] }
  };
  const actions = [
    action('filesystem.listFiles', { directory: resolve(workspace, 'inbox') }),
    action('filesystem.createTextFile', { path: resolve(workspace, 'inventory.md') })
  ];
  const checks = verifyWorkflowActionProcess({ testCase, workspace, inputManifest: testCase.inputs, mission: missionFor(actions) });

  assert.deepEqual(checks.filter((item) => !item.pass), []);
  const inputReadCheck = checks.find((item) => item.code === 'PROCESS_INPUT_READS');
  assert.equal(inputReadCheck?.details.expectedInputCount, 0);
  assert.deepEqual(inputReadCheck?.details.excludedInputPaths, ['inbox/a.txt', 'inbox/b.txt']);
  assert.equal(inputReadCheck?.details.exemptReason, 'command-does-not-request-these-inputs-be-read');
});

test('workflow process verifier binds an explicit filename to the read verb instead of every file in the clause', () => {
  const testCase = {
    command: 'a.txt는 archive/a.txt로 이동하고 b.txt를 읽어 내용을 확인해.',
    inputs: { 'a.txt': 'a', 'b.txt': 'b' },
    expected: { status: 'EXPECTED_STOP', files: [] }
  };
  const actions = [
    action('filesystem.searchFiles', { directory: workspace, query: '*.txt' }),
    action('filesystem.readText', { path: resolve(workspace, 'b.txt') })
  ];
  const checks = verifyWorkflowActionProcess({ testCase, workspace, inputManifest: testCase.inputs, mission: missionFor(actions) });

  assert.deepEqual(checks.filter((item) => !item.pass), []);
  const inputReadCheck = checks.find((item) => item.code === 'PROCESS_INPUT_READS');
  assert.equal(inputReadCheck?.details.expectedInputCount, 1);
  assert.deepEqual(inputReadCheck?.details.excludedInputPaths, ['a.txt']);
  assert.deepEqual(Object.keys(inputReadCheck?.details.selectionReasons ?? {}), ['b.txt']);
});

test('workflow process verifier supports contains-plus-extension selection and rejects a missing selected read', () => {
  const testCase = {
    command: '이름에 audit가 포함되고 확장자가 csv인 파일만 검색하고 선택된 파일을 모두 읽어.',
    inputs: {
      'inbox/audit-a.csv': 'a',
      'inbox/audit-b.csv': 'b',
      'inbox/audit-note.txt': 'note',
      'inbox/data.csv': 'data'
    },
    expected: { status: 'EXPECTED_STOP', files: [] }
  };
  const actions = [
    action('filesystem.searchFiles', { directory: resolve(workspace, 'inbox'), query: '*audit*.csv' }),
    action('filesystem.readText', { path: resolve(workspace, 'inbox/audit-a.csv') })
  ];
  const checks = verifyWorkflowActionProcess({ testCase, workspace, inputManifest: testCase.inputs, mission: missionFor(actions) });

  const inputReadCheck = checks.find((item) => item.code === 'PROCESS_INPUT_READS');
  assert.equal(inputReadCheck?.pass, false);
  assert.equal(inputReadCheck?.details.expectedInputCount, 2);
  assert.deepEqual(inputReadCheck?.details.missingInputReads, ['inbox/audit-b.csv']);
  assert.deepEqual(inputReadCheck?.details.excludedInputPaths, ['inbox/audit-note.txt', 'inbox/data.csv']);
});

test('workflow process verifier requires every generated text type named by a reread clause', () => {
  const testCase = {
    command: 'report.md와 dashboard.html을 만든 뒤 검색하고 HTML과 markdown을 각각 다시 읽어.',
    expected: {
      status: 'COMPLETED',
      files: [
        { path: 'report.md', type: 'text' },
        { path: 'dashboard.html', type: 'html' }
      ]
    }
  };
  const actions = [
    action('filesystem.createTextFile', { path: resolve(workspace, 'report.md') }),
    action('filesystem.createTextFile', { path: resolve(workspace, 'dashboard.html') }),
    action('filesystem.searchFiles', { directory: workspace, query: '*' }),
    action('filesystem.readText', { path: resolve(workspace, 'report.md') })
  ];
  const checks = verifyWorkflowActionProcess({ testCase, workspace, mission: missionFor(actions) });

  const rereadCheck = checks.find((item) => item.code === 'PROCESS_CREATED_TEXT_REREAD');
  assert.equal(rereadCheck?.pass, false);
  assert.deepEqual(rereadCheck?.details.requiredRereadPaths, ['report.md', 'dashboard.html']);
  assert.deepEqual(rereadCheck?.details.missingRereadPaths, ['dashboard.html']);
});

test('all 50 workflow commands retain their command-authoritative input and generated-text reread contracts', () => {
  const generatedRereadCaseIds = [];
  const inputRereadOnlyCaseIds = [];
  for (const testCase of workflowCases) {
    const checks = verifyWorkflowActionProcess({
      testCase: processOnlyCase(testCase, testCase.expected.files),
      workspace,
      inputManifest: testCase.inputs,
      mission: missionFor([])
    });
    const inputReadCheck = checks.find((item) => item.code === 'PROCESS_INPUT_READS');
    if (Object.keys(testCase.inputs ?? {}).length > 0) {
      const expectedInputCount = testCase.id === '26' ? 2 : Object.keys(testCase.inputs).length;
      assert.equal(inputReadCheck?.details.expectedInputCount, expectedInputCount, `C${testCase.id} input read contract`);
    }

    const rereadCheck = checks.find((item) => item.code === 'PROCESS_CREATED_TEXT_REREAD');
    if ((rereadCheck?.details.rereadClauses ?? []).length === 0) continue;
    if (rereadCheck?.details.required) generatedRereadCaseIds.push(testCase.id);
    else inputRereadOnlyCaseIds.push(testCase.id);
  }

  assert.deepEqual(generatedRereadCaseIds, [
    '01', '02', '04', '06', '07', '08', '09', '10', '11', '12', '14',
    '17', '18', '19', '22', '24', '29', '30', '33', '34', '35', '38',
    '43', '44', '45', '50'
  ]);
  assert.deepEqual(inputRereadOnlyCaseIds, ['26', '27', '28']);
});

let nextActionId = 0;
function action(actualToolName, args, expectedToolName = actualToolName, routeAdaptation = null) {
  const actionId = `action_${++nextActionId}`;
  return {
    actionId,
    observationId: `observation_${actionId}`,
    expectedToolName,
    actualToolName,
    arguments: args,
    status: 'succeeded',
    ...(routeAdaptation ? { routeAdaptation } : {})
  };
}

function missionFor(actions) {
  return {
    waves: [{ waveIndex: 1, actions: actions.map((item, index) => ({ ...item, order: index + 1 })) }],
    observations: actions.map((item) => ({
      observationId: item.observationId,
      actionId: item.actionId,
      toolName: item.actualToolName,
      outcome: 'success'
    }))
  };
}

function workflowCase(id) {
  const testCase = workflowCases.find((item) => item.id === id);
  assert.ok(testCase, `workflow case ${id} exists`);
  return testCase;
}

function processOnlyCase(testCase, files = []) {
  return {
    ...testCase,
    expected: {
      ...testCase.expected,
      status: 'EXPECTED_STOP',
      files
    }
  };
}
