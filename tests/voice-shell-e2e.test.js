import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { classifyShellCommand } from '../apps/pc-agent/src/pc-agent-runtime.js';
import { ClaudeCliTaskPlanner } from '../packages/core/src/planning/claude-cli-task-planner.js';
import { ApprovalDecision, TaskStatus } from '../packages/shared/src/types.js';

function plannerResponse(payload) {
  return JSON.stringify({ result: JSON.stringify(payload) });
}

test('shell classifier never labels process, COM, or file mutation commands as read-only', () => {
  assert.equal(classifyShellCommand('Get-Date -Format o').risk, 'safe');
  assert.equal(classifyShellCommand('Start-Process notepad.exe').risk, 'caution');
  assert.equal(classifyShellCommand('New-Object -ComObject Excel.Application').risk, 'caution');
  assert.equal(classifyShellCommand("[IO.File]::WriteAllText('a.txt','x')").risk, 'caution');
  assert.equal(classifyShellCommand('Remove-Item -Recurse C:\\temp').risk, 'blocked');
});

test('voice command executes a read-only PowerShell query and passes G verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-voice-shell-e2e-'));
  const previousShellCachePath = process.env.JARVIS_SHELL_CACHE_PATH;
  let modelCalls = 0;
  try {
    process.env.JARVIS_SHELL_CACHE_PATH = join(root, 'shell-cache.jsonl');
    const createdAt = new Date().toISOString();
    const planner = new ClaudeCliTaskPlanner({
      runner: () => {
        modelCalls += 1;
        return plannerResponse({ command: 'Get-Date -Format o', verify: '' });
      }
    });
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      taskPlanner: planner,
      bridgeRealExecution: true,
      workerDaemonEnabled: false
    });
    const pairing = runtime.bridgeRuntime.pairing.start();
    const paired = runtime.bridgeRuntime.pairing.confirm({
      deviceId: 'voice_shell_phone',
      deviceName: 'Voice Shell Phone',
      pairingCode: pairing.pairingCode
    });
    const created = runtime.bridgeRuntime.createTask({
      taskRequest: {
        requestId: 'req_voice_shell_readonly',
        createdAt,
        source: { type: 'mobile', module: 'C_MOBILE', deviceId: 'voice_shell_phone', inputMode: 'voice' },
        command: { rawText: '파워셸 명령으로 현재 날짜와 시간을 조회해줘', locale: 'ko-KR' },
        metadata: {
          voiceRecognition: {
            confidence: 0.96,
            engine: 'expo-speech-recognition',
            rawAudioStored: false
          }
        }
      },
      token: paired.deviceToken
    });
    const task = runtime.coreFacade.getTask(created.taskId);
    assert.equal(task.plan.action.toolName, 'shell.execute');
    assert.equal(task.plan.action.arguments.command, 'Get-Date -Format o');

    const approval = runtime.bridgeRuntime.listApprovals({ token: paired.deviceToken }).items
      .find((item) => item.taskId === created.taskId);
    const approved = await runtime.bridgeRuntime.decideApproval({
      approvalId: approval.approvalId,
      decision: ApprovalDecision.APPROVE,
      token: paired.deviceToken
    });
    assert.equal(approved.status, TaskStatus.APPROVED);
    const completed = await runtime.bridgeRuntime.confirmExecutionHandoff({
      handoffId: approved.handoffId,
      token: paired.deviceToken
    });
    const storedRun = runtime.bridgeRuntime.results.get(created.taskId);

    assert.equal(completed.status, TaskStatus.COMPLETED, JSON.stringify(completed));
    assert.equal(completed.verificationStatus, 'passed');
    assert.equal(storedRun.executionResult.readOnly, true);
    assert.equal(storedRun.executionResult.exitCode, 0);
    assert.match(storedRun.executionResult.stdoutPreview, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(modelCalls, 1);
    assert.equal(task.request.source.inputMode, 'voice');
    assert.equal(task.request.metadata.voiceRecognition.rawAudioStored, false);
  } finally {
    if (previousShellCachePath === undefined) delete process.env.JARVIS_SHELL_CACHE_PATH;
    else process.env.JARVIS_SHELL_CACHE_PATH = previousShellCachePath;
    await rm(root, { recursive: true, force: true });
  }
});
