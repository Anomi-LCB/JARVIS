import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { JsonlAuditLog, MemoryAuditLog } from '../../../shared/src/audit-log.js';
import { ActionType, stableId } from '../../../shared/src/types.js';

export const RuntimeTrustMode = Object.freeze({
  TRUSTED: 'trusted',
  GUARDED: 'guarded',
  LOCKDOWN: 'lockdown'
});

export const RuntimeTrustSeverity = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
});

const severityWeight = Object.freeze({
  [RuntimeTrustSeverity.LOW]: 5,
  [RuntimeTrustSeverity.MEDIUM]: 15,
  [RuntimeTrustSeverity.HIGH]: 30,
  [RuntimeTrustSeverity.CRITICAL]: 100
});

const readOnlyActionTypes = new Set([
  ActionType.LIST_FILES,
  ActionType.SEARCH_FILES,
  ActionType.BROWSER_SEARCH,
  ActionType.CAPABILITY_QUERY
]);

const recoveryToolNames = new Set([
  'rollback.execute',
  'rollback.restore',
  'diagnostics.read',
  'security.trust.status'
]);

const externalActionTypes = new Set([
  ActionType.UPLOAD_FILE,
  ActionType.SEND_EMAIL,
  ActionType.MAKE_PAYMENT
]);

// Test runtimes may simulate a restart by constructing a second kernel over the
// same temporary journal. Keep that journal's key stable without writing test
// secrets to disk or weakening the production key provider.
const testTrustKeysByPath = new Map();

export class RuntimeTrustKernel {
  constructor({
    actorId = 'core-runtime',
    clock = () => new Date(),
    statePath = null,
    auditPath = null,
    keyPath = null,
    signingSecret = null,
    testMode = process.env.JARVIS_TEST_MODE === '1',
    riskWindowMs = 5 * 60 * 1000,
    guardedThreshold = 30,
    lockdownThreshold = 80,
    highSignalLockCount = 3,
    signalDedupMs = 10_000,
    challengeTtlMs = 5 * 60 * 1000
  } = {}) {
    this.actorId = cleanIdentifier(actorId, 'core-runtime');
    this.clock = clock;
    this.statePath = statePath ? resolve(statePath) : null;
    this.auditPath = auditPath
      ? resolve(auditPath)
      : this.statePath
        ? join(dirname(this.statePath), `runtime-trust-audit-${this.actorId}.jsonl`)
        : null;
    this.keyPath = keyPath
      ? resolve(keyPath)
      : this.statePath
        ? join(dirname(this.statePath), 'runtime-trust-key.json')
        : null;
    this.riskWindowMs = riskWindowMs;
    this.guardedThreshold = guardedThreshold;
    this.lockdownThreshold = lockdownThreshold;
    this.highSignalLockCount = highSignalLockCount;
    this.signalDedupMs = signalDedupMs;
    this.challengeTtlMs = challengeTtlMs;
    this.lockdownHandlers = [];
    this.recoveryHandlers = [];
    this.recoveryProbes = new Map();
    this.lastObservedMode = null;

    const key = resolveTrustKey({
      signingSecret,
      keyPath: this.keyPath,
      testMode
    });
    this.signingSecret = key.secret;
    this.keyProvider = key.status;
    this.auditLog = this.auditPath
      ? new JsonlAuditLog({
          filePath: this.auditPath,
          clock,
          signingSecret: this.signingSecret,
          loadExisting: true,
          maxEntries: 20_000
        })
      : new MemoryAuditLog();
    this.state = this.loadOrCreateState();
    this.lastObservedMode = this.state.mode;
    this.verifyStartupIntegrity();
  }

  status({ includeSensitive = false } = {}) {
    this.syncFromDisk();
    this.refreshRiskState();
    const journal = this.verifyAuditJournal();
    const now = this.clock().toISOString();
    const publicState = {
      kernelVersion: 'a-runtime-trust-kernel-v1',
      statusVersion: 'a-runtime-trust-status-v1',
      actorId: this.actorId,
      mode: this.state.mode,
      operational: this.state.mode !== RuntimeTrustMode.LOCKDOWN,
      mutatingExecutionAllowed: this.state.mode === RuntimeTrustMode.TRUSTED,
      readOnlyExecutionAllowed: true,
      riskScore: this.state.riskScore,
      reasonCodes: [...this.state.reasonCodes],
      stateVersion: this.state.stateVersion,
      stateHash: this.state.stateHash,
      lastTransitionAt: this.state.lastTransitionAt,
      activeIncident: publicIncident(this.state.activeIncident, now),
      recentSignals: this.state.recentSignals.slice(0, 20).map(publicSignal),
      signalWindow: {
        windowMs: this.riskWindowMs,
        guardedThreshold: this.guardedThreshold,
        lockdownThreshold: this.lockdownThreshold,
        highSignalLockCount: this.highSignalLockCount
      },
      integrity: {
        stateSignatureValid: this.verifyState(this.state).valid,
        auditChainValid: journal.valid,
        auditEntries: journal.entries ?? 0,
        auditHeadHash: journal.headHash ?? null
      },
      keyProvider: {
        provider: this.keyProvider.provider,
        protectedByOs: this.keyProvider.protectedByOs,
        persistent: this.keyProvider.persistent,
        fallback: this.keyProvider.fallback,
        keyId: this.keyProvider.keyId,
        rawKeyStored: this.keyProvider.rawKeyStored
      },
      recovery: {
        challengeActive: this.challengeActive(now),
        challengeExpiresAt: this.state.recoveryChallenge?.expiresAt ?? null,
        requiredChecks: [...this.recoveryProbes.keys()].sort(),
        ownerSessionAutomaticallyRestored: false,
        capabilitiesAutomaticallyRestored: false
      },
      checkedAt: now
    };
    if (includeSensitive) {
      publicState.persistence = {
        statePath: this.statePath,
        auditPath: this.auditPath,
        keyPath: this.keyPath
      };
    }
    return publicState;
  }

