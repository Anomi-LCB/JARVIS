import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  computeAndroidScrollGesture,
  hasActiveAndroidTouchState,
  isPairedHomeScreen,
  isUnpairedHomeScreen,
  parseAndroidFocusedPackage,
  parseAndroidDisplaySize
} from '../scripts/mobile-live-bridge-e2e.mjs';

test('paired mobile home remains detectable when the connection badge is clipped by scroll', () => {
  const commandSurface = [
    'screen-content-HomeScreen',
    'home-command-input',
    'home-submit-button'
  ].join(' ');
  assert.equal(isPairedHomeScreen(commandSurface), false);
  assert.equal(isPairedHomeScreen(`${commandSurface} content-desc="JARVIS 모바일 앱, 연결됨"`), true);
  assert.equal(isPairedHomeScreen(`${commandSurface} text="연결됨" home-pair-button`), false);
});

test('unpaired mobile home requires both an explicit state marker and actionable pairing controls', () => {
  const unpaired = [
    'screen-content-HomeScreen',
    'content-desc="JARVIS 모바일 앱, 연결 필요"',
    '<node resource-id="home-bridge-url-input" text="http://adb.localhost:17777" hint="" bounds="[0,0][1,1]" />',
    '<node resource-id="home-pairing-code-input" text="" hint="페어링 코드 8자리" bounds="[0,0][1,1]" />',
    'home-pair-button'
  ].join(' ');
  assert.equal(isUnpairedHomeScreen(unpaired), true);
  assert.equal(isUnpairedHomeScreen(unpaired.replace('home-pair-button', '')), false);
  assert.equal(isUnpairedHomeScreen(unpaired.replace('연결 필요', '연결됨')), false);
});

test('Android foreground and stale-touch probes fail closed on ambiguous device state', () => {
  assert.equal(
    parseAndroidFocusedPackage('mCurrentFocus=Window{123 u0 local.eureka.jarvis.e2e/local.eureka.jarvis.MainActivity}'),
    'local.eureka.jarvis.e2e'
  );
  assert.equal(parseAndroidFocusedPackage('mCurrentFocus=Window{123 u0 UnintentionalLcdOn}'), null);
  assert.equal(hasActiveAndroidTouchState('TouchStatesByDisplay: <no displays touched>'), false);
  assert.equal(hasActiveAndroidTouchState('TouchStatesByDisplay:\n  0 : Windows:\n Pointer(id=2, FINGER)'), true);
  assert.equal(hasActiveAndroidTouchState('input dump unavailable'), false);
});

test('mobile live E2E uses the active Android override display size', () => {
  assert.deepEqual(
    parseAndroidDisplaySize('Physical size: 1440x3088\nOverride size: 720x1544\n'),
    { width: 720, height: 1544 }
  );
  assert.equal(parseAndroidDisplaySize('display size unavailable'), null);
});

test('mobile live E2E scroll gestures stay inside the device viewport', () => {
  const down = computeAndroidScrollGesture({ width: 720, height: 1544 }, 'down');
  const up = computeAndroidScrollGesture({ width: 720, height: 1544 }, 'up');

  for (const gesture of [down, up]) {
    assert.ok(gesture.startX >= 0 && gesture.startX < 720);
    assert.ok(gesture.endX >= 0 && gesture.endX < 720);
    assert.ok(gesture.startY >= 0 && gesture.startY < 1544);
    assert.ok(gesture.endY >= 0 && gesture.endY < 1544);
  }
  assert.equal(down.startY, up.endY);
  assert.equal(down.endY, up.startY);
  assert.ok(down.startY > down.endY);
});

test('native voice touch fallback is isolated and honestly labeled', async () => {
  const [app, harness] = await Promise.all([
    readFile('apps/mobile/src/App.tsx', 'utf8'),
    readFile('scripts/mobile-live-bridge-e2e.mjs', 'utf8')
  ]);

  assert.match(app, /Application\.applicationId !== isolatedE2EPackage/);
  assert.match(app, /void homeSetListening\(link\.segment === 'start'\)/);
  assert.match(app, /isolatedE2ECommandFixtures = new Set\(\['list files'\]\)/);
  assert.match(app, /void homeSubmit\(commandText\)/);
  assert.match(app, /void homeDecide\(link\.segment === 'approve'/);
  assert.match(harness, /activationTransport: 'isolated-e2e-deep-link'/);
  assert.match(harness, /physicalTapAccepted: false/);
  assert.match(harness, /physicalInputAccepted: commandInput\.entered/);
  assert.match(harness, /packageName === androidPackageName/);
  assert.match(harness, /android-app-data-clear-not-verified/);
  assert.match(harness, /android-foreground-recovery-failed/);
  assert.match(harness, /display-sleep-wake-cycle/);
  assert.doesNotMatch(harness, /input touchscreen swipe 540 520 540 1680/);
});
