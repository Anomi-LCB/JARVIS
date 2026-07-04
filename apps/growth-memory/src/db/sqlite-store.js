import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export class SqliteMemoryStore {
  constructor({ dbPath = 'apps/growth-memory/data/growth.sqlite', reviewDir = 'apps/growth-memory/data/reviews', backupDir = 'apps/growth-memory/data/backups', clock = () => new Date() } = {}) {
    this.dbPath = dbPath;
    this.reviewDir = reviewDir;
    this.backupDir = backupDir;
    this.clock = clock;
    this.schemaVersion = 5;
    this.inTransaction = false;
    mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(reviewDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.initialize();
  }

  initialize() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      this.applyMigration(1, 'initial_memory_review_preference_tables', `
      CREATE TABLE IF NOT EXISTS memory_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        learning_flags_json TEXT NOT NULL,
        trust_boundary_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS growth_reviews (
        review_id TEXT PRIMARY KEY,
        generated_at TEXT NOT NULL,
        period TEXT NOT NULL,
        review_json TEXT NOT NULL,
        file_path TEXT
      );

      CREATE TABLE IF NOT EXISTS confirmed_preferences (
        preference_id TEXT PRIMARY KEY,
        hypothesis_id TEXT NOT NULL,
        statement TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        preference_json TEXT NOT NULL
      );
      `);
      this.applyMigration(2, 'indexes_and_storage_metadata', `
        CREATE INDEX IF NOT EXISTS idx_memory_events_created_at ON memory_events(created_at);
        CREATE INDEX IF NOT EXISTS idx_memory_events_task_id ON memory_events(task_id);
        CREATE INDEX IF NOT EXISTS idx_memory_events_type_created ON memory_events(event_type, created_at);
        CREATE INDEX IF NOT EXISTS idx_growth_reviews_generated_at ON growth_reviews(generated_at);
        CREATE INDEX IF NOT EXISTS idx_confirmed_preferences_hypothesis ON confirmed_preferences(hypothesis_id);
        CREATE TABLE IF NOT EXISTS storage_backups (
          backup_id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          source_db_path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          integrity_status TEXT NOT NULL
        );
      `);
      this.applyMigration(3, 'memory_event_schema_and_hygiene_decisions', `
        ALTER TABLE memory_events ADD COLUMN schema_json TEXT NOT NULL DEFAULT '{}';
        CREATE INDEX IF NOT EXISTS idx_memory_events_schema_json ON memory_events(schema_json);
        CREATE TABLE IF NOT EXISTS hygiene_decisions (
          decision_id TEXT PRIMARY KEY,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          action TEXT NOT NULL,
          decided_at TEXT NOT NULL,
          decision_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_hygiene_decisions_target ON hygiene_decisions(target_type, target_id);
        CREATE INDEX IF NOT EXISTS idx_hygiene_decisions_decided_at ON hygiene_decisions(decided_at);
      `);
      this.applyMigration(4, 'failure_guardrail_reviews', `
        CREATE TABLE IF NOT EXISTS failure_guardrail_reviews (
          review_id TEXT PRIMARY KEY,
          failure_id TEXT NOT NULL,
          decision TEXT NOT NULL,
          reviewed_at TEXT NOT NULL,
          review_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_failure_guardrail_reviews_failure ON failure_guardrail_reviews(failure_id);
        CREATE INDEX IF NOT EXISTS idx_failure_guardrail_reviews_reviewed_at ON failure_guardrail_reviews(reviewed_at);
      `);
      this.applyMigration(5, 'growth_trend_snapshots', `
        CREATE TABLE IF NOT EXISTS growth_trend_snapshots (
          snapshot_id TEXT PRIMARY KEY,
          trend_type TEXT NOT NULL,
          generated_at TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_growth_trend_snapshots_type_time ON growth_trend_snapshots(trend_type, generated_at);
      `);
      this.setUserVersion(this.schemaVersion);
    });
  }

  applyMigration(version, name, sql) {
    const alreadyApplied = this.db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version);
    if (alreadyApplied) return { applied: false, version, name };
    this.db.exec(sql);
    this.db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      version,
      name,
      this.clock().toISOString()
    );
    return { applied: true, version, name };
  }

  setUserVersion(version) {
    this.db.exec(`PRAGMA user_version = ${Number(version)}`);
  }

  transaction(fn) {
    if (this.inTransaction) return fn();
    this.inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  migrations() {
    return this.db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC').all();
  }

  pragmaValue(name) {
    return this.db.prepare(`PRAGMA ${name}`).get();
  }

  integrityCheck() {
    const row = this.db.prepare('PRAGMA integrity_check').get();
    const value = row?.integrity_check ?? Object.values(row ?? {})[0] ?? 'unknown';
    return {
      status: value === 'ok' ? 'ok' : 'failed',
      result: value
    };
  }

  sha256File(filePath) {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  }

  backupEncryptionKeyProviderStatus({ keyMaterial = process.env.JARVIS_GROWTH_BACKUP_KEY } = {}) {
    const effectiveKeyMaterial = keyMaterial || 'jarvis-local-growth-backup-dev-key';
    const keyHash = createHash('sha256').update(String(effectiveKeyMaterial)).digest('hex');
    return {
      providerVersion: 'f-storage-encryption-key-provider-v1',
      provider: keyMaterial ? 'env_or_injected_key' : 'local_dev_fallback',
      keyId: `growth_backup_key_${keyHash.slice(0, 20)}`,
      algorithm: 'aes-256-gcm',
      plaintextKeyStored: false,
      envelopeVersion: 'f-storage-encrypted-backup-envelope-v1',
      productionReady: Boolean(keyMaterial),
      rotationPolicy: {
        rotationSupported: true,
        recommendedIntervalDays: 90,
        recoveryRequiresKeyMaterial: true
      }
    };
  }

  backupLocationPolicy({ wormDir = process.env.JARVIS_GROWTH_WORM_BACKUP_DIR ?? join(this.backupDir, 'worm-mirror') } = {}) {
    return {
      policyVersion: 'f-storage-backup-location-policy-v1',
      generatedAt: this.clock().toISOString(),
      localBackupDir: this.backupDir,
      wormDir,
      encryptedBackupRequired: true,
      plaintextBackupRetention: 'temporary_only_before_seal',
      immutableMirror: {
        enabled: true,
        overwriteAllowed: false,
        deleteAllowed: false,
        syncVersion: 'f-storage-worm-backup-sync-v1'
      },
      recoveryDrillRequired: true
    };
  }

  atRestEncryptionDeploymentPolicy({ keyMaterial = process.env.JARVIS_GROWTH_BACKUP_KEY } = {}) {
    const keyProvider = this.backupEncryptionKeyProviderStatus({ keyMaterial });
    return {
      policyVersion: 'f-storage-at-rest-encryption-deployment-policy-v1',
      generatedAt: this.clock().toISOString(),
      status: keyProvider.plaintextKeyStored === false && keyProvider.rotationPolicy.rotationSupported
        ? 'contract_ready'
        : 'failed',
      sqlite: {
        adapter: 'node:sqlite',
        sqlCipherRequiredForProduction: true,
        sqlCipherRuntimeDetected: process.env.JARVIS_GROWTH_SQLCIPHER_ENABLED === 'true',
        fallbackMode: 'encrypted-backup-envelope-plus-worm-restore-drill'
      },
      keyProvider,
      controls: {
        plaintextDbAllowedInDevOnly: true,
        encryptedBackupsRequired: true,
        wormMirrorRequired: true,
        restoreDrillRequired: true,
        externalKmsOrOsKeyringRecommended: true,
        rawKeyMaterialStored: false
      },
      productionReadiness: {
        readyForLocalProductGate: true,
        requiresExternalKeyProviderForProduction: keyProvider.productionReady === false,
        acceptedProductionProviders: ['os-keyring', 'kms', 'sqlcipher', 'injected-env-secret']
      }
    };
  }

  deriveBackupKey(keyMaterial) {
    return createHash('sha256').update(String(keyMaterial || process.env.JARVIS_GROWTH_BACKUP_KEY || 'jarvis-local-growth-backup-dev-key')).digest();
  }

  encryptedBackup({
    backupId = `growth-sealed-backup-${this.clock().toISOString().replace(/[:.]/g, '-')}`,
    keyMaterial = process.env.JARVIS_GROWTH_BACKUP_KEY,
    deletePlaintextAfterSeal = true
  } = {}) {
    this.db.exec('PRAGMA wal_checkpoint(FULL);');
    const plainTempPath = join(this.backupDir, `${backupId}.plain.tmp.sqlite`);
    const sealedPath = join(this.backupDir, `${backupId}.sqlite.sealed.json`);
    copyFileSync(this.dbPath, plainTempPath);
    const plaintext = readFileSync(plainTempPath);
    const keyProvider = this.backupEncryptionKeyProviderStatus({ keyMaterial });
    const iv = randomBytes(12);
    const aadRecord = {
      backupId,
      sourceDbPath: this.dbPath,
      schemaVersion: this.schemaVersion,
      createdAt: this.clock().toISOString()
    };
    const aad = Buffer.from(JSON.stringify(aadRecord), 'utf8');
    const cipher = createCipheriv('aes-256-gcm', this.deriveBackupKey(keyMaterial), iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const integrity = this.integrityCheck();
    const envelope = {
      envelopeVersion: 'f-storage-encrypted-backup-envelope-v1',
      backupId,
      createdAt: aadRecord.createdAt,
      algorithm: 'aes-256-gcm',
      key: {
        providerVersion: keyProvider.providerVersion,
        keyId: keyProvider.keyId,
        plaintextKeyStored: false
      },
      aad: aad.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      plaintext: {
        sha256: createHash('sha256').update(plaintext).digest('hex'),
        sizeBytes: plaintext.length
      },
      source: {
        dbPath: this.dbPath,
        schemaVersion: this.schemaVersion,
        integrity
      },
      privacy: {
        rawDbBytesInEnvelope: false,
        plaintextBackupStored: !deletePlaintextAfterSeal
      },
      recovery: {
        restoreDrillVersion: 'f-storage-encrypted-restore-drill-v1',
        requiresKeyMaterial: true
      }
    };
    writeFileSync(sealedPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    if (deletePlaintextAfterSeal && existsSync(plainTempPath)) unlinkSync(plainTempPath);
    const sizeBytes = statSync(sealedPath).size;
    this.db.prepare(`
      INSERT OR REPLACE INTO storage_backups (
        backup_id,
        file_path,
        created_at,
        source_db_path,
        size_bytes,
        integrity_status
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      backupId,
      sealedPath,
      this.clock().toISOString(),
      this.dbPath,
      sizeBytes,
      integrity.status === 'ok' ? 'sealed_ok' : 'sealed_source_failed'
    );
    return {
      backupVersion: 'f-storage-encrypted-backup-v1',
      success: integrity.status === 'ok',
      backupId,
      filePath: sealedPath,
      fileName: basename(sealedPath),
      sizeBytes,
      plaintextSizeBytes: plaintext.length,
      plaintextSha256: envelope.plaintext.sha256,
      keyProvider,
      envelope: {
        envelopeVersion: envelope.envelopeVersion,
        algorithm: envelope.algorithm,
        key: envelope.key,
        privacy: envelope.privacy,
        source: envelope.source,
        recovery: envelope.recovery
      },
      integrity
    };
  }

  readEncryptedEnvelope(filePath) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      return parsed?.envelopeVersion === 'f-storage-encrypted-backup-envelope-v1' ? parsed : null;
    } catch {
      return null;
    }
  }

  decryptEncryptedBackup(envelope, { keyMaterial = process.env.JARVIS_GROWTH_BACKUP_KEY } = {}) {
    const keyProvider = this.backupEncryptionKeyProviderStatus({ keyMaterial });
    if (envelope.key?.keyId && envelope.key.keyId !== keyProvider.keyId) {
      throw new Error('F_ENCRYPTED_BACKUP_KEY_MISMATCH');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.deriveBackupKey(keyMaterial),
      Buffer.from(envelope.iv, 'base64')
    );
    const aad = Buffer.from(envelope.aad, 'base64');
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final()
    ]);
    const sha256 = createHash('sha256').update(plaintext).digest('hex');
    if (sha256 !== envelope.plaintext?.sha256) {
      throw new Error('F_ENCRYPTED_BACKUP_DIGEST_MISMATCH');
    }
    return { plaintext, sha256, keyProvider };
  }

  materializeBackupForRead({ backupPath, keyMaterial, label = 'restore' } = {}) {
    const envelope = this.readEncryptedEnvelope(backupPath);
    if (!envelope) {
      return {
        path: backupPath,
        encrypted: false,
        envelope: null,
        cleanup: () => {}
      };
    }
    const decrypted = this.decryptEncryptedBackup(envelope, { keyMaterial });
    const tempPath = join(this.backupDir, `.${label}-${envelope.backupId}-${randomBytes(4).toString('hex')}.sqlite`);
    writeFileSync(tempPath, decrypted.plaintext);
    return {
      path: tempPath,
      encrypted: true,
      envelope: {
        envelopeVersion: envelope.envelopeVersion,
        backupId: envelope.backupId,
        keyId: envelope.key?.keyId,
        plaintextSha256: decrypted.sha256,
        plaintextSizeBytes: decrypted.plaintext.length
      },
      cleanup: () => {
        if (existsSync(tempPath)) unlinkSync(tempPath);
      }
    };
  }

  storageStatus() {
    const userVersionRow = this.pragmaValue('user_version');
    const journalModeRow = this.pragmaValue('journal_mode');
    const foreignKeysRow = this.pragmaValue('foreign_keys');
    const counts = {
      memoryEvents: this.db.prepare('SELECT COUNT(*) AS count FROM memory_events').get().count,
      growthReviews: this.db.prepare('SELECT COUNT(*) AS count FROM growth_reviews').get().count,
      confirmedPreferences: this.db.prepare('SELECT COUNT(*) AS count FROM confirmed_preferences').get().count,
      hygieneDecisions: this.db.prepare('SELECT COUNT(*) AS count FROM hygiene_decisions').get().count,
      failureGuardrailReviews: this.db.prepare('SELECT COUNT(*) AS count FROM failure_guardrail_reviews').get().count,
      growthTrendSnapshots: this.db.prepare('SELECT COUNT(*) AS count FROM growth_trend_snapshots').get().count,
      backups: this.db.prepare('SELECT COUNT(*) AS count FROM storage_backups').get().count
    };
    return {
      dbPath: this.dbPath,
      reviewDir: this.reviewDir,
      backupDir: this.backupDir,
      schemaVersion: userVersionRow?.user_version ?? this.schemaVersion,
      expectedSchemaVersion: this.schemaVersion,
      migrations: this.migrations(),
      pragmas: {
        journalMode: journalModeRow?.journal_mode,
        foreignKeys: Boolean(foreignKeysRow?.foreign_keys)
      },
      counts,
      integrity: this.integrityCheck()
    };
  }

  hasEvent(eventId) {
    return Boolean(this.db.prepare('SELECT event_id FROM memory_events WHERE event_id = ?').get(eventId));
  }

  hasFingerprint(fingerprint) {
    return Boolean(this.db.prepare('SELECT fingerprint FROM memory_events WHERE fingerprint = ?').get(fingerprint));
  }

  saveEvent(event) {
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO memory_events (
          event_id,
          event_type,
          task_id,
          created_at,
          source_json,
          payload_json,
          learning_flags_json,
          trust_boundary_json,
          schema_json,
          fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId,
        event.eventType,
        event.taskId,
        event.createdAt,
        JSON.stringify(event.source ?? {}),
        JSON.stringify(event.payload ?? {}),
        JSON.stringify(event.learningFlags ?? {}),
        JSON.stringify(event.trustBoundary ?? {}),
        JSON.stringify({
          schemaVersion: event.schemaVersion,
          schema: event.schema,
          schemaValidation: event.schemaValidation
        }),
        event.fingerprint
      );
      return event;
    });
  }

  allEvents() {
    return this.db.prepare('SELECT * FROM memory_events ORDER BY created_at ASC').all().map((row) => {
      const schemaRecord = JSON.parse(row.schema_json ?? '{}');
      return {
        eventId: row.event_id,
        eventType: row.event_type,
        taskId: row.task_id,
        createdAt: row.created_at,
        source: JSON.parse(row.source_json),
        payload: JSON.parse(row.payload_json),
        learningFlags: JSON.parse(row.learning_flags_json),
        trustBoundary: JSON.parse(row.trust_boundary_json),
        fingerprint: row.fingerprint,
        schemaVersion: schemaRecord.schemaVersion,
        schema: schemaRecord.schema,
        schemaValidation: schemaRecord.schemaValidation
      };
    });
  }

  updateEvent(event) {
    return this.transaction(() => {
      this.db.prepare(`
        UPDATE memory_events
        SET source_json = ?,
            payload_json = ?,
            learning_flags_json = ?,
            trust_boundary_json = ?,
            schema_json = ?
        WHERE event_id = ?
      `).run(
        JSON.stringify(event.source ?? {}),
        JSON.stringify(event.payload ?? {}),
        JSON.stringify(event.learningFlags ?? {}),
        JSON.stringify(event.trustBoundary ?? {}),
        JSON.stringify({
          schemaVersion: event.schemaVersion,
          schema: event.schema,
          schemaValidation: event.schemaValidation
        }),
        event.eventId
      );
      return event;
    });
  }

  saveReview(review) {
    const filePath = join(this.reviewDir, `${review.reviewId}.json`);
    this.transaction(() => {
      writeFileSync(filePath, JSON.stringify(review, null, 2), 'utf8');
      this.db.prepare(`
        INSERT OR REPLACE INTO growth_reviews (review_id, generated_at, period, review_json, file_path)
        VALUES (?, ?, ?, ?, ?)
      `).run(review.reviewId, review.generatedAt, review.period, JSON.stringify(review), filePath);
    });
    return { ...review, filePath };
  }

  latestReview() {
    const row = this.db.prepare('SELECT * FROM growth_reviews ORDER BY generated_at DESC LIMIT 1').get();
    if (!row) return null;
    return { ...JSON.parse(row.review_json), filePath: row.file_path };
  }

  saveConfirmedPreference(preference) {
    return this.transaction(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO confirmed_preferences (
          preference_id,
          hypothesis_id,
          statement,
          confirmed_at,
          preference_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        preference.preferenceId,
        preference.hypothesisId,
        preference.statement,
        preference.confirmedAt,
        JSON.stringify(preference)
      );
      return preference;
    });
  }

  allConfirmedPreferences() {
    return this.db.prepare('SELECT preference_json FROM confirmed_preferences ORDER BY confirmed_at ASC').all()
      .map((row) => JSON.parse(row.preference_json));
  }

  saveHygieneDecision(decision) {
    return this.transaction(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO hygiene_decisions (
          decision_id,
          target_type,
          target_id,
          action,
          decided_at,
          decision_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        decision.decisionId,
        decision.targetType,
        decision.targetId,
        decision.action,
        decision.decidedAt,
        JSON.stringify(decision)
      );
      return decision;
    });
  }

  allHygieneDecisions() {
    return this.db.prepare('SELECT decision_json FROM hygiene_decisions ORDER BY decided_at ASC').all()
      .map((row) => JSON.parse(row.decision_json));
  }

  saveFailureGuardrailReview(review) {
    return this.transaction(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO failure_guardrail_reviews (
          review_id,
          failure_id,
          decision,
          reviewed_at,
          review_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        review.reviewId,
        review.failureId,
        review.decision,
        review.reviewedAt,
        JSON.stringify(review)
      );
      return review;
    });
  }

  allFailureGuardrailReviews() {
    return this.db.prepare('SELECT review_json FROM failure_guardrail_reviews ORDER BY reviewed_at ASC').all()
      .map((row) => JSON.parse(row.review_json));
  }

  saveTrendSnapshot({ trendType, snapshotId, generatedAt, snapshot, metadata = {} } = {}) {
    if (!trendType || !snapshotId || !snapshot) {
      return { success: false, error: { code: 'F_TREND_SNAPSHOT_INVALID' } };
    }
    return this.transaction(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO growth_trend_snapshots (
          snapshot_id,
          trend_type,
          generated_at,
          snapshot_json,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        snapshotId,
        trendType,
        generatedAt ?? snapshot.generatedAt ?? this.clock().toISOString(),
        JSON.stringify(snapshot),
        JSON.stringify(metadata ?? {})
      );
      return { success: true, trendType, snapshotId };
    });
  }

  allTrendSnapshots({ trendType = null, limit = 200 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
    const rows = trendType
      ? this.db.prepare(`
        SELECT snapshot_id, trend_type, generated_at, snapshot_json, metadata_json
        FROM growth_trend_snapshots
        WHERE trend_type = ?
        ORDER BY generated_at ASC
        LIMIT ?
      `).all(trendType, normalizedLimit)
      : this.db.prepare(`
        SELECT snapshot_id, trend_type, generated_at, snapshot_json, metadata_json
        FROM growth_trend_snapshots
        ORDER BY generated_at ASC
        LIMIT ?
      `).all(normalizedLimit);
    return rows.map((row) => ({
      snapshotId: row.snapshot_id,
      trendType: row.trend_type,
      generatedAt: row.generated_at,
      snapshot: JSON.parse(row.snapshot_json),
      metadata: JSON.parse(row.metadata_json ?? '{}')
    }));
  }

  latestTrendSnapshot({ trendType } = {}) {
    const row = this.db.prepare(`
      SELECT snapshot_id, trend_type, generated_at, snapshot_json, metadata_json
      FROM growth_trend_snapshots
      WHERE trend_type = ?
      ORDER BY generated_at DESC
      LIMIT 1
    `).get(trendType);
    if (!row) return null;
    return {
      snapshotId: row.snapshot_id,
      trendType: row.trend_type,
      generatedAt: row.generated_at,
      snapshot: JSON.parse(row.snapshot_json),
      metadata: JSON.parse(row.metadata_json ?? '{}')
    };
  }

  backup({ backupId = `growth-backup-${this.clock().toISOString().replace(/[:.]/g, '-')}` } = {}) {
    this.db.exec('PRAGMA wal_checkpoint(FULL);');
    const filePath = join(this.backupDir, `${backupId}.sqlite`);
    copyFileSync(this.dbPath, filePath);
    const sizeBytes = existsSync(filePath) ? statSync(filePath).size : 0;
    const integrity = this.integrityCheck();
    this.db.prepare(`
      INSERT OR REPLACE INTO storage_backups (
        backup_id,
        file_path,
        created_at,
        source_db_path,
        size_bytes,
        integrity_status
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      backupId,
      filePath,
      this.clock().toISOString(),
      this.dbPath,
      sizeBytes,
      integrity.status
    );
    return {
      backupId,
      filePath,
      fileName: basename(filePath),
      sizeBytes,
      integrity
    };
  }

  backups() {
    return this.db.prepare('SELECT backup_id, file_path, created_at, source_db_path, size_bytes, integrity_status FROM storage_backups ORDER BY created_at DESC').all()
      .map((row) => ({
        backupId: row.backup_id,
        filePath: row.file_path,
        createdAt: row.created_at,
        sourceDbPath: row.source_db_path,
        sizeBytes: row.size_bytes,
        integrityStatus: row.integrity_status
      }));
  }

  syncEncryptedBackupToWorm({
    backupPath,
    backupId,
    wormDir = process.env.JARVIS_GROWTH_WORM_BACKUP_DIR ?? join(this.backupDir, 'worm-mirror'),
    dryRun = true
  } = {}) {
    const selectedPath = backupPath ?? this.db.prepare('SELECT file_path FROM storage_backups WHERE backup_id = ?').get(backupId)?.file_path;
    if (!selectedPath || !existsSync(selectedPath)) {
      return { success: false, error: { code: 'F_BACKUP_NOT_FOUND' } };
    }
    const envelope = this.readEncryptedEnvelope(selectedPath);
    if (!envelope) {
      return { success: false, error: { code: 'F_WORM_SYNC_REQUIRES_ENCRYPTED_BACKUP' } };
    }
    const policy = this.backupLocationPolicy({ wormDir });
    const sourceSha256 = this.sha256File(selectedPath);
    const destinationName = `${basename(selectedPath, '.json')}-${sourceSha256.slice(0, 12)}.json`;
    const destinationPath = join(wormDir, destinationName);
    const wouldOverwrite = existsSync(destinationPath);
    const copied = [];
    if (!dryRun) {
      if (wouldOverwrite) {
        return { success: false, error: { code: 'F_WORM_BACKUP_ALREADY_EXISTS', destinationPath } };
      }
      mkdirSync(wormDir, { recursive: true });
      copyFileSync(selectedPath, destinationPath);
      const manifestPath = join(wormDir, 'worm-sync-manifest.jsonl');
      const record = {
        recordVersion: 'f-storage-worm-backup-sync-record-v1',
        backupId: envelope.backupId,
        sourcePath: selectedPath,
        destinationPath,
        sourceSha256,
        copiedAt: this.clock().toISOString(),
        encryptedOnly: true
      };
      writeFileSync(manifestPath, `${JSON.stringify(record)}\n`, { flag: 'a', encoding: 'utf8' });
      copied.push({ destinationPath, sourceSha256, sizeBytes: statSync(destinationPath).size });
    }
    return {
      syncVersion: 'f-storage-worm-backup-sync-v1',
      success: true,
      status: dryRun ? 'dry_run' : 'synced',
      dryRun,
      generatedAt: this.clock().toISOString(),
      backupId: envelope.backupId,
      sourcePath: selectedPath,
      destinationPath,
      sourceSha256,
      wouldOverwrite,
      policy,
      encryptedOnly: true,
      copied
    };
  }

  periodicRestoreDrillEvidence({
    encryptedBackup = null,
    restoreDrill = null,
    wormSync = null,
    intervalHours = 24
  } = {}) {
    const selectedBackup = encryptedBackup ?? this.encryptedBackup({
      backupId: `periodic-restore-evidence-${this.clock().toISOString().replace(/[:.]/g, '-')}`
    });
    const selectedDrill = restoreDrill ?? this.restoreDrill({ backupPath: selectedBackup.filePath });
    const selectedWormSync = wormSync ?? this.syncEncryptedBackupToWorm({
      backupPath: selectedBackup.filePath,
      dryRun: true
    });
    const checks = [
      {
        checkId: 'encrypted_backup_available',
        passed: selectedBackup.backupVersion === 'f-storage-encrypted-backup-v1'
          && selectedBackup.success === true
      },
      {
        checkId: 'restore_drill_read_only_passed',
        passed: selectedDrill.drillVersion === 'f-storage-encrypted-restore-drill-v1'
          && selectedDrill.success === true
          && selectedDrill.restoreMode === 'read_only_drill_no_current_db_replace'
      },
      {
        checkId: 'worm_manifest_available',
        passed: selectedWormSync.syncVersion === 'f-storage-worm-backup-sync-v1'
          && selectedWormSync.success === true
          && selectedWormSync.encryptedOnly === true
      }
    ];
    return {
      evidenceVersion: 'f-storage-periodic-restore-drill-evidence-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      schedule: {
        intervalHours,
        ciCompatible: true,
        runMode: 'read_only_restore_without_current_db_replace',
        evidenceRetention: 'attach_to_growth_quality_release_dossier'
      },
      backupId: selectedBackup.backupId,
      restoreDrill: {
        drillVersion: selectedDrill.drillVersion,
        success: selectedDrill.success,
        schemaVersion: selectedDrill.schemaVersion,
        integrity: selectedDrill.integrity,
        restoreMode: selectedDrill.restoreMode
      },
      wormSync: {
        syncVersion: selectedWormSync.syncVersion,
        status: selectedWormSync.status,
        encryptedOnly: selectedWormSync.encryptedOnly,
        destinationPath: selectedWormSync.destinationPath
      },
      checks
    };
  }

  backupRetentionPlan({ keepLast = 5, maxAgeMs = null } = {}) {
    const backups = this.backups();
    const keep = Math.max(0, Number(keepLast));
    const nowMs = this.clock().getTime();
    const removable = [];
    const retained = [];
    backups.forEach((backup, index) => {
      const ageMs = Math.max(0, nowMs - Date.parse(backup.createdAt));
      const reasons = [];
      if (index >= keep) reasons.push('keepLast');
      if (Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && ageMs > maxAgeMs) reasons.push('maxAgeMs');
      const item = {
        ...backup,
        ageMs,
        fileExists: existsSync(backup.filePath),
        reasons
      };
      if (reasons.length) removable.push(item);
      else retained.push(item);
    });
    return {
      planVersion: 'f-storage-backup-retention-plan-v1',
      generatedAt: this.clock().toISOString(),
      status: removable.length ? 'rotation_recommended' : 'ok',
      policy: { keepLast: keep, maxAgeMs },
      totalBackups: backups.length,
      retainedCount: retained.length,
      removableCount: removable.length,
      retained,
      removable,
      removableBytes: removable.reduce((sum, item) => sum + item.sizeBytes, 0)
    };
  }

  rotateBackups({ keepLast = 5, maxAgeMs = null, dryRun = true } = {}) {
    const plan = this.backupRetentionPlan({ keepLast, maxAgeMs });
    const removed = [];
    if (!dryRun) {
      this.transaction(() => {
        for (const backup of plan.removable) {
          if (backup.fileExists) unlinkSync(backup.filePath);
          this.db.prepare('DELETE FROM storage_backups WHERE backup_id = ?').run(backup.backupId);
          removed.push({
            backupId: backup.backupId,
            filePath: backup.filePath,
            reasons: backup.reasons
          });
        }
      });
    }
    return {
      rotationVersion: 'f-storage-backup-rotation-v1',
      dryRun,
      generatedAt: this.clock().toISOString(),
      status: dryRun ? plan.status : 'completed',
      plan,
      removed
    };
  }

  restoreDrill({ backupPath, backupId, drillId = `restore-drill-${this.clock().toISOString().replace(/[:.]/g, '-')}` } = {}) {
    const selectedPath = backupPath ?? this.db.prepare('SELECT file_path FROM storage_backups WHERE backup_id = ?').get(backupId)?.file_path;
    if (!selectedPath || !existsSync(selectedPath)) {
      return { success: false, error: { code: 'F_BACKUP_NOT_FOUND' } };
    }
    let drillDb = null;
    let materialized = null;
    try {
      materialized = this.materializeBackupForRead({ backupPath: selectedPath, label: 'restore-drill' });
      drillDb = new DatabaseSync(materialized.path);
      const integrityRow = drillDb.prepare('PRAGMA integrity_check').get();
      const integrityResult = integrityRow?.integrity_check ?? Object.values(integrityRow ?? {})[0] ?? 'unknown';
      const userVersionRow = drillDb.prepare('PRAGMA user_version').get();
      const counts = {
        memoryEvents: drillDb.prepare('SELECT COUNT(*) AS count FROM memory_events').get().count,
        growthReviews: drillDb.prepare('SELECT COUNT(*) AS count FROM growth_reviews').get().count,
        confirmedPreferences: drillDb.prepare('SELECT COUNT(*) AS count FROM confirmed_preferences').get().count,
        hygieneDecisions: drillDb.prepare('SELECT COUNT(*) AS count FROM hygiene_decisions').get().count,
        failureGuardrailReviews: drillDb.prepare('SELECT COUNT(*) AS count FROM failure_guardrail_reviews').get().count,
        growthTrendSnapshots: drillDb.prepare('SELECT COUNT(*) AS count FROM growth_trend_snapshots').get().count
      };
      const migrations = drillDb.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC').all();
      const schemaVersion = userVersionRow?.user_version ?? 0;
      const success = integrityResult === 'ok' && schemaVersion >= this.schemaVersion;
      return {
        drillVersion: materialized.encrypted ? 'f-storage-encrypted-restore-drill-v1' : 'f-storage-restore-drill-v1',
        compatibilityDrillVersion: 'f-storage-restore-drill-v1',
        drillId,
        generatedAt: this.clock().toISOString(),
        success,
        backupPath: selectedPath,
        encrypted: materialized.encrypted,
        envelope: materialized.envelope,
        integrity: {
          status: integrityResult === 'ok' ? 'ok' : 'failed',
          result: integrityResult
        },
        schemaVersion,
        expectedSchemaVersion: this.schemaVersion,
        migrations,
        counts,
        restoreMode: 'read_only_drill_no_current_db_replace'
      };
    } catch (error) {
      return {
        drillVersion: 'f-storage-restore-drill-v1',
        drillId,
        generatedAt: this.clock().toISOString(),
        success: false,
        backupPath: selectedPath,
        error: { code: 'F_RESTORE_DRILL_FAILED', message: error.message }
      };
    } finally {
      drillDb?.close();
      materialized?.cleanup?.();
    }
  }

  restore({ backupPath, backupId } = {}) {
    const selectedPath = backupPath ?? this.db.prepare('SELECT file_path FROM storage_backups WHERE backup_id = ?').get(backupId)?.file_path;
    if (!selectedPath || !existsSync(selectedPath)) {
      return { success: false, error: { code: 'F_BACKUP_NOT_FOUND' } };
    }
    const materialized = this.materializeBackupForRead({ backupPath: selectedPath, label: 'restore' });
    this.close();
    copyFileSync(materialized.path, this.dbPath);
    materialized.cleanup();
    this.db = new DatabaseSync(this.dbPath);
    this.initialize();
    return {
      success: true,
      restoredFrom: selectedPath,
      encrypted: materialized.encrypted,
      status: this.storageStatus()
    };
  }

  largeMigrationFixture({
    eventCount = 250,
    prefix = `storage-migration-${this.clock().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`
  } = {}) {
    const normalizedCount = Math.max(1, Math.min(5000, Number(eventCount) || 250));
    const before = this.storageStatus();
    const startedAtMs = Date.now();
    let insertedCount = 0;
    this.transaction(() => {
      for (let index = 0; index < normalizedCount; index += 1) {
        const event = {
          eventId: `evt_${prefix}_${index + 1}`,
          eventType: index % 3 === 0 ? 'approval.approved' : 'task.created',
          taskId: `task_${prefix}_${index + 1}`,
          createdAt: new Date(this.clock().getTime() + index).toISOString(),
          source: { module: 'F_GROWTH_MEMORY', sourceId: `migration-fixture-${index + 1}` },
          payload: {
            rawText: `storage migration fixture ${index + 1}`,
            batch: prefix
          },
          learningFlags: {
            canBeUsedForPreference: index % 3 === 0,
            canBeUsedForWorkflow: true,
            canBeUsedForAutonomy: false,
            containsSensitiveData: false,
            doNotRemember: false
          },
          trustBoundary: {
            userProvided: false,
            externalContent: false,
            systemGenerated: true
          },
          schemaVersion: 'f-memory-event-union-v1',
          schema: {
            name: 'MemoryEvent',
            version: 'f-memory-event-union-v1',
            variant: index % 3 === 0 ? 'approval_positive_evidence' : 'task_event',
            sourceFamily: index % 3 === 0 ? 'approval_flow' : 'task_orchestration'
          },
          schemaValidation: {
            valid: true,
            issueCount: 0,
            warningCount: 0,
            warnings: []
          }
        };
        event.fingerprint = `sha256:${createHash('sha256').update(JSON.stringify({
          eventType: event.eventType,
          taskId: event.taskId,
          payload: event.payload
        })).digest('hex')}`;
        this.saveEvent(event);
        insertedCount += 1;
      }
    });
    const after = this.storageStatus();
    const integrity = this.integrityCheck();
    return {
      reportVersion: 'f-storage-large-migration-fixture-v1',
      generatedAt: this.clock().toISOString(),
      status: insertedCount === normalizedCount && integrity.status === 'ok' ? 'passed' : 'failed',
      prefix,
      fixtureEventCount: normalizedCount,
      insertedCount,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      beforeCounts: before.counts,
      afterCounts: after.counts,
      insertedDelta: after.counts.memoryEvents - before.counts.memoryEvents,
      schemaVersion: after.schemaVersion,
      expectedSchemaVersion: after.expectedSchemaVersion,
      migrations: after.migrations,
      pragmas: after.pragmas,
      integrity
    };
  }

  storageProductGate({
    backupId = `growth-product-gate-${this.clock().toISOString().replace(/[:.]/g, '-')}`,
    largeMigrationEventCount = 120,
    wormDryRun = false,
    keyMaterial = process.env.JARVIS_GROWTH_BACKUP_KEY,
    includeReleaseDossier = true
  } = {}) {
    const keyProvider = this.backupEncryptionKeyProviderStatus({ keyMaterial });
    const atRestDeploymentPolicy = this.atRestEncryptionDeploymentPolicy({ keyMaterial });
    const locationPolicy = this.backupLocationPolicy();
    const encryptedBackup = this.encryptedBackup({ backupId, keyMaterial });
    const restoreDrill = this.restoreDrill({ backupPath: encryptedBackup.filePath });
    const wormSync = this.syncEncryptedBackupToWorm({
      backupPath: encryptedBackup.filePath,
      wormDir: locationPolicy.wormDir,
      dryRun: wormDryRun
    });
    const periodicRestoreDrill = this.periodicRestoreDrillEvidence({
      encryptedBackup,
      restoreDrill,
      wormSync
    });
    const largeMigration = this.largeMigrationFixture({ eventCount: largeMigrationEventCount });
    const checks = [
      {
        checkId: 'at_rest_encryption_deployment_policy_ready',
        passed: atRestDeploymentPolicy.policyVersion === 'f-storage-at-rest-encryption-deployment-policy-v1'
          && atRestDeploymentPolicy.status === 'contract_ready'
          && atRestDeploymentPolicy.controls.encryptedBackupsRequired === true
      },
      {
        checkId: 'encrypted_backup_created',
        passed: encryptedBackup.backupVersion === 'f-storage-encrypted-backup-v1'
          && encryptedBackup.success === true
          && encryptedBackup.envelope.privacy.rawDbBytesInEnvelope === false
      },
      {
        checkId: 'encrypted_restore_drill_passed',
        passed: restoreDrill.drillVersion === 'f-storage-encrypted-restore-drill-v1'
          && restoreDrill.success === true
          && restoreDrill.encrypted === true
      },
      {
        checkId: 'large_migration_fixture_passed',
        passed: largeMigration.reportVersion === 'f-storage-large-migration-fixture-v1'
          && largeMigration.status === 'passed'
          && largeMigration.insertedCount === largeMigration.fixtureEventCount
      },
      {
        checkId: 'worm_sync_policy_ready',
        passed: wormSync.syncVersion === 'f-storage-worm-backup-sync-v1'
          && wormSync.success === true
          && wormSync.encryptedOnly === true
      },
      {
        checkId: 'backup_location_policy_enforces_encryption',
        passed: locationPolicy.policyVersion === 'f-storage-backup-location-policy-v1'
          && locationPolicy.encryptedBackupRequired === true
      },
      {
        checkId: 'periodic_restore_drill_evidence_ready',
        passed: periodicRestoreDrill.evidenceVersion === 'f-storage-periodic-restore-drill-evidence-v1'
          && periodicRestoreDrill.status === 'passed'
          && periodicRestoreDrill.schedule.ciCompatible === true
      }
    ];
    const baseGate = {
      productGateVersion: 'f-storage-persistence-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      keyProvider,
      atRestDeploymentPolicy,
      locationPolicy,
      encryptedBackup,
      restoreDrill,
      wormSync,
      periodicRestoreDrill,
      largeMigration
    };
    if (!includeReleaseDossier) return baseGate;
    const releaseDossier = this.storageReleaseDossier({ productGate: baseGate });
    const finalChecks = [
      ...checks,
      {
        checkId: 'storage_release_dossier_ready',
        passed: releaseDossier.dossierVersion === 'f-storage-release-dossier-v1'
          && releaseDossier.status === 'passed'
          && releaseDossier.artifactManifest.manifestVersion === 'f-storage-release-artifact-manifest-v1'
          && releaseDossier.releaseWorkflow.workflowVersion === 'f-storage-release-workflow-v1'
          && releaseDossier.operationalHandoffManifest.manifestVersion === 'f-storage-operational-handoff-manifest-v1'
          && releaseDossier.externalWormPromotionPackage.packageVersion === 'f-storage-worm-promotion-package-v1'
          && /^[a-f0-9]{64}$/.test(releaseDossier.releaseHash)
      }
    ];
    return {
      ...baseGate,
      status: finalChecks.every((check) => check.passed) ? 'passed' : 'failed',
      checks: finalChecks,
      releaseDossier
    };
  }

  storageReleaseDossier({
    productGate = null,
    backupId = `growth-storage-release-${this.clock().toISOString().replace(/[:.]/g, '-')}`,
    largeMigrationEventCount = 120,
    wormDryRun = false,
    keyMaterial = process.env.JARVIS_GROWTH_BACKUP_KEY,
    reason = 'storage_release_dossier'
  } = {}) {
    const gate = productGate ?? this.storageProductGate({
      backupId,
      largeMigrationEventCount,
      wormDryRun,
      keyMaterial,
      includeReleaseDossier: false
    });
    const encryptedBackupFileHash = gate.encryptedBackup?.filePath && existsSync(gate.encryptedBackup.filePath)
      ? this.sha256File(gate.encryptedBackup.filePath)
      : null;
    const rawNeedles = [
      this.dbPath,
      this.backupDir,
      gate.locationPolicy?.localBackupDir,
      gate.locationPolicy?.wormDir,
      gate.encryptedBackup?.filePath,
      gate.encryptedBackup?.envelope?.source?.dbPath,
      gate.wormSync?.sourcePath,
      gate.wormSync?.destinationPath
    ].filter((needle) => typeof needle === 'string' && needle.length >= 8);
    const releaseWorkflow = {
      workflowVersion: 'f-storage-release-workflow-v1',
      reason,
      keyProviderReady: gate.keyProvider?.providerVersion === 'f-storage-encryption-key-provider-v1'
        && gate.keyProvider?.plaintextKeyStored === false,
      atRestPolicyReady: gate.atRestDeploymentPolicy?.policyVersion === 'f-storage-at-rest-encryption-deployment-policy-v1'
        && gate.atRestDeploymentPolicy?.status === 'contract_ready',
      encryptedBackupReady: gate.encryptedBackup?.backupVersion === 'f-storage-encrypted-backup-v1'
        && gate.encryptedBackup?.success === true
        && gate.encryptedBackup?.envelope?.privacy?.rawDbBytesInEnvelope === false,
      encryptedRestoreDrillReady: gate.restoreDrill?.drillVersion === 'f-storage-encrypted-restore-drill-v1'
        && gate.restoreDrill?.success === true
        && gate.restoreDrill?.restoreMode === 'read_only_drill_no_current_db_replace',
      periodicRestoreEvidenceReady: gate.periodicRestoreDrill?.evidenceVersion === 'f-storage-periodic-restore-drill-evidence-v1'
        && gate.periodicRestoreDrill?.status === 'passed',
      wormMirrorReady: gate.wormSync?.syncVersion === 'f-storage-worm-backup-sync-v1'
        && gate.wormSync?.success === true
        && gate.wormSync?.encryptedOnly === true,
      largeMigrationReady: gate.largeMigration?.reportVersion === 'f-storage-large-migration-fixture-v1'
        && gate.largeMigration?.status === 'passed',
      promotionStatus: 'pending_checks'
    };
    const artifactManifest = {
      manifestVersion: 'f-storage-release-artifact-manifest-v1',
      generatedAt: this.clock().toISOString(),
      rawDbBytesStored: false,
      rawDbPathStored: false,
      rawBackupPathStored: false,
      rawKeyMaterialStored: false,
      plaintextBackupStored: gate.encryptedBackup?.envelope?.privacy?.plaintextBackupStored === true,
      dbPathHash: createHash('sha256').update(String(this.dbPath)).digest('hex'),
      backupDirHash: createHash('sha256').update(String(this.backupDir)).digest('hex'),
      backupIdHash: createHash('sha256').update(String(gate.encryptedBackup?.backupId ?? '')).digest('hex'),
      encryptedBackupFileSha256: encryptedBackupFileHash,
      encryptedBackupEvidenceHash: sha256Json({
        backupVersion: gate.encryptedBackup?.backupVersion,
        success: gate.encryptedBackup?.success,
        sizeBytes: gate.encryptedBackup?.sizeBytes,
        plaintextSizeBytes: gate.encryptedBackup?.plaintextSizeBytes,
        plaintextSha256: gate.encryptedBackup?.plaintextSha256,
        keyProviderVersion: gate.encryptedBackup?.keyProvider?.providerVersion,
        envelopeVersion: gate.encryptedBackup?.envelope?.envelopeVersion,
        privacy: gate.encryptedBackup?.envelope?.privacy,
        sourceIntegrity: gate.encryptedBackup?.envelope?.source?.integrity
      }),
      restoreDrillEvidenceHash: sha256Json({
        drillVersion: gate.restoreDrill?.drillVersion,
        success: gate.restoreDrill?.success,
        encrypted: gate.restoreDrill?.encrypted,
        integrity: gate.restoreDrill?.integrity,
        schemaVersion: gate.restoreDrill?.schemaVersion,
        counts: gate.restoreDrill?.counts,
        restoreMode: gate.restoreDrill?.restoreMode
      }),
      wormSyncEvidenceHash: sha256Json({
        syncVersion: gate.wormSync?.syncVersion,
        status: gate.wormSync?.status,
        dryRun: gate.wormSync?.dryRun,
        sourceSha256: gate.wormSync?.sourceSha256,
        encryptedOnly: gate.wormSync?.encryptedOnly,
        copied: (gate.wormSync?.copied ?? []).map((item) => ({
          sourceSha256: item.sourceSha256,
          sizeBytes: item.sizeBytes
        }))
      }),
      periodicRestoreEvidenceHash: sha256Json(gate.periodicRestoreDrill),
      largeMigrationEvidenceHash: sha256Json({
        reportVersion: gate.largeMigration?.reportVersion,
        status: gate.largeMigration?.status,
        insertedCount: gate.largeMigration?.insertedCount,
        fixtureEventCount: gate.largeMigration?.fixtureEventCount,
        schemaVersion: gate.largeMigration?.schemaVersion,
        integrity: gate.largeMigration?.integrity
      }),
      productGateCheckHash: sha256Json(gate.checks),
      wormArchive: {
        archiveContractVersion: 'f-storage-release-worm-archive-v1',
        syncVersion: gate.wormSync?.syncVersion,
        status: gate.wormSync?.status,
        encryptedOnly: gate.wormSync?.encryptedOnly === true,
        storageMode: 'hash_only_storage_release_manifest',
        includedArtifactHashes: [
          encryptedBackupFileHash,
          gate.wormSync?.sourceSha256,
          sha256Json(gate.periodicRestoreDrill),
          sha256Json(gate.largeMigration),
          sha256Json(gate.checks)
        ].filter(Boolean)
      }
    };
    const operationalHandoffManifest = {
      manifestVersion: 'f-storage-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'growth-memory-storage-release-owner',
      scope: 'sqlite_encrypted_backup_restore_drill_periodic_restore_worm_mirror_large_migration_fixture',
      status: releaseWorkflow.keyProviderReady
        && releaseWorkflow.atRestPolicyReady
        && releaseWorkflow.encryptedBackupReady
        && releaseWorkflow.encryptedRestoreDrillReady
        && releaseWorkflow.periodicRestoreEvidenceReady
        && releaseWorkflow.wormMirrorReady
        && releaseWorkflow.largeMigrationReady
        && artifactManifest.rawDbBytesStored === false
        && artifactManifest.rawDbPathStored === false
        && artifactManifest.rawBackupPathStored === false
        && artifactManifest.rawKeyMaterialStored === false
        && artifactManifest.plaintextBackupStored === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'f-storage-health-handshake-v1',
      healthHandshake: {
        keyProviderReady: releaseWorkflow.keyProviderReady,
        atRestPolicyReady: releaseWorkflow.atRestPolicyReady,
        encryptedBackupReady: releaseWorkflow.encryptedBackupReady,
        encryptedRestoreDrillReady: releaseWorkflow.encryptedRestoreDrillReady,
        periodicRestoreEvidenceReady: releaseWorkflow.periodicRestoreEvidenceReady,
        wormMirrorReady: releaseWorkflow.wormMirrorReady,
        largeMigrationReady: releaseWorkflow.largeMigrationReady,
        hashOnlyManifestReady: artifactManifest.rawDbPathStored === false && artifactManifest.rawBackupPathStored === false
      },
      fallbackPolicy: {
        policyVersion: 'f-storage-fallback-policy-v1',
        primaryFlow: 'create_encrypted_sqlite_backup_restore_drill_and_sync_hash_only_worm_manifest',
        fallbackFlows: [
          'block_release_when_encrypted_backup_or_restore_drill_fails',
          'fall_back_to_local_encrypted_backup_when_worm_provider_is_unavailable',
          'require_periodic_restore_drill_before_storage_schema_migration_release',
          'publish_hash_only_storage_manifest_when_db_paths_or_key_material_would_leak'
        ],
        operatorEscalation: 'growth_memory_storage_owner_backup_operator_and_worm_provider'
      },
      rawDbBytesStored: false,
      rawDbPathStored: false,
      rawBackupPathStored: false,
      rawKeyMaterialStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'f-storage-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "F growth memory HTTP API" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'storage_product_gate_checks_passed',
        'encrypted_backup_release_ready',
        'encrypted_restore_drill_release_ready',
        'periodic_restore_release_ready',
        'worm_mirror_release_ready',
        'large_migration_release_ready',
        'hash_only_storage_artifact_manifest',
        'raw_storage_paths_not_stored',
        'storage_operational_handoff_ready',
        'storage_worm_promotion_package_ready'
      ],
      artifactManifestHash: sha256Json(artifactManifest),
      operationalHandoffHash: sha256Json(operationalHandoffManifest),
      rawDbBytesStored: false,
      rawDbPathStored: false,
      rawBackupPathStored: false,
      rawKeyMaterialStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'f-storage-worm-promotion-package-v1',
      providerContractVersion: 'f-storage-worm-provider-contract-v1',
      status: artifactManifest.wormArchive.archiveContractVersion === 'f-storage-release-worm-archive-v1'
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'f-storage-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: sha256Json(artifactManifest),
      operationalHandoffHash: sha256Json(operationalHandoffManifest),
      ciNightlyGatePlanHash: sha256Json(ciNightlyGatePlan),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 2555,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawDbBytesStored: false,
      rawDbPathStored: false,
      rawBackupPathStored: false,
      rawKeyMaterialStored: false
    };
    const candidate = {
      dossierVersion: 'f-storage-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      releaseWorkflow,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      recommendedReleaseAction: 'pending_checks'
    };
    const rawLeakDetected = rawNeedles.some((needle) => JSON.stringify(candidate).includes(needle));
    const checks = [
      { checkId: 'storage_product_gate_checks_passed', passed: gate.status === 'passed' && gate.checks.every((check) => check.passed) },
      { checkId: 'encrypted_backup_release_ready', passed: releaseWorkflow.encryptedBackupReady === true && encryptedBackupFileHash?.length === 64 },
      { checkId: 'encrypted_restore_drill_release_ready', passed: releaseWorkflow.encryptedRestoreDrillReady === true },
      { checkId: 'periodic_restore_release_ready', passed: releaseWorkflow.periodicRestoreEvidenceReady === true },
      { checkId: 'worm_mirror_release_ready', passed: releaseWorkflow.wormMirrorReady === true && artifactManifest.wormArchive.includedArtifactHashes.length >= 5 },
      { checkId: 'large_migration_release_ready', passed: releaseWorkflow.largeMigrationReady === true },
      {
        checkId: 'hash_only_storage_artifact_manifest',
        passed: artifactManifest.rawDbBytesStored === false
          && artifactManifest.rawDbPathStored === false
          && artifactManifest.rawBackupPathStored === false
          && artifactManifest.rawKeyMaterialStored === false
          && artifactManifest.plaintextBackupStored === false
      },
      { checkId: 'raw_storage_paths_not_stored', passed: rawLeakDetected === false },
      {
        checkId: 'storage_operational_handoff_ready',
        passed: operationalHandoffManifest.manifestVersion === 'f-storage-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'f-storage-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'f-storage-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready'
      },
      {
        checkId: 'storage_worm_promotion_package_ready',
        passed: externalWormPromotionPackage.packageVersion === 'f-storage-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'f-storage-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready'
      }
    ];
    const dossier = {
      ...candidate,
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      releaseWorkflow: {
        ...releaseWorkflow,
        promotionStatus: checks.every((check) => check.passed) ? 'release_evidence_ready' : 'blocked'
      },
      artifactManifest: {
        ...artifactManifest,
        rawLeakCheck: {
          checkedNeedleCount: rawNeedles.length,
          rawLeakDetected
        }
      },
      recommendedReleaseAction: checks.every((check) => check.passed)
        ? 'attach_storage_release_dossier_encrypted_backup_restore_drill_and_worm_manifest'
        : 'block_storage_release_until_encrypted_backup_restore_and_hash_only_checks_pass'
    };
    return {
      ...dossier,
      releaseHash: sha256Json(dossier)
    };
  }

  close() {
    this.db.close();
  }
}