  createPurposeBoundSigner({ purpose } = {}) {
    const normalizedPurpose = String(purpose ?? '').trim();
    if (!/^[a-z0-9][a-z0-9:._-]{2,119}$/iu.test(normalizedPurpose)) {
      throw Object.assign(new Error('A stable signer purpose is required.'), { code: 'A_TRUST_SIGNER_PURPOSE_INVALID' });
    }
    if (this.keyProvider.persistent !== true || this.keyProvider.fallback === true) {
      throw Object.assign(new Error('Persistent protected runtime trust key is unavailable.'), { code: 'A_TRUST_SIGNER_KEY_NOT_PERSISTENT' });
    }
    const key = createHmac('sha256', this.signingSecret)
      .update(`jarvis-local-record:${normalizedPurpose}`)
      .digest();
    return Object.freeze({
      purpose: normalizedPurpose,
      keyId: this.keyProvider.keyId,
      sign: value => createHmac('sha256', key).update(String(value)).digest('base64url'),
      verify: (value, signature) => secureTextEqual(
        createHmac('sha256', key).update(String(value)).digest('base64url'),
        String(signature ?? '')
      )
    });
  }

  verifyLocalJournalHead(journalId, { sequence = 0, headHash = 'GENESIS' } = {}) {
    this.syncFromDisk();
    const normalizedId = cleanIdentifier(journalId, 'local-journal');
    const stored = this.state.localJournalHeads?.[normalizedId] ?? { sequence: 0, headHash: 'GENESIS' };
    const requestedSequence = Number(sequence);
    if (!Number.isSafeInteger(requestedSequence) || requestedSequence < 0
      || typeof headHash !== 'string' || !/^(?:GENESIS|[a-f0-9]{64})$/iu.test(headHash)) {
      return { valid: false, reason: 'journal-head-invalid' };
    }
    if (requestedSequence < stored.sequence) return { valid: false, reason: 'journal-truncated-or-replayed', storedSequence: stored.sequence };
    if (requestedSequence === stored.sequence && headHash !== stored.headHash) return { valid: false, reason: 'journal-anchor-mismatch', storedSequence: stored.sequence };
    return { valid: true, needsAnchor: requestedSequence > stored.sequence, storedSequence: stored.sequence };
  }

  anchorLocalJournalHead(journalId, { sequence, headHash } = {}) {
    this.syncFromDisk();
    const normalizedId = cleanIdentifier(journalId, 'local-journal');
    const current = this.state.localJournalHeads?.[normalizedId] ?? { sequence: 0, headHash: 'GENESIS' };
    const verified = this.verifyLocalJournalHead(normalizedId, { sequence, headHash });
    if (!verified.valid) throw Object.assign(new Error('Local journal does not extend its signed trust-state anchor.'), { code: 'A_TRUST_LOCAL_JOURNAL_ANCHOR_INVALID', reason: verified.reason });
    if (Number(sequence) === current.sequence) return { success: true, sequence: current.sequence, headHash: current.headHash, unchanged: true };
    this.state.localJournalHeads = {
      ...(this.state.localJournalHeads ?? {}),
      [normalizedId]: { sequence: Number(sequence), headHash }
    };
    this.persistState(`local-journal-anchor:${normalizedId}`);
    return { success: true, sequence: Number(sequence), headHash, unchanged: false };
  }

  publicStatus() {
    return this.status({ includeSensitive: false });
  }

  authorizeExecution({ action = {}, dryRun = false, source = 'unknown' } = {}) {
    this.syncFromDisk();
    this.refreshRiskState();
    const actionType = action.actionType ?? null;
    const toolName = action.toolName ?? null;
    const readOnly = dryRun === true || isReadOnlyAction(action);
    const recovery = recoveryToolNames.has(toolName) || action.recovery === true;
    const external = externalActionTypes.has(actionType)
      || action.capability?.externalTransfer === true
      || action.context?.externalTransfer === true;
    const irreversible = action.capability?.reversible === false
      || action.context?.irreversible === true
      || actionType === ActionType.DELETE_FILE;
    const elevated = action.context?.allowAdminPrivilege === true
      || action.arguments?.runAsAdministrator === true;

    let allowed = true;
    let code = 'A_TRUST_EXECUTION_ALLOWED';
    let reason = 'trusted-runtime';
    if (this.state.mode === RuntimeTrustMode.LOCKDOWN && !readOnly && !recovery) {
      allowed = false;
      code = 'A_TRUST_LOCKDOWN_ACTIVE';
      reason = 'mutating-execution-blocked-during-lockdown';
    } else if (this.state.mode === RuntimeTrustMode.GUARDED && (external || irreversible || elevated)) {
      allowed = false;
      code = 'A_TRUST_GUARDED_HIGH_IMPACT_BLOCKED';
      reason = 'high-impact-execution-blocked-during-guarded-mode';
    }
    const decision = {
      authorizationVersion: 'a-runtime-trust-execution-authorization-v1',
      allowed,
      code,
      reason,
      mode: this.state.mode,
      source,
      actionType,
      toolName,
      readOnly,
      recovery,
      external,
      irreversible,
      elevated,
      riskScore: this.state.riskScore,
      evaluatedAt: this.clock().toISOString()
    };
    if (!allowed) {
      this.writeAudit('trust.execution.blocked', {
        code,
        source,
        actionType,
        toolName,
        mode: this.state.mode,
        stateHash: this.state.stateHash
      });
    }
    return decision;
  }

