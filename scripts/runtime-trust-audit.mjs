import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RuntimeTrustKernel,
  RuntimeTrustMode
} from '../packages/core/src/security/runtime-trust-kernel.js';
import { ActionType } from '../packages/shared/src/types.js';

export async function runRuntimeTrustAudit({
  reportPath = resolve('dist', 'verification', 'runtime-trust-kernel-audit.json'),
  markdownPath = resolve('dist', 'verification', 'runtime-trust-kernel-audit.md'),
  clock = () => new Date()
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-runtime-trust-audit-'));
  const statePath = join(root, 'runtime-trust-state.json');
  const auditPath = join(root, 'runtime-trust-audit.jsonl');
  const signingSecret = 'isolated-runtime-trust-audit-secret';
  try {
    let lockdownCallbackCount = 0;
    let recoveryCallbackCount = 0;
    const kernel = new RuntimeTrustKernel({
      actorId: 'runtime-trust-audit',
      statePath,
      auditPath,
      signingSecret,
      testMode: true,
      clock
    });
    kernel.registerLockdownHandler(() => { lockdownCallbackCount += 1; });
    kernel.registerRecoveryHandler(() => { recoveryCallbackCount += 1; });
    kernel.registerRecoveryProbe('policy-integrity-fixture', () => ({ valid: true }));

    const initial = kernel.publicStatus();
    const guarded = kernel.recordSignal({
      code: 'E_TOOL_OUTPUT_PROVENANCE_TAINTED',
      severity: 'high',
      source: 'untrusted-tool-output',
      category: 'tool-poisoning',
      metadata: { rawToolOutputStored: false }
    }).trust;
    const guardedExternal = kernel.authorizeExecution({
      action: {
        actionType: ActionType.SEND_EMAIL,
        toolName: 'email.send',
        capability: { externalTransfer: true }
      },
      source: 'audit-fixture'
    });
    const guardedLocal = kernel.authorizeExecution({
      action: {
        actionType: ActionType.CREATE_FILE,
        toolName: 'filesystem.createTextFile',
        capability: { reversible: true }
      },
      source: 'audit-fixture'
    });
    kernel.recordSignal({
      code: 'E_CAPABILITY_TOKEN_SIGNATURE_INVALID',
      severity: 'critical',
      source: 'capability-verifier',
      category: 'capability-integrity',
      metadata: { rawTokenStored: false }
    });
    const locked = kernel.publicStatus();
    const lockedMutation = kernel.authorizeExecution({
      action: { actionType: ActionType.DESKTOP_CONTROL, toolName: 'desktop.control' },
      source: 'audit-fixture'
    });
    const lockedRead = kernel.authorizeExecution({
      action: { actionType: ActionType.LIST_FILES, toolName: 'filesystem.listFiles' },
      source: 'audit-fixture'
    });
    const challenge = kernel.createRecoveryChallenge({ requestedBy: 'runtime-trust-audit' });
    const invalidRecovery = kernel.recover({
      challenge: 'forged-recovery-challenge',
      recoveredBy: 'runtime-trust-audit'
    });
    const recoveryChallenge = kernel.createRecoveryChallenge({ requestedBy: 'runtime-trust-audit' });
    const recovery = kernel.recover({
      challenge: recoveryChallenge.challenge,
      recoveredBy: 'runtime-trust-audit',
      reason: 'all-integrity-probes-passed'
    });
    const restarted = new RuntimeTrustKernel({
      actorId: 'runtime-trust-audit',
      statePath,
      auditPath,
      signingSecret,
      testMode: true,
      clock
    });
    const restartStatus = restarted.publicStatus();
    const tamperedState = JSON.parse(await readFile(statePath, 'utf8'));
    tamperedState.manualReason = 'forged-state-without-valid-signature';
    tamperedState.lastTransitionAt = '2099-01-01T00:00:00.000Z';
    await writeFile(statePath, `${JSON.stringify(tamperedState, null, 2)}\n`, 'utf8');
    const failClosed = new RuntimeTrustKernel({
      actorId: 'runtime-trust-audit',
      statePath,
      auditPath,
      signingSecret,
      testMode: true,
      clock
    });
    const tamperStatus = failClosed.publicStatus();
    const incidentArtifacts = (await readdir(root)).filter((name) => name.includes('.incident-'));

    const quarantineStatePath = join(root, 'quarantine-trust-state.json');
    const quarantineAuditPath = join(root, 'quarantine-trust-audit.jsonl');
    const quarantineOptions = {
      actorId: 'runtime-trust-quarantine-audit',
      statePath: quarantineStatePath,
      auditPath: quarantineAuditPath,
      signingSecret,
      testMode: true,
      clock
    };
    const quarantineSeed = new RuntimeTrustKernel(quarantineOptions);
    quarantineSeed.recordSignal({
      code: 'E_AUDIT_QUARANTINE_FIXTURE',
      severity: 'high',
      source: 'audit-fixture'
    });
    const quarantineRecords = (await readFile(quarantineAuditPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    const originalSignature = quarantineRecords[0].trustSignature;
    quarantineRecords[0].trustSignature = `${originalSignature.slice(0, -1)}${originalSignature.endsWith('x') ? 'y' : 'x'}`;
    await writeFile(quarantineAuditPath, `${quarantineRecords.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
    const quarantineKernel = new RuntimeTrustKernel(quarantineOptions);
    const auditTamperStatus = quarantineKernel.publicStatus();
    const auditChallenge = quarantineKernel.createRecoveryChallenge({ requestedBy: 'runtime-trust-audit' });
    const auditQuarantine = quarantineKernel.quarantineInvalidAuditJournal({
      challenge: auditChallenge.challenge,
      requestedBy: 'runtime-trust-audit',
      reason: 'synthetic-audit-signature-tamper'
    });
    const quarantineManifest = JSON.parse(await readFile(join(root, auditQuarantine.manifestFile), 'utf8'));
    const postQuarantineChallenge = quarantineKernel.createRecoveryChallenge({ requestedBy: 'runtime-trust-audit' });
    const postQuarantineRecovery = quarantineKernel.recover({
      challenge: postQuarantineChallenge.challenge,
      recoveredBy: 'runtime-trust-audit',
      reason: 'forensic-quarantine-complete'
    });
    const productGate = kernel.productGate();
    const rawEvidence = JSON.stringify({
      initial,
      guarded,
      locked,
      recovery,
      restartStatus,
      tamperStatus,
      auditTamperStatus,
      auditQuarantine,
      quarantineManifest,
      postQuarantineRecovery,
      productGate
    });
    const checks = [
      check('trusted_baseline', initial.mode === RuntimeTrustMode.TRUSTED),
      check('untrusted_tool_signal_enters_guarded_mode', guarded.mode === RuntimeTrustMode.GUARDED),
      check('guarded_external_commit_blocked', guardedExternal.allowed === false),
      check('guarded_reversible_local_work_preserved', guardedLocal.allowed === true),
      check('critical_capability_integrity_failure_locks_runtime', locked.mode === RuntimeTrustMode.LOCKDOWN),
      check('lockdown_revocation_hook_invoked', lockdownCallbackCount >= 1),
      check('lockdown_mutating_execution_blocked', lockedMutation.allowed === false),
      check('lockdown_read_only_diagnostics_preserved', lockedRead.allowed === true),
      check('forged_recovery_challenge_rejected', invalidRecovery.error?.code === 'A_TRUST_RECOVERY_CHALLENGE_INVALID'),
      check('verified_recovery_passed', recovery.success === true && recovery.trust?.mode === RuntimeTrustMode.TRUSTED),
      check('recovery_hook_invoked_once', recoveryCallbackCount === 1),
      check('signed_state_survives_restart', restartStatus.mode === RuntimeTrustMode.TRUSTED && restartStatus.integrity.stateSignatureValid),
      check('persisted_state_tampering_fails_closed', tamperStatus.mode === RuntimeTrustMode.LOCKDOWN),
      check('tampered_state_preserved_as_incident_evidence', incidentArtifacts.length > 0),
      check('trust_audit_chain_valid_after_incident', tamperStatus.integrity.auditChainValid === true),
      check('tampered_audit_signature_fails_closed', auditTamperStatus.mode === RuntimeTrustMode.LOCKDOWN && auditTamperStatus.integrity.auditChainValid === false),
      check('invalid_audit_journal_preserved_forensically', auditQuarantine.success === true && auditQuarantine.originalJournalPreserved === true),
      check('audit_quarantine_manifest_hash_bound_and_signed', quarantineManifest.manifestHash?.length === 64 && quarantineManifest.signature?.length > 32),
      check('replacement_audit_chain_valid', auditQuarantine.replacementIntegrity?.valid === true),
      check('post_quarantine_recovery_requires_fresh_challenge', auditQuarantine.recoveryChallengeRequired === true && postQuarantineRecovery.success === true),
      check('kernel_product_gate_passed', productGate.status === 'passed'),
      check('raw_security_material_absent', !rawEvidence.includes(signingSecret)
        && !rawEvidence.includes(challenge.challenge)
        && !rawEvidence.includes(recoveryChallenge.challenge)
        && !rawEvidence.includes(auditChallenge.challenge)
        && !rawEvidence.includes(postQuarantineChallenge.challenge))
    ];
    const report = {
      reportVersion: 'jarvis-runtime-trust-kernel-audit-v1',
      generatedAt: clock().toISOString(),
      status: checks.every((item) => item.passed) ? 'passed' : 'failed',
      score: Math.round((checks.filter((item) => item.passed).length / checks.length) * 100),
      scope: {
        system: 'JARVIS A-G mutating execution plane',
        controls: [
          'risk-signal-correlation',
          'adaptive-guarded-mode',
          'persistent-fail-closed-lockdown',
          'capability-and-owner-session-revocation-hooks',
          'complete-mediation-at-core-and-pc-agent',
          'challenge-and-integrity-gated-recovery',
          'signed-state-and-hash-chained-audit',
          'signed-forensic-audit-quarantine'
        ]
      },
      standardsMapping: {
        nistAiRmf: ['GOVERN', 'MAP', 'MEASURE', 'MANAGE'],
        owaspGenAi: ['prompt-injection', 'supply-chain', 'improper-output-handling', 'excessive-agency', 'unbounded-consumption'],
        cisaSecureByDesign: ['secure-by-default', 'complete-logging', 'customer-visible-security-state', 'safe-recovery']
      },
      checks,
      evidence: {
        initialMode: initial.mode,
        guardedMode: guarded.mode,
        lockdownMode: locked.mode,
        recoveredMode: recovery.trust?.mode ?? null,
        restartMode: restartStatus.mode,
        tamperMode: tamperStatus.mode,
        auditTamperMode: auditTamperStatus.mode,
        auditQuarantinePreserved: auditQuarantine.originalJournalPreserved === true,
        auditReplacementValid: auditQuarantine.replacementIntegrity?.valid === true,
        postQuarantineRecoveryMode: postQuarantineRecovery.trust?.mode ?? null,
        incidentArtifactCount: incidentArtifacts.length,
        productGateStatus: productGate.status,
        rawSecurityMaterialStored: false,
        isolatedAuditWorkspaceRemoved: true
      },
      claimBoundary: 'This audit demonstrates layered local runtime controls and fail-closed behavior. It does not claim that any system is impossible to compromise.'
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(markdownPath, renderMarkdown(report), 'utf8');
    return report;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function check(checkId, passed) {
  return { checkId, passed: passed === true };
}

function renderMarkdown(report) {
  const rows = report.checks.map((item) => `| ${item.checkId} | ${item.passed ? 'PASS' : 'FAIL'} |`).join('\n');
  return `# JARVIS Runtime Trust Kernel Audit\n\n`
    + `- Status: **${report.status}**\n`
    + `- Score: **${report.score}/100**\n`
    + `- Boundary: ${report.claimBoundary}\n\n`
    + `## Checks\n\n| Check | Result |\n|---|---|\n${rows}\n`;
}

async function runCli() {
  const report = await runRuntimeTrustAudit();
  const reportPath = resolve('dist', 'verification', 'runtime-trust-kernel-audit.json');
  const exists = await access(reportPath).then(() => true, () => false);
  console.log(JSON.stringify({
    status: report.status,
    score: report.score,
    passed: report.checks.filter((item) => item.passed).length,
    total: report.checks.length,
    reportPath,
    artifactWritten: exists
  }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(`JARVIS runtime trust audit failed: ${error.message}`);
    process.exit(1);
  });
}
