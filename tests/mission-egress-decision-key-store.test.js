import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MissionEgressDecisionKeyStore } from '../packages/core/src/security/mission-egress-decision-key-store.js';

const claims = () => ({ decision: 'allow', decisionId: 'decision-1', missionId: 'm-1', callKey: 'c-1',
  providerId: 'provider-1', toolName: 'read_verified', contentSha256: 'a'.repeat(64), use: 'single-call',
  authorizationMode: 'policy-auto', gateId: null, approvedBy: 'policy:local-v1', policyVersion: 'local-v1',
  issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-egress-key-'));
  const path = join(root, 'egress-key.json');
  const store = new MissionEgressDecisionKeyStore({ path, platform: 'win32',
    // This reversible test protector verifies the store contract only; it is never used by product runtime.
    protect: value => Buffer.from(value, 'base64').toString('base64'),
    unprotect: value => Buffer.from(value, 'base64').toString('base64'), harden: () => {}, ...overrides });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { store, path };
}

test('Mission egress Ed25519 key is generated inside an OS-protected envelope and signs scoped claims', async t => {
  const { store, path } = await fixture(t);
  assert.equal(store.status().signingEnabled, false);
  const initialized = store.initialize();
  assert.equal(initialized.algorithm, 'Ed25519');
  assert.equal('privateKeyDer' in initialized, false);
  assert.equal(store.status().protectedByOs, true);
  assert.equal(store.status().privateKeyExported, false);
  const decision = store.signDecision(claims());
  assert.equal(store.verifyDecision(decision), true);
  const changed = structuredClone(decision); changed.claims.missionId = 'm-2';
  assert.equal(store.verifyDecision(changed), false);
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes('privateKeyDer'), false);
  assert.equal(raw.includes('BEGIN PRIVATE KEY'), false);
});

test('initialization cannot report success when immediate protected-key readback is unavailable', async t => {
  const { store, path } = await fixture(t, { unprotect: () => { throw Object.assign(new Error('synthetic DPAPI readback failure'), { code: 'ETIMEDOUT' }); } });
  assert.throws(() => store.initialize(), error => error.code === 'A_MISSION_EGRESS_KEYSTORE_WRITE_FAILED'
    && error.operationStage === 'post-write-readback');
  assert.equal(store.status().reason, 'key-store-unreadable');
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes('privateKeyDer'), false);
  assert.equal(raw.includes('BEGIN PRIVATE KEY'), false);
});

test('rotating the current user key immediately invalidates grants signed by its predecessor', async t => {
  const { store } = await fixture(t);
  store.initialize();
  const oldGrant = store.signDecision(claims());
  const rotated = store.rotate();
  assert.equal(rotated.previousKeyRevoked, true);
  assert.notEqual(rotated.previousKeyId, rotated.activeKeyId);
  assert.equal(rotated.existingGrantsRemainValid, false);
  assert.equal(store.verifyDecision(oldGrant), false);
  assert.equal(store.verifyDecision(store.signDecision(claims())), true);
});

test('an unreadable protected envelope can be explicitly recovered and old grants stay revoked', async t => {
  const { store, path } = await fixture(t); store.initialize();
  const oldGrant = store.signDecision(claims());
  await writeFile(path, '{corrupted-envelope');
  assert.equal(store.status().reason, 'key-store-unreadable');
  const recovered = store.recoverUnreadable({ recoveredBy: 'core-admin:test-token' });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.previousKeyRevoked, true);
  assert.equal(recovered.existingGrantsRemainValid, false);
  assert.equal(recovered.recoveredBy, 'core-admin:test-token');
  assert.match(recovered.previousEnvelopeSha256, /^[a-f0-9]{64}$/u);
  assert.equal(store.status().keyId, recovered.activeKeyId);
  assert.equal(store.status().recoveredBy, 'core-admin:test-token');
  assert.equal(store.verifyDecision(oldGrant), false);
  assert.equal(store.verifyDecision(store.signDecision(claims())), true);
  assert.throws(() => store.recoverUnreadable(), error => error.code === 'A_MISSION_EGRESS_KEYSTORE_RECOVERY_NOT_NEEDED');
});

