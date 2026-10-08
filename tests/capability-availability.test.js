import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityAvailabilityRegistry } from '../packages/core/src/capabilities/capability-availability.js';
import { IntegrationConnectorRegistry } from '../packages/core/src/personal-operations/integration-security.js';

const epoch = Date.parse('2026-09-27T00:00:00.000Z');
const binding = { capabilityId: 'mail.read', providerId: 'google', accountRef: 'account-a', scopes: ['mail.read'] };
function setup() {
  let now = epoch;
  return { registry: new CapabilityAvailabilityRegistry({ clock: () => new Date(now), freshnessMs: 1000 }),
    advance: ms => { now += ms; }, time: () => new Date(now).toISOString() };
}
function observation(overrides = {}) {
  return { ...binding, codeVersion: 'build-1', permissionRevision: 'grant-1', observedAt: new Date(epoch).toISOString(),
    accountStatus: 'connected', observedAccountRef: 'account-a', grantedScopes: ['mail.read'],
    verificationLevel: 'live-probe', evidenceRef: 'probe-1', ...overrides };
}
test('forgetting one failed source removes its receipt without revoking provider grants or deleting newer evidence',()=>{
 const {registry}=setup();registry.recordObservation(observation());
 assert.equal(registry.forgetObservation(binding,{expectedEvidenceRef:'other-probe'}),false);assert.equal(registry.evaluate(binding).available,true);
 assert.equal(registry.forgetObservation(binding,{expectedEvidenceRef:'probe-1'}),true);assert.equal(registry.evaluate(binding).available,false);
 registry.recordObservation(observation({evidenceRef:'probe-2'}));
 assert.equal(registry.forgetObservation(binding,{expectedEvidenceRef:'probe-1'}),false);assert.equal(registry.evaluate(binding).available,true);
});

test('code without an observation is unknown; fresh exact-account probe is prerequisite availability, not authorization', () => {
  const { registry } = setup();
  const unknown = registry.evaluate(binding);
  assert.equal(unknown.available, false);
  assert.equal(unknown.status, 'unknown');
  assert.ok(unknown.nextAction);
  const ready = registry.recordObservation(observation());
  assert.equal(ready.available, true);
  assert.equal(ready.verificationLevel, 'live-probe');
  assert.equal(ready.executionAuthorized, false);
  assert.equal(ready.requiresPolicyCheck, true);
  assert.equal(registry.status().liveAvailableCount, 1);
  assert.equal(registry.status().liveExecutionVerifiedCount, 0);
});

test('a mock or sandbox result cannot enable real-account execution availability', () => {
  for (const verificationLevel of ['unverified', 'synthetic', 'sandbox']) {
    const { registry } = setup();
    const result = registry.recordObservation(observation({ verificationLevel }));
    assert.equal(result.available, false);
    assert.equal(result.status, 'unverified');
    assert.ok(result.reasons.some(item => item.code === 'execution-unverified'));
    assert.equal(registry.status().liveAvailableCount, 0);
  }
});

test('freshness is evaluated at use time and cannot be extended by stale status reads', () => {
  const { registry, advance } = setup();
  registry.recordObservation(observation());
  advance(999);
  assert.equal(registry.evaluate(binding).available, true);
  advance(1);
  const stale = registry.evaluate(binding);
  assert.equal(stale.available, false);
  assert.equal(stale.freshness, 'stale');
  assert.ok(stale.reasons.some(item => item.code === 'observation-stale'));
  assert.equal(registry.status().liveAvailableCount, 0);
});

test('expiry blocks a previously valid account before freshness TTL expires', () => {
  const { registry, advance } = setup();
  registry.recordObservation(observation({ expiresAt: new Date(epoch + 200).toISOString() }));
  advance(200);
  const result = registry.evaluate(binding);
  assert.equal(result.available, false);
  assert.equal(result.accountStatus, 'expired');
  assert.ok(result.reasons.some(item => item.code === 'connection-expired'));
});

