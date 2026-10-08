import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasJarvisTitleContract,
  parseMobileDeviceSmokeCliOptions,
  selectMobileDeviceSmokeTargets
} from '../scripts/mobile-device-smoke.mjs';
import { prepareReactNativeGradleSettings } from '../scripts/mobile-android-stabilize-gradle.mjs';
import {
  evaluateAndroidInstallEligibility,
  selectAndroidInstallTarget
} from '../scripts/mobile-android-install.mjs';

test('mobile device smoke can target the isolated current-build package', () => {
  const options = parseMobileDeviceSmokeCliOptions([
    '--package',
    'local.eureka.jarvis.e2e',
    '--artifact-dir',
    'dist/mobile-device-e2e',
    '--launch-wait-ms',
    '9000'
  ], { env: {} });

  assert.deepEqual(options, {
    packageName: 'local.eureka.jarvis.e2e',
    artifactDir: 'dist/mobile-device-e2e',
    launchWaitMs: 9000
  });
});

test('mobile device smoke accepts the localized production JARVIS title contract', () => {
  assert.equal(hasJarvisTitleContract('<node resource-id="jarvis-mobile-title" text="JARVIS" />'), true);
  assert.equal(hasJarvisTitleContract('<node resource-id="jarvis-mobile-title" text="Jarvis Mobile" />'), true);
  assert.equal(hasJarvisTitleContract('<node resource-id="jarvis-mobile-title" text="자비스" />'), true);
  assert.equal(hasJarvisTitleContract('<node resource-id="jarvis-mobile-title" text="다른 앱" />'), false);
  assert.equal(hasJarvisTitleContract('<node resource-id="other-title" text="JARVIS" />'), false);
});

test('mobile device smoke package can be configured without exposing credentials', () => {
  const options = parseMobileDeviceSmokeCliOptions([], {
    env: { JARVIS_MOBILE_DEVICE_PACKAGE: 'local.eureka.jarvis.e2e' }
  });

  assert.equal(options.packageName, 'local.eureka.jarvis.e2e');
  assert.deepEqual(Object.keys(options), ['packageName']);
});

test('mobile device smoke isolates an explicitly selected phone from other attached devices', () => {
  const options = parseMobileDeviceSmokeCliOptions([
    '--serial',
    'PHONE-02',
    '--package',
    'local.eureka.jarvis.e2e'
  ], { env: {} });
  const selected = selectMobileDeviceSmokeTargets({
    requestedSerial: options.requestedSerial,
    devices: [
      { serial: 'GLASSES-01', state: 'device' },
      { serial: 'PHONE-02', state: 'device' }
    ]
  });

  assert.deepEqual(options, {
    packageName: 'local.eureka.jarvis.e2e',
    requestedSerial: 'PHONE-02'
  });
  assert.deepEqual(selected, {
    devices: [{ serial: 'PHONE-02', state: 'device' }],
    reason: null
  });
});

test('mobile device smoke refuses an unauthorized explicit target without falling back', () => {
  const selected = selectMobileDeviceSmokeTargets({
    requestedSerial: 'PHONE-02',
    devices: [
      { serial: 'GLASSES-01', state: 'device' },
      { serial: 'PHONE-02', state: 'unauthorized' }
    ]
  });

  assert.deepEqual(selected, {
    devices: [],
    reason: 'requested-android-device-not-ready:PHONE-02:unauthorized'
  });
});

test('offline Android stabilization removes only the optional Foojay resolver', () => {
  const source = `pluginManagement { repositories { mavenCentral() } }
plugins { id("org.gradle.toolchains.foojay-resolver-convention").version("0.5.0") }
include(":react-native-gradle-plugin")`;
  const offline = prepareReactNativeGradleSettings(source, { offline: true });
  const online = prepareReactNativeGradleSettings(source, { offline: false });

  assert.equal(offline.patched, true);
  assert.doesNotMatch(offline.text, /foojay-resolver-convention/);
  assert.match(offline.text, /include\(":react-native-gradle-plugin"\)/);
  assert.deepEqual(online, { text: source, patched: false });
});

test('Android installer refuses to guess a target when a phone and glasses are both connected', () => {
  const selection = selectAndroidInstallTarget({
    readyDevices: [
      { serial: 'GLASSES-01', state: 'device' },
      { serial: 'PHONE-02', state: 'device' }
    ]
  });

  assert.deepEqual(selection, {
    serial: null,
    reason: 'multiple-ready-devices-require-explicit-target'
  });
  assert.deepEqual(selectAndroidInstallTarget({
    readyDevices: [
      { serial: 'GLASSES-01', state: 'device' },
      { serial: 'PHONE-02', state: 'device' }
    ],
    requestedDevice: 'PHONE-02'
  }), { serial: 'PHONE-02', reason: null });
});

test('Android installer never installs a stale APK after the requested build fails', () => {
  assert.deepEqual(evaluateAndroidInstallEligibility({
    installRequested: true,
    buildRequested: true,
    buildResult: { attempted: true, exitCode: null, timedOut: true },
    apkExists: true,
    selectedDevice: 'PHONE-02'
  }), {
    allowed: false,
    reason: 'current-build-not-successful-stale-apk-blocked'
  });

  assert.deepEqual(evaluateAndroidInstallEligibility({
    installRequested: true,
    buildRequested: true,
    buildResult: { attempted: true, exitCode: 0, timedOut: false },
    apkExists: true,
    selectedDevice: 'PHONE-02'
  }), { allowed: true, reason: null });
});
