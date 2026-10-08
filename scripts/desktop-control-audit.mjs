import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { IntentParser } from '../packages/core/src/intent/intent-parser.js';
import { ClaudeCliTaskPlanner } from '../packages/core/src/planning/claude-cli-task-planner.js';
import { ActionType, InputSource, ModuleId, TaskStatus } from '../packages/shared/src/types.js';

const reportPath = resolve(process.env.JARVIS_DESKTOP_CONTROL_AUDIT_REPORT ?? 'dist/verification/desktop-control-audit.json');
const markdownPath = reportPath.replace(/\.json$/i, '.md');
const fixturePath = fileURLToPath(new URL('./fixtures/windows-desktop-control-fixture.ps1', import.meta.url));
const startedAt = new Date();
const runRoot = await mkdtemp(join(tmpdir(), 'jarvis-desktop-control-audit-'));
const workspace = join(runRoot, 'workspace');
const auditRoot = join(runRoot, 'audit');
const uniqueTitle = `JARVIS Desktop Control Audit ${process.pid}-${Date.now()}`;
const expectedValue = `JARVIS-CLOSED-LOOP-${Date.now()}`;
const templatePath = join(workspace, 'trusted-visual-templates', 'confirm-icon.png');
const command = `${uniqueTitle} 창의 입력란에 검증 값을 입력하고 일반 버튼, 화면 글자 버튼, 글자 없는 확인 아이콘을 차례로 누른 뒤 상태값을 확인해`;
let fixture = null;
let report;