test('unreadable-key recovery refuses a readable key and preserves corrupt bytes if replacement cannot be protected', async t => {
  const { store, path } = await fixture(t); store.initialize();
  assert.throws(() => store.recoverUnreadable(), error => error.code === 'A_MISSION_EGRESS_KEYSTORE_RECOVERY_NOT_NEEDED');
  await writeFile(path, '{corrupted-envelope');
  const original = await readFile(path, 'utf8');
  const protect = store.protect;
  store.protect = () => { throw new Error('synthetic-protection-failure'); };
  assert.throws(() => store.recoverUnreadable(), error => error.code === 'A_MISSION_EGRESS_KEYSTORE_RECOVERY_FAILED'
    && error.operationStage === 'dpapi-protect');
  store.protect = protect;
  const harden = store.harden;
  store.harden = () => { throw Object.assign(new Error('synthetic-acl-failure'), { code: 'EPERM' }); };
  assert.throws(() => store.recoverUnreadable(), error => error.code === 'A_MISSION_EGRESS_KEYSTORE_RECOVERY_FAILED'
    && error.operationStage === 'acl-harden' && error.cause?.code === 'EPERM');
  store.harden = harden;
  assert.equal(await readFile(path, 'utf8'), original);
});

test('the signer refuses unscoped, wrong-mode and overlong-lived authorization claims', async t => {
  const { store } = await fixture(t); store.initialize();
  assert.throws(() => store.signDecision({ decision: 'allow' }), error => error.code === 'A_MISSION_EGRESS_CLAIMS_INVALID');
  const autoWithGate = { ...claims(), gateId: 'unexpected-gate' };
  assert.throws(() => store.signDecision(autoWithGate), error => error.code === 'A_MISSION_EGRESS_CLAIMS_INVALID');
  const longGrant = { ...claims(), expiresAt: new Date(Date.now() + 301_000).toISOString() };
  assert.throws(() => store.signDecision(longGrant), error => error.code === 'A_MISSION_EGRESS_CLAIMS_INVALID');
});

test('key-store locks reject concurrent rotation and failed rotation preserves the active signing key', async t => {
  const { store, path } = await fixture(t); store.initialize();
  const current = store.signDecision(claims());
  await writeFile(`${path}.rotate-lock`, JSON.stringify({ pid: process.pid, createdAt: new Date(0).toISOString() }));
  assert.throws(() => store.rotate(), error => error.code === 'A_MISSION_EGRESS_KEYSTORE_ROTATION_BUSY');
  await rm(`${path}.rotate-lock`, { force: true });
  const protect = store.protect;
  store.protect = () => { throw new Error('synthetic-protection-failure'); };
  assert.throws(() => store.rotate(), error => error.code === 'A_MISSION_EGRESS_KEYSTORE_ROTATION_FAILED'
    && error.operationStage === 'dpapi-protect');
  store.protect = protect;
  assert.equal(store.verifyDecision(current), true);
});

test('non-Windows and unreadable key stores fail closed without a plaintext fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-egress-key-platform-'));
  const path = join(root, 'must-not-exist.json');
  const unavailable = new MissionEgressDecisionKeyStore({ path, platform: 'linux' });
  assert.equal(unavailable.status().signingEnabled, false);
  assert.throws(() => unavailable.initialize(), error => error.code === 'A_MISSION_EGRESS_KEYSTORE_UNAVAILABLE');
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  await writeFile(path, JSON.stringify({ version: 'bad', provider: 'plaintext', protectedPayload: 'private' }));
  const broken = new MissionEgressDecisionKeyStore({ path, platform: 'win32', protect: x => x, unprotect: x => x, harden: () => {} });
  assert.throws(() => broken.signDecision({ decision: 'allow' }), error => error.code === 'A_MISSION_EGRESS_KEYSTORE_METADATA_INVALID');
  await rm(root, { recursive: true, force: true });
});
