import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateFailureObservations } from './task-failure-observation.js';
import { validateSuccessObservations } from './task-success-observation.js';

const storeVersion = 'a-worker-queue-store-v1';
const queueItemStatuses = new Set([
  'queued',
  'running',
  'retry_scheduled',
  'succeeded',
  'failed',
  'quarantined'
]);

function normalizeSnapshotCollections(snapshot, { errorCode, message }) {
  const snapshotPrototype = snapshot && typeof snapshot === 'object'
    ? Object.getPrototypeOf(snapshot)
    : null;
  if (!snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || (snapshotPrototype !== Object.prototype && snapshotPrototype !== null)
    || typeof snapshot.toJSON === 'function') {
    const error = new TypeError(message);
    error.code = errorCode;
    throw error;
  }

  const normalized = { ...snapshot };
  try { if(Object.prototype.hasOwnProperty.call(snapshot,'failureObservations')) normalized.failureObservations=validateFailureObservations(snapshot.failureObservations); }
  catch(cause) { throw Object.assign(new TypeError(message,{cause}),{code:errorCode}); }
  try { if(Object.prototype.hasOwnProperty.call(snapshot,'successObservations')) normalized.successObservations=validateSuccessObservations(snapshot.successObservations); }
  catch(cause) { throw Object.assign(new TypeError(message,{cause}),{code:errorCode}); }
  const failureIds=new Set((normalized.failureObservations??[]).map(item=>item.taskId));
  if((normalized.successObservations??[]).some(item=>failureIds.has(item.taskId)))throw Object.assign(new TypeError(message),{code:errorCode});
  for (const key of ['queue', 'runs']) {
    if (!Object.prototype.hasOwnProperty.call(normalized, key)) {
      normalized[key] = [];
      continue;
    }
    if (!Array.isArray(normalized[key])) {
      const error = new TypeError(message);
      error.code = errorCode;
      throw error;
    }
    validateCollectionItems(normalized[key], key, { errorCode, message });
  }
  return normalized;
}

function validateCollectionItems(items, collection, { errorCode, message }) {
  const requiredFields = collection === 'queue'
    ? ['queueId', 'taskId', 'status']
    : ['runId', 'taskId', 'status'];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const validRecord = item !== null
      && typeof item === 'object'
      && !Array.isArray(item)
      && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
      && typeof item.toJSON !== 'function';
    const validFields = validRecord && requiredFields.every((field) => isSafeSnapshotToken(item[field]));
    const validStatus = collection !== 'queue' || (validRecord && queueItemStatuses.has(item.status));
    if (!validRecord || !validFields || !validStatus) {
      const error = new TypeError(`${message} Invalid ${collection}[${index}] record.`);
      error.code = errorCode;
      throw error;
    }
  }
}

function isSafeSnapshotToken(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

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
      if (snapshot?.storeVersion !== storeVersion) {
        const error = new Error('Unsupported worker queue store version.');
        error.code = 'A_WORKER_QUEUE_STORE_VERSION_UNSUPPORTED';
        throw error;
      }
      return normalizeSnapshotCollections(snapshot, {
        errorCode: 'A_WORKER_QUEUE_STORE_CORRUPT',
        message: 'Worker queue snapshot collections are malformed.'
      });
    } catch (error) {
      if (!error.code) error.code = 'A_WORKER_QUEUE_STORE_CORRUPT';
      throw error;
    }
  }

  save(snapshot) {
    const validation = {
      errorCode: 'A_WORKER_QUEUE_STORE_SNAPSHOT_INVALID',
      message: 'Worker queue snapshot collections must be arrays when provided.'
    };
    try {
      const normalized = normalizeSnapshotCollections(snapshot, validation);
      const persistedAt = this.clock().toISOString();
      const payload = {
        ...normalized,
        storeVersion,
        persistedAt
      };
      const serialized = JSON.stringify(payload, null, 2);
      const persisted = JSON.parse(serialized);
      if (persisted.storeVersion !== storeVersion || persisted.persistedAt !== persistedAt) {
        const error = new TypeError('Worker queue snapshot reserved metadata changed during serialization.');
        error.code = validation.errorCode;
        throw error;
      }
      const validated = normalizeSnapshotCollections(persisted, validation);
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmpPath, `${serialized}\n`, 'utf8');
      renameSync(tmpPath, this.filePath);
      return validated;
    } catch (error) {
      if (!error.code) error.code = validation.errorCode;
      throw error;
    }
  }

  metadata() {
    return {
      storeVersion,
      filePath: this.filePath
    };
  }
}