try {
  await mkdir(workspace, { recursive: true });
  fixture = spawn('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    fixturePath,
    '-Title',
    uniqueTitle,
    '-TemplatePath',
    templatePath,
    '-EnableDuplicateAfterClick'
  ], {
    stdio: 'ignore',
    windowsHide: false
  });
  await waitForSpawn(fixture);
  await waitForFile(templatePath, 5000);

  const intent = new IntentParser().parse(command, { requestId: `request_desktop_audit_${Date.now()}` });
  const target = { processId: fixture.pid };
  const args = {
    rawText: command,
    target,
    operations: [
      { op: 'setValue', selector: { automationId: 'CommandInput', controlType: 'Edit' }, value: expectedValue },
      { op: 'invoke', selector: { automationId: 'ApplyButton', controlType: 'Button' } },
      { op: 'clickText', text: 'VISUAL APPLY', matchMode: 'exact' },
      { op: 'clickTemplate', targetLabel: '확인 아이콘', templatePath, minConfidence: 0.9, scaleTolerance: 0.2, ambiguityGap: 0.03 }
    ],
    verification: [
      { type: 'elementValueEquals', selector: { automationId: 'CommandInput', controlType: 'Edit' }, expected: expectedValue },
      { type: 'windowTitleContains', expected: expectedValue },
      { type: 'windowTitleContains', expected: 'VISUAL_DONE' },
      { type: 'windowTitleContains', expected: 'ICON_DONE' }
    ],
    timeoutMs: 8000
  };
  let plannerCalls = 0;
  const taskPlanner = new ClaudeCliTaskPlanner({
    runner: () => {
      plannerCalls += 1;
      return plannerResponse({
        target: args.target,
        operations: args.operations,
        verification: args.verification,
        timeoutMs: args.timeoutMs
      });
    }
  });
  const runtime = createAgRuntime({
    allowedRoots: [workspace],
    auditRoot,
    env: {},
    taskPlanner,
    workerDaemonEnabled: false
  });

  const targetPreflight = await waitForDesktopTarget(runtime.pcAgent.registry.get('desktop.control'), args, 10000);
  const task = runtime.coreFacade.createTask(command, {
    inputMode: 'voice',
    source: InputSource.VOICE,
    sourceModule: ModuleId.PC_AGENT,
    deviceId: 'pc_desktop_control_audit',
    metadata: {
      voiceRecognition: {
        confidence: 0.99,
        locale: 'ko-KR',
        engine: 'desktop-control-audit-transcript',
        rawAudioStored: false
      }
    }
  });
  const preRunStatus = task.status;
  const run = await runtime.orchestrationWorker.runTask(task.taskId, {
    deviceId: 'pc_desktop_control_audit',
    userConfirmation: { confirmed: true }
  });
  const result = run.execution;
  const directPcResult = runtime.pcAgent.taskResult(task.taskId);
  const adapter = runtime.pcAgent.registry.get('desktop.control');
  await delay(200);
  const ambiguousArgs = {
    target: { processId: fixture.pid },
    operations: [{
      op: 'clickTemplate',
      targetLabel: '확인 아이콘',
      templatePath,
      minConfidence: 0.9,
      scaleTolerance: 0.2,
      ambiguityGap: 0.03
    }],
    verification: [{ type: 'windowTitleContains', expected: 'SHOULD_NOT_CHANGE' }],
    timeoutMs: 8000
  };
  await waitForDesktopTarget(adapter, ambiguousArgs, 10000);
  const ambiguousResult = await adapter.execute(ambiguousArgs);

  const serializedResult = JSON.stringify(result);
  const visualPerception = result.executionResult?.evidence?.operations
    ?.find((item) => item.op === 'clicktext')?.perception;
  const templatePerception = result.executionResult?.evidence?.operations
    ?.find((item) => item.op === 'clicktemplate')?.perception;
  const checks = [
    check('korean_intent_routes_to_desktop_control', intent.actionType === ActionType.DESKTOP_CONTROL, { actionType: intent.actionType }),
    check('desktop_control_adapter_registered', runtime.pcAgent.registry.get('desktop.control') !== null),
    check('structured_planner_called_once', plannerCalls === 1, { plannerCalls }),
    check('core_plan_routes_to_desktop_control', task.plan?.action?.actionType === ActionType.DESKTOP_CONTROL
      && task.plan?.action?.toolName === 'desktop.control', {
      actionType: task.plan?.action?.actionType,
      toolName: task.plan?.action?.toolName
    }),
    check('approval_gate_reached_before_execution', preRunStatus === TaskStatus.WAITING_APPROVAL, { preRunStatus }),
    check('a_to_g_worker_completed', run.success === true && run.status === TaskStatus.COMPLETED, { workerStatus: run.status }),
    check('g_execution_verification_passed', run.executionVerification?.status === 'passed', { verificationStatus: run.executionVerification?.status }),
    check('f_learning_handoff_emitted', Boolean(run.learning), { learningEventId: run.learning?.memoryEvent?.eventId ?? run.learning?.eventId ?? null }),
    check('runtime_task_completed', result.status === TaskStatus.COMPLETED, { taskStatus: result.status }),
    check('adapter_execution_succeeded', result.executionResult?.status === 'success', { adapterStatus: result.executionResult?.status }),
    check('interactive_windows_session_detected', result.executionResult?.interactiveSession === true),
    check('four_ui_mutations_recorded', result.executionResult?.changedItems?.length === 4, { changedItems: result.executionResult?.changedItems?.length ?? 0 }),
    check('closed_loop_verification_passed', result.executionResult?.verification?.passed === true),
    check('input_and_result_states_verified', result.executionResult?.verification?.checks?.length === 4
      && result.executionResult.verification.checks.every((item) => item.passed === true)),
    check('canvas_text_clicked_through_local_ocr', visualPerception?.engine === 'Windows.Media.Ocr'
      && visualPerception?.foregroundVerified === true
      && visualPerception?.matchCount === 1),
    check('visual_capture_and_ocr_text_not_stored', visualPerception?.screenshotStored === false
      && visualPerception?.rawOcrTextStored === false
      && Boolean(visualPerception?.captureHash)
      && Boolean(visualPerception?.queryHash)),
    check('icon_clicked_through_local_template_matcher', templatePerception?.engine === 'Jarvis.LocalTemplateMatcher'
      && templatePerception?.foregroundVerified === true
      && templatePerception?.matchCount === 1
      && Number(templatePerception?.confidence ?? 0) >= 0.9
      && Boolean(templatePerception?.templateHash)),
    check('template_capture_pixels_not_stored', templatePerception?.screenshotStored === false
      && templatePerception?.rawPixelsStored === false
      && templatePerception?.templateCopied === false
      && Boolean(templatePerception?.captureHash)),
    check('ambiguous_icon_candidates_fail_closed', ambiguousResult?.status === 'failed'
      && ambiguousResult?.error === 'desktop-visual-template-ambiguous', {
      status: ambiguousResult?.status ?? null,
      error: ambiguousResult?.error ?? null
    }),
    check('raw_typed_value_not_persisted', !serializedResult.includes(expectedValue)),
    check('raw_visual_target_not_persisted', !serializedResult.includes('VISUAL APPLY')),
    check('verification_hashes_persisted', result.executionResult?.verification?.checks?.every((item) => item.expectedHash && item.actualHash))
  ];
  const finishedAt = new Date();
  report = {
    reportVersion: 'jarvis-windows-desktop-control-audit-v3',
    generatedAt: finishedAt.toISOString(),
    status: checks.every((item) => item.passed) ? 'passed' : 'failed',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    environment: {
      platform: process.platform,
      fixtureProcessId: fixture.pid,
      fixtureOwnedByAudit: true,
      interactiveSession: result.executionResult?.interactiveSession === true,
      preflightWindow: targetPreflight.observation?.observedWindow ?? { found: false }
    },
    flow: {
      command,
      actionType: intent.actionType,
      toolName: 'desktop.control',
      inputMode: 'voice-transcript',
      plannerMode: 'deterministic-structured-planner-fixture',
      plannerCalls,
      preRunStatus,
      workerStatus: run.status,
      targetSelector: { processId: fixture.pid, titleHashPresent: Boolean(result.executionResult?.observedWindow?.titleHash) },
      operations: args.operations.map((item) => ({ op: item.op, selector: item.selector })),
      verification: args.verification.map((item) => ({ type: item.type, selector: item.selector }))
    },
    checks,
    evidence: {
      taskId: result.taskId,
      taskStatus: result.status,
      failedReason: result.failedReason ?? null,
      adapterError: result.executionResult?.error ?? null,
      nodeAdapterStatus: directPcResult?.executionResult?.status ?? directPcResult?.status ?? null,
      nodeAdapterError: directPcResult?.executionResult?.error ?? directPcResult?.failedReason ?? null,
      nodeAdapterSummary: directPcResult?.executionResult?.summary ?? null,
      adapterSummary: result.executionResult?.summary ?? null,
      adapterVersion: result.executionResult?.evidence?.adapterVersion,
      operationCount: result.executionResult?.operationCount,
      changedItems: result.executionResult?.changedItems,
      verification: result.executionResult?.verification,
      observedWindow: result.executionResult?.observedWindow,
      adapterEvidence: result.executionResult?.evidence,
      localOcrPerception: visualPerception ?? null,
      localTemplatePerception: templatePerception ?? null,
      ambiguousTemplateControl: {
        status: ambiguousResult?.status ?? null,
        error: ambiguousResult?.error ?? null,
        mutationRecorded: (ambiguousResult?.changedItems?.length ?? 0) > 0
      },
      evidenceId: result.evidence?.evidenceId,
      gVerificationStatus: run.executionVerification?.status ?? null,
      fLearningHandoffEmitted: Boolean(run.learning),
      rawTypedValueStored: serializedResult.includes(expectedValue)
    },
    boundaries: [
      'This audit proves deterministic UI Automation control, local OCR text targeting, and trusted local template targeting for icon-only canvas controls in an interactive user session.',
      'The command traverses A planning, E approval, B execution, G verification, and F learning handoff with real Windows UI execution.',
      'Icon-only controls with trusted templates are covered; novel icons, games, video streams, and remote-desktop surfaces still require a general vision perception path.',
      'Unstructured natural-language planning depends on an available LLM; the execution adapter itself is deterministic.'
    ]
  };
  if (report.status !== 'passed') process.exitCode = 1;
} catch (error) {
  const finishedAt = new Date();
  report = {
    reportVersion: 'jarvis-windows-desktop-control-audit-v3',
    generatedAt: finishedAt.toISOString(),
    status: 'failed',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    error: {
      name: error?.name ?? 'Error',
      message: String(error?.message ?? error).slice(0, 1000)
    }
  };
  process.exitCode = 1;
} finally {
  await stopOwnedFixture(fixture);
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  console.log(`Desktop control audit: ${report.status}`);
  console.log(`Report: ${reportPath}`);
  console.log(`Summary: ${markdownPath}`);
  if (report.status !== 'passed') {
    console.error(report.error?.message ?? failedChecksMessage(report.checks ?? []));
    process.exitCode = 1;
  }
}

