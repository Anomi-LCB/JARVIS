import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendJsonlSync } from './jsonl.js';

export class JsonlAuditLog {
  constructor({
    filePath,
    clock = () => new Date(),
    signingSecret = process.env.JARVIS_AUDIT_EXPORT_SECRET ?? 'jarvis-local-audit-export-secret',
    archiveDir = filePath ? join(dirname(filePath), 'archive') : null,
    loadExisting = false,
    retentionMs = 90 * 24 * 60 * 60 * 1000,
    maxEntries = 10000
  }) {
    this.filePath = filePath;
    this.clock = clock;
    this.signingSecret = signingSecret;
    this.archiveDir = archiveDir;
    this.retentionMs = retentionMs;
    this.maxEntries = maxEntries;
    this.entries = [];
    this.sequence = 0;
    this.lastHash = 'GENESIS';
    this.rotationState = {
      archives: [],
      lastRotatedAt: null,
      lastArchivePath: null,
      lastArchiveHash: null,
      retentionMs,
      maxEntries
    };
    if (loadExisting) this.loadExistingEntries();
  }

  write(event, payload = {}) {
    const baseEntry = {
      event,
      timestamp: this.clock().toISOString(),
      sequence: this.sequence + 1,
      previousHash: this.lastHash,
      category: auditCategoryFor(event),
      severity: auditSeverityFor(event),
      ...payload
    };
    const entry = {
      ...baseEntry,
      hash: auditHash(baseEntry)
    };
    this.sequence = entry.sequence;
    this.lastHash = entry.hash;
    this.entries.unshift(entry);
    appendJsonlSync(this.filePath, entry);
    return entry;
  }

  recent(limit = 20) {
    return this.entries.slice(0, limit);
  }

  query({ category, severity, cursor = 0, limit = 20 } = {}) {
    const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const normalizedCursor = Math.max(Number(cursor) || 0, 0);
    const entries = this.filteredEntries({ category, severity });
    const items = entries.slice(normalizedCursor, normalizedCursor + normalizedLimit);
    const nextCursor = normalizedCursor + items.length < entries.length
      ? String(normalizedCursor + items.length)
      : null;
    return {
      items,
      pageInfo: {
        cursor: String(normalizedCursor),
        nextCursor,
        limit: normalizedLimit,
        total: entries.length
      }
    };
  }

  summary({ category, severity, cursor = 0, limit = 10 } = {}) {
    const entries = this.filteredEntries({ category, severity });
    const page = this.query({ category, severity, cursor, limit });
    return {
      total: entries.length,
      byCategory: countBy(entries, 'category'),
      bySeverity: countBy(entries, 'severity'),
      latest: page.items,
      pageInfo: page.pageInfo,
      chain: this.verifyChain(),
      retention: this.retentionStatus()
    };
  }

  verifyChain() {
    const chronological = [...this.entries].reverse();
    let previousHash = 'GENESIS';
    for (const entry of chronological) {
      const { hash, ...unsigned } = entry;
      if (entry.previousHash !== previousHash) {
        return { valid: false, reason: 'previous_hash_mismatch', sequence: entry.sequence };
      }
      if (auditHash(unsigned) !== hash) {
        return { valid: false, reason: 'hash_mismatch', sequence: entry.sequence };
      }
      previousHash = hash;
    }
    return { valid: true, entries: chronological.length, headHash: previousHash };
  }

  exportBundle({ category, severity, cursor = 0, limit = 200, reason = 'manual_export' } = {}) {
    const page = this.query({ category, severity, cursor, limit });
    const bundleBase = {
      schemaVersion: 'jarvis-audit-export-v1',
      exportId: `audit_export_${randomBytes(8).toString('hex')}_${Date.parse(this.clock().toISOString()).toString(36)}`,
      createdAt: this.clock().toISOString(),
      reason,
      filters: { category: category ?? null, severity: severity ?? null, cursor: String(Math.max(Number(cursor) || 0, 0)), limit: page.pageInfo.limit },
      pageInfo: page.pageInfo,
      chain: this.verifyChain(),
      retention: this.retentionStatus(),
      entries: [...page.items].reverse()
    };
    const manifestHash = sha256Json(bundleBase);
    return {
      ...bundleBase,
      manifestHash,
      signature: signAuditManifest(manifestHash, this.signingSecret),
      signatureAlgorithm: 'HMAC-SHA256'
    };
  }