  recordSignal({
    code,
    severity = RuntimeTrustSeverity.MEDIUM,
    source = 'unknown',
    category = 'security',
    metadata = {},
    force = false
  } = {}) {
    this.syncFromDisk();
    const normalizedSeverity = severityWeight[severity] ? severity : RuntimeTrustSeverity.MEDIUM;
    const now = this.clock().toISOString();
    const signal = {
      signalVersion: 'a-runtime-trust-signal-v1',
      signalId: stableId('trust_signal', `${code}:${source}:${randomBytes(6).toString('hex')}`, now),
      code: cleanCode(code),
      severity: normalizedSeverity,
      weight: severityWeight[normalizedSeverity],
      source: cleanIdentifier(source, 'unknown'),
      category: cleanIdentifier(category, 'security'),
      metadata: sanitizeMetadata(metadata),
      fingerprint: sha256Json({ code: cleanCode(code), source: cleanIdentifier(source, 'unknown'), category }),
      observedAt: now
    };
    const duplicate = this.state.recentSignals.find((candidate) => (
      candidate.fingerprint === signal.fingerprint
      && Date.parse(now) - Date.parse(candidate.observedAt) < this.signalDedupMs
    ));
    if (duplicate && !force) {
      return {
        accepted: false,
        deduplicated: true,
        signal: publicSignal(duplicate),
        trust: this.publicStatus()
      };
    }

    this.state.recentSignals.unshift(signal);
    this.state.recentSignals = this.state.recentSignals.slice(0, 100);
    this.state.reasonCodes = unique([signal.code, ...this.state.reasonCodes]).slice(0, 20);
    this.recalculateRisk(now);
    const highCount = this.activeSignals(now).filter((item) => (
      item.severity === RuntimeTrustSeverity.HIGH || item.severity === RuntimeTrustSeverity.CRITICAL
    )).length;
    const shouldLock = normalizedSeverity === RuntimeTrustSeverity.CRITICAL
      || this.state.riskScore >= this.lockdownThreshold
      || highCount >= this.highSignalLockCount;
    if (shouldLock) {
      this.transitionToLockdown({
        reasonCode: signal.code,
        source: signal.source,
        triggerSignalId: signal.signalId,
        manual: false
      });
    } else if (this.state.riskScore >= this.guardedThreshold) {
      this.transitionMode(RuntimeTrustMode.GUARDED, {
        reasonCode: signal.code,
        source: signal.source
      });
    } else {
      this.persistState('signal-recorded');
    }
    this.writeAudit('trust.signal.recorded', {
      signalId: signal.signalId,
      code: signal.code,
      severity: signal.severity,
      source: signal.source,
      category: signal.category,
      metadata: signal.metadata,
      resultingMode: this.state.mode,
      riskScore: this.state.riskScore,
      stateHash: this.state.stateHash
    });
    return {
      accepted: true,
      deduplicated: false,
      signal: publicSignal(signal),
      trust: this.publicStatus()
    };
  }

  engageLockdown({ reason = 'operator-emergency-lockdown', requestedBy = 'local-admin' } = {}) {
    this.syncFromDisk();
    const now = this.clock().toISOString();
    const signal = {
      signalVersion: 'a-runtime-trust-signal-v1',
      signalId: stableId('trust_signal', `manual:${reason}:${randomBytes(6).toString('hex')}`, now),
      code: 'A_TRUST_MANUAL_LOCKDOWN',
      severity: RuntimeTrustSeverity.CRITICAL,
      weight: severityWeight.critical,
      source: cleanIdentifier(requestedBy, 'local-admin'),
      category: 'operator-control',
      metadata: sanitizeMetadata({ reason }),
      fingerprint: sha256Json({ code: 'A_TRUST_MANUAL_LOCKDOWN', requestedBy }),
      observedAt: now
    };
    this.state.recentSignals.unshift(signal);
    this.state.reasonCodes = unique([signal.code, ...this.state.reasonCodes]).slice(0, 20);
    this.state.riskScore = 100;
    this.transitionToLockdown({
      reasonCode: signal.code,
      source: signal.source,
      triggerSignalId: signal.signalId,
      manual: true
    });
    this.writeAudit('trust.lockdown.manual', {
      requestedBy: signal.source,
      reasonHash: sha256(String(reason)),
      incidentId: this.state.activeIncident?.incidentId,
      stateHash: this.state.stateHash
    });
    return { success: true, trust: this.publicStatus() };
  }

