import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, realpathSync, lstatSync, renameSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {parsePersonalKnowledgeStatement,projectPersonalKnowledge} from '../personal-knowledge-projection.js';
import {memoryScopeMatches,normalizeMemoryScope,sourceRecallAllowed} from '../memory-provenance.js';

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
  constructor({ dbPath, reviewDir, backupDir, clock = () => new Date(), reconcileReviewExports = true } = {}) {
    let defaultRoot='apps/growth-memory/data';
    if(process.env.JARVIS_TEST_MODE==='1'){
      const root=process.env.JARVIS_TEST_AUDIT_ROOT;
      if(!root || !isAbsolute(root))throw Object.assign(new Error('An isolated absolute test root is required.'),{code:'F_TEST_MEMORY_ROOT_REQUIRED'});
      // Omitted review/backup paths must not silently fall back to production
      // merely because a test supplied its own database filename.
      defaultRoot=join(root,'growth-memory-'+process.pid);
    }
    dbPath??=join(defaultRoot,'growth.sqlite');
    reviewDir??=join(defaultRoot,'reviews');backupDir??=join(defaultRoot,'backups');
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
    this.reviewExportReconciliationEnabled=reconcileReviewExports;
    if(reconcileReviewExports)this.reconcileReviewExports();
  }

  initialize() {
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
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
      // Operational generation is excluded from restored application tables.
      this.db.exec(`CREATE TABLE IF NOT EXISTS memory_restore_generation (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), generation INTEGER NOT NULL);
        INSERT OR IGNORE INTO memory_restore_generation VALUES (1, 0);`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS pending_memory_events (
        event_id TEXT PRIMARY KEY, event_json TEXT NOT NULL, event_hash TEXT NOT NULL,
        queued_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS source_retraction_deliveries (
        delivery_hash TEXT NOT NULL, receiver_hash TEXT NOT NULL, generation INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('attempted','acknowledged')),
        attempts INTEGER NOT NULL, observed_at TEXT NOT NULL,
        PRIMARY KEY(delivery_hash,receiver_hash,generation));`);
      // Content-free monotonic revision fences survive application rollback,
      // including snapshots where the original source is absent.
      this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_retirements (
        source_event_id TEXT PRIMARY KEY, successor_event_id TEXT NOT NULL);
        INSERT OR IGNORE INTO knowledge_retirements
        SELECT event_id,json_extract(payload_json,'$.knowledgeRetiredBy') FROM memory_events
        WHERE json_type(payload_json,'$.knowledgeRetiredBy')='text';`);
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_events_owner_conversation_time ON memory_events(json_extract(source_json,'$.memoryScope.userId'),json_extract(source_json,'$.memoryScope.conversationId'),created_at);");
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

  transaction(fn, {deferred=false} = {}) {
    if (this.inTransaction) return fn();
    this.inTransaction = true;
    let began = false;
    try {
      this.db.exec(deferred?'BEGIN DEFERRED TRANSACTION;':'BEGIN IMMEDIATE TRANSACTION;'); began = true;
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      if (began) this.db.exec('ROLLBACK;');
      throw error;
    } finally {
      this.inTransaction = false;
      if(this.reviewExportsDirty && this.reviewExportReconciliationEnabled){
        this.reviewExportsDirty=false;
        this.reconcileReviewExports();
      }
    }
  }

  reviewSourceState() {
    return {sourceDigest:this.sourceRetractionDigest(),hasSourceFences:this.allSourceRetractions().length>0||this.hasRetiredKnowledgeSources(),
      preferenceDigest:this.preferenceStateDigest(),hasPreferences:this.allConfirmedPreferences().length>0};
  }

  projectStoredReview(row,state=this.reviewSourceState()) {
    const review=JSON.parse(row.review_json);
    const reason=state.hasSourceFences && review.sourceRetractionDigest!==state.sourceDigest?'F_REVIEW_SOURCE_RETRACTED':
      (review.preferenceStateDigest!==undefined||state.hasPreferences)&&review.preferenceStateDigest!==state.preferenceDigest?'F_REVIEW_PREFERENCE_CHANGED':null;
    return reason?{reviewId:row.review_id,generatedAt:row.generated_at,status:'source_review_required',contentWithheld:true,reasonCode:reason}:review;
  }

  writeReviewExport(path,text) {
    const temporary=path+'.'+randomBytes(8).toString('hex')+'.tmp';
    try{writeFileSync(temporary,text,{encoding:'utf8',flag:'wx'});renameSync(temporary,path);}
    finally{if(existsSync(temporary))unlinkSync(temporary);}
  }

  reconcileReviewExports() {
    if(this.inTransaction||!this.reviewExportReconciliationEnabled)return this.reviewExportStatus??{status:'pending',pending:0};
    let pending=0,rewritten=0,total=0;
    try{
      // Hold the SQLite writer lock through the bounded filesystem publication,
      // so another connection cannot correct sources between check and rename.
      this.db.exec('BEGIN IMMEDIATE');
      const state=this.reviewSourceState(),base=realpathSync(this.reviewDir);
      for(const row of this.db.prepare('SELECT * FROM growth_reviews').all()){
        total++;
        try{
          if(!/^[\w.-]{1,200}$/.test(row.review_id)||row.review_id==='.'||row.review_id==='..'
            ||resolve(row.file_path)!==resolve(this.reviewDir,row.review_id+'.json')
            ||realpathSync(dirname(row.file_path))!==base)throw new Error('Unsafe export path.');
          if(existsSync(row.file_path)){
            const stat=lstatSync(row.file_path);
            if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('Unsafe export identity.');
          }
          const text=JSON.stringify(this.projectStoredReview(row,state),null,2);
          if(!existsSync(row.file_path)||readFileSync(row.file_path,'utf8')!==text){this.writeReviewExport(row.file_path,text);rewritten++;}
        }catch{pending++;}
      }
      this.db.exec('COMMIT');
    }catch{try{this.db.exec('ROLLBACK');}catch{}pending=Math.max(1,pending);}
    this.reviewExportStatus={status:pending?'requires_retry':'ready',total,pending,rewritten,
      ...(pending?{reasonCode:'F_REVIEW_EXPORT_RECONCILIATION_REQUIRED'}:{})};
    return this.reviewExportStatus;
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
      reviewExports:this.reviewExportStatus??{status:'not_checked',pending:null},
      integrity: this.integrityCheck()
    };
  }

  hasEvent(eventId) {
    return Boolean(this.db.prepare('SELECT event_id FROM memory_events WHERE event_id = ?').get(eventId));
  }

  hasFingerprint(fingerprint) {
    return Boolean(this.db.prepare('SELECT fingerprint FROM memory_events WHERE fingerprint = ?').get(fingerprint));
  }

  assertRestoreGeneration(expectedGeneration) {
    if (expectedGeneration === undefined) return;
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
      throw Object.assign(new Error('Invalid restore generation.'), { code: 'F_MEMORY_GENERATION_INVALID' });
    const currentGeneration = this.restoreGeneration();
    if (expectedGeneration !== currentGeneration) throw Object.assign(new Error('Memory generation changed.'),
      { code: 'F_MEMORY_GENERATION_CONFLICT', currentGeneration });
  }

  saveEvent(event, { expectedGeneration, expectedKnowledgeSource = null } = {}) {
    return this.transaction(() => {
      this.assertRestoreGeneration(expectedGeneration);
      if(event.payload?.knowledge?.supersedesEventId !== undefined && !expectedKnowledgeSource)
        throw Object.assign(new Error('Knowledge corrections require an observed source revision.'), {code:'F_KNOWLEDGE_REVISION_REQUIRED'});
      if(expectedKnowledgeSource){
        const previous=this.db.prepare('SELECT * FROM memory_events WHERE event_id = ?').get(expectedKnowledgeSource.eventId);
        const child=this.db.prepare("SELECT event_id FROM memory_events WHERE json_extract(payload_json,'$.knowledge.supersedesEventId') = ? LIMIT 1").get(expectedKnowledgeSource.eventId);
        const retired=this.db.prepare('SELECT 1 FROM knowledge_retirements WHERE source_event_id=?').get(expectedKnowledgeSource.eventId);
        if(!previous || previous.created_at!==expectedKnowledgeSource.observedAt || retired || JSON.parse(previous.payload_json).knowledgeRetiredBy || child || this.hasSourceRetraction(expectedKnowledgeSource.eventId))
          throw Object.assign(new Error('Knowledge correction source changed.'),{code:'F_KNOWLEDGE_REVISION_CONFLICT'});
        const parent={eventId:previous.event_id,createdAt:previous.created_at,source:JSON.parse(previous.source_json),payload:JSON.parse(previous.payload_json),
          trustBoundary:JSON.parse(previous.trust_boundary_json),learningFlags:JSON.parse(previous.learning_flags_json)};
        const parentKnowledge=parent.payload.knowledge??parsePersonalKnowledgeStatement(parent.payload.rawText),knowledge=event.payload?.knowledge;
        const scope=normalizeMemoryScope(event.source?.memoryScope);
        const shapes=[parent,event].flatMap(item=>projectPersonalKnowledge([{...item,payload:{knowledge:{...(item===parent?parentKnowledge:knowledge),supersedesEventId:undefined}}}],{now:this.clock()}));
        if(!scope || !memoryScopeMatches(parent,scope) || !sourceRecallAllowed(parent) || !sourceRecallAllowed(event)
          || !parentKnowledge || knowledge?.supersedesEventId!==expectedKnowledgeSource.eventId
          || ['kind','subject','predicate'].some(key=>parentKnowledge[key]!==knowledge?.[key])
          || Date.parse(event.createdAt)<=Date.parse(parent.createdAt) || shapes.length!==2 || shapes.some(item=>item.status!=='active'))
          throw Object.assign(new Error('Knowledge correction contract is invalid.'),{code:'F_KNOWLEDGE_CORRECTION_INVALID'});
      }
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
      if(expectedKnowledgeSource){
        this.db.prepare('INSERT INTO knowledge_retirements(source_event_id,successor_event_id) VALUES(?,?)')
          .run(expectedKnowledgeSource.eventId,event.eventId);
        // Preserve only the revision edge on the old source. Withdrawing the
        // correction must not silently reactivate a value it replaced.
        this.db.prepare("UPDATE memory_events SET payload_json=json_set(payload_json,'$.knowledgeRetiredBy',?) WHERE event_id=?")
          .run(event.eventId,expectedKnowledgeSource.eventId);
        this.reviewExportsDirty=true;
      }
      return event;
    });
  }

  queueMemoryEvent(event) {
    return this.transaction(() => {
      if (Buffer.byteLength(JSON.stringify(event), 'utf8') > 131072) return { success: false, error: { code: 'F_MEMORY_PENDING_TOO_LARGE' } };
      const hash = sha256Json(event), current = this.db.prepare('SELECT event_hash FROM pending_memory_events WHERE event_id = ?').get(event.eventId);
      if (!current && this.pendingMemoryStatus().pendingCount >= 1000) return { success: false, error: { code: 'F_MEMORY_PENDING_FULL' } };
      if (current && current.event_hash !== hash) return { success: false, error: { code: 'F_MEMORY_PENDING_ID_CONFLICT' } };
      if (this.hasSourceRetraction(event.eventId)) return { success: false, error: { code: 'F_MEMORY_SOURCE_RETRACTED' } };
      this.db.prepare('INSERT OR IGNORE INTO pending_memory_events(event_id,event_json,event_hash,queued_at) VALUES(?,?,?,?)')
        .run(event.eventId, JSON.stringify(event), hash, this.clock().toISOString());
      return { success: true, queued: true };
    });
  }

  pendingMemoryStatus() {
    const row = this.db.prepare('SELECT count(*) AS pendingCount, COALESCE(sum(attempts),0) AS replayAttempts FROM pending_memory_events').get();
    return { ...row, executionAuthority: false };
  }

  drainPendingMemoryEvents(ingest, { limit = 10 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return { success: false, error: { code: 'F_MEMORY_PENDING_LIMIT_INVALID' } };
    const ids = this.db.prepare('SELECT event_id FROM pending_memory_events ORDER BY queued_at,event_id LIMIT ?').all(limit);
    const outcomes = { stored: 0, suppressed: 0, failed: 0 };
    for (const { event_id: id } of ids) this.transaction(() => {
      const row = this.db.prepare('SELECT event_json FROM pending_memory_events WHERE event_id = ?').get(id);
      if (!row) return;
      if (this.hasSourceRetraction(id)) { this.db.prepare('DELETE FROM pending_memory_events WHERE event_id = ?').run(id); outcomes.suppressed++; return; }
      let result;
      try { result = ingest(JSON.parse(row.event_json)); }
      catch { result = { success: false, error: { code: 'F_MEMORY_PENDING_REPLAY_FAILED' } }; }
      if (result?.success === true) { this.db.prepare('DELETE FROM pending_memory_events WHERE event_id = ?').run(id); outcomes.stored++; }
      else { this.db.prepare('UPDATE pending_memory_events SET attempts=attempts+1,last_error=? WHERE event_id=?')
        .run(result?.error?.code ?? 'F_MEMORY_PENDING_REPLAY_FAILED', id); outcomes.failed++; }
    });
    return { success: true, ...outcomes, ...this.pendingMemoryStatus() };
  }

  retiredKnowledgeSourceIds(){
    return this.knowledgeRetirementEdges().map(row=>row.sourceEventId);
  }

  knowledgeRetirementEdges(){
    return this.db.prepare('SELECT source_event_id AS sourceEventId,successor_event_id AS successorEventId FROM knowledge_retirements ORDER BY source_event_id').all();
  }

  knowledgeSnapshot({scope}={}){
    return this.transaction(()=>({events:this.allEvents({scope}),retiredSourceIds:this.retiredKnowledgeSourceIds(),
      retractedSourceIds:this.allSourceRetractions().map(item=>item.targetId),generation:this.restoreGeneration()}),{deferred:true});
  }

  allEvents({scope}={}) {
    const normalized=scope===undefined?null:normalizeMemoryScope(scope);
    if(scope!==undefined && !normalized)return [];
    // Workspace paths remain checked by memoryScopeMatches after decoding:
    // legacy relative paths must not be lost by a SQL equality prefilter.
    const rows=normalized?this.db.prepare("SELECT * FROM memory_events WHERE json_extract(source_json,'$.memoryScope.userId')=? AND json_extract(source_json,'$.memoryScope.conversationId') IS ? ORDER BY created_at ASC").all(normalized.userId,normalized.conversationId)
      :this.db.prepare('SELECT * FROM memory_events ORDER BY created_at ASC').all();
    return rows.map((row) => {
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
    }).filter(event=>!normalized || memoryScopeMatches(event,normalized));
  }

  updateEvent(event, { expectedGeneration } = {}) {
    return this.transaction(() => {
      this.assertRestoreGeneration(expectedGeneration);
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

  saveReview(review, { expectedGeneration, expectedSourceRetractionDigest, expectedPreferenceStateDigest } = {}) {
    if(typeof review.reviewId!=='string'||!/^[\w.-]{1,200}$/.test(review.reviewId)||['.','..'].includes(review.reviewId))
      throw Object.assign(new Error('Invalid review identity.'),{code:'F_REVIEW_ID_INVALID'});
    const filePath = join(this.reviewDir, `${review.reviewId}.json`);
    this.transaction(() => {
      this.assertRestoreGeneration(expectedGeneration);
      const sourceRetractionDigest = this.sourceRetractionDigest();
      if (expectedSourceRetractionDigest !== undefined && sourceRetractionDigest !== expectedSourceRetractionDigest) {
        throw Object.assign(new Error('Memory sources changed during report generation.'), { code: 'F_MEMORY_SOURCE_CHANGED' });
      }
      const preferenceStateDigest = this.preferenceStateDigest();
      if (expectedPreferenceStateDigest !== undefined && preferenceStateDigest !== expectedPreferenceStateDigest) throw Object.assign(new Error("Memory preferences changed."), { code: "F_MEMORY_PREFERENCE_CHANGED" });
      review = { ...review, sourceRetractionDigest, preferenceStateDigest };
      this.db.prepare(`
        INSERT OR REPLACE INTO growth_reviews (review_id, generated_at, period, review_json, file_path)
        VALUES (?, ?, ?, ?, ?)
      `).run(review.reviewId, review.generatedAt, review.period, JSON.stringify(review), filePath);
      this.reviewExportsDirty=true;
    });
    return { ...review, ...(this.reviewExportStatus?.pending?{exportPending:true}: {filePath}),exportStatus:this.reviewExportStatus };
  }

  latestReview() {
    this.reconcileReviewExports();
    const row = this.db.prepare('SELECT * FROM growth_reviews ORDER BY generated_at DESC LIMIT 1').get();
    if (!row) return null;
    const review = JSON.parse(row.review_json);
    if ((this.allSourceRetractions().length || this.hasRetiredKnowledgeSources()) && review.sourceRetractionDigest !== this.sourceRetractionDigest()) {
      return { reviewId: row.review_id, generatedAt: row.generated_at, status: 'source_review_required',
        contentWithheld: true, reasonCode: 'F_REVIEW_SOURCE_RETRACTED' };
    }
    if ((review.preferenceStateDigest !== undefined || this.allConfirmedPreferences().length) && review.preferenceStateDigest !== this.preferenceStateDigest()) return {
      reviewId: row.review_id, generatedAt: row.generated_at, status: "preference_review_required",
      contentWithheld: true, reasonCode: "F_REVIEW_PREFERENCE_CHANGED"
    };
    return { ...review, ...(this.reviewExportStatus?.pending?{exportPending:true}:{filePath:row.file_path}),exportStatus:this.reviewExportStatus };
  }

  getConfirmedPreference(preferenceId) {
    const row = this.db.prepare('SELECT preference_json FROM confirmed_preferences WHERE preference_id = ?').get(preferenceId);
    return row ? JSON.parse(row.preference_json) : null;
  }

  saveConfirmedPreference(preference, { expectedRevision = null, expectedGeneration } = {}) {
    return this.transaction(() => {
      this.assertRestoreGeneration(expectedGeneration);
      if (expectedRevision !== null) {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw Object.assign(new Error('Invalid memory revision.'), { code: 'F_MEMORY_REVISION_INVALID' });
        const current = this.getConfirmedPreference(preference.preferenceId);
        const currentRevision = current ? current.revision ?? 1 : 0;
        if (currentRevision !== expectedRevision) throw Object.assign(new Error('Memory revision conflict.'), { code: 'F_MEMORY_REVISION_CONFLICT', currentRevision });
        if (preference.revision !== expectedRevision + 1) throw Object.assign(new Error('Invalid next memory revision.'), { code: 'F_MEMORY_REVISION_INVALID' });
      }
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
      this.reviewExportsDirty=true;
      return preference;
    });
  }

  allConfirmedPreferences() {
    return this.db.prepare('SELECT preference_json FROM confirmed_preferences ORDER BY confirmed_at ASC').all()
      .map((row) => JSON.parse(row.preference_json));
  }

  saveHygieneDecision(decision, { expectedGeneration } = {}) {
    return this.transaction(() => {
      this.assertRestoreGeneration(expectedGeneration);
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
      if(decision.targetType==='memory_event'&&['delete','redact'].includes(decision.action))this.reviewExportsDirty=true;
      return decision;
    });
  }

  applyHygieneDecision(decision, event, { expectedGeneration } = {}) {
    return this.transaction(() => {
      this.assertRestoreGeneration(expectedGeneration);
      if (event && (!this.hasEvent(event.eventId) || event.eventId !== decision.targetId)) {
        throw Object.assign(new Error('Hygiene target is unavailable.'), { code: 'F_MEMORY_EVENT_NOT_FOUND' });
      }
      if (decision.targetType === 'memory_event' && ['keep', 'defer'].includes(decision.action)
        && this.hasSourceRetraction(decision.targetId)) {
        throw Object.assign(new Error('Source was withdrawn.'), { code: 'F_MEMORY_SOURCE_RETRACTED' });
      }
      if (decision.targetType === 'memory_event' && decision.action === 'redact'
        && this.db.prepare("SELECT 1 FROM hygiene_decisions WHERE target_type = 'memory_event' AND target_id = ? AND action = 'delete' LIMIT 1").get(decision.targetId)) {
        throw Object.assign(new Error('Deleted source cannot be downgraded.'), { code: 'F_MEMORY_SOURCE_RETRACTED' });
      }
      this.saveHygieneDecision(decision, { expectedGeneration });
      if (event) this.updateEvent(event, { expectedGeneration });
      return { success: true };
    });
  }

  allHygieneDecisions() {
    return this.db.prepare('SELECT decision_json FROM hygiene_decisions ORDER BY decided_at ASC').all()
      .map((row) => JSON.parse(row.decision_json));
  }

  allSourceRetractions() {
    return this.allHygieneDecisions().filter(item => item.targetType === 'memory_event'
      && ['delete', 'redact'].includes(item.action));
  }

  preferenceStateDigest() {
    return sha256Json(this.allConfirmedPreferences().sort((a,b) => a.preferenceId.localeCompare(b.preferenceId)));
  }

  sourceRetractionDigest() {
    const retractions=this.allSourceRetractions().map(item => ({ id: item.decisionId,
      targetId: item.targetId, action: item.action })).sort((a, b) => a.id.localeCompare(b.id));
    const retirements=this.knowledgeRetirementEdges();
    // A corrected assertion is no longer eligible for current recall, but its
    // task must not be marked deleted. Include the durable revision fence in
    // derived publication checks; preserve legacy hashes until one exists.
    return sha256Json(retirements.length?{retractions,knowledgeRetirements:retirements}:retractions);
  }

  hasRetiredKnowledgeSources() {
    return Boolean(this.db.prepare('SELECT 1 FROM knowledge_retirements LIMIT 1').get());
  }

  hasSourceRetraction(eventId) {
    return Boolean(this.db.prepare("SELECT 1 FROM hygiene_decisions WHERE target_type = 'memory_event' AND target_id = ? AND action IN ('delete', 'redact') LIMIT 1").get(eventId));
  }

  saveFailureGuardrailReview(review, { expectedGeneration, expectedSourceRetractionDigest } = {}) {
    return this.transaction(() => {
      this.assertRestoreGeneration(expectedGeneration);
      const sourceRetractionDigest = this.sourceRetractionDigest();
      if (expectedSourceRetractionDigest !== undefined && sourceRetractionDigest !== expectedSourceRetractionDigest) throw Object.assign(new Error("Memory source changed."), { code: "F_MEMORY_SOURCE_CHANGED" });
      if ((review.evidenceEventIds ?? []).some(id => this.hasSourceRetraction(id))) throw Object.assign(new Error("Memory source retracted."), { code: "F_MEMORY_SOURCE_RETRACTED" });
      review = { ...review, sourceRetractionDigest };
      const existing=this.db.prepare('SELECT review_json FROM failure_guardrail_reviews WHERE review_id=?').get(review.reviewId);
      if(existing){
        if(canonicalJson(JSON.parse(existing.review_json))!==canonicalJson(review))
          throw Object.assign(new Error('Failure review revision is immutable.'),{code:'F_FAILURE_REVIEW_REVISION_CONFLICT'});
        return JSON.parse(existing.review_json);
      }
      this.db.prepare(`
        INSERT INTO failure_guardrail_reviews (
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
    const withdrawn = this.allSourceRetractions().length > 0 || this.hasRetiredKnowledgeSources();
    const digest = this.sourceRetractionDigest();
    return this.db.prepare('SELECT review_json FROM failure_guardrail_reviews ORDER BY rowid ASC').all()
      .map((row) => {
        const review = JSON.parse(row.review_json);
        if (withdrawn && review.sourceRetractionDigest !== digest) return {
          reviewId: review.reviewId, failureId: review.failureId, reviewedAt: review.reviewedAt,
          contentWithheld: true, status: 'source_review_required', reasonCode: 'F_FAILURE_REVIEW_SOURCE_RETRACTED'
        };
        return review;
      });
  }

  saveTrendSnapshot({ trendType, snapshotId, generatedAt, snapshot, metadata = {} } = {}, { expectedGeneration, expectedSourceRetractionDigest, expectedPreferenceStateDigest } = {}) {
    if (!trendType || !snapshotId || !snapshot) {
      return { success: false, error: { code: 'F_TREND_SNAPSHOT_INVALID' } };
    }
    return this.transaction(() => {
      this.assertRestoreGeneration(expectedGeneration);
      const sourceRetractionDigest = this.sourceRetractionDigest();
      if (expectedSourceRetractionDigest !== undefined && sourceRetractionDigest !== expectedSourceRetractionDigest) {
        throw Object.assign(new Error("Memory source changed."), { code: "F_MEMORY_SOURCE_CHANGED" });
      }
      const preferenceStateDigest = this.preferenceStateDigest();
      if (expectedPreferenceStateDigest !== undefined && preferenceStateDigest !== expectedPreferenceStateDigest) throw Object.assign(new Error("Memory preferences changed."), { code: "F_MEMORY_PREFERENCE_CHANGED" });
      snapshot = { ...snapshot, sourceRetractionDigest, preferenceStateDigest };
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

  trendSourceState() {
    const preferences = this.allConfirmedPreferences();
    return { withdrawn: this.allSourceRetractions().length > 0 || this.hasRetiredKnowledgeSources(), digest: this.sourceRetractionDigest(),
      hasPreferences: preferences.length > 0, hasCorrections: preferences.some(item => (item.revision ?? 1) > 1),
      preferenceDigest: sha256Json(preferences.sort((a,b) => a.preferenceId.localeCompare(b.preferenceId))) };
  }

  projectTrendSnapshot(row, { includeRetractedContent = false, sourceState = null } = {}) {
    const snapshot = JSON.parse(row.snapshot_json);
    sourceState ??= this.trendSourceState();
    const withdrawn = sourceState.withdrawn;
    const stale = withdrawn && snapshot.sourceRetractionDigest !== sourceState.digest;
    // Skill snapshots intentionally retain private revision history for safe
    // rehydration. A fresh digest does not make that history public again.
    const preferenceChanged = (snapshot.preferenceStateDigest !== undefined || sourceState.hasPreferences) && snapshot.preferenceStateDigest !== sourceState.preferenceDigest;
    const privateSkillHistory = (withdrawn || sourceState.hasCorrections) && row.trend_type === 'skill_registry';
    if (!includeRetractedContent && (stale || privateSkillHistory || preferenceChanged)) return {
      snapshotId: row.snapshot_id, trendType: row.trend_type, generatedAt: row.generated_at,
      snapshot: null, metadata: {}, contentWithheld: true, status: 'source_review_required',
      reasonCode: privateSkillHistory ? 'F_SKILL_SNAPSHOT_PRIVATE_RETAINED' : preferenceChanged ? 'F_TREND_PREFERENCE_CHANGED' : 'F_TREND_SOURCE_RETRACTED'
    };
    return { snapshotId: row.snapshot_id, trendType: row.trend_type, generatedAt: row.generated_at,
      snapshot, metadata: JSON.parse(row.metadata_json ?? '{}') };
  }

  allTrendSnapshots({ trendType = null, limit = 200, includeRetractedContent = false } = {}) {
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
    const sourceState = this.trendSourceState();
    return rows.map(row => this.projectTrendSnapshot(row, { includeRetractedContent, sourceState }));
  }

  latestTrendSnapshot({ trendType, includeRetractedContent = false } = {}) {
    const row = this.db.prepare(`
      SELECT snapshot_id, trend_type, generated_at, snapshot_json, metadata_json
      FROM growth_trend_snapshots
      WHERE trend_type = ?
      ORDER BY generated_at DESC
      LIMIT 1
    `).get(trendType);
    if (!row) return null;
    return this.projectTrendSnapshot(row, { includeRetractedContent });
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

  sourceRetractionDelivery({ deliveryKey, receiverId, expectedGeneration } = {}) {
    this.assertRestoreGeneration(expectedGeneration);
    return this.db.prepare('SELECT state,attempts,observed_at AS observedAt FROM source_retraction_deliveries WHERE delivery_hash=? AND receiver_hash=? AND generation=?')
      .get(sha256Json(deliveryKey), sha256Json(receiverId), expectedGeneration) ?? null;
  }

  recordSourceRetractionDelivery({ deliveryKey, receiverId, state, expectedGeneration } = {}) {
    if (typeof deliveryKey !== 'string' || typeof receiverId !== 'string' || !receiverId
      || !['attempted','acknowledged'].includes(state) || !Number.isSafeInteger(expectedGeneration)) throw new Error('F_RETRACTION_RECEIPT_INVALID');
    return this.transaction(() => {
      this.assertRestoreGeneration(expectedGeneration);
      this.db.prepare(`INSERT INTO source_retraction_deliveries VALUES(?,?,?,?,?,?)
        ON CONFLICT(delivery_hash,receiver_hash,generation) DO UPDATE SET state=excluded.state,
        attempts=source_retraction_deliveries.attempts+excluded.attempts,observed_at=excluded.observed_at`)
        .run(sha256Json(deliveryKey),sha256Json(receiverId),expectedGeneration,state,state === 'attempted' ? 1 : 0,this.clock().toISOString());
      return { recorded: true };
    });
  }

  restoreGeneration() {
    return this.db.prepare('SELECT generation FROM memory_restore_generation WHERE singleton = 1').get().generation;
  }

  restore({ backupPath, backupId } = {}) {
    const selectedPath = backupPath ?? this.db.prepare('SELECT file_path FROM storage_backups WHERE backup_id = ?').get(backupId)?.file_path;
    if (!selectedPath || !existsSync(selectedPath)) return { success: false, error: { code: 'F_BACKUP_NOT_FOUND' } };
    // Construct and validate a complete replacement before touching the live DB.
    // Copy rows in one SQLite transaction, retaining the original DB identity.
    // Application workers still need maintenance/re-hydration of their caches.
    const retractions = this.allSourceRetractions();
    const stagedPath = join(dirname(this.dbPath), `.growth-restore-${randomBytes(12).toString('hex')}.sqlite`);
    let staged = null, materialized = null, attached = false;
    try {
      materialized = this.materializeBackupForRead({ backupPath: selectedPath, label: 'restore' });
      copyFileSync(materialized.path, stagedPath);
      const probe = new DatabaseSync(stagedPath);
      try {
        if (probe.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('Invalid restore database.');
        const version = probe.prepare('PRAGMA user_version').get()?.user_version;
        const tables = new Set(probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
        if (!Number.isInteger(version) || version < 1 || version > this.schemaVersion
          || ['memory_events', 'growth_reviews', 'confirmed_preferences', 'schema_migrations'].some(name => !tables.has(name)))
          throw new Error('Unsupported restore schema.');
      }
      finally { probe.close(); }
      staged = new SqliteMemoryStore({ dbPath: stagedPath, reviewDir: this.reviewDir, backupDir: this.backupDir, clock: this.clock, reconcileReviewExports:false });
      staged.transaction(() => {
        for (const decision of retractions) {
          // A historical keep decision must never replace a current withdrawal.
          staged.saveHygieneDecision(decision);
        }
      });
      const integrity = staged.integrityCheck();
      if (integrity.status !== 'ok') throw new Error('Invalid restore integrity.');
      if (retractions.some(item => !staged.hasSourceRetraction(item.targetId))) throw new Error('Missing withdrawal.');
      staged.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      staged.close(); staged = null;
      this.db.prepare('ATTACH DATABASE ? AS restore_snapshot').run(stagedPath); attached = true;
      const tables = ['memory_events', 'growth_reviews', 'confirmed_preferences', 'storage_backups',
        'hygiene_decisions', 'failure_guardrail_reviews', 'growth_trend_snapshots'];
      for (const table of tables) {
        const current = this.db.prepare(`PRAGMA main.table_info(${table})`).all().map(row => [row.name, row.type, row.pk]);
        const restored = this.db.prepare(`PRAGMA restore_snapshot.table_info(${table})`).all().map(row => [row.name, row.type, row.pk]);
        if (JSON.stringify(current) !== JSON.stringify(restored)) throw new Error('Restore table contract changed.');
      }
      const retainedCount = this.transaction(() => {
        // Re-read after obtaining the writer lock: staging may take time, and
        // another connection can withdraw sources during that preparation.
        const latestRetractions = this.allSourceRetractions();
        const latestKnowledgeRetirements=this.knowledgeRetirementEdges();
        // Merge fences from the selected backup, never replace the current
        // fence ledger. Staged opening upgrades older backups with this table.
        this.db.exec('INSERT OR IGNORE INTO main.knowledge_retirements SELECT * FROM restore_snapshot.knowledge_retirements;');
        for (const table of tables) {
          this.db.exec(`DELETE FROM main.${table}; INSERT INTO main.${table} SELECT * FROM restore_snapshot.${table};`);
        }
        for (const decision of latestRetractions) this.saveHygieneDecision(decision);
        // Restoration may roll back application rows, but must not silently
        // reactivate assertions already replaced by a later owner correction.
        // Read under the writer lock so a correction during staging is retained.
        const retire=this.db.prepare("UPDATE memory_events SET payload_json=json_set(payload_json,'$.knowledgeRetiredBy',?) WHERE event_id=?");
        for(const edge of latestKnowledgeRetirements)retire.run(edge.successorEventId,edge.sourceEventId);
        if (latestRetractions.some(item => !this.hasSourceRetraction(item.targetId))) throw new Error('Restore lost withdrawal.');
        this.db.exec('UPDATE memory_restore_generation SET generation = generation + 1 WHERE singleton = 1');
        this.reviewExportsDirty=true;
        return latestRetractions.length;
      });
      return { success: true, restoredFrom: selectedPath, encrypted: materialized.encrypted,
        retainedSourceRetractionCount: retainedCount, restoreMode: 'transactional_rows_preserve_database_identity', status: this.storageStatus() };
    } catch {
      return { success: false, error: { code: 'F_STORAGE_RESTORE_FAILED' } };
    } finally {
      if (attached) this.db.exec('DETACH DATABASE restore_snapshot;');
      staged?.close();
      materialized?.cleanup();
      for (const file of [stagedPath, `${stagedPath}-wal`, `${stagedPath}-shm`]) if (existsSync(file)) unlinkSync(file);
    }
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
