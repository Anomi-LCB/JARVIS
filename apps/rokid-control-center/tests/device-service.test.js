import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeviceList } from '../src/adb-client.js';
import { DeviceService, parseLaunchablePackages, parsePackagePath } from '../src/device-service.js';

test('ADB 장치 목록에서 Rokid 메타데이터를 보존한다', () => {
  const devices = parseDeviceList('List of devices attached\n1901092544700559 device product:glasses model:RG_glasses device:glasses transport_id:7\nR3 unauthorized transport_id:6\n');
  assert.equal(devices.length, 2);
  assert.deepEqual(devices[0], {
    serial: '1901092544700559', state: 'device', product: 'glasses', model: 'RG_glasses', device: 'glasses', transport_id: '7'
  });
  assert.equal(devices[1].state, 'unauthorized');
});

test('패키지 경로를 안전하게 파싱한다', () => {
  assert.deepEqual(parsePackagePath('package:/data/app/demo/base.apk=com.krokid.hud'), { path: '/data/app/demo/base.apk', name: 'com.krokid.hud' });
  assert.equal(parsePackagePath('invalid'), null);
});

test('화면이 있는 앱의 실행 컴포넌트를 구분한다', () => {
  const launchable = parseLaunchablePackages('9 activities found:\n  Activity #0:\n    com.android.settings/.Settings\n  Activity #1:\n    com.krokid.hud/.MainActivity\n');
  assert.equal(launchable.get('com.android.settings'), 'com.android.settings/.Settings');
  assert.equal(launchable.get('com.krokid.hud'), 'com.krokid.hud/.MainActivity');
  assert.equal(launchable.has('com.rokid.background'), false);
});

test('변경 명령은 허용 목록과 범위를 강제한다', async () => {
  const adb = {
    async listDevices() { return [{ serial: 'rokid-1', state: 'device', product: 'glasses', model: 'RG_glasses', device: 'glasses' }]; },
    async shell(_serial, args) {
      if (args.join(' ') === 'pm list packages -f') return 'package:/data/app/base.apk=com.krokid.hud';
      if (args.join(' ') === 'pm list packages -3') return 'package:com.krokid.hud';
      if (args[0] === 'dumpsys') return 'versionName=0.1.0 flags=[ DEBUGGABLE HAS_CODE ] User 0: enabled=0';
      return 'ok';
    }
  };
  const records = [];
  const service = new DeviceService({ adb, audit: { async append(value) { records.push(value); return value; } } });
  assert.deepEqual(await service.controlArgs('rokid-1', { action: 'brightness', value: 200 }), ['settings', 'put', 'system', 'screen_brightness', '200']);
  await assert.rejects(() => service.controlArgs('rokid-1', { action: 'brightness', value: 999 }), /허용 범위/);
  await assert.rejects(() => service.controlArgs('rokid-1', { action: 'launch', packageName: 'bad;command' }), /패키지 이름/);
  await assert.rejects(() => service.control({ action: 'reboot' }), /확인 문구/);
});

test('초보자용 시각 제어에 현재 기기 상태를 제공한다', async () => {
  const adb = {
    async listDevices() { return [{ serial: 'rokid-1', state: 'device', product: 'glasses', model: 'RG_glasses', device: 'glasses' }]; },
    async shell(_serial, args) {
      const command = args.join(' ');
      if (command === 'wm size') return 'Physical size: 480x640';
      if (command === 'wm density') return 'Physical density: 240';
      if (command === 'dumpsys wifi') return 'Wi-Fi is enabled';
      if (command === 'settings get system screen_brightness') return '204';
      if (command === 'settings get system screen_off_timeout') return '300000';
      if (command === 'settings get system accelerometer_rotation') return '1';
      if (command === 'settings get global bluetooth_on') return '0';
      if (command === 'dumpsys power') return 'mWakefulness=Awake';
      if (command === 'pm list features') return 'feature:android.hardware.camera';
      if (args[0] === 'getprop' && args[1] === 'ro.boot.vbmeta.device_state') return 'unlocked';
      if (args[0] === 'getprop' && args[1] === 'ro.boot.flash.locked') return '0';
      return '';
    }
  };
  const service = new DeviceService({ adb, audit: { async append() {} } });
  const overview = await service.overview();
  assert.deepEqual(overview.controls, { brightness: 204, screenTimeout: 300000, rotation: true, bluetooth: false });
  assert.equal(overview.wifi.enabled, true);
  assert.deepEqual(overview.power, { wakefulness: 'Awake', screenOn: true });
});

test('PC 화면의 탭과 드래그를 안경 좌표 안에서만 전달한다', async () => {
  const commands = [];
  const adb = {
    async listDevices() { return [{ serial: 'rokid-1', state: 'device', product: 'glasses', model: 'RG_glasses', device: 'glasses' }]; },
    async shell(_serial, args) {
      commands.push(args);
      if (args.join(' ') === 'wm size') return 'Physical size: 480x640';
      if (args.join(' ') === 'wm density') return 'Physical density: 240';
      return '';
    }
  };
  const service = new DeviceService({ adb, audit: { async append(value) { return value; } } });
  await service.screenInteraction({ kind: 'tap', x: 120, y: 320 });
  await service.screenInteraction({ kind: 'swipe', x: 20, y: 500, endX: 420, endY: 100, durationMs: 310 });
  assert.ok(commands.some((args) => args.join(' ') === 'input tap 120 320'));
  assert.ok(commands.some((args) => args.join(' ') === 'input swipe 20 500 420 100 310'));
  await assert.rejects(() => service.screenInteraction({ kind: 'tap', x: 480, y: 10 }), /허용 범위/);
});
