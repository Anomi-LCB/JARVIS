import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WindowsDesktopControlToolAdapter } from '../apps/pc-agent/src/windows-desktop-control.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { ExecutionResultVerifier } from '../apps/verification/src/verification-runtime.js';
import { IntentParser } from '../packages/core/src/intent/intent-parser.js';
import { ClaudeCliTaskPlanner } from '../packages/core/src/planning/claude-cli-task-planner.js';
import { ActionType, createTaskRequest, InputSource, ModuleId, TaskStatus } from '../packages/shared/src/types.js';

const intentParser = new IntentParser();

test('visual helper processes share the desktop adapter DPI coordinate space', async () => {
  for (const helper of ['windows-local-ocr.ps1', 'windows-local-template-match.ps1']) {
    const source = await readFile(join(process.cwd(), 'apps', 'pc-agent', 'src', helper), 'utf8');
    const dpiActivation = source.indexOf(']::SetProcessDPIAware()');
    const coordinateScale = source.indexOf('DpiX / 96.0');
    const virtualBoundsRead = source.indexOf('[System.Windows.Forms.SystemInformation]::VirtualScreen');
    assert.notEqual(dpiActivation, -1, `${helper} must activate DPI awareness`);
    assert.notEqual(coordinateScale, -1, `${helper} must calculate the screen coordinate scale`);
    assert.notEqual(virtualBoundsRead, -1, `${helper} must read virtual screen bounds`);
    assert.ok(dpiActivation < virtualBoundsRead, `${helper} must activate DPI awareness before reading bounds`);
    assert.ok(coordinateScale < virtualBoundsRead, `${helper} must calculate scaling before mapping bounds`);
    assert.match(source, /requestedX\s*\/\s*\$screenScaleX/);
    assert.match(source, /PrintWindow/, `${helper} must support window-relative capture`);
  }
  const controller = await readFile(join(process.cwd(), 'apps', 'pc-agent', 'src', 'windows-desktop-control.ps1'), 'utf8');
  assert.match(controller, /windowHandle\s*=\s*\$handle\.ToInt64\(\)/);
  assert.match(controller, /Local\\JARVIS\.DesktopControl\.Execution\.v1/);
  assert.match(controller, /desktop-control-busy/);
  assert.match(controller, /PointBelongsToProcess/);
  assert.match(controller, /desktop-visual-point-not-owned-by-target/);
  assert.match(controller, /AttachThreadInput/);
  assert.match(controller, /ActivateWindow/);
});

test('Korean window interaction commands route to the dedicated desktop control action', () => {
  const command = 'JARVIS 테스트 창의 입력란에 완료를 입력하고 Apply 버튼을 눌러';
  const intent = intentParser.parse(command, { requestId: 'request_desktop_intent' });

  assert.equal(intent.actionType, ActionType.DESKTOP_CONTROL);
  assert.equal(intent.category, 'desktop');
  assert.equal(intent.slots.rawCommand, command);
});

