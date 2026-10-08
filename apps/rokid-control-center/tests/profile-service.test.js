import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileService } from '../src/profile-service.js';

test('현재 상태를 사용자 모드로 저장하고 적용 후 한 번에 되돌린다', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'rokid-profile-test-'));
  const current = { brightness: 140, screenTimeout: 60_000, rotation: false, wifi: false, bluetooth: false };
  const controls = [];
  const auditRecords = [];
  const service = new ProfileService({
    deviceService: fakeDeviceService(current, controls),
    audit: { async append(value) { auditRecords.push(value); } },
    dataRoot,
    now: () => new Date('2026-08-16T01:00:00.000Z')
  });

  const saved = await service.saveCurrent('내 작업 모드');
  assert.equal(saved.name, '내 작업 모드');
  assert.equal((await service.list()).custom.length, 1);

  const applied = await service.apply('comfort');
  assert.equal(applied.status, 'applied');
  assert.deepEqual(current, { brightness: 95, screenTimeout: 300_000, rotation: true, wifi: true, bluetooth: true });
  assert.equal((await service.list()).lastApplied.profileName, '편안한 실내');

  const undone = await service.undo();
  assert.equal(undone.status, 'undone');
  assert.deepEqual(current, { brightness: 140, screenTimeout: 60_000, rotation: false, wifi: false, bluetooth: false });
  assert.equal(auditRecords.at(-1).type, 'profile.undo');
  assert.ok(controls.length >= 8);
});

test('모드 적용 중 실패하면 이미 바꾼 설정을 원래대로 롤백한다', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'rokid-profile-test-'));
  const initial = { brightness: 160, screenTimeout: 300_000, rotation: true, wifi: true, bluetooth: true };
  const current = { ...initial };
  let failed = false;
  const deviceService = fakeDeviceService(current, [], (payload) => {
    if (!failed && payload.action === 'wifi' && payload.value === false) {
      failed = true;
      throw new Error('synthetic wifi failure');
    }
  });
  const auditRecords = [];
  const service = new ProfileService({ deviceService, audit: { async append(value) { auditRecords.push(value); } }, dataRoot });

  await assert.rejects(() => service.apply('battery'), /원래대로 되돌렸습니다/);
  assert.deepEqual(current, initial);
  assert.equal(auditRecords.at(-1).status, 'failed');
  assert.equal(auditRecords.at(-1).rolledBack, true);
});

function fakeDeviceService(current, records, beforeControl = () => {}) {
  return {
    async overview() {
      return {
        controls: {
          brightness: current.brightness,
          screenTimeout: current.screenTimeout,
          rotation: current.rotation,
          bluetooth: current.bluetooth
        },
        wifi: { enabled: current.wifi }
      };
    },
    async control(payload) {
      beforeControl(payload);
      const keys = { brightness: 'brightness', timeout: 'screenTimeout', rotation: 'rotation', wifi: 'wifi', bluetooth: 'bluetooth' };
      current[keys[payload.action]] = payload.value;
      records.push(payload);
      return { status: 'succeeded' };
    }
  };
}
