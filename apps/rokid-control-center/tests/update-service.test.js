import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { UpdateService } from '../src/update-service.js';

test('A/B 업데이트 ZIP을 해시하고 로컬 매니페스트로 준비한다', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'rokid-update-test-'));
  const auditRecords = [];
  const service = new UpdateService({
    adb: {
      async shell(_serial, args) {
        if (args[0] === 'getprop' && args[1].endsWith('check_url')) return 'https://ota.example.test';
        if (args[0] === 'getprop') return '/v1/check';
        if (args[0] === 'dumpsys') return 'versionCode=2920 versionName=2.9.2 userId=1000';
        return 'ota_check_state_key=normal\nota_upgrade_state_key=update_success';
      }
    },
    deviceService: { async selectRokid() { return { serial: 'rokid-test' }; } },
    audit: { async append(value) { auditRecords.push(value); return value; } },
    dataRoot,
    execute: async () => ({ stdout: 'payload.bin\npayload_properties.txt\ncare_map.pb\n', stderr: '' }),
    openFolder: async () => {},
    now: () => new Date('2026-08-16T00:00:00.000Z')
  });
  await service.ensureDirectories();
  await writeFile(join(service.inboxRoot, 'update.zip'), Buffer.from('synthetic-update-package'));
  const status = await service.status();
  assert.equal(status.vendor.checkEndpoint, 'https://ota.example.test/v1/check');
  assert.equal(status.localVault.packages[0].hasPayload, true);
  assert.equal(status.localVault.packages[0].hasPayloadProperties, true);
  const prepared = await service.prepare('update.zip');
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.manifest.delivery.deviceApplyAllowed, false);
  assert.match(await readFile(prepared.manifestPath, 'utf8'), /rokid-local-update-manifest-v1/);
  assert.equal(auditRecords.at(-1).type, 'update.package.prepared');
});

test('경로 이동 파일명과 payload 없는 ZIP은 거부한다', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'rokid-update-test-'));
  const service = new UpdateService({
    adb: { async shell() { return ''; } },
    deviceService: { async selectRokid() { return { serial: 'rokid-test' }; } },
    audit: { async append() {} },
    dataRoot,
    execute: async () => ({ stdout: 'META-INF/MANIFEST.MF\n', stderr: '' }),
    openFolder: async () => {}
  });
  await service.ensureDirectories();
  await writeFile(join(service.inboxRoot, 'bad.zip'), Buffer.from('not-an-update'));
  await assert.rejects(() => service.prepare('../bad.zip'), /올바른 ZIP/);
  await assert.rejects(() => service.prepare('bad.zip'), /payload\.bin/);
});

test('GUI에서 선택한 업데이트 파일을 보관함 경계 안에 스트리밍 저장한다', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'rokid-update-import-test-'));
  const auditRecords = [];
  const service = new UpdateService({
    adb: { async shell() { return ''; } },
    deviceService: { async selectRokid() { return { serial: 'rokid-test' }; } },
    audit: { async append(value) { auditRecords.push(value); } },
    dataRoot
  });
  const content = Buffer.from('synthetic zip bytes');
  const result = await service.importPackage('friendly-update.zip', Readable.from(content), { maximumBytes: 1024 });
  assert.equal(result.status, 'imported');
  assert.deepEqual(await readFile(join(service.inboxRoot, 'friendly-update.zip')), content);
  assert.equal(auditRecords.at(-1).type, 'update.package.imported');
  await assert.rejects(() => service.importPackage('../escape.zip', Readable.from(content)), /올바른 ZIP/);
  await assert.rejects(() => service.importPackage('friendly-update.zip', Readable.from(content)), /이미 있습니다/);
});
