import assert from 'node:assert/strict';
import test from 'node:test';
import { GoalExecutivePlanner, buildMissionPlanningPrompt } from '../packages/core/src/mission/mission-planner.js';
import { MissionRuntime } from '../packages/core/src/mission/mission-runtime.js';

const reportHash = '8ba132a912fcb7c7b243e9ea618b94a315d7286a9b3dbf16b866928c2a5c2f9c';
const zipHash = 'f0810a5899b4d20ac8ee056041eb40ad4af0b19c887621724621a34eea063e8f';
const reportPath = 'C:\\workspace\\executive-ops-report.md';

function runtimeObservation(action, executionResult) {
  return MissionRuntime.prototype.successObservation.call({
    artifactReference(path, details = {}) {
      const name = String(path).split(/[\\/]/u).at(-1);
      return {
        name,
        relativePath: name,
        rootIndex: 0,
        outsideAllowedRoots: false,
        ...details
      };
    }
  }, action, { taskId: action.taskId }, {
    execution: { executionResult },
    executionVerification: {
      verificationId: `verification-${action.actionId}`,
      status: 'passed',
      score: 100,
      checks: []
    }
  });
}

function plannerContext({ objective = '보고서를 만들고 검증된 결과를 전송해줘', observations = [], waves = [] } = {}) {
  return {
    capabilities: [
      { toolName: 'archive.createZip' },
      { toolName: 'email.send' },
      { toolName: 'filesystem.createTextFile' },
      { toolName: 'filesystem.listFiles' },
      { toolName: 'filesystem.readText' },
      { toolName: 'shell.execute' }
    ],
    mission: { objective, successCriteria: [], waves },
    observations
  };
}

function hashShellAction() {
  return {
    id: 'hash',
    title: 'executive-ops-report.md SHA-256 해시 확인',
    command: 'PowerShell 명령 실행: executive-ops-report.md 파일의 SHA-256 해시를 확인해줘',
    expectedToolName: 'shell.execute',
    arguments: {
      command: `(Get-FileHash '${reportPath}' -Algorithm SHA256).Hash.ToLower()`
    },
    dependencies: []
  };
}

test('Mission observations retain dedicated create and read SHA-256 evidence', () => {
  const createObservation = runtimeObservation({
    actionId: 'create-report',
    taskId: 'task-create-report',
    actualToolName: 'filesystem.createTextFile',
    arguments: { path: reportPath }
  }, {
    status: 'success',
    sha256: '[redacted]',
    outputPaths: [reportPath],
    evidence: {
      executionEvidence: {
        files: [{ path: reportPath, sha256: reportHash, size: 1306 }]
      }
    }
  });
  assert.equal(createObservation.artifacts[0].contentSha256, reportHash);

  const readObservation = runtimeObservation({
    actionId: 'read-report',
    taskId: 'task-read-report',
    actualToolName: 'filesystem.readText',
    arguments: { path: reportPath, maxChars: 12000 }
  }, {
    status: 'success',
    outputPaths: [],
    stdoutPreview: '# 운영 총괄 보고서',
    contentSha256: reportHash,
    evidence: { contentSha256: reportHash }
  });
  assert.deepEqual(readObservation.artifacts, []);
  assert.equal(readObservation.data.fileEvidence.relativePath, 'executive-ops-report.md');
  assert.equal(readObservation.data.fileEvidence.contentSha256, reportHash);
});

