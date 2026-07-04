export class DeviceBridge {
  constructor(devices = []) {
    this.devices = devices;
  }

  connectionSummary() {
    return this.devices.map((device) => ({
      name: device.name,
      type: device.type,
      status: device.latencyMs < 250 ? 'connected' : 'degraded',
      latencyMs: device.latencyMs
    }));
  }

  routeMessage(message) {
    const target = this.devices.find((device) => device.type === message.targetType);
    if (!target) {
      return { delivered: false, reason: 'no-target' };
    }
    return {
      delivered: target.latencyMs < 500,
      target: target.name,
      etaMs: target.latencyMs + Math.ceil(message.payload.length / 4)
    };
  }
}
