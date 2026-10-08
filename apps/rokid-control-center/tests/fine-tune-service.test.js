import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FineTuneService } from '../src/fine-tune-service.js';

test('세부 설정을 시각 정보로 제공하고 변경을 되돌린다', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'rokid-fine-tune-test-'));
  const values = {
    system: new Map([['show_touches', '0'], ['screen_brightness', '128']]),
    secure: new Map([['location_mode', '0'], ['android_id', 'fixed-id']]),
    global: new Map([['window_animation_scale', '1']])
  };
  const auditRecords = [];
  const deviceService = fakeDeviceService(values);
  const service = new FineTuneService({
    deviceService,
    dataRoot,
    audit: { async append(value) { auditRecords.push(value); return value; } },
    now: () => new Date('2026-08-16T10:00:00.000Z')
  });

  const first = await service.list();
  assert.equal(first.counts.system, 2);
  assert.equal(first.items.find((item) => item.key === 'show_touches').label, '터치 위치 표시');
  assert.equal(first.items.find((item) => item.key === 'android_id').editable, false);

  await service.change({ scope: 'system', key: 'show_touches', value: true });
  assert.equal(values.system.get('show_touches'), '1');
  assert.equal((await service.list()).lastChange.label, '터치 위치 표시');

  await service.undo();
  assert.equal(values.system.get('show_touches'), '0');
  assert.equal((await service.list()).lastChange, null);
  assert.deepEqual(auditRecords.map((item) => item.type), ['setting.change', 'setting.undo']);
});

test('주의 설정과 기기 식별값에 안전 확인을 강제한다', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'rokid-fine-tune-test-'));
  const values = { system: new Map(), secure: new Map([['location_mode', '0'], ['android_id', 'fixed-id']]), global: new Map() };
  const service = new FineTuneService({ deviceService: fakeDeviceService(values), dataRoot, audit: { async append() {} } });
  await assert.rejects(() => service.change({ scope: 'secure', key: 'location_mode', value: '3' }), /확인 문구/);
  await service.change({ scope: 'secure', key: 'location_mode', value: '3', confirmation: '세부 설정 변경' });
  assert.equal(values.secure.get('location_mode'), '3');
  await assert.rejects(() => service.change({ scope: 'secure', key: 'android_id', value: 'changed' }), /잠갔습니다/);
});

function fakeDeviceService(values) {
  return {
    async settings(scope) { return [...values[scope].entries()].map(([key, value]) => ({ key, value })); },
    async readSetting(scope, key) {
      return values[scope].has(key) ? { exists: true, value: values[scope].get(key) } : { exists: false, value: '' };
    },
    async writeSetting(scope, key, value) { values[scope].set(key, String(value)); },
    async deleteSetting(scope, key) { values[scope].delete(key); }
  };
}
