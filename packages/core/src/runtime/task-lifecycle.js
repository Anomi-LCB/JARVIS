import { TaskStatus } from '../../../shared/src/types.js';

export class TaskLifecycle {
  constructor({ taskId, createdAt = new Date().toISOString() }) {
    this.taskId = taskId;
    this.createdAt = createdAt;
    this.events = [
      {
        status: TaskStatus.CREATED,
        label: '요청 접수',
        at: createdAt,
        evidence: 'TaskRequest stored'
      }
    ];
  }

  mark(status, label, evidence, at = new Date().toISOString()) {
    const event = { status, label, evidence, at };
    this.events.push(event);
    return event;
  }

  current() {
    return this.events.at(-1);
  }

  progress() {
    const order = [
      TaskStatus.CREATED,
      TaskStatus.PLANNING,
      TaskStatus.WAITING_APPROVAL,
      TaskStatus.APPROVED,
      TaskStatus.EXECUTING,
      TaskStatus.VERIFYING,
      TaskStatus.RETRYING,
      TaskStatus.COMPENSATING,
      TaskStatus.COMPENSATED,
      TaskStatus.COMPLETED
    ];
    const index = Math.max(0, order.indexOf(this.current().status));
    return {
      currentStep: this.current().label,
      stepIndex: index + 1,
      totalSteps: order.length
    };
  }

  asTaskStatus({ title, summary, updatedAt = new Date().toISOString() } = {}) {
    return {
      taskId: this.taskId,
      status: this.current().status,
      title,
      summary,
      updatedAt,
      progress: this.progress()
    };
  }
}
