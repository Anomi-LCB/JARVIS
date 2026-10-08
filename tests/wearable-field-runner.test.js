import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createGradleBuildInvocation,
  isAllowedFieldUrl,
  parseWearableFieldRunnerArgs,
  selectWearableDevice
} from '../scripts/wearable-field-runner.mjs';

test('wearable field runner accepts only the ADB loopback field origin', () => {
  assert.equal(isAllowedFieldUrl('http://127.0.0.1:4176/field-calibration.html'), true);
  assert.equal(isAllowedFieldUrl('http://localhost:4176/field-calibration.html'), true);
  assert.equal(isAllowedFieldUrl('https://127.0.0.1:4176/field-calibration.html'), false);
  assert.equal(isAllowedFieldUrl('http://127.0.0.1:17777/health'), false);
  assert.equal(isAllowedFieldUrl('http://example.com:4176/field-calibration.html'), false);
  assert.equal(isAllowedFieldUrl('http://user:secret@127.0.0.1:4176/field-calibration.html'), false);
});

test('wearable device selection requires an explicit serial when multiple devices are ready', () => {
  const devices = [
    { serial: 'glasses-1', state: 'device' },
    { serial: 'phone-1', state: 'device' }
  ];
  assert.throws(() => selectWearableDevice({ devices }), /multiple-ready-devices-require-serial/);
  assert.equal(selectWearableDevice({ devices, requestedSerial: 'glasses-1' }).serial, 'glasses-1');
  assert.throws(() => selectWearableDevice({ devices, requestedSerial: 'missing' }), /requested-wearable-device-not-ready/);
});

test('wearable field runner CLI keeps device selection explicit', () => {
  assert.deepEqual(parseWearableFieldRunnerArgs([
    '--serial', 'glasses-1',
    '--skip-build',
    '--skip-install',
    '--output', 'dist/custom.json'
  ], { env: {} }), {
    serial: 'glasses-1',
    build: false,
    install: false,
    jsonPath: 'dist/custom.json'
  });
});

test('wearable field runner invokes the Gradle batch wrapper through cmd on Windows', () => {
  const invocation = createGradleBuildInvocation({
    root: 'C:\\Jarvis',
    projectDir: 'C:\\Jarvis\\apps\\wearable-field-runner',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    platform: 'win32'
  });
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args.slice(0, 4), [
    '/d',
    '/s',
    '/c',
    'C:\\Jarvis\\apps\\mobile\\android\\gradlew.bat'
  ]);
  assert.deepEqual(invocation.args.slice(4), [
    '-p',
    'C:\\Jarvis\\apps\\wearable-field-runner',
    ':app:assembleDebug',
    '--no-daemon'
  ]);
});

test('wearable WebView host enforces the loopback and microphone security boundary', async () => {
  const manifest = await readFile('apps/wearable-field-runner/app/src/main/AndroidManifest.xml', 'utf8');
  const network = await readFile('apps/wearable-field-runner/app/src/main/res/xml/network_security_config.xml', 'utf8');
  const activity = await readFile('apps/wearable-field-runner/app/src/main/java/local/eureka/jarvis/wearablefield/FieldLabActivity.java', 'utf8');
  const nativeAudio = await readFile('apps/wearable-field-runner/app/src/main/java/local/eureka/jarvis/wearablefield/NativeAudioLoopbackServer.java', 'utf8');

  assert.match(manifest, /android\.permission\.RECORD_AUDIO/);
  assert.match(manifest, /android\.permission\.MODIFY_AUDIO_SETTINGS/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(network, /base-config cleartextTrafficPermitted="false"/);
  assert.match(network, />127\.0\.0\.1</);
  assert.match(activity, /setAllowFileAccess\(false\)/);
  assert.match(activity, /setAllowContentAccess\(false\)/);
  assert.match(activity, /setMixedContentMode\(WebSettings\.MIXED_CONTENT_NEVER_ALLOW\)/);
  assert.match(activity, /PermissionRequest\.RESOURCE_AUDIO_CAPTURE/);
  assert.match(activity, /JARVIS-Native-Audio\/1\.0/);
  assert.match(nativeAudio, /InetAddress\.getByName\("127\.0\.0\.1"\)/);
  assert.match(nativeAudio, /MediaRecorder\.AudioSource\.VOICE_RECOGNITION/);
  assert.match(nativeAudio, /ToneGenerator\.TONE_PROP_BEEP/);
  assert.match(nativeAudio, /X-Jarvis-Capture-Cue/);
  assert.match(nativeAudio, /ROKID_AUDIO_CHANNEL_MASK = 0x3c/);
  assert.match(nativeAudio, /ROKID_VIDEO_CHANNEL_MASK = 0x6000fc/);
  assert.match(nativeAudio, /extractInputChannel/);
  assert.match(nativeAudio, /rawAudioStored\\\":false/);
  assert.match(nativeAudio, /origin_not_allowed/);
  const onCreateStart = activity.indexOf('protected void onCreate');
  const onCreateEnd = activity.indexOf('@Override', onCreateStart + 1);
  const onCreate = activity.slice(onCreateStart, onCreateEnd);
  assert.ok(onCreate.indexOf('setContentView(webView);') < onCreate.indexOf('enterImmersiveMode();'));
  assert.match(activity, /decorView\.getWindowInsetsController\(\)/);
  assert.doesNotMatch(activity, /addJavascriptInterface/);
});