test('revocation and scope loss apply across capabilities and requested scope subsets', () => {
  const { registry, advance, time } = setup();
  registry.recordObservation(observation());
  advance(1);
  registry.recordObservation(observation({ capabilityId: 'calendar.read', scopes: ['calendar.read'],
    grantedScopes: [], permissionRevision: 'grant-2', accountStatus: 'revoked', observedAt: time() }));
  const result = registry.evaluate(binding);
  assert.equal(result.available, false);
  assert.ok(result.reasons.some(item => item.code === 'account-revoked'));
  assert.ok(result.reasons.some(item => item.code === 'scope-not-granted'));
  assert.ok(result.reasons.some(item => item.code === 'permission-revision-changed'));
  assert.throws(() => registry.recordObservation(observation()), { code: 'A_AVAILABILITY_OLDER_OBSERVATION' });
});

test('conflicting observations at the same timestamp cannot resurrect an old grant', () => {
  const { registry, advance, time } = setup();
  registry.recordObservation(observation());
  advance(1);
  registry.recordObservation(observation({ permissionRevision: 'grant-2', accountStatus: 'revoked', observedAt: time() }));
  assert.throws(() => registry.recordObservation(observation({ observedAt: time() })),
    { code: 'A_AVAILABILITY_CONFLICTING_OBSERVATION' });
  assert.equal(registry.evaluate(binding).available, false);
});

test('a changed account identity discovered by another capability invalidates older account observations', () => {
  const { registry, advance, time } = setup();
  registry.recordObservation(observation());
  advance(1);
  registry.recordObservation(observation({ capabilityId: 'calendar.read', observedAccountRef: 'account-b', observedAt: time() }));
  const result = registry.evaluate(binding);
  assert.equal(result.available, false);
  assert.ok(result.reasons.some(item => item.code === 'account-identity-unverified'));
});

test('wrong account, wrong provider and different device never inherit a healthy observation', () => {
  const { registry } = setup();
  registry.recordObservation(observation({ deviceRef: 'phone-a', deviceStatus: 'online', observedDeviceRef: 'phone-a' }));
  for (const requested of [
    { ...binding, deviceRef: 'phone-a', accountRef: 'account-b' },
    { ...binding, deviceRef: 'phone-b' },
    { ...binding, deviceRef: 'phone-a', providerId: 'other' },
    { ...binding, deviceRef: 'phone-a', scopes: ['mail.send'] }
  ]) {
    assert.equal(registry.evaluate(requested).available, false);
  }
});

test('probe account/device identities must match the exact requested binding', () => {
  const { registry } = setup();
  const result = registry.recordObservation(observation({ deviceRef: 'phone-a', deviceStatus: 'online',
    observedAccountRef: 'account-b', observedDeviceRef: 'phone-b' }));
  assert.equal(result.available, false);
  assert.ok(result.reasons.some(item => item.code === 'account-identity-unverified'));
  assert.ok(result.reasons.some(item => item.code === 'device-identity-unverified'));
});

test('offline observation blocks all capabilities on that device', () => {
  const { registry, advance, time } = setup();
  registry.recordObservation(observation({ deviceRef: 'phone-a', deviceStatus: 'online', observedDeviceRef: 'phone-a' }));
  advance(1);
  registry.recordObservation(observation({ capabilityId: 'device.read', scopes: [], deviceRef: 'phone-a',
    deviceStatus: 'offline', observedDeviceRef: 'phone-a', observedAt: time() }));
  const result = registry.evaluate({ ...binding, deviceRef: 'phone-a' });
  assert.equal(result.available, false);
  assert.equal(result.deviceStatus, 'offline');
  assert.ok(result.reasons.some(item => item.code === 'device-offline'));
});

test('code or permission revision changes invalidate prior observations', () => {
  const { registry } = setup();
  registry.recordObservation(observation());
  assert.equal(registry.evaluate(binding, { codeVersion: 'build-2' }).available, false);
  assert.equal(registry.evaluate(binding, { permissionRevision: 'grant-2' }).available, false);
  assert.equal(registry.evaluate(binding, { codeReady: false }).available, false);
});

test('scope ordering and duplicates do not create alternative authorization identities', () => {
  const { registry } = setup();
  registry.recordObservation(observation({ scopes: ['calendar.read', 'mail.read'], grantedScopes: ['mail.read', 'calendar.read'] }));
  const result = registry.evaluate({ ...binding, scopes: ['mail.read', 'calendar.read', 'mail.read'] });
  assert.equal(result.available, true);
});

