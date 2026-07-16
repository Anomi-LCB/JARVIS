import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreFacade } from '../packages/core/src/core-facade.js';

// 실패한 작업의 승인 카드에 다시 결정이 와도(폰 재시도·중복 탭) 절대 던지지 않고
// 상태에 맞는 응답을 돌려줘야 한다. (실사용 보고: Invalid task transition: FAILED -> APPROVED)
async function withFacade(run) {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-approval-retry-'));
  const facade = new CoreFacade({
    eventLogPath: join(dir, 'events.jsonl'),
    orchestrationJournalPath: join(dir, 'orch.jsonl'),
    workMemory: { rewriteWithReference: () => null, record: () => null }
  });
  try {
    await run(facade);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function decideFor(facade, record, decision) {
  return facade.submitApprovalDecision({
    decisionVersion: 'approval-decision-v1',
    approvalId: record.approvalCard.approvalId,
    taskId: record.taskId,
    decision,
    decidedBy: { module: 'C_MOBILE', deviceId: 'test_device' },
    decidedAt: new Date().toISOString()
  });
}

test('re-approving a failed task consumes retry budget then blocks cleanly', async () => {
  await withFacade((facade) => {
    const record = facade.createTask('메모 만들어줘', {});
    assert.equal(decideFor(facade, record, 'approve').success, true);

    facade.recordExecutionFailure(record.taskId, { reason: 'fail-1' });
    assert.equal(facade.getTask(record.taskId).status, 'FAILED');

    const retry1 = decideFor(facade, record, 'approve');
    assert.equal(retry1.success, true);
    assert.equal(retry1.status, 'APPROVED');

    facade.recordExecutionFailure(record.taskId, { reason: 'fail-2' });
    const retry2 = decideFor(facade, record, 'approve');
    assert.equal(retry2.success, true);

    facade.recordExecutionFailure(record.taskId, { reason: 'fail-3' });
    const exhausted = decideFor(facade, record, 'approve');
    assert.equal(exhausted.success, false);
    assert.equal(exhausted.reason, 'retry-budget-exhausted');
    assert.equal(exhausted.status, 'BLOCKED');
  });
});

test('duplicate approve is a no-op success, terminal-state decisions do not throw', async () => {
  await withFacade((facade) => {
    const record = facade.createTask('메모 만들어줘', {});
    decideFor(facade, record, 'approve');
    const dup = decideFor(facade, record, 'approve');
    assert.equal(dup.success, true);
    assert.equal(dup.reason, 'already-approved');

    facade.recordExecutionFailure(record.taskId, { reason: 'fail-1' });
    facade.recordExecutionFailure(record.taskId, { reason: 'fail-2' });
    facade.recordExecutionFailure(record.taskId, { reason: 'fail-3' });
    decideFor(facade, record, 'approve'); // retry 1
    decideFor(facade, record, 'approve'); // retry 2 → 실패 반복으로 소진
  });
});

test('respond on a failed task replans back to waiting approval', async () => {
  await withFacade((facade) => {
    const record = facade.createTask('메모 만들어줘', {});
    decideFor(facade, record, 'approve');
    facade.recordExecutionFailure(record.taskId, { reason: 'fail-1' });

    const replanned = decideFor(facade, record, 'respond');
    assert.equal(replanned.success, true);
    assert.equal(replanned.status, 'WAITING_APPROVAL');
  });
});

test('reject on an already terminal task returns cleanly', async () => {
  await withFacade((facade) => {
    const record = facade.createTask('메모 만들어줘', {});
    decideFor(facade, record, 'approve');
    facade.recordExecutionFailure(record.taskId, { reason: 'fail-1' });
    decideFor(facade, record, 'approve'); // retry 1
    facade.recordExecutionFailure(record.taskId, { reason: 'fail-2' });
    decideFor(facade, record, 'approve'); // retry 2
    facade.recordExecutionFailure(record.taskId, { reason: 'fail-3' });
    decideFor(facade, record, 'approve'); // 예산 소진 → BLOCKED
    const rejected = decideFor(facade, record, 'reject');
    assert.equal(rejected.success, false);
    assert.equal(rejected.reason, 'cancel-not-applicable');
  });
});