  createRecoveryChallenge({ requestedBy = 'local-admin' } = {}) {
    this.syncFromDisk();
    if (this.state.mode !== RuntimeTrustMode.LOCKDOWN) {
      return failure('A_TRUST_RECOVERY_NOT_REQUIRED', 'Runtime trust lockdown is not active.');
    }
    const now = this.clock().toISOString();
    const challenge = randomBytes(32).toString('base64url');
    const challengeId = stableId('trust_recovery', this.state.activeIncident?.incidentId ?? 'incident', now);
    this.state.recoveryChallenge = {
      challengeId,
      challengeHash: sha256(challenge),
      requestedBy: cleanIdentifier(requestedBy, 'local-admin'),
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + this.challengeTtlMs).toISOString(),
      attempts: 0
    };
    this.persistState('recovery-challenge-created');
    this.writeAudit('trust.recovery.challenge_created', {
      challengeId,
      requestedBy: this.state.recoveryChallenge.requestedBy,
      expiresAt: this.state.recoveryChallenge.expiresAt,
      incidentId: this.state.activeIncident?.incidentId,
      stateHash: this.state.stateHash
    });
    return {
      success: true,
      challengeVersion: 'a-runtime-trust-recovery-challenge-v1',
      challengeId,
      challenge,
      expiresAt: this.state.recoveryChallenge.expiresAt,
      requiredChecks: [...this.recoveryProbes.keys()].sort(),
      rawChallengeStored: false
    };
  }

  quarantineInvalidAuditJournal({ challenge, requestedBy = 'local-admin', reason = 'invalid-audit-journal' } = {}) {
    this.syncFromDisk();
    if (this.state.mode !== RuntimeTrustMode.LOCKDOWN) {
      return failure('A_TRUST_AUDIT_QUARANTINE_LOCKDOWN_REQUIRED', 'Audit quarantine is available only during runtime trust lockdown.');
    }
    const challengeRecord = this.state.recoveryChallenge;
    if (!challengeRecord || !this.challengeActive()) {
      return failure('A_TRUST_RECOVERY_CHALLENGE_REQUIRED', 'A current recovery challenge is required.');
    }
    challengeRecord.attempts += 1;
    this.persistState('audit-quarantine-challenge-attempted');
    if (!secureHashEqual(challengeRecord.challengeHash, sha256(challenge ?? ''))) {
      this.recordSignal({
        code: 'A_TRUST_RECOVERY_CHALLENGE_INVALID',
        severity: RuntimeTrustSeverity.HIGH,
        source: requestedBy,
        category: 'recovery',
        metadata: { challengeId: challengeRecord.challengeId, operation: 'audit-quarantine' },
        force: true
      });
      return failure('A_TRUST_RECOVERY_CHALLENGE_INVALID', 'Recovery challenge verification failed.');
    }
    const stateIntegrity = this.verifyStateFile();
    if (!stateIntegrity.valid) {
      return failure('A_TRUST_STATE_INTEGRITY_REQUIRED', 'The signed runtime trust state must be intact before audit quarantine.');
    }
    const journalIntegrity = this.verifyAuditJournal();
    if (journalIntegrity.valid) {
      return failure('A_TRUST_AUDIT_QUARANTINE_NOT_REQUIRED', 'The runtime trust audit journal is already valid.');
    }
    if (!this.auditPath || !existsSync(this.auditPath)) {
      return failure('A_TRUST_AUDIT_JOURNAL_UNAVAILABLE', 'The invalid audit journal is unavailable for forensic quarantine.');
    }

    const now = this.clock().toISOString();
    const rawJournal = readFileSync(this.auditPath);
    const originalJournalHash = sha256(rawJournal);
    const quarantinePath = `${this.auditPath}.quarantine-${Date.parse(now)}-${originalJournalHash.slice(0, 12)}.jsonl`;
    const manifestPath = `${quarantinePath}.manifest.json`;
    renameSync(this.auditPath, quarantinePath);

    const manifestPayload = {
      manifestVersion: 'a-runtime-trust-audit-quarantine-manifest-v1',
      actorId: this.actorId,
      generatedAt: now,
      originalAuditFile: basename(this.auditPath),
      quarantineFile: basename(quarantinePath),
      originalJournalHash,
      originalJournalBytes: rawJournal.length,
      verificationFailure: sanitizeMetadata(journalIntegrity),
      requestedBy: cleanIdentifier(requestedBy, 'local-admin'),
      reasonHash: sha256(String(reason)),
      signingKeyId: this.keyProvider.keyId,
      stateHash: this.state.stateHash,
      originalJournalPreserved: true,
      rawSecurityMaterialStored: false
    };
    const manifestHash = sha256Json(manifestPayload);
    const manifest = {
      ...manifestPayload,
      manifestHash,
      signatureAlgorithm: 'HMAC-SHA256',
      signature: signHash(manifestHash, this.signingSecret)
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    this.auditLog = new JsonlAuditLog({
      filePath: this.auditPath,
      clock: this.clock,
      signingSecret: this.signingSecret,
      loadExisting: true,
      maxEntries: 20_000
    });
    this.state.recoveryChallenge = null;
    this.persistState('invalid-audit-journal-quarantined');
    this.writeAudit('trust.audit_journal.quarantined', {
      originalJournalHash,
      originalJournalBytes: rawJournal.length,
      quarantineFile: basename(quarantinePath),
      manifestFile: basename(manifestPath),
      manifestHash,
      requestedBy: manifestPayload.requestedBy,
      reasonHash: manifestPayload.reasonHash,
      priorFailureReason: journalIntegrity.reason ?? 'unknown',
      stateHash: this.state.stateHash
    });
    const replacementIntegrity = this.verifyAuditJournal();
    return {
      success: replacementIntegrity.valid,
      quarantineVersion: 'a-runtime-trust-audit-quarantine-v1',
      originalJournalHash,
      originalJournalBytes: rawJournal.length,
      quarantineFile: basename(quarantinePath),
      manifestFile: basename(manifestPath),
      manifestHash,
      originalJournalPreserved: true,
      replacementIntegrity,
      challengeConsumed: true,
      recoveryChallengeRequired: true,
      trust: this.publicStatus()
    };
  }

  recover({ challenge, recoveredBy = 'local-admin', reason = 'verified-recovery' } = {}) {
    this.syncFromDisk();
    if (this.state.mode !== RuntimeTrustMode.LOCKDOWN) {
      return failure('A_TRUST_RECOVERY_NOT_REQUIRED', 'Runtime trust lockdown is not active.');
    }
    const challengeRecord = this.state.recoveryChallenge;
    if (!challengeRecord || !this.challengeActive()) {
      return failure('A_TRUST_RECOVERY_CHALLENGE_REQUIRED', 'A current recovery challenge is required.');
    }
    challengeRecord.attempts += 1;
    this.persistState('recovery-challenge-attempted');
    if (!secureHashEqual(challengeRecord.challengeHash, sha256(challenge ?? ''))) {
      this.recordSignal({
        code: 'A_TRUST_RECOVERY_CHALLENGE_INVALID',
        severity: RuntimeTrustSeverity.HIGH,
        source: recoveredBy,
        category: 'recovery',
        metadata: { challengeId: challengeRecord.challengeId },
        force: true
      });
      return failure('A_TRUST_RECOVERY_CHALLENGE_INVALID', 'Recovery challenge verification failed.');
    }
    const checks = this.runRecoveryChecks();
    if (!checks.passed) {
      this.persistState('recovery-integrity-blocked');
      this.writeAudit('trust.recovery.blocked', {
        challengeId: challengeRecord.challengeId,
        failedChecks: checks.items.filter((item) => !item.passed).map((item) => item.checkId),
        incidentId: this.state.activeIncident?.incidentId,
        stateHash: this.state.stateHash
      });
      return {
        ...failure('A_TRUST_RECOVERY_CHECKS_FAILED', 'Runtime integrity checks must pass before recovery.'),
        checks
      };
    }
    const recoveredAt = this.clock().toISOString();
    const incident = this.state.activeIncident;
    this.state.mode = RuntimeTrustMode.TRUSTED;
    this.state.riskScore = 0;
    this.state.reasonCodes = [];
    this.state.recentSignals = [];
    this.state.activeIncident = incident ? {
      ...incident,
      status: 'recovered',
      recoveredAt,
      recoveredBy: cleanIdentifier(recoveredBy, 'local-admin'),
      recoveryReasonHash: sha256(String(reason))
    } : null;
    this.state.recoveryChallenge = null;
    this.state.lastTransitionAt = recoveredAt;
    this.persistState('verified-recovery');
    this.writeAudit('trust.recovery.completed', {
      incidentId: incident?.incidentId ?? null,
      recoveredBy: cleanIdentifier(recoveredBy, 'local-admin'),
      recoveryReasonHash: sha256(String(reason)),
      checks: checks.items.map((item) => ({ checkId: item.checkId, passed: item.passed })),
      stateHash: this.state.stateHash
    });
    this.invokeHandlers(this.recoveryHandlers, {
      incidentId: incident?.incidentId ?? null,
      recoveredAt,
      recoveredBy: cleanIdentifier(recoveredBy, 'local-admin')
    });
    this.lastObservedMode = RuntimeTrustMode.TRUSTED;
    return { success: true, checks, trust: this.publicStatus() };
  }

  registerLockdownHandler(handler) {
    if (typeof handler === 'function') {
      this.lockdownHandlers.push(handler);
      if (this.state.mode === RuntimeTrustMode.LOCKDOWN) {
        this.invokeHandlers([handler], this.state.activeIncident);
      }
    }
    return this;
  }

  registerRecoveryHandler(handler) {
    if (typeof handler === 'function') this.recoveryHandlers.push(handler);
    return this;
  }

  registerRecoveryProbe(checkId, probe) {
    if (checkId && typeof probe === 'function') this.recoveryProbes.set(cleanIdentifier(checkId, 'probe'), probe);
    return this;
  }

  runRecoveryChecks() {
    const items = [];
    const stateIntegrity = this.verifyStateFile();
    items.push({ checkId: 'trust-state-signature', passed: stateIntegrity.valid, detail: safeDetail(stateIntegrity) });
    const auditIntegrity = this.verifyAuditJournal();
    items.push({ checkId: 'trust-audit-chain', passed: auditIntegrity.valid, detail: safeDetail(auditIntegrity) });
    for (const [checkId, probe] of this.recoveryProbes.entries()) {
      try {
        const result = probe();
        const passed = result === true
          || result?.valid === true
          || result?.passed === true
          || ['passed', 'valid', 'ready', 'ok'].includes(result?.status);
        items.push({ checkId, passed, detail: safeDetail(result) });
      } catch (error) {
        items.push({ checkId, passed: false, detail: { errorCode: error.code ?? 'TRUST_RECOVERY_PROBE_FAILED' } });
      }
    }
    return {
      checksVersion: 'a-runtime-trust-recovery-checks-v1',
      passed: items.every((item) => item.passed),
      checkedAt: this.clock().toISOString(),
      items
    };
  }

  productGate() {
    const isolated = new RuntimeTrustKernel({
      actorId: 'product-gate',
      clock: this.clock,
      signingSecret: `${this.signingSecret}:product-gate`,
      testMode: true,
      riskWindowMs: this.riskWindowMs,
      guardedThreshold: this.guardedThreshold,
      lockdownThreshold: this.lockdownThreshold,
      highSignalLockCount: this.highSignalLockCount
    });
    isolated.registerRecoveryProbe('synthetic-integrity', () => ({ valid: true }));
    const baseline = isolated.publicStatus();
    const guarded = isolated.recordSignal({
      code: 'E_TOOL_OUTPUT_PROVENANCE_TAINTED',
      severity: RuntimeTrustSeverity.HIGH,
      source: 'product-gate',
      metadata: { rawContentStored: false }
    }).trust;
    const guardedExternal = isolated.authorizeExecution({
      action: { actionType: ActionType.SEND_EMAIL, toolName: 'email.send', capability: { externalTransfer: true } },
      source: 'product-gate'
    });
    isolated.recordSignal({
      code: 'E_CAPABILITY_TOKEN_SIGNATURE_INVALID',
      severity: RuntimeTrustSeverity.CRITICAL,
      source: 'product-gate',
      metadata: { rawTokenStored: false }
    });
    const lockdown = isolated.publicStatus();
    const lockdownMutation = isolated.authorizeExecution({
      action: { actionType: ActionType.CREATE_FILE, toolName: 'filesystem.createTextFile' },
      source: 'product-gate'
    });
    const lockdownRead = isolated.authorizeExecution({
      action: { actionType: ActionType.LIST_FILES, toolName: 'filesystem.listFiles' },
      source: 'product-gate'
    });
    const challenge = isolated.createRecoveryChallenge({ requestedBy: 'product-gate' });
    const recovered = isolated.recover({
      challenge: challenge.challenge,
      recoveredBy: 'product-gate',
      reason: 'synthetic-verified-recovery'
    });
    const checks = [
      { checkId: 'trusted_baseline_ready', passed: baseline.mode === RuntimeTrustMode.TRUSTED },
      { checkId: 'high_signal_enters_guarded_mode', passed: guarded.mode === RuntimeTrustMode.GUARDED },
      { checkId: 'guarded_external_action_blocked', passed: guardedExternal.allowed === false },
      { checkId: 'critical_signal_enters_lockdown', passed: lockdown.mode === RuntimeTrustMode.LOCKDOWN },
      { checkId: 'lockdown_mutation_blocked', passed: lockdownMutation.allowed === false },
      { checkId: 'lockdown_read_only_available', passed: lockdownRead.allowed === true },
      { checkId: 'challenge_based_recovery_passed', passed: recovered.success === true && recovered.trust?.mode === RuntimeTrustMode.TRUSTED },
      { checkId: 'raw_security_material_absent', passed: JSON.stringify({ baseline, guarded, lockdown }).includes(this.signingSecret) === false }
    ];
    return {
      productGateVersion: 'a-runtime-trust-kernel-product-gate-v1',
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      evidence: {
        baselineMode: baseline.mode,
        guardedMode: guarded.mode,
        lockdownMode: lockdown.mode,
        recoveredMode: recovered.trust?.mode ?? null,
        mutatingExecutionBlocked: lockdownMutation.allowed === false,
        readOnlyDiagnosticsPreserved: lockdownRead.allowed === true,
        rawSecurityMaterialStored: false
      }
    };
  }

  verifyStartupIntegrity() {
    const stateIntegrity = this.verifyState(this.state);
    const auditIntegrity = this.verifyAuditJournal();
    if (!stateIntegrity.valid || !auditIntegrity.valid) {
      const reasonCode = !stateIntegrity.valid
        ? 'A_TRUST_STATE_SIGNATURE_INVALID'
        : 'A_TRUST_AUDIT_CHAIN_INVALID';
      this.preserveIncidentArtifact(reasonCode);
      this.state = createInitialState(this.clock);
      this.state.recentSignals = [];
      this.state.reasonCodes = [reasonCode];
      this.state.riskScore = 100;
      this.transitionToLockdown({
        reasonCode,
        source: 'startup-integrity-check',
        triggerSignalId: null,
        manual: false
      });
    }
  }

  loadOrCreateState() {
    if (!this.statePath || !existsSync(this.statePath)) {
      const initial = createInitialState(this.clock);
      this.state = initial;
      this.persistState('initialization');
      return this.state;
    }
    try {
      const loaded = JSON.parse(readFileSync(this.statePath, 'utf8'));
      const verified = this.verifyState(loaded);
      if (!verified.valid) return loaded;
      return normalizeLoadedState(loaded, this.clock);
    } catch (error) {
      return {
        ...createInitialState(this.clock),
        signature: 'invalid',
        loadErrorCode: error.code ?? 'A_TRUST_STATE_PARSE_FAILED'
      };
    }
  }

  syncFromDisk() {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const loaded = JSON.parse(readFileSync(this.statePath, 'utf8'));
      const verified = this.verifyState(loaded);
      if (!verified.valid) {
        if (this.state.mode !== RuntimeTrustMode.LOCKDOWN) {
          this.state = createInitialState(this.clock);
          this.state.riskScore = 100;
          this.state.reasonCodes = ['A_TRUST_STATE_SIGNATURE_INVALID'];
          this.transitionToLockdown({
            reasonCode: 'A_TRUST_STATE_SIGNATURE_INVALID',
            source: 'runtime-state-sync',
            triggerSignalId: null,
            manual: false
          });
        }
        return;
      }
      const next = normalizeLoadedState(loaded, this.clock);
      const changedToLockdown = this.state.mode !== RuntimeTrustMode.LOCKDOWN
        && next.mode === RuntimeTrustMode.LOCKDOWN;
      this.state = next;
      if (changedToLockdown || (this.lastObservedMode !== RuntimeTrustMode.LOCKDOWN && next.mode === RuntimeTrustMode.LOCKDOWN)) {
        this.invokeHandlers(this.lockdownHandlers, next.activeIncident);
      }
      this.lastObservedMode = next.mode;
    } catch {
      if (this.state.mode !== RuntimeTrustMode.LOCKDOWN) {
        this.state.riskScore = 100;
        this.state.reasonCodes = unique(['A_TRUST_STATE_PARSE_FAILED', ...this.state.reasonCodes]);
        this.transitionToLockdown({
          reasonCode: 'A_TRUST_STATE_PARSE_FAILED',
          source: 'runtime-state-sync',
          triggerSignalId: null,
          manual: false
        });
      }
    }
  }

  refreshRiskState() {
    if (this.state.mode === RuntimeTrustMode.LOCKDOWN) return;
    const previousMode = this.state.mode;
    this.recalculateRisk();
    const nextMode = this.state.riskScore >= this.guardedThreshold
      ? RuntimeTrustMode.GUARDED
      : RuntimeTrustMode.TRUSTED;
    if (nextMode !== previousMode) this.transitionMode(nextMode, { reasonCode: 'A_TRUST_RISK_WINDOW_UPDATED', source: 'risk-window' });
  }

  recalculateRisk(now = this.clock().toISOString()) {
    const active = this.activeSignals(now);
    this.state.riskScore = Math.min(100, active.reduce((sum, signal) => sum + (severityWeight[signal.severity] ?? 0), 0));
    return this.state.riskScore;
  }

  activeSignals(now = this.clock().toISOString()) {
    const nowMs = Date.parse(now);
    return this.state.recentSignals.filter((signal) => nowMs - Date.parse(signal.observedAt) <= this.riskWindowMs);
  }

  transitionToLockdown({ reasonCode, source, triggerSignalId, manual }) {
    const now = this.clock().toISOString();
    const wasLocked = this.state.mode === RuntimeTrustMode.LOCKDOWN;
    this.state.mode = RuntimeTrustMode.LOCKDOWN;
    this.state.riskScore = 100;
    this.state.lastTransitionAt = now;
    this.state.reasonCodes = unique([cleanCode(reasonCode), ...this.state.reasonCodes]).slice(0, 20);
    this.state.recoveryChallenge = null;
    if (!wasLocked) {
      this.state.activeIncident = {
        incidentVersion: 'a-runtime-trust-incident-v1',
        incidentId: stableId('trust_incident', `${reasonCode}:${randomBytes(10).toString('hex')}`, now),
        status: 'active',
        reasonCode: cleanCode(reasonCode),
        source: cleanIdentifier(source, 'unknown'),
        triggerSignalId,
        manual: manual === true,
        engagedAt: now,
        recoveredAt: null
      };
    }
    this.persistState('lockdown-transition');
    this.writeAudit('trust.lockdown.engaged', {
      incidentId: this.state.activeIncident?.incidentId,
      reasonCode: cleanCode(reasonCode),
      source: cleanIdentifier(source, 'unknown'),
      triggerSignalId,
      manual: manual === true,
      stateHash: this.state.stateHash
    });
    if (!wasLocked) this.invokeHandlers(this.lockdownHandlers, this.state.activeIncident);
    this.lastObservedMode = RuntimeTrustMode.LOCKDOWN;
  }

  transitionMode(mode, { reasonCode, source }) {
    if (this.state.mode === RuntimeTrustMode.LOCKDOWN && mode !== RuntimeTrustMode.LOCKDOWN) return;
    const previousMode = this.state.mode;
    this.state.mode = mode;
    this.state.lastTransitionAt = this.clock().toISOString();
    this.persistState('mode-transition');
    if (previousMode !== mode) {
      this.writeAudit('trust.mode.transitioned', {
        previousMode,
        mode,
        reasonCode: cleanCode(reasonCode),
        source: cleanIdentifier(source, 'unknown'),
        riskScore: this.state.riskScore,
        stateHash: this.state.stateHash
      });
    }
    this.lastObservedMode = mode;
  }

  persistState(reason) {
    const now = this.clock().toISOString();
    const previousStateHash = this.state.stateHash ?? 'GENESIS';
    const unsigned = {
      ...this.state,
      stateSchemaVersion: 'a-runtime-trust-state-v1',
      stateVersion: Number(this.state.stateVersion ?? 0) + 1,
      actorId: this.actorId,
      updatedAt: now,
      updateReason: cleanIdentifier(reason, 'state-update'),
      previousStateHash
    };
    delete unsigned.signature;
    delete unsigned.stateHash;
    const stateHash = sha256Json(unsigned);
    const signed = {
      ...unsigned,
      stateHash,
      signature: signHash(stateHash, this.signingSecret),
      signatureAlgorithm: 'HMAC-SHA256'
    };
    this.state = signed;
    if (this.statePath) {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tempPath = `${this.statePath}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
      writeFileSync(tempPath, `${JSON.stringify(signed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      replaceFile(tempPath, this.statePath);
    }
    return signed;
  }

  verifyState(state) {
    if (!state || state.stateSchemaVersion !== 'a-runtime-trust-state-v1') {
      return { valid: false, reason: 'state-schema-invalid' };
    }
    const { signature, stateHash, ...unsigned } = state;
    const expectedHash = sha256Json(unsigned);
    if (!secureHashEqual(expectedHash, stateHash)) return { valid: false, reason: 'state-hash-mismatch' };
    const expectedSignature = signHash(expectedHash, this.signingSecret);
    if (!secureTextEqual(expectedSignature, signature)) return { valid: false, reason: 'state-signature-mismatch' };
    return { valid: true, stateHash, stateVersion: state.stateVersion };
  }

  verifyStateFile() {
    if (!this.statePath) return this.verifyState(this.state);
    try {
      return this.verifyState(JSON.parse(readFileSync(this.statePath, 'utf8')));
    } catch (error) {
      return { valid: false, reason: 'state-file-unreadable', errorCode: error.code ?? null };
    }
  }

  verifyAuditJournal() {
    return verifySignedAuditLog(this.auditLog, this.signingSecret);
  }

  verifyPeerAuditJournal({ auditPath, actorId = 'peer-runtime' } = {}) {
    if (!auditPath) return { valid: false, reason: 'peer-audit-path-missing', actorId };
    const resolvedPath = resolve(auditPath);
    if (!existsSync(resolvedPath)) {
      return { valid: false, reason: 'peer-audit-journal-missing', actorId, auditFile: basename(resolvedPath) };
    }
    try {
      const auditLog = new JsonlAuditLog({
        filePath: resolvedPath,
        clock: this.clock,
        signingSecret: this.signingSecret,
        loadExisting: true,
        maxEntries: 20_000
      });
      return {
        ...verifySignedAuditLog(auditLog, this.signingSecret),
        actorId: cleanIdentifier(actorId, 'peer-runtime'),
        auditFile: basename(resolvedPath)
      };
    } catch (error) {
      return {
        valid: false,
        reason: 'peer-audit-journal-unreadable',
        actorId: cleanIdentifier(actorId, 'peer-runtime'),
        auditFile: basename(resolvedPath),
        errorCode: error.code ?? null
      };
    }
  }

  writeAudit(event, payload = {}) {
    const trustPayloadHash = sha256Json({ event, actorId: this.actorId, payload: sanitizeMetadata(payload) });
    return this.auditLog.write(event, {
      actorId: this.actorId,
      ...sanitizeMetadata(payload),
      trustPayloadHash,
      trustSignature: signHash(trustPayloadHash, this.signingSecret),
      rawSecurityMaterialStored: false
    });
  }

  challengeActive(now = this.clock().toISOString()) {
    const challenge = this.state.recoveryChallenge;
    return Boolean(challenge && Date.parse(challenge.expiresAt) > Date.parse(now) && challenge.attempts < 5);
  }

  preserveIncidentArtifact(reasonCode) {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const target = `${this.statePath}.incident-${Date.parse(this.clock().toISOString())}-${cleanIdentifier(reasonCode, 'integrity')}.json`;
      writeFileSync(target, readFileSync(this.statePath));
    } catch {
      // Lockdown still proceeds even if evidence preservation is unavailable.
    }
  }

  invokeHandlers(handlers, payload) {
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (error) {
        this.writeAudit('trust.lifecycle.handler_failed', {
          errorCode: error.code ?? 'A_TRUST_HANDLER_FAILED',
          mode: this.state.mode
        });
      }
    }
  }
}