test('LLM desktop plans are sanitized into UI Automation operations and routed to desktop.control', () => {
  const command = 'JARVIS 테스트 창의 입력란에 완료를 입력하고 Apply 버튼을 눌러';
  let plannerCalls = 0;
  const planner = new ClaudeCliTaskPlanner({
    runner: () => {
      plannerCalls += 1;
      return plannerResponse({
        target: { titleContains: 'JARVIS 테스트' },
        operations: [
          { op: 'SETVALUE', selector: { automationId: 'CommandInput' }, value: '완료' },
          { op: 'invoke', selector: { automationId: 'ApplyButton' } },
          { op: 'clickText', text: 'VISUAL APPLY', matchMode: 'exact' },
          { op: 'clickTemplate', targetLabel: '확인 아이콘', templatePath: 'C:\\workspace\\confirm.png', minConfidence: 0.93 }
        ],
        verification: [
          { type: 'ELEMENTVALUEEQUALS', selector: { automationId: 'StatusLabel' }, expected: '완료' }
        ],
        timeoutMs: 8000
      });
    }
  });
  const taskRequest = makeTaskRequest(command);
  const intent = intentParser.parse(command, { requestId: taskRequest.requestId });
  const plan = planner.createPlan(taskRequest, intent, { route: planner.skillRouter.route(intent) });

  assert.equal(plan.action.actionType, ActionType.DESKTOP_CONTROL);
  assert.equal(plan.action.toolName, 'desktop.control');
  assert.deepEqual(plan.action.arguments.target, { titleContains: 'JARVIS 테스트' });
  assert.deepEqual(plan.action.arguments.operations.map((item) => item.op), ['setValue', 'invoke', 'clickText', 'clickTemplate']);
  assert.deepEqual(plan.action.arguments.operations[2], { op: 'clickText', text: 'VISUAL APPLY', matchMode: 'exact' });
  assert.deepEqual(plan.action.arguments.operations[3], {
    op: 'clickTemplate',
    targetLabel: '확인 아이콘',
    templatePath: 'C:\\workspace\\confirm.png',
    minConfidence: 0.93
  });
  assert.deepEqual(plan.action.arguments.verification.map((item) => item.type), ['elementValueEquals']);
  assert.equal(plan.action.arguments.timeoutMs, 8000);
  assert.equal(plannerCalls, 1, 'one desktop action uses one structured planning round trip');
  assert.equal(
    plan.planGraph.nodes.filter((node) => node.nodeId?.startsWith('action_')).length,
    1,
    'one ordered desktop transaction is never duplicated into sentence fragments'
  );
});