  verifyExportBundle(bundle) {
    return verifySignedAuditExport(bundle, { signingSecret: this.signingSecret });
  }

  rotate({ reason = 'manual_rotation', archiveDir = this.archiveDir } = {}) {
    const archivedEntries = [...this.entries].reverse();
    const previousHeadHash = this.lastHash;
    const archiveBundle = this.exportBundle({
      cursor: 0,
      limit: Math.max(archivedEntries.length, 1),
      reason
    });
    archiveBundle.entries = archivedEntries;
    archiveBundle.pageInfo = {
      cursor: '0',
      nextCursor: null,
      limit: archivedEntries.length,
      total: archivedEntries.length
    };
    archiveBundle.manifestHash = sha256Json(unsignedExportBundle(archiveBundle));
    archiveBundle.signature = signAuditManifest(archiveBundle.manifestHash, this.signingSecret);
    const archivePath = archiveDir
      ? this.writeArchiveBundle(archiveDir, archiveBundle)
      : null;
    const archiveHash = sha256Json(archiveBundle);

    this.entries = [];
    this.sequence = 0;
    this.lastHash = 'GENESIS';
    if (this.filePath) writeFileSync(this.filePath, '', 'utf8');
    const rotationEntry = this.write('audit.rotation.completed', {
      reason,
      archivedEntries: archivedEntries.length,
      archivePath,
      archiveHash,
      previousHeadHash
    });
    this.rotationState = {
      ...this.rotationState,
      lastRotatedAt: rotationEntry.timestamp,
      lastArchivePath: archivePath,
      lastArchiveHash: archiveHash,
      archives: [
        {
          path: archivePath,
          archiveHash,
          archivedEntries: archivedEntries.length,
          rotatedAt: rotationEntry.timestamp,
          previousHeadHash
        },
        ...this.rotationState.archives
      ].slice(0, 20)
    };
    return {
      success: true,
      archivedEntries: archivedEntries.length,
      archivePath,
      archiveHash,
      previousHeadHash,
      rotationEntry,
      chain: this.verifyChain()
    };
  }

  retentionStatus() {
    const nowMs = this.clock().getTime();
    const expired = this.entries.filter((entry) => nowMs - Date.parse(entry.timestamp) > this.retentionMs).length;
    const overMax = Math.max(this.entries.length - this.maxEntries, 0);
    return {
      retentionMs: this.retentionMs,
      maxEntries: this.maxEntries,
      currentEntries: this.entries.length,
      expiredEntries: expired,
      overMaxEntries: overMax,
      rotationRecommended: expired > 0 || overMax > 0,
      ...this.rotationState
    };
  }

  filteredEntries({ category, severity } = {}) {
    return this.entries.filter((entry) => (!category || entry.category === category) && (!severity || entry.severity === severity));
  }

  loadExistingEntries() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    const lines = readFileSync(this.filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    const loaded = [];
    for (const line of lines) {
      try {
        loaded.push(JSON.parse(line));
      } catch {
        // Keep audit loading resilient; chain verification will surface tampering.
      }
    }
    this.entries = [...loaded].reverse();
    const last = loaded.at(-1);
    this.sequence = Number(last?.sequence ?? 0);
    this.lastHash = last?.hash ?? 'GENESIS';
  }

  writeArchiveBundle(archiveDir, bundle) {
    mkdirSync(archiveDir, { recursive: true });
    const filePath = join(archiveDir, `${bundle.exportId}.json`);
    writeFileSync(filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    return filePath;
  }
}

export class MemoryAuditLog {
  constructor() {
    this.entries = [];
    this.sequence = 0;
    this.lastHash = 'GENESIS';
  }