test('Planner removes C50 redundant hash shell while preserving archive and exact email bindings', () => {
  const createObservation = runtimeObservation({
    actionId: 'create-report',
    taskId: 'task-create-report',
    actualToolName: 'filesystem.createTextFile',
    arguments: { path: reportPath }
  }, {
    status: 'success',
    outputPaths: [reportPath],
    evidence: { executionEvidence: { files: [{ path: reportPath, sha256: reportHash }] } }
  });
  const readObservation = runtimeObservation({
    actionId: 'read-report',
    taskId: 'task-read-report',
    actualToolName: 'filesystem.readText',
    arguments: { path: reportPath }
  }, {
    status: 'success',
    outputPaths: [],
    contentSha256: reportHash,
    evidence: { contentSha256: reportHash }
  });
  const emailArguments = {
    to: '',
    recipientMode: 'self',
    subject: '[JARVIS-50:C50] 운영 총괄 검증본',
    body: '검증된 보고서와 ZIP을 첨부합니다.',
    attachments: [
      { attachmentRef: { rootIndex: 0, relativePath: 'executive-ops-report.md' }, attachmentSha256: reportHash },
      { attachmentRef: { rootIndex: 0, relativePath: 'executive-ops-package.zip' }, attachmentSha256: zipHash }
    ],
    idempotencyKey: 'jarvis-complex-workflow-50-C50-v1'
  };
  const planner = new GoalExecutivePlanner();
  const plan = planner.sanitizePlan({
    decision: 'continue',
    actions: [
      {
        id: 'zip',
        title: 'executive-ops-package.zip 생성',
        command: '보고서와 카드를 executive-ops-package.zip으로 압축해줘',
        expectedToolName: 'archive.createZip',
        arguments: { path: 'C:\\workspace\\executive-ops-package.zip', inputPaths: [reportPath] },
        dependencies: []
      },
      hashShellAction(),
      {
        id: 'email',
        title: '운영 총괄 보고서 메일 발송',
        command: '검증된 두 파일을 내 Gmail로 보내줘',
        expectedToolName: 'email.send',
        arguments: emailArguments,
        dependencies: ['zip', 'hash']
      }
    ],
    criteriaAssessment: []
  }, plannerContext({
    objective: 'executive-ops-report.md와 executive-ops-package.zip을 검증해 내 구글 메일로 보내줘.',
    observations: [createObservation, readObservation],
    waves: [{ actions: [
      { actionId: 'create-report', arguments: { path: reportPath } },
      { actionId: 'read-report', arguments: { path: reportPath } }
    ] }]
  }));

  assert.deepEqual(plan.actions.map((action) => action.expectedToolName), ['archive.createZip', 'email.send']);
  const email = plan.actions.at(-1);
  assert.deepEqual(email.dependencies, ['zip']);
  assert.deepEqual(email.arguments, emailArguments);
});

test('Planner preserves shell verification with in-wave prerequisites despite older file evidence', () => {
  const planner = new GoalExecutivePlanner();
  const plan = planner.sanitizePlan({ decision: 'continue', actions: [
    {
      id: 'refresh', command: 'executive-ops-report.md 텍스트 파일을 만들어줘',
      expectedToolName: 'filesystem.createTextFile', arguments: { path: reportPath, content: '새 관찰' }, dependencies: []
    },
    { ...hashShellAction(), dependencies: ['refresh'] },
    {
      id: 'read_after_hash', command: 'executive-ops-report.md 내용을 읽어줘',
      expectedToolName: 'filesystem.readText', arguments: { path: reportPath }, dependencies: ['hash']
    }
  ] }, plannerContext({ observations: [{
    actionId: 'old-create', outcome: 'success', toolName: 'filesystem.createTextFile',
    artifacts: [{ relativePath: 'executive-ops-report.md', contentSha256: reportHash }], verification: { status: 'passed' }
  }] }));
  assert.deepEqual(plan.actions.map(({ id, dependencies }) => ({ id, dependencies })), [
    { id: 'refresh', dependencies: [] }, { id: 'hash', dependencies: ['refresh'] },
    { id: 'read_after_hash', dependencies: ['hash'] }
  ]);
});

test('Planner preserves explicit shell requests and failure fallbacks', () => {
  const evidence = [{
    actionId: 'create-report',
    outcome: 'success',
    toolName: 'filesystem.createTextFile',
    artifacts: [{ relativePath: 'executive-ops-report.md', contentSha256: reportHash }],
    verification: { status: 'passed' }
  }];
  const planner = new GoalExecutivePlanner();
  const explicit = planner.sanitizePlan({
    decision: 'continue',
    actions: [hashShellAction()],
    criteriaAssessment: []
  }, plannerContext({
    objective: 'PowerShell로 Get-FileHash를 실행해서 executive-ops-report.md의 SHA-256을 출력해줘.',
    observations: evidence
  }));
  assert.equal(explicit.actions[0].expectedToolName, 'shell.execute');

  const fallbackAction = hashShellAction();
  fallbackAction.title = '전용 도구 실패 후 대체 해시 확인';
  const fallback = planner.sanitizePlan({
    decision: 'continue',
    actions: [fallbackAction],
    criteriaAssessment: []
  }, plannerContext({ observations: evidence }));
  assert.equal(fallback.actions[0].expectedToolName, 'shell.execute');

  const failedOnly = planner.sanitizePlan({
    decision: 'continue',
    actions: [hashShellAction()],
    criteriaAssessment: []
  }, plannerContext({
    observations: [{
      actionId: 'create-report',
      outcome: 'failed',
      toolName: 'filesystem.createTextFile',
      artifacts: [],
      verification: { status: 'failed' }
    }]
  }));
  assert.equal(failedOnly.actions[0].expectedToolName, 'shell.execute');
});