test('visual icon control pins a trusted local template and fails closed on risky, outside-root, or unverified clicks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-template-control-'));
  const workspace = join(root, 'workspace');
  const templatePath = join(workspace, 'confirm.png');
  const outsidePath = join(root, 'outside.png');
  const calls = [];
  await mkdir(workspace, { recursive: true });
  await writeFile(templatePath, Buffer.alloc(128, 0x5a));
  await writeFile(outsidePath, Buffer.alloc(128, 0x4b));
  try {
    const adapter = new WindowsDesktopControlToolAdapter({
      hostPlatform: 'win32',
      allowedRoots: [workspace],
      runner: (request) => {
        calls.push(request);
        const operation = request.operations[0];
        return {
          adapterVersion: 'b-windows-desktop-control-v1',
          status: 'success',
          interactiveSession: true,
          operations: [{
            op: 'clicktemplate',
            status: 'completed',
            perception: {
              adapterVersion: 'b-windows-local-template-v1',
              engine: 'Jarvis.LocalTemplateMatcher',
              templateHash: operation.templateHash,
              captureHash: 'capture-hash',
              matchCount: 1,
              candidateCount: 1,
              selectedIndex: 0,
              confidence: 0.976,
              secondConfidence: 0.2,
              ambiguityGap: 0.776,
              selectedScale: 1,
              screenshotStored: false,
              rawPixelsStored: false,
              templateCopied: false,
              foregroundVerified: true,
              centerX: 640,
              centerY: 480
            }
          }],
          operationCount: 1,
          verification: { passed: true, checks: [{ type: 'windowTitleContains', passed: true, expectedHash: 'expected', actualHash: 'actual' }] },
          observedWindow: { found: true, titleHash: 'window-hash' }
        };
      }
    });

    const result = await adapter.execute({
      target: { titleContains: 'Canvas Fixture' },
      operations: [{ op: 'clickTemplate', targetLabel: '확인 아이콘', templatePath, minConfidence: 0.95 }],
      verification: [{ type: 'windowTitleContains', expected: 'ICON_DONE' }]
    });
    assert.equal(result.status, 'success');
    assert.equal(calls[0].operations[0].templateTrusted, true);
    assert.match(calls[0].operations[0].templateHash, /^[a-f0-9]{64}$/);
    assert.equal(result.evidence.operations[0].perception.engine, 'Jarvis.LocalTemplateMatcher');
    assert.equal(result.evidence.operations[0].perception.rawPixelsStored, false);
    assert.equal(JSON.stringify(result.evidence).includes(templatePath), false);
    assert.equal(JSON.stringify(result.evidence).includes('centerX'), false);

    const outside = await adapter.execute({
      target: { titleContains: 'Canvas Fixture' },
      operations: [{ op: 'clickTemplate', targetLabel: '확인 아이콘', templatePath: outsidePath }],
      verification: [{ type: 'windowTitleContains', expected: 'ICON_DONE' }]
    });
    assert.equal(outside.status, 'blocked');
    assert.equal(outside.error, 'desktop-visual-template-untrusted');

    const risky = await adapter.execute({
      target: { titleContains: 'Canvas Fixture' },
      operations: [{ op: 'clickTemplate', targetLabel: '모두 삭제', templatePath }],
      verification: [{ type: 'windowTitleContains', expected: 'DELETED' }]
    });
    assert.equal(risky.status, 'blocked');
    assert.equal(risky.error, 'desktop-visual-target-blocked');

    const unverified = await adapter.execute({
      target: { titleContains: 'Canvas Fixture' },
      operations: [{ op: 'clickTemplate', targetLabel: '확인 아이콘', templatePath }],
      verification: [{ type: 'windowExists' }]
    });
    assert.equal(unverified.status, 'blocked');
    assert.equal(unverified.error, 'desktop-visual-click-postcondition-required');
    assert.equal(calls.length, 1, 'blocked template clicks never reach the Windows helper');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local template helper rejects a changed template hash before screen capture', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-template-hash-'));
  const templatePath = join(root, 'changed.png');
  await writeFile(templatePath, Buffer.alloc(128, 0x6c));
  try {
    const request = {
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      templatePath,
      templateHash: '0'.repeat(64),
      minConfidence: 0.9,
      scaleTolerance: 0.2
    };
    const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
    const stdout = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(process.cwd(), 'apps', 'pc-agent', 'src', 'windows-local-template-match.ps1')
    ], {
      encoding: 'utf8',
      env: { ...process.env, JARVIS_LOCAL_TEMPLATE_REQUEST_BASE64: encoded }
    });
    const result = JSON.parse(String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1));
    assert.equal(result.status, 'failed');
    assert.equal(result.stage, 'template-load');
    assert.equal(result.screenshotStored, false);
    assert.equal(result.rawPixelsStored, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('visual text control uses local OCR evidence and fails closed for sensitive or unverified targets', async () => {
  const calls = [];
  const adapter = new WindowsDesktopControlToolAdapter({
    hostPlatform: 'win32',
    runner: (request) => {
      calls.push(request);
      return {
        adapterVersion: 'b-windows-desktop-control-v1',
        status: 'success',
        interactiveSession: true,
        operations: [{
          op: 'clicktext',
          status: 'completed',
          perception: {
            adapterVersion: 'b-windows-local-ocr-v1',
            engine: 'Windows.Media.Ocr',
            languageTag: 'ko',
            queryHash: 'query-hash',
            matchMode: 'exact',
            matchCount: 1,
            selectedIndex: 0,
            wordCount: 4,
            captureHash: 'capture-hash',
            screenshotStored: false,
            rawOcrTextStored: false,
            foregroundVerified: true,
            centerX: 999,
            centerY: 888
          }
        }],
        operationCount: 1,
        verification: { passed: true, checks: [{ type: 'windowTitleContains', passed: true, expectedHash: 'expected', actualHash: 'actual' }] },
        observedWindow: { found: true, titleHash: 'window-hash' }
      };
    }
  });

  const result = await adapter.execute({
    target: { titleContains: 'Canvas Fixture' },
    operations: [{ op: 'clickText', text: 'VISUAL APPLY', matchMode: 'exact' }],
    verification: [{ type: 'windowTitleContains', expected: 'VISUAL_DONE' }]
  });
  assert.equal(result.status, 'success');
  assert.equal(result.evidence.operations[0].perception.engine, 'Windows.Media.Ocr');
  assert.equal(result.evidence.operations[0].perception.foregroundVerified, true);
  assert.equal(JSON.stringify(result.evidence).includes('VISUAL APPLY'), false);
  assert.equal(JSON.stringify(result.evidence).includes('centerX'), false);

  const blockedSensitive = await adapter.execute({
    target: { titleContains: 'Canvas Fixture' },
    operations: [{ op: 'clickText', text: '모두 허용' }],
    verification: [{ type: 'windowTitleContains', expected: '완료' }]
  });
  assert.equal(blockedSensitive.status, 'blocked');
  assert.equal(blockedSensitive.error, 'desktop-visual-target-blocked');

  const blockedUnverified = await adapter.execute({
    target: { titleContains: 'Canvas Fixture' },
    operations: [{ op: 'clickText', text: 'VISUAL APPLY' }],
    verification: [{ type: 'windowExists' }]
  });
  assert.equal(blockedUnverified.status, 'blocked');
  assert.equal(blockedUnverified.error, 'desktop-visual-click-postcondition-required');
  assert.equal(calls.length, 1, 'blocked visual targets never reach the helper');
});

test('desktop adapter emits minimized evidence and blocks script hosts before execution', async () => {
  const calls = [];
  const adapter = new WindowsDesktopControlToolAdapter({
    hostPlatform: 'win32',
    runner: (request) => {
      calls.push(request);
      return {
        adapterVersion: 'b-windows-desktop-control-v1',
        status: 'success',
        interactiveSession: true,
        operations: request.operations.map((operation) => ({ op: operation.op, status: 'completed', durationMs: 2 })),
        operationCount: request.operations.length,
        verification: {
          passed: true,
          checks: request.verification.map((check) => ({ type: check.type, passed: true, expectedHash: 'expected', actualHash: 'actual' }))
        },
        observedWindow: { found: true, titleHash: 'window-hash' }
      };
    }
  });
  const args = {
    target: { title: 'JARVIS Desktop Fixture' },
    operations: [
      { op: 'setValue', selector: { automationId: 'CommandInput' }, value: 'sensitive typed value' },
      { op: 'invoke', selector: { automationId: 'ApplyButton' } }
    ],
    verification: [
      { type: 'elementValueEquals', selector: { automationId: 'StatusLabel' }, expected: 'sensitive typed value' }
    ]
  };

  const shadow = await adapter.shadow(args);
  const result = await adapter.execute(args);
  assert.deepEqual(shadow.warnings, []);
  assert.equal(result.status, 'success');
  assert.equal(result.changedItems.length, 2);
  assert.equal(JSON.stringify(result.evidence).includes('sensitive typed value'), false);
  assert.equal(calls.length, 2, 'shadow observation and execution both use the structured helper');

  const blocked = await adapter.execute({
    operations: [{ op: 'launch', filePath: 'powershell.exe', arguments: ['-Command', 'whoami'] }],
    verification: [{ type: 'windowExists' }]
  });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.error, /desktop-launch-blocked/);
  assert.equal(calls.length, 2, 'blocked launch never reaches the Windows helper');
});