  write(event, payload = {}) {
    const baseEntry = {
      event,
      timestamp: new Date().toISOString(),
      sequence: this.sequence + 1,
      previousHash: this.lastHash,
      category: auditCategoryFor(event),
      severity: auditSeverityFor(event),
      ...payload
    };
    const entry = { ...baseEntry, hash: auditHash(baseEntry) };
    this.sequence = entry.sequence;
    this.lastHash = entry.hash;
    this.entries.unshift(entry);
    return entry;
  }

  recent(limit = 20) {
    return this.entries.slice(0, limit);
  }

  summary(options = {}) {
    return JsonlAuditLog.prototype.summary.call(this, options);
  }

  verifyChain() {
    return JsonlAuditLog.prototype.verifyChain.call(this);
  }

  query(options = {}) {
    return JsonlAuditLog.prototype.query.call(this, options);
  }

  exportBundle(options = {}) {
    this.signingSecret ??= 'jarvis-local-audit-export-secret';
    this.retentionMs ??= 90 * 24 * 60 * 60 * 1000;
    this.maxEntries ??= 10000;
    this.rotationState ??= { archives: [], retentionMs: this.retentionMs, maxEntries: this.maxEntries };
    return JsonlAuditLog.prototype.exportBundle.call(this, options);
  }

  verifyExportBundle(bundle) {
    this.signingSecret ??= 'jarvis-local-audit-export-secret';
    return JsonlAuditLog.prototype.verifyExportBundle.call(this, bundle);
  }

  retentionStatus() {
    this.retentionMs ??= 90 * 24 * 60 * 60 * 1000;
    this.maxEntries ??= 10000;
    this.rotationState ??= { archives: [], retentionMs: this.retentionMs, maxEntries: this.maxEntries };
    return JsonlAuditLog.prototype.retentionStatus.call(this);
  }

  filteredEntries(options = {}) {
    return JsonlAuditLog.prototype.filteredEntries.call(this, options);
  }
}

export function auditCategoryFor(event) {
  if (/auth|device|pairing|heartbeat/.test(event)) return 'access';
  if (/security|network|rate_limit|validation|blocked|failed|expired|revoked/.test(event)) return 'security';
  if (/approval/.test(event)) return 'approval';
  if (/execution|task|feedback|growth|memory|verification|regression/.test(event)) return 'workflow';
  return 'system';
}

export function auditSeverityFor(event) {
  if (/blocked|failed|invalid|expired|revoked|public_request|rate_limit/.test(event)) return 'warning';
  if (/error|forbidden|denied/.test(event)) return 'error';
  return 'info';
}

export function auditHash(entry) {
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

export function verifySignedAuditExport(bundle, { signingSecret = process.env.JARVIS_AUDIT_EXPORT_SECRET ?? 'jarvis-local-audit-export-secret' } = {}) {
  if (!bundle || typeof bundle !== 'object') return { valid: false, reason: 'bundle_missing' };
  const unsigned = unsignedExportBundle(bundle);
  const manifestHash = sha256Json(unsigned);
  if (manifestHash !== bundle.manifestHash) {
    return { valid: false, reason: 'manifest_hash_mismatch', expected: manifestHash, actual: bundle.manifestHash };
  }
  const expectedSignature = signAuditManifest(manifestHash, signingSecret);
  if (expectedSignature !== bundle.signature) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return {
    valid: true,
    exportId: bundle.exportId,
    entries: bundle.entries?.length ?? 0,
    manifestHash
  };
}

function unsignedExportBundle(bundle) {
  const { manifestHash, signature, signatureAlgorithm, ...unsigned } = bundle;
  return unsigned;
}

function signAuditManifest(manifestHash, signingSecret) {
  return createHmac('sha256', signingSecret).update(String(manifestHash)).digest('base64url');
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function countBy(entries, key) {
  return entries.reduce((counts, entry) => {
    counts[entry[key]] = (counts[entry[key]] ?? 0) + 1;
    return counts;
  }, {});
}
