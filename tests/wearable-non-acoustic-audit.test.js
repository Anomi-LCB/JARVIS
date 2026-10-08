import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBatteryState,
  parseDisplaySize,
  parseThermalState
} from '../scripts/wearable-non-acoustic-audit.mjs';

test('wearable non-acoustic audit normalizes battery evidence without raw dumps', () => {
  const state = parseBatteryState(`
    USB powered: true
    status: 5
    health: 2
    present: true
    level: 87
    temperature: 315
  `);
  assert.deepEqual(state, {
    present: true,
    level: 87,
    healthCode: 2,
    statusCode: 5,
    usbPowered: true,
    temperatureC: 31.5
  });
});

test('wearable non-acoustic audit parses thermal and physical display state', () => {
  assert.deepEqual(parseThermalState(`
    Thermal Status: 0
    HAL Ready: true
    ThermalHAL 2.0 connected: yes
  `), { status: 0, halReady: true, halConnected: true });
  assert.deepEqual(parseDisplaySize('Physical size: 480x640'), { width: 480, height: 640 });
});
