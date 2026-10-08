import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PcAgentRuntime } from '../apps/pc-agent/src/pc-agent-runtime.js';
import { createPcAgentOpenApiSpec } from '../apps/pc-agent/src/main.mjs';
import { PolicySecurityRuntime } from '../apps/policy-security/src/policy-runtime.js';
import { CoreFacade } from '../packages/core/src/core-facade.js';
import { createCoreOpenApiSpec, createCoreServer } from '../packages/core/src/main.mjs';
import { PersonalOwnerSessionManager } from '../packages/core/src/security/personal-owner-session.js';
import {
  RuntimeTrustKernel,
  RuntimeTrustMode
} from '../packages/core/src/security/runtime-trust-kernel.js';
import { ActionType } from '../packages/shared/src/types.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

test('runtime trust kernel escalates risk and completely mediates high-impact execution', () => {
  const kernel = new RuntimeTrustKernel({ signingSecret: 'trust-unit-secret', testMode: true });
  assert.equal(kernel.publicStatus().mode, RuntimeTrustMode.TRUSTED);

  const guarded = kernel.recordSignal({
    code: 'E_TOOL_OUTPUT_PROVENANCE_TAINTED',
    severity: 'high',
    source: 'unit-test',
    metadata: { rawToolOutputStored: false }
  });
  assert.equal(guarded.trust.mode, RuntimeTrustMode.GUARDED);
  assert.equal(kernel.authorizeExecution({
    action: {
      actionType: ActionType.SEND_EMAIL,
      toolName: 'email.send',
      capability: { externalTransfer: true }
    }
  }).allowed, false);
  assert.equal(kernel.authorizeExecution({
    action: {
      actionType: ActionType.CREATE_FILE,
      toolName: 'filesystem.createTextFile',
      capability: { reversible: true }
    }
  }).allowed, true);

  kernel.recordSignal({
    code: 'E_CAPABILITY_TOKEN_SIGNATURE_INVALID',
    severity: 'critical',
    source: 'unit-test',
    metadata: { rawTokenStored: false }
  });
  assert.equal(kernel.publicStatus().mode, RuntimeTrustMode.LOCKDOWN);
  assert.equal(kernel.authorizeExecution({
    action: { actionType: ActionType.CREATE_FILE, toolName: 'filesystem.createTextFile' }
  }).allowed, false);
  assert.equal(kernel.authorizeExecution({
    action: { actionType: ActionType.LIST_FILES, toolName: 'filesystem.listFiles' }
  }).allowed, true);
});