function createInitialState(clock) {
  const now = clock().toISOString();
  return {
    stateSchemaVersion: 'a-runtime-trust-state-v1',
    stateVersion: 0,
    actorId: null,
    mode: RuntimeTrustMode.TRUSTED,
    riskScore: 0,
    reasonCodes: [],
    recentSignals: [],
    localJournalHeads: {},
    activeIncident: null,
    recoveryChallenge: null,
    createdAt: now,
    updatedAt: now,
    lastTransitionAt: now,
    updateReason: 'initialization',
    previousStateHash: 'GENESIS',
    stateHash: null,
    signature: null,
    signatureAlgorithm: 'HMAC-SHA256'
  };
}

function normalizeLoadedState(state, clock) {
  return {
    ...createInitialState(clock),
    ...state,
    reasonCodes: Array.isArray(state.reasonCodes) ? state.reasonCodes : [],
    recentSignals: Array.isArray(state.recentSignals) ? state.recentSignals : []
  };
}

function resolveTrustKey({ signingSecret, keyPath, testMode }) {
  if (signingSecret) {
    return keyResult(signingSecret, 'injected-secret', false, false, false);
  }
  if (process.env.JARVIS_TRUST_KERNEL_SECRET) {
    return keyResult(process.env.JARVIS_TRUST_KERNEL_SECRET, 'env-os-secret-store', false, false, false);
  }
  if (testMode) {
    if (!keyPath) return keyResult(randomBytes(32), 'ephemeral-process-key', false, false, true);
    if (process.env.JARVIS_TEST_TRUST_SECRET) {
      const derived = createHmac('sha256', process.env.JARVIS_TEST_TRUST_SECRET)
        .update(`jarvis-test-trust:${keyPath}`)
        .digest();
      return keyResult(derived, 'test-derived-path-key', false, false, true);
    }
    let secret = testTrustKeysByPath.get(keyPath);
    if (!secret) {
      secret = randomBytes(32);
      testTrustKeysByPath.set(keyPath, secret);
    }
    return keyResult(secret, 'test-ephemeral-path-key', false, false, true);
  }
  if (!keyPath) {
    return keyResult(randomBytes(32), 'ephemeral-process-key', false, false, true);
  }
  mkdirSync(dirname(keyPath), { recursive: true });
  if (existsSync(keyPath)) return readTrustKeyFile(keyPath);
  const secret = randomBytes(32);
  const record = protectTrustKey(secret);
  try {
    writeFileSync(keyPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return keyResult(secret, record.provider, record.protectedByOs, true, record.fallback, record.rawKeyStored === true);
  } catch (error) {
    if (error.code === 'EEXIST') return readTrustKeyFile(keyPath);
    throw error;
  }
}

function protectTrustKey(secret) {
  if (process.platform === 'win32') {
    try {
      return {
        keyRecordVersion: 'a-runtime-trust-key-v1',
        provider: 'windows-dpapi-current-user',
        protectedByOs: true,
        fallback: false,
        protectedKey: runDpapi(secret.toString('base64'), 'Protect'),
        rawKeyStored: false
      };
    } catch {
      // A permission-restricted local key is the explicit fallback.
    }
  }
  return {
    keyRecordVersion: 'a-runtime-trust-key-v1',
    provider: 'permission-restricted-file',
    protectedByOs: false,
    fallback: true,
    encodedKey: secret.toString('base64'),
    rawKeyStored: true
  };
}

function readTrustKeyFile(keyPath) {
  const record = JSON.parse(readFileSync(keyPath, 'utf8'));
  if (record.keyRecordVersion !== 'a-runtime-trust-key-v1') throw new Error('Unsupported runtime trust key record.');
  if (record.provider === 'windows-dpapi-current-user') {
    const decoded = Buffer.from(runDpapi(record.protectedKey, 'Unprotect'), 'base64');
    return keyResult(decoded, record.provider, true, true, false, false);
  }
  if (record.encodedKey) {
    return keyResult(Buffer.from(record.encodedKey, 'base64'), record.provider, false, true, true, true);
  }
  throw new Error('Runtime trust key material is unavailable.');
}

function runDpapi(inputBase64, mode) {
  const method = mode === 'Protect' ? 'Protect' : 'Unprotect';
  const command = [
    'Add-Type -AssemblyName System.Security;',
    '$bytes=[Convert]::FromBase64String($env:JARVIS_TRUST_DPAPI_INPUT);',
    '$scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser;',
    `$out=[System.Security.Cryptography.ProtectedData]::${method}($bytes,$null,$scope);`,
    '[Convert]::ToBase64String($out)'
  ].join(' ');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    // Windows PowerShell/DPAPI cold starts can exceed 8s on a busy desktop.
    // Match the bounded product secret-store operation budget; never replace an unreadable key.
    timeout: 20_000,
    env: { ...process.env, JARVIS_TRUST_DPAPI_INPUT: inputBase64 }
  }).trim();
}

