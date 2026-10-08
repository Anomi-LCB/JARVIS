import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireOwnedProcessLock } from '../../../shared/src/owned-process-lock.js';

const GENESIS = 'GENESIS';
const hash = value => createHash('sha256').update(value).digest('hex');
const hashJson = value => hash(canonicalJson(value));

/** Signed, anchored lifecycle evidence. Executable functions and owner session IDs are never journaled. */
export class CapabilityPackagePromotionJournal {
  constructor({ filePath, signer, trustKernel, journalId = 'capability-package-promotions', clock = () => new Date() } = {}) {
    if (!filePath || typeof signer?.sign !== 'function' || typeof signer?.verify !== 'function' || !trustKernel) {
      throw new TypeError('filePath, purpose-bound signer, and runtime trust kernel are required');
    }
    this.filePath = filePath;
    this.signer = signer;
    this.trustKernel = trustKernel;
    this.journalId = journalId;
    this.clock = clock;
    this.records = [];
    this.fault = null;
    this.load();
  }

  load() {
    const lock = acquireJournalLock(`${this.filePath}.lock`);
    try {
      return this.#loadUnlocked();
    } finally {
      lock.release();
    }
  }

  #loadUnlocked() {
    this.records = [];
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf8');
        if (raw && !raw.endsWith('\n')) throw journalError('A_CAPABILITY_PACKAGE_JOURNAL_TORN_TAIL', 'Promotion journal has an incomplete final record.');
        const lines = raw.split(/\r?\n/u).filter(Boolean);
        let previousHash = GENESIS;
        for (const [index, line] of lines.entries()) {
          const record = JSON.parse(line);
          const { recordHash, signature, ...unsigned } = record;
          if (record.journalVersion !== 'a-capability-package-promotion-journal-v1'
            || record.journalId !== this.journalId
            || record.signatureAlgorithm !== 'HMAC-SHA256'
            || record.sequence !== index + 1
            || record.signingKeyId !== this.signer.keyId
            || record.previousHash !== previousHash
            || hashJson(unsigned) !== recordHash
            || !this.signer.verify(recordHash, signature)) {
            throw journalError('A_CAPABILITY_PACKAGE_JOURNAL_INVALID', `Promotion journal validation failed at record ${index + 1}.`);
          }
          previousHash = recordHash;
          this.records.push(record);
        }
      }
      const head = this.head();
      const anchor = this.trustKernel.verifyLocalJournalHead(this.journalId, head);
      if (!anchor.valid) throw journalError('A_CAPABILITY_PACKAGE_JOURNAL_ANCHOR_INVALID', anchor.reason);
      if (anchor.needsAnchor) this.trustKernel.anchorLocalJournalHead(this.journalId, head);
    } catch (error) {
      this.fault = error;
      this.records = [];
      throw error;
    }
  }

  append(eventType, payload = {}) {
    if (this.fault) throw journalError('A_CAPABILITY_PACKAGE_JOURNAL_UNAVAILABLE', 'Promotion journal has a prior integrity or write failure.');
    let lock;
    try {
      lock = acquireJournalLock(`${this.filePath}.lock`);
      // Separate Core processes can have independently cached journal heads.
      // Re-validate the chain and the signed trust-state anchor while holding
      // the cross-process lock before assigning the next sequence number.
      this.#loadUnlocked();
      const previousHash = this.records.at(-1)?.recordHash ?? GENESIS;
      const unsigned = {
        journalVersion: 'a-capability-package-promotion-journal-v1',
        sequence: this.records.length + 1,
        journalId: this.journalId,
        recordedAt: this.clock().toISOString(),
        eventType,
        previousHash,
        signatureAlgorithm: 'HMAC-SHA256',
        signingKeyId: this.signer.keyId,
        payload: sanitize(payload)
      };
      const recordHash = hashJson(unsigned);
      const record = { ...unsigned, recordHash, signature: this.signer.sign(recordHash) };
      mkdirSync(dirname(this.filePath), { recursive: true });
      const fd = openSync(this.filePath, 'a', 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.records.push(record);
      this.trustKernel.anchorLocalJournalHead(this.journalId, this.head());
      return publicRecord(record);
    } catch (error) {
      if (error?.code === 'OWNED_PROCESS_LOCK_BUSY') {
        throw journalError('A_CAPABILITY_PACKAGE_JOURNAL_BUSY', 'Another Core process is updating the promotion journal; retry after it releases the lock.');
      }
      this.fault = error;
      throw journalError('A_CAPABILITY_PACKAGE_JOURNAL_WRITE_FAILED', 'Signed promotion lifecycle record could not be durably anchored.', { causeCode: error.code ?? null });
    } finally {
      lock?.release();
    }
  }

  head() {
    return { sequence: this.records.length, headHash: this.records.at(-1)?.recordHash ?? GENESIS };
  }

  stageHistory(stageId) {
    // Do not expose mutable cached records as a recovery authority.
    this.load();
    return this.records.filter(record => record.payload?.stageId === stageId)
      .map(record => JSON.parse(JSON.stringify(publicRecord(record))));
  }

  rollbackHistory(rollbackId) {
    this.load();
    const commits=this.records.filter(r=>r.eventType==='promotion_committed'&&r.payload?.rollbackId===rollbackId);
    const stages=new Set(commits.map(r=>r.payload.stageId));
    return this.records.filter(r=>r.payload?.rollbackId===rollbackId||stages.has(r.payload?.stageId))
      .map(r=>JSON.parse(JSON.stringify(publicRecord(r))));
  }

  status() {
    const pending = new Map();
    const stages = new Map();
    for (const record of this.records) {
      const payload = record.payload ?? {};
      if (payload.stageId) stages.set(payload.stageId, record.eventType);
      if (record.eventType === 'promotion_started') pending.set(payload.stageId, 'promotion');
      if (record.eventType === 'promotion_committed' || record.eventType === 'promotion_failed') pending.delete(payload.stageId);
      if (record.eventType === 'rollback_started') pending.set(payload.rollbackId, 'rollback');
      if (record.eventType === 'rollback_committed' || record.eventType === 'rollback_failed') pending.delete(payload.rollbackId);
    }
    const unfinishedStages = [...stages.entries()].filter(([, event]) => ['stage_created', 'evaluation_passed', 'owner_reviewed'].includes(event)).map(([stageId, lastEvent]) => ({ stageId, lastEvent }));
    return {
      journalVersion: 'a-capability-package-promotion-journal-status-v1',
      available: !this.fault,
      integrity: this.fault ? 'faulted' : 'verified',
      ...this.head(),
      pendingTransitions: [...pending.entries()].map(([id, operation]) => ({ id, operation })),
      unfinishedStages,
      automaticExecutableRecovery: false,
      checkedAt: this.clock().toISOString()
    };
  }
}

function sanitize(value, depth = 0) {
  if (depth > 8) return '[depth-limited]';
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitize(item, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return value.slice(0, 2_000);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    return String(value);
  }
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (/ownerSessionId|password|secret|token|credential|otp|pin|cvv/iu.test(key)) continue;
    result[key] = sanitize(item, depth + 1);
  }
  return result;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function publicRecord(record) {
  const { signature, ...safe } = record;
  return safe;
}

function journalError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function acquireJournalLock(lockPath) {
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      return acquireOwnedProcessLock({ lockPath });
    } catch (error) {
      if (error?.code !== 'OWNED_PROCESS_LOCK_BUSY' || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