test('runtime trust state survives restart and fails closed after persisted-state tampering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-trust-persistence-'));
  const statePath = join(dir, 'trust-state.json');
  const auditPath = join(dir, 'trust-audit.jsonl');
  const options = {
    actorId: 'persistence-test',
    statePath,
    auditPath,
    signingSecret: 'persistent-trust-secret',
    testMode: true
  };
  try {
    const first = new RuntimeTrustKernel(options);
    first.recordSignal({ code: 'E_TOOL_OUTPUT_PROVENANCE_TAINTED', severity: 'high', source: 'fixture' });
    assert.equal(first.publicStatus().mode, RuntimeTrustMode.GUARDED);

    const restarted = new RuntimeTrustKernel(options);
    assert.equal(restarted.publicStatus().mode, RuntimeTrustMode.GUARDED);
    const tampered = JSON.parse(await readFile(statePath, 'utf8'));
    tampered.mode = RuntimeTrustMode.TRUSTED;
    tampered.riskScore = 0;
    await writeFile(statePath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

    const failClosed = new RuntimeTrustKernel(options);
    const status = failClosed.publicStatus();
    assert.equal(status.mode, RuntimeTrustMode.LOCKDOWN);
    assert.equal(status.reasonCodes.includes('A_TRUST_STATE_SIGNATURE_INVALID'), true);
    assert.equal(status.integrity.stateSignatureValid, true);
    const files = await import('node:fs/promises').then(({ readdir }) => readdir(dir));
    assert.equal(files.some((name) => name.includes('.incident-')), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isolated test trust keys stay stable across runtime reconstruction without disk secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-test-trust-key-'));
  const previousSecret = process.env.JARVIS_TEST_TRUST_SECRET;
  process.env.JARVIS_TEST_TRUST_SECRET = 'unit-test-process-boundary-secret';
  const options = {
    actorId: 'derived-test-key',
    statePath: join(dir, 'trust-state.json'),
    auditPath: join(dir, 'trust-audit.jsonl'),
    keyPath: join(dir, 'trust-key.json'),
    testMode: true
  };
  try {
    const first = new RuntimeTrustKernel(options);
    first.recordSignal({ code: 'E_DERIVED_KEY_FIXTURE', severity: 'high', source: 'unit-test' });
    const second = new RuntimeTrustKernel(options);
    assert.equal(first.publicStatus().keyProvider.provider, 'test-derived-path-key');
    assert.equal(second.publicStatus().keyProvider.keyId, first.publicStatus().keyProvider.keyId);
    assert.equal(second.publicStatus().mode, RuntimeTrustMode.GUARDED);
    await assert.rejects(readFile(options.keyPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    if (previousSecret === undefined) delete process.env.JARVIS_TEST_TRUST_SECRET;
    else process.env.JARVIS_TEST_TRUST_SECRET = previousSecret;
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime trust recovery requires a one-time challenge and every internal integrity probe', () => {
  const kernel = new RuntimeTrustKernel({ signingSecret: 'recovery-trust-secret', testMode: true });
  let externalIntegrityValid = false;
  let recoveryCallbackCount = 0;
  kernel.registerRecoveryProbe('external-integrity', () => ({ valid: externalIntegrityValid }));
  kernel.registerRecoveryHandler(() => { recoveryCallbackCount += 1; });
  kernel.engageLockdown({ reason: 'unit-recovery-drill', requestedBy: 'unit-admin' });

  const challenge = kernel.createRecoveryChallenge({ requestedBy: 'unit-admin' });
  const wrong = kernel.recover({ challenge: 'wrong-challenge', recoveredBy: 'unit-admin' });
  assert.equal(wrong.success, false);
  assert.equal(wrong.error.code, 'A_TRUST_RECOVERY_CHALLENGE_INVALID');
  assert.equal(kernel.publicStatus().mode, RuntimeTrustMode.LOCKDOWN);

  const retryChallenge = kernel.createRecoveryChallenge({ requestedBy: 'unit-admin' });
  const blocked = kernel.recover({ challenge: retryChallenge.challenge, recoveredBy: 'unit-admin' });
  assert.equal(blocked.success, false);
  assert.equal(blocked.error.code, 'A_TRUST_RECOVERY_CHECKS_FAILED');
  assert.equal(blocked.checks.items.find((item) => item.checkId === 'external-integrity').passed, false);

  externalIntegrityValid = true;
  const recovered = kernel.recover({ challenge: retryChallenge.challenge, recoveredBy: 'unit-admin' });
  assert.equal(recovered.success, true);
  assert.equal(recovered.trust.mode, RuntimeTrustMode.TRUSTED);
  assert.equal(recoveryCallbackCount, 1);
  assert.equal(recovered.trust.recovery.ownerSessionAutomaticallyRestored, false);
  assert.equal(recovered.trust.recovery.capabilitiesAutomaticallyRestored, false);
});

test('invalid trust audit journals are preserved in signed quarantine before recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-trust-audit-quarantine-'));
  const statePath = join(dir, 'trust-state.json');
  const auditPath = join(dir, 'trust-audit.jsonl');
  const options = {
    actorId: 'audit-quarantine-test',
    statePath,
    auditPath,
    signingSecret: 'audit-quarantine-secret',
    testMode: true
  };
  try {
    const initial = new RuntimeTrustKernel(options);
    initial.recordSignal({ code: 'E_CONTAINED_FIXTURE', severity: 'high', source: 'unit-test' });
    const records = (await readFile(auditPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    records[0].trustSignature = `${records[0].trustSignature.slice(0, -1)}x`;
    await writeFile(auditPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

    const failClosed = new RuntimeTrustKernel(options);
    assert.equal(failClosed.publicStatus().mode, RuntimeTrustMode.LOCKDOWN);
    assert.equal(failClosed.publicStatus().integrity.auditChainValid, false);

    const challenge = failClosed.createRecoveryChallenge({ requestedBy: 'unit-admin' });
    const quarantined = failClosed.quarantineInvalidAuditJournal({
      challenge: challenge.challenge,
      requestedBy: 'unit-admin',
      reason: 'unit-forensic-preservation'
    });
    assert.equal(quarantined.success, true);
    assert.equal(quarantined.originalJournalPreserved, true);
    assert.equal(quarantined.replacementIntegrity.valid, true);
    assert.equal(quarantined.recoveryChallengeRequired, true);
    assert.equal(failClosed.publicStatus().mode, RuntimeTrustMode.LOCKDOWN);

    const files = await readdir(dir);
    assert.equal(files.includes(quarantined.quarantineFile), true);
    assert.equal(files.includes(quarantined.manifestFile), true);
    const manifest = JSON.parse(await readFile(join(dir, quarantined.manifestFile), 'utf8'));
    assert.equal(manifest.manifestVersion, 'a-runtime-trust-audit-quarantine-manifest-v1');
    assert.equal(manifest.originalJournalHash, quarantined.originalJournalHash);
    assert.equal(manifest.originalJournalPreserved, true);
    assert.equal(manifest.rawSecurityMaterialStored, false);
    assert.equal(manifest.manifestHash.length, 64);
    assert.equal(manifest.signature.length > 32, true);

    const recoveryChallenge = failClosed.createRecoveryChallenge({ requestedBy: 'unit-admin' });
    const recovered = failClosed.recover({ challenge: recoveryChallenge.challenge, recoveredBy: 'unit-admin' });
    assert.equal(recovered.success, true);
    assert.equal(recovered.trust.mode, RuntimeTrustMode.TRUSTED);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime recovery fails closed when a peer trust journal is invalid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-trust-peer-audit-'));
  const peerAuditPath = join(dir, 'peer-audit.jsonl');
  try {
    const peer = new RuntimeTrustKernel({
      actorId: 'peer-runtime',
      statePath: join(dir, 'peer-state.json'),
      auditPath: peerAuditPath,
      signingSecret: 'shared-peer-audit-secret',
      testMode: true
    });
    peer.recordSignal({ code: 'E_PEER_AUDIT_FIXTURE', severity: 'high', source: 'unit-test' });
    const records = (await readFile(peerAuditPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    const signature = records[0].trustSignature;
    records[0].trustSignature = `${signature.slice(0, -1)}${signature.endsWith('x') ? 'y' : 'x'}`;
    await writeFile(peerAuditPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

    const primary = new RuntimeTrustKernel({
      actorId: 'primary-runtime',
      statePath: join(dir, 'primary-state.json'),
      auditPath: join(dir, 'primary-audit.jsonl'),
      signingSecret: 'shared-peer-audit-secret',
      testMode: true
    });
    primary.registerRecoveryProbe('peer-trust-audit-peer-runtime', () => primary.verifyPeerAuditJournal({
      auditPath: peerAuditPath,
      actorId: 'peer-runtime'
    }));
    primary.engageLockdown({ reason: 'peer-audit-drill', requestedBy: 'unit-admin' });
    const challenge = primary.createRecoveryChallenge({ requestedBy: 'unit-admin' });
    const blocked = primary.recover({ challenge: challenge.challenge, recoveredBy: 'unit-admin' });
    assert.equal(blocked.success, false);
    assert.equal(blocked.error.code, 'A_TRUST_RECOVERY_CHECKS_FAILED');
    const peerCheck = blocked.checks.items.find((item) => item.checkId === 'peer-trust-audit-peer-runtime');
    assert.equal(peerCheck.passed, false);
    assert.equal(primary.publicStatus().mode, RuntimeTrustMode.LOCKDOWN);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PC Agent rejects a forged signed capability and triggers durable trust lockdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-trust-capability-'));
  try {
    const kernel = new RuntimeTrustKernel({
      actorId: 'pc-agent-test',
      statePath: join(dir, 'trust-state.json'),
      auditPath: join(dir, 'trust-audit.jsonl'),
      signingSecret: 'pc-agent-trust-secret',
      testMode: true
    });
    const policy = new PolicySecurityRuntime({
      auditRoot: dir,
      signingSecret: 'capability-signing-secret',
      journalSecret: 'capability-journal-secret',
      trustKernel: kernel
    });
    const pcAgent = new PcAgentRuntime({
      policyRuntime: policy,
      trustKernel: kernel,
      allowedRoots: [dir],
      auditRoot: dir
    });
    const capability = policy.capabilities.issue({
      taskId: 'task_forged_capability',
      planId: 'plan_forged_capability',
      approvalId: 'approval_forged_capability',
      action: {
        actionType: ActionType.CREATE_FILE,
        toolName: 'filesystem.createTextFile',
        skillId: 'jarvis.test.create'
      },
      allowedPaths: [dir]
    });
    const pieces = capability.capabilityToken.split('.');
    pieces[2] = `${pieces[2].slice(0, -1)}${pieces[2].endsWith('a') ? 'b' : 'a'}`;
    const result = await pcAgent.receiveExecutionPacket({
      packetId: 'packet_forged_capability',
      taskId: 'task_forged_capability',
      planId: 'plan_forged_capability',
      action: {
        actionType: ActionType.CREATE_FILE,
        toolName: 'filesystem.createTextFile',
        arguments: { path: join(dir, 'must-not-exist.txt'), content: 'blocked' }
      },
      capabilityToken: { ...capability, capabilityToken: pieces.join('.') },
      userConfirmation: { confirmed: true },
      requestedMode: 'execute'
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.blockedReason, 'E_CAPABILITY_TOKEN_SIGNATURE_INVALID');
    assert.equal(kernel.publicStatus().mode, RuntimeTrustMode.LOCKDOWN);
    await assert.rejects(readFile(join(dir, 'must-not-exist.txt'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime trust product gate proves guarded, lockdown, and verified recovery paths', () => {
  const kernel = new RuntimeTrustKernel({ signingSecret: 'product-gate-trust-secret', testMode: true });
  const gate = kernel.productGate();
  assert.equal(gate.status, 'passed');
  assert.equal(gate.checks.every((check) => check.passed), true);
  assert.equal(gate.evidence.mutatingExecutionBlocked, true);
  assert.equal(gate.evidence.readOnlyDiagnosticsPreserved, true);
  assert.equal(gate.evidence.rawSecurityMaterialStored, false);
});

test('runtime trust controls are published in Core and PC Agent API contracts', () => {
  const coreSpec = createCoreOpenApiSpec(new CoreFacade());
  const pcSpec = createPcAgentOpenApiSpec();
  assert.equal(coreSpec.paths['/security/trust'].get.operationId, 'getRuntimeTrustStatus');
  assert.equal(coreSpec.paths['/security/trust/lockdown'].post.operationId, 'engageRuntimeTrustLockdown');
  assert.equal(coreSpec.paths['/security/trust/recovery/challenge'].post.operationId, 'createRuntimeTrustRecoveryChallenge');
  assert.equal(coreSpec.paths['/security/trust/audit/quarantine'].post.operationId, 'quarantineInvalidRuntimeTrustAuditJournal');
  assert.equal(coreSpec.paths['/security/trust/recover'].post.operationId, 'recoverRuntimeTrust');
  assert.equal(coreSpec.paths['/security/trust/product-gate'].post.operationId, 'runRuntimeTrustProductGate');
  assert.ok(coreSpec.components.schemas.RuntimeTrustStatus);
  assert.ok(pcSpec.paths['/api/trust/status'].get);
  assert.ok(pcSpec.paths['/api/trust/audit/quarantine'].post);
});

test('runtime trust kernel purpose signers reject ephemeral keys and anchors prevent journal replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-trust-journal-anchor-'));
  const statePath = join(dir, 'trust-state.json');
  const keyPath = join(dir, 'trust-key.json');
  try {
    const first = new RuntimeTrustKernel({ statePath, keyPath, testMode: true });
    assert.throws(() => first.createPurposeBoundSigner({ purpose: 'promotion-journal-test' }), { code: 'A_TRUST_SIGNER_KEY_NOT_PERSISTENT' });
    assert.equal(first.verifyLocalJournalHead('promotion-journal-test', { sequence: 0, headHash: 'GENESIS' }).valid, true);
    first.anchorLocalJournalHead('promotion-journal-test', { sequence: 1, headHash: 'a'.repeat(64) });

    const restarted = new RuntimeTrustKernel({ statePath, keyPath, testMode: true });
    assert.equal(restarted.verifyLocalJournalHead('promotion-journal-test', { sequence: 0, headHash: 'GENESIS' }).reason, 'journal-truncated-or-replayed');
    assert.equal(restarted.verifyLocalJournalHead('promotion-journal-test', { sequence: 1, headHash: 'a'.repeat(64) }).valid, true);
    assert.equal(restarted.verifyLocalJournalHead('promotion-journal-test', { sequence: 1, headHash: 'b'.repeat(64) }).reason, 'journal-anchor-mismatch');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Core trust-control API is admin-only, local, and revokes owner authority on lockdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-trust-core-api-'));
  const kernel = new RuntimeTrustKernel({ signingSecret: 'core-api-trust-secret', testMode: true });
  const policy = new PolicySecurityRuntime({ auditRoot: dir, trustKernel: kernel });
  const core = new CoreFacade({
    policyEngine: policy,
    workspaceRoot: dir,
    cwd: () => dir,
    eventLogPath: join(dir, 'events.jsonl'),
    orchestrationJournalPath: join(dir, 'orchestration.jsonl')
  });
  const owner = new PersonalOwnerSessionManager({ eventBus: core.eventBus });
  kernel.registerLockdownHandler((incident) => owner.revoke({
    reason: `trust-lockdown:${incident?.reasonCode}`,
    revokedBy: 'trust-kernel'
  }));
  kernel.registerRecoveryProbe('policy-audit-chain', () => policy.auditLog.verifyChain());
  const server = createCoreServer(core, {
    adminToken: 'trust-api-admin',
    ownerSessionManager: owner,
    trustKernel: kernel
  });
  const address = await listenOnFetchSafePort(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    Authorization: 'Bearer trust-api-admin',
    'Content-Type': 'application/json'
  };
  try {
    const denied = await fetch(`${baseUrl}/security/trust`);
    assert.equal(denied.status, 401);

    owner.activate({ durationMinutes: 10, requestedBy: 'unit-owner' });
    const lockedResponse = await fetch(`${baseUrl}/security/trust/lockdown`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'api-emergency-test', requestedBy: 'unit-admin' })
    });
    assert.equal(lockedResponse.status, 200);
    assert.equal((await lockedResponse.json()).trust.mode, RuntimeTrustMode.LOCKDOWN);
    assert.equal(owner.status().active, false);

    const ownerActivation = await fetch(`${baseUrl}/owner-session/activate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ durationMinutes: 10 })
    });
    assert.equal(ownerActivation.status, 423);

    const challengeResponse = await fetch(`${baseUrl}/security/trust/recovery/challenge`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestedBy: 'unit-admin' })
    });
    const challenge = await challengeResponse.json();
    assert.equal(challengeResponse.status, 200);
    const recoveredResponse = await fetch(`${baseUrl}/security/trust/recover`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ challenge: challenge.challenge, recoveredBy: 'unit-admin' })
    });
    const recovered = await recoveredResponse.json();
    assert.equal(recoveredResponse.status, 200);
    assert.equal(recovered.trust.mode, RuntimeTrustMode.TRUSTED);
    assert.equal(owner.status().active, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
