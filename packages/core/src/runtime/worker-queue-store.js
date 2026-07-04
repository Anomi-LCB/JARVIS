import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class FileWorkerQueueStore {
  constructor({ filePath, clock = () => new Date() } = {}) {
    if (!filePath) {
      throw new Error('FileWorkerQueueStore requires filePath.');
    }
    this.filePath = filePath;
    this.clock = clock;
  }

  load() {
    if (!existsSync(this.filePath)) return null;
    try {
      const snapshot = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (snapshot?.storeVersion !== 'a-worker-queue-store-v1') {
        const error = new Error('Unsupported worker queue store version.');
        error.code = 'A_WORKER_QUEUE_STORE_VERSION_UNSUPPORTED';
        throw error;
      }
      return snapshot;
    } catch (error) {
      if (!error.code) error.code = 'A_WORKER_QUEUE_STORE_CORRUPT';
      throw error;
    }
  }

  save(snapshot) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload = {
      storeVersion: 'a-worker-queue-store-v1',
      persistedAt: this.clock().toISOString(),
      ...snapshot
    };
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, this.filePath);
    return payload;
  }

  metadata() {
    return {
      storeVersion: 'a-worker-queue-store-v1',
      filePath: this.filePath
    };
  }
}