function keyResult(secret, provider, protectedByOs, persistent, fallback, rawKeyStored = false) {
  const value = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
  return {
    secret: value,
    status: {
      provider,
      protectedByOs,
      persistent,
      fallback,
      keyId: `trust_key_${sha256(value).slice(0, 20)}`,
      rawKeyStored
    }
  };
}

function isReadOnlyAction(action) {
  if (action.readOnly === true || action.capability?.writesLocalFiles === false) return true;
  if (readOnlyActionTypes.has(action.actionType)) return true;
  return ['filesystem.listFiles', 'filesystem.searchFiles', 'browser.search', 'capability.describe'].includes(action.toolName);
}

function publicSignal(signal) {
  return {
    signalVersion: signal.signalVersion,
    signalId: signal.signalId,
    code: signal.code,
    severity: signal.severity,
    source: signal.source,
    category: signal.category,
    metadata: signal.metadata,
    observedAt: signal.observedAt
  };
}

function publicIncident(incident, now) {
  if (!incident) return null;
  return {
    incidentVersion: incident.incidentVersion,
    incidentId: incident.incidentId,
    status: incident.status,
    reasonCode: incident.reasonCode,
    source: incident.source,
    manual: incident.manual,
    engagedAt: incident.engagedAt,
    recoveredAt: incident.recoveredAt ?? null,
    activeForMs: incident.status === 'active'
      ? Math.max(0, Date.parse(now) - Date.parse(incident.engagedAt))
      : null
  };
}

