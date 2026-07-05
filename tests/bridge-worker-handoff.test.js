import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MobileAppRuntime } from '../apps/mobile/src/mobile-runtime.js';
import { ApprovalDecision, TaskStatus } from '../packages/shared/src/types.js';

test('mobile approve + handoff confirm executes the real plan through the worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-handoff-'));
  const createdOutputs = [];
  try {
    // 플래너의 산출물 경로는 './workspace' 고정이므로 실서비스와 동일한 allowedRoots를 쓴다.
    const runtime = createAgRuntime({
      allowedRoots: ['./workspace'],
      auditRoot: dir,
      bridgeRealExecution: true,
      workerQueueStorePath: null,
      workerLeaseStorePath: null
    });
    assert.ok(runtime.bridgeRuntime.orchestrationWorker, 'bridge runtime exposes the orchestration worker');

    const mobile = new MobileAppRuntime({ bridgeRuntime: runtime.bridgeRuntime });
    const pairing = runtime.bridgeRuntime.pairing.start();
    const paired = mobile.pair({ pairingCode: pairing.pairingCode, bridgeUrl: pairing.bridgeUrl });
    assert.equal(paired.success !== false, true);

    const sent = mobile.sendCommand('주간 정산표 엑셀로 만들어줘');
    assert.equal(sent.status, TaskStatus.WAITING_APPROVAL);

    const approval = mobile.approvalQueue().items.find((item) => item.taskId === sent.taskId);
    assert.ok(approval, 'approval card exists for the task');

    const approved = await mobile.decideApproval({
      approvalId: approval.approvalId,
      decision: ApprovalDecision.APPROVE
    });
    assert.equal(approved.requiresUserConfirmation, true);

    const executed = await mobile.confirmExecution(approved.handoffId);
    assert.equal(executed.status, TaskStatus.COMPLETED);

    const result = mobile.result(sent.taskId);
    const outputPaths = result.executionResult?.outputPaths ?? [];
    assert.ok(outputPaths.length > 0, 'real execution produced output paths');
    assert.ok(
      outputPaths.some((path) => path.endsWith('.xlsx')),
      `xlsx plan executed through the worker, got: ${outputPaths.join(', ')}`
    );
    assert.ok(outputPaths.every((path) => existsSync(path)), 'output files actually exist on disk');
    createdOutputs.push(...outputPaths);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await Promise.all(createdOutputs.map((path) => rm(path, { force: true }).catch(() => undefined)));
  }
});
