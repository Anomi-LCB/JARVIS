import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildRecognitionServiceOrder,
  isRecoverableRecognitionStartError,
  recognitionStartupTimeoutMs
} from '../apps/mobile/src/voice/recognitionPolicy.js';

test('Android system default recognizer is selected before vendor fallbacks', () => {
  assert.deepEqual(
    buildRecognitionServiceOrder({
      availableServices: [
        'com.google.android.as',
        'com.google.android.tts',
        'com.samsung.android.bixby.agent'
      ],
      defaultService: 'com.google.android.tts'
    }),
    [
      'com.google.android.tts',
      'com.google.android.as',
      'com.samsung.android.bixby.agent',
      'platform-default'
    ]
  );
});

test('recognizer order is deterministic, unique, and retains platform fallback', () => {
  assert.deepEqual(
    buildRecognitionServiceOrder({
      availableServices: ['', 'vendor.speech', 'vendor.speech', 'com.google.android.as'],
      defaultService: 'hidden.system.recognizer'
    }),
    ['platform-default', 'com.google.android.as', 'vendor.speech']
  );
  assert.deepEqual(buildRecognitionServiceOrder(), ['platform-default']);
});

test('startup recovery never bypasses explicit permission denial or cancellation', () => {
  assert.equal(isRecoverableRecognitionStartError('network'), true);
  assert.equal(isRecoverableRecognitionStartError('startup-timeout'), true);
  assert.equal(isRecoverableRecognitionStartError('not-allowed'), false);
  assert.equal(isRecoverableRecognitionStartError('aborted'), false);
  assert.equal(recognitionStartupTimeoutMs, 5000);
});

test('mobile voice runtime waits for native readiness and avoids duplicate error/end retries', async () => {
  const [voiceMode, app] = await Promise.all([
    readFile('apps/mobile/src/voice/voiceMode.ts', 'utf8'),
    readFile('apps/mobile/src/App.tsx', 'utf8')
  ]);
  assert.match(voiceMode, /getDefaultRecognitionService/);
  assert.match(voiceMode, /waitForRecognitionStart/);
  assert.match(voiceMode, /useSpeechRecognitionEvent\('audiostart'/);
  assert.match(voiceMode, /if \(!startupSettled && recognitionActive\) return/);
  assert.match(voiceMode, /recognitionModule\?\.abort\?\.\(\)/);
  assert.match(voiceMode, /if \(recognitionStartOperation\) return recognitionStartOperation/);
  assert.doesNotMatch(voiceMode, /handlers\.onNoSpeech\?\.\(\);\s*handlers\.onEnd/);
  assert.match(app, /if \(!\['aborted', 'not-allowed'\]\.includes\(code\)\) rotateRecognitionEngine\(\)/);
  assert.doesNotMatch(app, /onError: \(message, code\)[\s\S]{0,900}void convListen\(900\)/);
});