test('PC agent records adapter verification failures as FAILED rather than COMPLETED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-desktop-failure-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  try {
    const desktopControlAdapter = new WindowsDesktopControlToolAdapter({
      hostPlatform: 'win32',
      runner: (request) => request.operations.every((operation) => operation.op === 'inspect')
        ? {
            status: 'success',
            interactiveSession: true,
            operations: [{ op: 'inspect', status: 'completed' }],
            verification: { passed: true, checks: [{ type: 'windowExists', passed: true }] },
            observedWindow: { found: true, titleHash: 'fixture-window' }
          }
        : {
          status: 'failed',
          error: 'desktop-control-verification-failed',
          interactiveSession: true,
          operations: [{ op: 'invoke', status: 'completed' }],
          verification: { passed: false, checks: [{ type: 'elementValueEquals', passed: false }] },
          observedWindow: { found: true, titleHash: 'fixture-window' }
        }
    });
    const runtime = createAgRuntime({
      allowedRoots: [workspace],
      auditRoot: join(root, 'audit'),
      desktopControlAdapter,
      env: {},
      workerDaemonEnabled: false
    });
    const result = await execute(runtime, {
      id: 'desktop_failed',
      actionType: ActionType.DESKTOP_CONTROL,
      toolName: 'desktop.control',
      args: {
        target: { title: 'JARVIS Desktop Fixture' },
        operations: [{ op: 'invoke', selector: { automationId: 'ApplyButton' } }],
        verification: [{ type: 'elementValueEquals', selector: { automationId: 'StatusLabel' }, expected: '완료' }]
      }
    });

    assert.equal(result.status, TaskStatus.FAILED);
    assert.equal(result.executionResult.status, 'failed');
    assert.equal(result.failedReason, 'desktop-control-verification-failed');
    assert.equal(result.executionResult.interactiveSession, true);
    assert.equal(result.executionResult.changedItems.length, 1);
    assert.equal(result.executionResult.changedItems[0].verificationStatus, 'unverified');
    assert.equal(result.executionResult.sideEffectsMayHaveOccurred, true);
    assert.equal(result.executionResult.verification.passed, false);
    assert.equal(result.evidence.status, 'failed');
    assert.equal(result.memoryEvent.eventType, 'execution.failed');
    assert.equal(runtime.pcAgent.taskResult(result.taskId).status, TaskStatus.FAILED);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('G accepts explicitly non-rollbackable desktop work only with verified bounded postconditions', async () => {
  const taskId = 'task_desktop_nonrollback_verification';
  const contract = {
    toolName: 'desktop.control',
    readOnly: false,
    mutatesSystem: true,
    rollback: false,
    evidence: ['operationCount', 'verification'],
    modes: ['shadow', 'execute']
  };
  const checks = await new ExecutionResultVerifier().verify({
    executionResult: {
      taskId,
      startedAt: '2026-08-17T00:00:00.000Z',
      finishedAt: '2026-08-17T00:00:01.000Z',
      executedBy: { module: ModuleId.PC_AGENT, toolName: 'desktop.control' },
      rollbackAvailable: false,
      outputPaths: [],
      changedItems: [{ type: 'desktop_interaction', operation: 'invoke', sequenceIndex: 0 }],
      verification: { passed: true, checks: [{ type: 'windowTitleContains', passed: true }] },
      safety: { adapterContract: contract }
    },
    evidence: {
      evidenceId: 'evidence_desktop_nonrollback',
      taskId,
      status: 'success',
      outputPaths: [],
      shadow: { expectedChangesCount: 1 }
    },
    adapterContract: contract
  });

  assert.equal(checks.every((item) => item.status === 'passed'), true, JSON.stringify(checks));
  assert.equal(checks.some((item) => item.checkId === 'non_rollback_postcondition_verified'), true);
  assert.equal(checks.some((item) => item.checkId === 'non_rollback_changed_items_bounded'), true);
});

function plannerResponse(payload) {
  return JSON.stringify({ result: JSON.stringify(payload) });
}

function makeTaskRequest(rawText) {
  return createTaskRequest({
    rawText,
    deviceId: 'pc_desktop_test',
    inputMode: 'voice',
    source: InputSource.PC_UI,
    sourceModule: ModuleId.CORE,
    userId: 'local_user',
    locale: 'ko-KR',
    createdAt: new Date().toISOString()
  });
}

async function execute(runtime, { id, actionType, toolName, args }) {
  const taskId = `task_${id}`;
  const planId = `plan_${id}`;
  const approvalId = `approval_${id}`;
  const action = { actionType, toolName, skillId: `test.${id}`, arguments: args };
  const capabilityToken = runtime.policyRuntime.capabilities.issue({
    taskId,
    planId,
    approvalId,
    action,
    allowedPaths: runtime.pcAgent.allowedRoots
  });
  return await runtime.pcAgent.receiveExecutionPacket({
    packetId: `packet_${id}`,
    taskId,
    planId,
    action,
    capabilityToken,
    requestedMode: 'execute',
    userConfirmation: { confirmed: true, approvalId },
    approvalDecision: { approvalId, decision: 'approve' }
  });
}