function sanitizeMetadata(value, depth = 0) {
  if (depth > 4) return '[depth-limited]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/token|secret|password|authorization|cookie|credential|content|command|prompt/i.test(value)) {
      return { valueHash: sha256(value), redacted: true };
    }
    return value.slice(0, 160);
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeMetadata(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => {
      if (/token|secret|password|authorization|cookie|credential|content|command|prompt|path/i.test(key)) {
        return [`${key}Hash`, sha256(typeof item === 'string' ? item : JSON.stringify(item ?? null))];
      }
      return [key, sanitizeMetadata(item, depth + 1)];
    }));
  }
  return String(value).slice(0, 160);
}

function safeDetail(value) {
  if (value === true) return { status: 'passed' };
  if (!value || typeof value !== 'object') return { status: String(value ?? 'unavailable').slice(0, 80) };
  const allowed = ['valid', 'passed', 'status', 'reason', 'entries', 'headHash', 'sequence', 'errorCode'];
  return Object.fromEntries(allowed.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function replaceFile(tempPath, targetPath) {
  try {
    renameSync(tempPath, targetPath);
  } catch (error) {
    if (process.platform !== 'win32' || !existsSync(targetPath)) throw error;
    writeFileSync(targetPath, readFileSync(tempPath), { mode: 0o600 });
    rmSync(tempPath, { force: true });
  }
}

function signHash(hash, secret) {
  return createHmac('sha256', secret).update(String(hash)).digest('base64url');
}

function verifySignedAuditLog(auditLog, signingSecret) {
  const chain = auditLog.verifyChain();
  if (!chain.valid) return chain;
  for (const entry of auditLog.entries) {
    if (!entry.trustSignature || !entry.trustPayloadHash) {
      return { valid: false, reason: 'trust-entry-signature-missing', sequence: entry.sequence };
    }
    if (!secureTextEqual(signHash(entry.trustPayloadHash, signingSecret), entry.trustSignature)) {
      return { valid: false, reason: 'trust-entry-signature-invalid', sequence: entry.sequence };
    }
  }
  return chain;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Json(value) {
  return sha256(canonicalJson(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function secureHashEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''), 'hex');
  const rightBuffer = Buffer.from(String(right ?? ''), 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function secureTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuffer = Buffer.from(String(right ?? ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cleanIdentifier(value, fallback) {
  const normalized = String(value ?? fallback).trim().replace(/[^a-zA-Z0-9_.:-]+/g, '-').slice(0, 120);
  return normalized || fallback;
}

function cleanCode(value) {
  return cleanIdentifier(value, 'A_TRUST_UNKNOWN_SIGNAL').toUpperCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function failure(code, message) {
  return { success: false, error: { code, message } };
}