function check(checkId, passed, evidence = {}) {
  return { checkId, passed: passed === true, evidence };
}

async function waitForSpawn(child) {
  await Promise.race([
    new Promise((resolvePromise, rejectPromise) => {
      child.once('spawn', resolvePromise);
      child.once('error', rejectPromise);
    }),
    delay(5000).then(() => { throw new Error('desktop-fixture-spawn-timeout'); })
  ]);
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await delay(50);
    }
  }
  throw new Error('desktop-template-fixture-timeout');
}

async function waitForDesktopTarget(adapter, args, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastWarnings = [];
  while (Date.now() < deadline) {
    const shadow = await adapter.shadow(args);
    lastWarnings = shadow.warnings ?? [];
    if (lastWarnings.length === 0 && shadow.observation?.observedWindow?.found === true) return shadow;
    await delay(150);
  }
  throw new Error(`desktop-fixture-window-timeout:${lastWarnings.join(',')}`);
}

function plannerResponse(payload) {
  return JSON.stringify({ result: JSON.stringify(payload) });
}

async function stopOwnedFixture(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    delay(3000)
  ]);
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function failedChecksMessage(checks) {
  return `Desktop control checks failed: ${checks.filter((item) => !item.passed).map((item) => item.checkId).join(', ')}`;
}

function renderMarkdown(value) {
  if (value.status !== 'passed') {
    return `# JARVIS Windows Desktop Control Audit\n\n- Status: **FAILED**\n- Error: ${value.error?.message ?? 'unknown'}\n`;
  }
  const passed = value.checks.filter((item) => item.passed).length;
  return [
    '# JARVIS Windows Desktop Control Audit',
    '',
    `- Status: **${value.status.toUpperCase()}**`,
    `- Checks: **${passed}/${value.checks.length} passed**`,
    `- Runtime: **${value.durationMs} ms**`,
    `- Action: \`${value.flow.actionType}\` via \`${value.flow.toolName}\``,
    `- Operations: **${value.evidence.operationCount}**`,
    `- Closed-loop verification: **${value.evidence.verification?.passed ? 'passed' : 'failed'}**`,
    `- Raw typed value persisted: **${value.evidence.rawTypedValueStored ? 'yes' : 'no'}**`,
    '',
    '## Checks',
    '',
    ...value.checks.map((item) => `- ${item.passed ? '[x]' : '[ ]'} ${item.checkId}`),
    '',
    '## Boundaries',
    '',
    ...value.boundaries.map((item) => `- ${item}`),
    ''
  ].join('\n');
}
