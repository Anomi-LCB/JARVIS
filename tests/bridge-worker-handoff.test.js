import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, dirname, basename } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MobileAppRuntime } from '../apps/mobile/src/mobile-runtime.js';
import { ApprovalDecision, TaskStatus } from '../packages/shared/src/types.js';

test('mobile approve + handoff confirm executes the real plan through the worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-handoff-'));
  let runtime;
  try {
    await mkdir(join(dir,'workspace'));
    runtime = createAgRuntime({
      env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},
      allowedRoots: [relative(process.cwd(),join(dir,'workspace'))],
      auditRoot: dir,
      bridgeRealExecution: true,
      workerQueueStorePath: null,
      workerLeaseStorePath: null
    });
    assert.ok(runtime.bridgeRuntime.orchestrationWorker, 'bridge runtime exposes the orchestration worker');
    const failures=[];runtime.coreFacade.eventBus.subscribe('task.failed',event=>failures.push({reason:event.payload.reason,evidence:event.payload.evidence}));

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
    const observed=runtime.coreFacade.getTask(sent.taskId);
    assert.equal(executed.status, TaskStatus.COMPLETED, JSON.stringify({error:executed.error,taskStatus:observed?.status,failures}));

    const result = mobile.result(sent.taskId);
    const outputPaths = result.executionResult?.outputPaths ?? [];
    assert.ok(outputPaths.length > 0, 'real execution produced output paths');
    assert.ok(
      outputPaths.some((path) => path.endsWith('.xlsx')),
      `xlsx plan executed through the worker, got: ${outputPaths.join(', ')}`
    );
    assert.ok(outputPaths.every((path) => existsSync(path)), 'output files actually exist on disk');
  } finally {
    runtime?.coreFacade.cognition?.close?.();
    assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('jarvis-handoff-'));
    await rm(dir, { recursive: true, force: true });
  }
});
