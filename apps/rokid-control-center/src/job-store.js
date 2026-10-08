import { randomUUID } from 'node:crypto';

export class JobStore {
  constructor({ retentionMs = 24 * 60 * 60_000 } = {}) {
    this.jobs = new Map();
    this.retentionMs = retentionMs;
  }

  start(type, worker) {
    this.cleanup();
    const id = randomUUID();
    const job = {
      id,
      type,
      status: 'running',
      percent: 0,
      stage: '시작 준비',
      startedAt: new Date().toISOString(),
      completedAt: null,
      result: null,
      error: null
    };
    this.jobs.set(id, job);
    Promise.resolve().then(() => worker((progress) => Object.assign(job, progress))).then((result) => {
      Object.assign(job, { status: 'completed', percent: 100, stage: '완료', completedAt: new Date().toISOString(), result });
    }).catch((error) => {
      Object.assign(job, { status: 'failed', stage: '실패', completedAt: new Date().toISOString(), error: String(error.message ?? error) });
    });
    return { ...job };
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  cleanup() {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, job] of this.jobs) {
      if (job.completedAt && new Date(job.completedAt).getTime() < cutoff) this.jobs.delete(id);
    }
  }
}
