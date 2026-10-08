import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DeviceRegistry,
  DeviceTokenService,
  PairingManager
} from '../apps/bridge/src/bridge-runtime.js';

test('bridge marks persisted devices for re-pairing after the signing key changes and restores them with a new token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-bridge-token-key-'));
  const journalPath = join(root, 'bridge-devices.jsonl');
  const clock = () => new Date('2026-08-30T00:00:00.000Z');
  try {
    const oldTokenService = new DeviceTokenService({ secret: 'old-device-token-secret-material-32-bytes', clock });
    const oldRegistry = new DeviceRegistry({ tokenService: oldTokenService, journalPath, clock });
    const oldIssued = oldTokenService.issue({ deviceId: 'phone-1', deviceName: 'Phone 1' });
    oldRegistry.register({
      deviceId: 'phone-1',
      deviceName: 'Phone 1',
      tokenHash: oldIssued.tokenHash,
      expiresAt: oldIssued.expiresAt,
      issuedAt: oldIssued.issuedAt,
      tokenId: oldIssued.tokenId,
      tokenVersion: oldIssued.tokenVersion,
      tokenAlgorithm: oldIssued.algorithm,
      tokenScope: oldIssued.scope
    });

    const newTokenService = new DeviceTokenService({ secret: 'new-device-token-secret-material-32-bytes', clock });
    const reconciled = new DeviceRegistry({ tokenService: newTokenService, journalPath, clock });
    const stale = reconciled.list()[0];
    assert.equal(stale.status, 'reauth_required');
    assert.equal(stale.tokenStatus, 'reauth_required');
    assert.equal(stale.trustLabel, 'reauth-required-device');
    assert.equal(reconciled.inventory().reauthRequiredDevices, 1);
    assert.equal(reconciled.authenticateToken(oldIssued.deviceToken).success, false);

    const pairing = new PairingManager({ registry: reconciled, clock });
    const started = pairing.start();
    const repaired = pairing.confirm({
      deviceId: 'phone-1',
      deviceName: 'Phone 1',
      pairingId: started.pairingId,
      pairingCode: started.pairingCode
    });
    assert.equal(repaired.success, true);
    assert.equal(repaired.rePaired, true);
    assert.equal(reconciled.authenticateToken(repaired.deviceToken).success, true);
    assert.equal(reconciled.list()[0].status, 'active');
    assert.equal(reconciled.list()[0].tokenKeyId, newTokenService.keyId());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
