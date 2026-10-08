import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { IsolatedDeviceSimulator } from '../apps/pc-agent/src/adapters/smart-home/isolated-device-simulator.js';

const fixtureBytes = readFileSync(new URL('../packages/core/fixtures/s12-isolated-physical-device.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');

test('S12 reconciles a lost light response, refuses unsafe devices, and restores only an unchanged effect', () => {
  const simulator = new IsolatedDeviceSimulator({ devices: fixture.initialDevices });
  const initial = simulator.listDevices();
  const uncertain = simulator.execute({ ...fixture.allowedCommand, idempotencyKey: 's12-light-on-1', loseResponse: true });
  assert.equal(uncertain.uncertain, true);
  const observed = simulator.getStatus(fixture.allowedCommand.deviceId);
  assert.equal(observed.state, 'on');
  const duplicate = simulator.execute({ ...fixture.allowedCommand, idempotencyKey: 's12-light-on-1' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(simulator.commandLog.length, 1);

  for (const command of fixture.forbiddenCommands) {
    assert.equal(simulator.execute({ ...command, idempotencyKey: `blocked-${command.deviceId}` }).success, false);
  }
  assert.equal(simulator.getStatus('thermostat.living-room').state, 21);
  assert.equal(simulator.getStatus('lock.front-door').state, 'locked');

  const restored = simulator.restore({ effectId: uncertain.effectId });
  assert.equal(restored.success, true);
  assert.equal(simulator.getStatus(fixture.allowedCommand.deviceId).state, 'off');
  const final = simulator.listDevices();
  assert.equal(final.find(item => item.deviceId === 'thermostat.living-room').state, 21);
  assert.equal(final.find(item => item.deviceId === 'lock.front-door').state, 'locked');
  assert.deepEqual(initial.map(({ deviceId, state }) => [deviceId, state]), [
    ['light.living-room', 'off'], ['thermostat.living-room', 21], ['lock.front-door', 'locked']
  ]);

  if (process.env.JARVIS_S12_ORACLE_EVIDENCE_PATH) {
    writeFileSync(process.env.JARVIS_S12_ORACLE_EVIDENCE_PATH, `${JSON.stringify({ schemaVersion: 1, scenarioId: 'S12',
      fixtureId: fixture.fixtureId, fixtureSha256, initial, uncertain, observed: { state: observed.state, revision: observed.revision },
      duplicate, blocked: fixture.forbiddenCommands.map(command => ({ deviceId: command.deviceId, result: simulator.execute({
        ...command, idempotencyKey: `evidence-${command.deviceId}` }) })), commandLog: simulator.commandLog, restored,
      final: simulator.listDevices(), noNetwork: true, physicalDeviceAccess: false }, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' });
  }
});

test('S12 restore fails closed when an independent state change followed the uncertain effect', () => {
  const simulator = new IsolatedDeviceSimulator({ devices: fixture.initialDevices });
  const applied = simulator.execute({ ...fixture.allowedCommand, idempotencyKey: 's12-conflict-1' });
  const device = simulator.devices.get(fixture.conflictState.deviceId);
  device.state = fixture.conflictState.state;
  device.revision += 1;
  const result = simulator.restore({ effectId: applied.effectId });
  assert.equal(result.success, false);
  assert.equal(result.code, 'state-changed-after-effect');
  assert.equal(simulator.getStatus(fixture.conflictState.deviceId).state, 'off');
  assert.equal(simulator.commandLog.length, 1, 'refused restore must not write a command');
});

test('S12 rejects missing idempotency keys and unknown devices', () => {
  const simulator = new IsolatedDeviceSimulator({ devices: fixture.initialDevices });
  assert.equal(simulator.execute({ ...fixture.allowedCommand }).code, 'idempotency-key-required');
  assert.equal(simulator.execute({ deviceId: 'unknown.device', command: 'turn_on', idempotencyKey: 'unknown' }).code, 'device-not-found');
});

test('S12 binds an idempotency key to the exact device and command', () => {
  const simulator = new IsolatedDeviceSimulator({ devices: [
    { deviceId: 'light.one', kind: 'light', state: 'off' },
    { deviceId: 'light.two', kind: 'light', state: 'off' }
  ] });
  simulator.execute({ deviceId: 'light.one', command: 'turn_on', idempotencyKey: 'shared' });
  for (const request of [
    { deviceId: 'light.two', command: 'turn_on' },
    { deviceId: 'light.one', command: 'turn_off' }
  ]) {
    assert.equal(simulator.execute({ ...request, idempotencyKey: 'shared' }).code, 'idempotency-key-conflict');
  }
  assert.equal(simulator.commandLog.length, 1);
  assert.equal(simulator.getStatus('light.two').state, 'off');
});

test('S12 duplicate receipt preserves the applied state rather than claiming a later state', () => {
  const simulator = new IsolatedDeviceSimulator();
  const request = { deviceId: 'light.living-room', command: 'turn_on', idempotencyKey: 'on' };
  const applied = simulator.execute(request);
  simulator.execute({ ...request, command: 'turn_off', idempotencyKey: 'off' });
  const duplicate = simulator.execute(request);
  assert.equal(duplicate.state, applied.state);
  assert.equal(duplicate.revision, applied.revision);
  assert.equal(simulator.getStatus(request.deviceId).state, 'off');
  assert.equal(simulator.commandLog.length, 2);
});
