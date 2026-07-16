import { TaskStatus } from '../../../shared/src/types.js';

const allowedTransitions = new Map([
  [TaskStatus.CREATED, [TaskStatus.PLANNING, TaskStatus.BLOCKED, TaskStatus.CANCELLED, TaskStatus.EXPIRED]],
  [TaskStatus.PLANNING, [TaskStatus.WAITING_APPROVAL, TaskStatus.APPROVED, TaskStatus.BLOCKED, TaskStatus.CANCELLED, TaskStatus.EXPIRED]],
  [TaskStatus.WAITING_APPROVAL, [TaskStatus.APPROVED, TaskStatus.PLANNING, TaskStatus.BLOCKED, TaskStatus.CANCELLED, TaskStatus.EXPIRED]],
  [TaskStatus.APPROVED, [TaskStatus.EXECUTING, TaskStatus.BLOCKED, TaskStatus.CANCELLED, TaskStatus.EXPIRED]],
  [TaskStatus.EXECUTING, [TaskStatus.VERIFYING, TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.BLOCKED, TaskStatus.RETRYING, TaskStatus.COMPENSATING]],
  [TaskStatus.VERIFYING, [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.BLOCKED, TaskStatus.RETRYING, TaskStatus.COMPENSATING]],
  // RETRYING→APPROVED: 실패 후 사용자가 같은 승인 카드로 재시도하면 재승인을 거쳐 재실행한다.
  [TaskStatus.RETRYING, [TaskStatus.APPROVED, TaskStatus.EXECUTING, TaskStatus.FAILED, TaskStatus.BLOCKED, TaskStatus.COMPENSATING, TaskStatus.EXPIRED]],
  // FAILED→PLANNING(수정 재계획)·CANCELLED(실패 카드 닫기)도 사용자 행동으로 허용한다.
  [TaskStatus.FAILED, [TaskStatus.RETRYING, TaskStatus.PLANNING, TaskStatus.CANCELLED, TaskStatus.COMPENSATING, TaskStatus.BLOCKED]],
  [TaskStatus.COMPENSATING, [TaskStatus.COMPENSATED, TaskStatus.FAILED, TaskStatus.BLOCKED]],
  [TaskStatus.COMPENSATED, []],
  [TaskStatus.COMPLETED, []],
  [TaskStatus.EXPIRED, []],
  [TaskStatus.BLOCKED, []],
  [TaskStatus.CANCELLED, []]
]);

export class TaskStateMachine {
  constructor(initialStatus = TaskStatus.CREATED, { clock = () => new Date(), maxRetries = 2 } = {}) {
    this.status = initialStatus;
    this.clock = clock;
    this.maxRetries = maxRetries;
    this.retryCount = 0;
    this.failureCount = 0;
    this.history = [{ from: null, to: initialStatus, at: this.clock().toISOString(), reason: 'initial' }];
  }

  static transitionTable() {
    return Object.fromEntries([...allowedTransitions.entries()].map(([from, to]) => [from, [...to]]));
  }

  canTransition(nextStatus) {
    const allowed = allowedTransitions.get(this.status) ?? [];
    return allowed.includes(nextStatus);
  }

  transition(nextStatus, reason = 'runtime', evidence = {}) {
    if (!this.canTransition(nextStatus)) {
      throw new Error(`Invalid task transition: ${this.status} -> ${nextStatus}`);
    }
    const previous = this.status;
    this.status = nextStatus;
    const event = { from: previous, to: nextStatus, reason, evidence, at: this.clock().toISOString() };
    this.history.unshift(event);
    return this.status;
  }

  expireIfPast(expiresAt, { now = this.clock().toISOString(), reason = 'deadline-expired' } = {}) {
    if (!expiresAt || Number.isNaN(Date.parse(expiresAt)) || Date.parse(now) <= Date.parse(expiresAt)) {
      return { expired: false, status: this.status };
    }
    if (!this.canTransition(TaskStatus.EXPIRED)) {
      return { expired: false, status: this.status, reason: 'transition-not-allowed' };
    }
    this.transition(TaskStatus.EXPIRED, reason, { expiresAt, now });
    return { expired: true, status: this.status, expiresAt, now };
  }

  recordFailure({ reason = 'execution-failed', evidence = {} } = {}) {
    this.failureCount += 1;
    if (this.status !== TaskStatus.FAILED && this.canTransition(TaskStatus.FAILED)) {
      this.transition(TaskStatus.FAILED, reason, evidence);
    }
    return {
      status: this.status,
      failureCount: this.failureCount,
      retryable: this.retryCount < this.maxRetries && this.canTransition(TaskStatus.RETRYING)
    };
  }

  retry({ reason = 'retry-requested', evidence = {} } = {}) {
    if (this.retryCount >= this.maxRetries) {
      if (this.canTransition(TaskStatus.BLOCKED)) {
        this.transition(TaskStatus.BLOCKED, 'retry-budget-exhausted', { retryCount: this.retryCount, maxRetries: this.maxRetries });
      }
      return { retried: false, status: this.status, retryCount: this.retryCount, reason: 'retry-budget-exhausted' };
    }
    this.retryCount += 1;
    this.transition(TaskStatus.RETRYING, reason, { ...evidence, retryCount: this.retryCount, maxRetries: this.maxRetries });
    return { retried: true, status: this.status, retryCount: this.retryCount, maxRetries: this.maxRetries };
  }

  resumeExecution({ reason = 'retry-resume-execution', evidence = {} } = {}) {
    this.transition(TaskStatus.EXECUTING, reason, evidence);
    return { status: this.status, retryCount: this.retryCount };
  }

  beginCompensation({ reason = 'compensation-started', evidence = {} } = {}) {
    this.transition(TaskStatus.COMPENSATING, reason, evidence);
    return { status: this.status };
  }

  completeCompensation({ reason = 'compensation-completed', evidence = {} } = {}) {
    this.transition(TaskStatus.COMPENSATED, reason, evidence);
    return { status: this.status };
  }
}