test('Documentation mentions and filenames do not become explicit shell requests', () => {
  const planner = new GoalExecutivePlanner();
  const plan = planner.sanitizePlan({
    decision: 'continue',
    actions: [{
      ...hashShellAction(),
      title: 'powershell-integrity.hwpx SHA-256 확인',
      command: 'PowerShell 명령 실행: powershell-integrity.hwpx 파일의 SHA-256 해시를 확인해줘',
      arguments: { command: "(Get-FileHash 'C:\\workspace\\powershell-integrity.hwpx').Hash" }
    }],
    criteriaAssessment: []
  }, plannerContext({
    objective: 'Microsoft Learn의 Get-FileHash와 Get-Content 공식 문서를 읽고 절차를 powershell-integrity.hwpx에 작성한 뒤 형식과 개수를 확인해.',
    observations: [{
      actionId: 'create-guide',
      outcome: 'success',
      toolName: 'hwp.create',
      artifacts: [{ relativePath: 'powershell-integrity.hwpx', contentSha256: reportHash }],
      verification: { status: 'passed' }
    }],
    waves: [{ actions: [{ actionId: 'create-guide', arguments: { path: 'C:\\workspace\\powershell-integrity.hwpx' } }] }]
  }));
  assert.equal(plan, null);
});

test('Planner removes covered shell list, read, and write verification actions', () => {
  const planner = new GoalExecutivePlanner({ maxActionsPerWave: 8 });
  const listActionId = 'mission-list';
  const plan = planner.sanitizePlan({
    decision: 'continue',
    actions: [
      {
        id: 'list', title: '목록 재검증', command: 'PowerShell 명령 실행: 폴더 목록을 확인해줘',
        expectedToolName: 'shell.execute', arguments: { command: "Get-ChildItem 'C:\\workspace'" }
      },
      {
        id: 'read', title: '본문 재검증', command: 'PowerShell 명령 실행: report.md 내용을 읽어줘',
        expectedToolName: 'shell.execute', arguments: { command: "Get-Content 'C:\\workspace\\report.md'" }
      },
      {
        id: 'write', title: '본문 쓰기 재검증', command: 'PowerShell 명령 실행: report.md 내용을 기록해줘',
        expectedToolName: 'shell.execute', arguments: { command: "Set-Content 'C:\\workspace\\report.md' 'done'" }
      },
      {
        id: 'keep', title: '압축', command: 'report.md를 report.zip으로 압축해줘',
        expectedToolName: 'archive.createZip', arguments: { path: 'C:\\workspace\\report.zip', inputPaths: ['C:\\workspace\\report.md'] }
      }
    ],
    criteriaAssessment: []
  }, plannerContext({
    observations: [
      {
        actionId: listActionId, outcome: 'success', toolName: 'filesystem.listFiles',
        data: { items: [{ name: 'report.md' }] }, verification: { status: 'passed' }
      },
      {
        actionId: 'mission-read', outcome: 'success', toolName: 'filesystem.readText', artifacts: [],
        data: { fileEvidence: { relativePath: 'report.md', contentSha256: reportHash } }, verification: { status: 'passed' }
      },
      {
        actionId: 'mission-write', outcome: 'success', toolName: 'filesystem.createTextFile',
        artifacts: [{ relativePath: 'report.md', contentSha256: reportHash }], verification: { status: 'passed' }
      }
    ],
    waves: [{ actions: [
      { actionId: listActionId, arguments: { directory: 'C:\\workspace' } },
      { actionId: 'mission-read', arguments: { path: 'C:\\workspace\\report.md' } },
      { actionId: 'mission-write', arguments: { path: 'C:\\workspace\\report.md' } }
    ] }]
  }));
  assert.deepEqual(plan.actions.map((action) => action.id), ['keep']);
});

test('Mission prompt makes dedicated evidence authoritative over redundant shell verification', () => {
  const prompt = buildMissionPlanningPrompt({
    ...plannerContext({ observations: [{
      actionId: 'read-report',
      outcome: 'success',
      toolName: 'filesystem.readText',
      data: { fileEvidence: { rootIndex: 0, relativePath: 'executive-ops-report.md', contentSha256: reportHash } },
      verification: { status: 'passed' }
    }] }),
    capabilitySelection: null,
    maxActionsPerWave: 4,
    today: '2026-09-03'
  });
  assert.match(prompt, /contentSha256·목록·읽기 증거/);
  assert.match(prompt, /같은 파일을 해시·목록·읽기·쓰기 검증하기 위한 shell\.execute를 추가하지 마세요/);
  assert.match(prompt, /전용 도구가 실패한 뒤의 명시적 대체 경로/);
  assert.match(prompt, new RegExp(reportHash));
});
