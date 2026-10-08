const DEFAULT_DEVICES = Object.freeze([
  { deviceId: 'light.living-room', kind: 'light', state: 'off' },
  { deviceId: 'thermostat.living-room', kind: 'thermostat', state: 21 },
  { deviceId: 'lock.front-door', kind: 'door_lock', state: 'locked' }
]);

/** In-memory, non-networked fixture for validating device scoping and rollback logic. */
export class IsolatedDeviceSimulator {
  constructor({ devices = DEFAULT_DEVICES } = {}) {
    this.devices = new Map(devices.map(device => [device.deviceId, { ...device, revision: 0 }]));
    this.commandLog = [];
    this.effects = new Map();
  }

  listDevices() { return [...this.devices.values()].map(({ deviceId, kind, state, revision }) => ({ deviceId, kind, state, revision })); }
  getStatus(deviceId) {
    const device = this.devices.get(deviceId);
    return device ? { ...device } : { success: false, code: 'device-not-found' };
  }

  execute({ deviceId, command, idempotencyKey, loseResponse = false } = {}) {
    const device = this.devices.get(deviceId);
    if (!device) return { success: false, code: 'device-not-found' };
    if (device.kind !== 'light' || !['turn_on', 'turn_off'].includes(command)) {
      return { success: false, code: 'device-action-outside-light-scope', state: device.state };
    }
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) return { success: false, code: 'idempotency-key-required' };
    const prior = this.effects.get(idempotencyKey);
    if (prior) {
      if (prior.deviceId !== deviceId || prior.command !== command) return { success: false, code: 'idempotency-key-conflict' };
      return { success: true, duplicate: true, ...prior.after, effectId: prior.effectId };
    }
    const before = { state: device.state, revision: device.revision };
    device.state = command === 'turn_on' ? 'on' : 'off';
    device.revision += 1;
    const effect = { effectId: `effect-${this.commandLog.length + 1}`, deviceId, command, before,
      after: { state: device.state, revision: device.revision }, idempotencyKey };
    this.effects.set(idempotencyKey, effect);
    this.commandLog.push({ effectId: effect.effectId, deviceId, command, stateAfter: device.state, revision: device.revision });
    return loseResponse ? { success: false, uncertain: true, code: 'response-lost-after-effect', effectId: effect.effectId }
      : { success: true, ...effect.after, effectId: effect.effectId };
  }

  restore({ effectId } = {}) {
    const effect = [...this.effects.values()].find(item => item.effectId === effectId);
    const device = effect && this.devices.get(effect.deviceId);
    if (!device) return { success: false, code: 'effect-not-found' };
    if (device.revision !== effect.after.revision || device.state !== effect.after.state) {
      return { success: false, code: 'state-changed-after-effect', current: { state: device.state, revision: device.revision } };
    }
    const command = effect.before.state === 'on' ? 'turn_on' : 'turn_off';
    device.state = effect.before.state;
    device.revision += 1;
    this.commandLog.push({ effectId: `${effect.effectId}-restore`, deviceId: device.deviceId, command,
      stateAfter: device.state, revision: device.revision, restores: effect.effectId });
    return { success: true, state: device.state, revision: device.revision, restores: effect.effectId };
  }
}