test('connection metadata reuses bundled capability scopes without claiming account probe success', () => {
  const { registry, time } = setup();
  const connectorRegistry = new IntegrationConnectorRegistry();
  connectorRegistry.register({ id: 'google', authMethods: ['oauth2'], scopes: ['mail.read', 'mail.send'],
    capabilities: [{ id: 'mail.read', riskTier: 'read', scopes: ['mail.read'] }] });
  const result = registry.recordConnection({ capabilityId: 'mail.read', providerId: 'google', connectorRegistry,
    codeVersion: 'build-1', observedAt: time(), connection: { connectionId: 'connection-1', connectorId: 'google',
      status: 'connected', scopes: ['mail.read'], updatedAt: time(), label: 'private@example.com', accessToken: 'secret' } });
  assert.equal(result.available, false);
  assert.equal(result.verificationLevel, 'unverified');
  assert.deepEqual(result.scopes, ['mail.read']);
  assert.equal(result.accountRef, 'connection-1');
  assert.doesNotMatch(JSON.stringify(registry.status()), /private@|secret|accessToken/);
});

test('connection source cannot substitute a provider and malformed references cannot leak raw identity', () => {
  const { registry, time } = setup();
  const connectorRegistry = new IntegrationConnectorRegistry();
  connectorRegistry.register({ id: 'google', authMethods: ['oauth2'], scopes: [],
    capabilities: [{ id: 'mail.read', riskTier: 'read', scopes: [] }] });
  assert.throws(() => registry.recordConnection({ capabilityId: 'mail.read', providerId: 'google', connectorRegistry,
    codeVersion: 'build-1', observedAt: time(), connection: { connectionId: 'connection-1', connectorId: 'different' } }),
  { code: 'A_AVAILABILITY_PROVIDER_MISMATCH' });
  assert.throws(() => registry.recordObservation(observation({ accountRef: 'person@example.com' })),
    { code: 'A_AVAILABILITY_REFERENCE_INVALID' });
});

test('future timestamps, overstated TTL and evidence-free live declarations are refused', () => {
  const { registry } = setup();
  assert.throws(() => registry.recordObservation(observation({ observedAt: new Date(epoch + 1).toISOString() })),
    { code: 'A_AVAILABILITY_FUTURE_OBSERVATION' });
  assert.throws(() => registry.recordObservation(observation({ freshnessMs: 1001 })),
    { code: 'A_AVAILABILITY_FRESHNESS_INVALID' });
  assert.throws(() => registry.recordObservation(observation({ evidenceRef: null })),
    { code: 'A_AVAILABILITY_EVIDENCE_REQUIRED' });
  assert.equal(registry.status().observationCount, 0);
});

test('output is a closed projection and callers cannot mutate stored observations', () => {
  const { registry } = setup();
  const input = observation({ credentials: { refreshToken: 'private-value' }, error: 'Bearer private-value', label: 'personal data' });
  const result = registry.recordObservation(input);
  input.grantedScopes.length = 0;
  result.scopes.push('mail.send');
  result.reasons.push({ code: 'modified' });
  const current = registry.evaluate(binding);
  assert.equal(current.available, true);
  assert.deepEqual(current.scopes, ['mail.read']);
  assert.doesNotMatch(JSON.stringify(registry.status()), /private-value|personal data|refreshToken|Bearer/);
});

test('local capabilities do not fabricate account or device bindings', () => {
  const { registry } = setup();
  const local = { capabilityId: 'file.read', providerId: 'local', scopes: [] };
  const result = registry.recordObservation({ ...local, codeVersion: 'build-1', observedAt: new Date(epoch).toISOString(),
    verificationLevel: 'live-execution', evidenceRef: 'run-1' });
  assert.equal(result.available, true);
  assert.equal(result.accountStatus, 'not-required');
  assert.equal(result.deviceStatus, 'not-required');
  assert.equal(registry.status().liveExecutionVerifiedCount, 1);
});
