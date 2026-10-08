import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  evaluateVoiceAutoSubmit,
  evaluateVoiceReadbackConfirmation,
  evaluateVoiceRepeatConfirmation,
  normalizeVoiceConfidence
} from '../apps/mobile/src/voice/voice-evidence.js';

test('mobile voice confidence treats the native -1 sentinel as unavailable', () => {
  assert.equal(normalizeVoiceConfidence(-1), null);
  assert.equal(normalizeVoiceConfidence(undefined), null);
  assert.equal(normalizeVoiceConfidence(null), null);
  assert.equal(normalizeVoiceConfidence(0), 0);
  assert.equal(normalizeVoiceConfidence(0.82), 0.82);
  assert.equal(normalizeVoiceConfidence(2), null);
});

test('mobile voice auto-submit blocks only explicit low-confidence final results', () => {
  assert.deepEqual(evaluateVoiceAutoSubmit({ confidence: -1 }), {
    accepted: true,
    confidence: null,
    threshold: 0.5,
    reason: 'confidence-unavailable'
  });
  assert.equal(evaluateVoiceAutoSubmit({ confidence: 0 }).accepted, false);
  assert.equal(evaluateVoiceAutoSubmit({ confidence: 0.49 }).accepted, false);
  assert.equal(evaluateVoiceAutoSubmit({ confidence: 0.5 }).accepted, true);
  assert.equal(evaluateVoiceAutoSubmit({ confidence: 0.9 }).accepted, true);
});

test('Android recognizer preserves unavailable confidence without weakening zero-confidence blocking', async () => {
  const [dependencyPatch, installedSource, rootPackage] = await Promise.all([
    readFile('patches/expo-speech-recognition@3.1.3.patch', 'utf8'),
    readFile('apps/mobile/node_modules/expo-speech-recognition/android/src/main/java/expo/modules/speechrecognition/ExpoSpeechService.kt', 'utf8'),
    readFile('package.json', 'utf8')
  ]);
  assert.match(dependencyPatch, /confidences\?\.getOrNull\(index\) \?: -1f/);
  assert.match(installedSource, /confidences\?\.getOrNull\(index\) \?: -1f/);
  assert.doesNotMatch(installedSource, /confidences\?\.getOrNull\(index\) \?: 0f/);
  assert.equal(
    JSON.parse(rootPackage).pnpm.patchedDependencies['expo-speech-recognition@3.1.3'],
    'patches/expo-speech-recognition@3.1.3.patch'
  );
});

test('low-confidence voice commands require independent-engine or triple-repeat consensus', () => {
  const first = evaluateVoiceRepeatConfirmation(null, {
    transcript: '파일 목록 보여 줘',
    engine: 'engine-a',
    now: 1_000
  });
  assert.equal(first.accepted, false);
  assert.equal(first.count, 1);

  const independent = evaluateVoiceRepeatConfirmation(first.candidate, {
    transcript: '파일 목록 보여줘',
    engine: 'engine-b',
    now: 2_000
  });
  assert.equal(independent.accepted, true);
  assert.equal(independent.reason, 'independent-engine-consensus');
  assert.equal(independent.independentEngineCount, 2);

  const divergent = evaluateVoiceRepeatConfirmation(first.candidate, {
    transcript: '발 목록 보여 줘',
    engine: 'engine-b',
    now: 2_000
  });
  assert.equal(divergent.accepted, false);
  const recovered = evaluateVoiceRepeatConfirmation(divergent.candidate, {
    transcript: '파일 목록 보여줘',
    engine: 'engine-c',
    now: 3_000
  });
  assert.equal(recovered.accepted, true);
  assert.equal(recovered.reason, 'independent-engine-consensus');
  assert.equal(recovered.independentEngineCount, 2);

  const sameEngineSecond = evaluateVoiceRepeatConfirmation(first.candidate, {
    transcript: '파일 목록 보여줘',
    engine: 'engine-a',
    now: 2_000
  });
  assert.equal(sameEngineSecond.accepted, false);
  const sameEngineThird = evaluateVoiceRepeatConfirmation(sameEngineSecond.candidate, {
    transcript: '파일 목록 보여줘',
    engine: 'engine-a',
    now: 3_000
  });
  assert.equal(sameEngineThird.accepted, true);
  assert.equal(sameEngineThird.reason, 'same-engine-triple-consensus');

  const expired = evaluateVoiceRepeatConfirmation(first.candidate, {
    transcript: '파일 목록 보여줘',
    engine: 'engine-b',
    now: 100_000
  });
  assert.equal(expired.accepted, false);
  assert.equal(expired.count, 1);
});

test('low-confidence readback accepts only a clear short confirmation inside the active window', () => {
  const pending = {
    at: 1_000,
    transcript: '파일 목록 보여 줘',
    evidence: { confidence: 0, engine: 'engine-a' }
  };
  const accepted = evaluateVoiceReadbackConfirmation(pending, {
    transcript: '네 맞아요',
    engine: 'engine-b',
    evidence: { confidence: 0.91 },
    now: 2_000
  });
  assert.equal(accepted.handled, true);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.transcript, pending.transcript);
  assert.equal(accepted.reason, 'explicit-affirmation');
  assert.equal(accepted.confirmationCount, 2);
  assert.equal(accepted.independentEngineCount, 2);
  assert.equal(accepted.confirmationEngine, 'engine-b');
  assert.equal(accepted.confirmationConfidence, 0.91);

  const rejected = evaluateVoiceReadbackConfirmation(pending, {
    transcript: '아니요',
    engine: 'engine-b',
    evidence: { confidence: 0.86 },
    now: 2_000
  });
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.accepted, false);

  const lowConfidence = evaluateVoiceReadbackConfirmation(pending, {
    transcript: '네',
    engine: 'engine-b',
    evidence: { confidence: 0 },
    now: 2_000
  });
  assert.equal(lowConfidence.handled, true);
  assert.equal(lowConfidence.accepted, false);
  assert.equal(lowConfidence.reason, 'confirmation-low-confidence');

  const commandThatStartsWithYes = evaluateVoiceReadbackConfirmation(pending, {
    transcript: '네트워크 상태 알려 줘',
    engine: 'engine-b',
    evidence: { confidence: 0.95 },
    now: 2_000
  });
  assert.equal(commandThatStartsWithYes.handled, false);

  const expired = evaluateVoiceReadbackConfirmation(pending, {
    transcript: '네',
    engine: 'engine-b',
    evidence: { confidence: 0.95 },
    now: 100_001
  });
  assert.equal(expired.handled, false);
  assert.equal(expired.reason, 'confirmation-expired');
});

test('mobile voice UI waits for native readiness and records acoustic diagnostics', async () => {
  const [voiceMode, recognitionPolicy, app, mobilePackage] = await Promise.all([
    readFile('apps/mobile/src/voice/voiceMode.ts', 'utf8'),
    readFile('apps/mobile/src/voice/recognitionPolicy.js', 'utf8'),
    readFile('apps/mobile/src/App.tsx', 'utf8'),
    readFile('apps/mobile/package.json', 'utf8')
  ]);
  assert.match(voiceMode, /useSpeechRecognitionEvent\('audiostart'/);
  assert.match(voiceMode, /useSpeechRecognitionEvent\('start'/);
  assert.match(voiceMode, /useSpeechRecognitionEvent\('speechstart'/);
  assert.match(voiceMode, /useSpeechRecognitionEvent\('volumechange'/);
  assert.match(voiceMode, /volumeChangeEventOptions:\s*\{\s*enabled:\s*true/);
  assert.match(recognitionPolicy, /com\.google\.android\.as/);
  assert.match(recognitionPolicy, /com\.google\.android\.tts/);
  assert.match(voiceMode, /getDefaultRecognitionService/);
  assert.match(voiceMode, /rotateRecognitionEngine/);
  assert.match(voiceMode, /androidRecognitionServicePackage/);
  assert.match(voiceMode, /startListeningFromAudioFile/);
  assert.match(voiceMode, /sampleRate:\s*16000/);
  assert.match(app, /voicePhase:\s*'starting'/);
  assert.match(app, /voicePhase:\s*'ready'/);
  assert.match(app, /voiceSessionRef/);
  assert.match(app, /rotateRecognitionEngine/);
  assert.match(app, /evaluateVoiceRepeatConfirmation/);
  assert.match(app, /confirmationMode:\s*'repeat-consensus'/);
  assert.match(app, /evaluateVoiceReadbackConfirmation/);
  assert.match(app, /confirmationMode:\s*'voice-readback'/);
  assert.match(app, /confirmationEngine:\s*voiceEvidence\?\.confirmationEngine/);
  assert.match(app, /confirmationTranscriptStored:\s*false/);
  assert.match(app, /homeSayThenListen/);
  assert.match(app, /homeSetListening\(nextListening: boolean\)/);
  assert.match(app, /\['start', 'stop'\]\.includes\(link\.segment\)/);
  assert.match(app, /Application\.applicationId !== isolatedE2EPackage/);
  assert.match(app, /source\.hostname === '127\.0\.0\.1'/);
  assert.match(app, /source\.pathname === isolatedE2EVoiceFixturePath/);
  assert.match(app, /FileSystem\.downloadAsync/);
  assert.match(app, /FileSystem\.deleteAsync/);
  assert.match(app, /jarvis-e2e-voice-cleanup/);
  assert.match(app, /mobile_voice_conversation_requires_pc_confirmation/);
  assert.match(app, /requestPcConfirmation\(card\.approvalId/);
  assert.match(app, /homeTrackPcConfirmation\(card\.taskId, seq\)/);
  assert.match(app, /testID="home-pc-voice-confirmation"/);
  assert.match(app, /자비스 \{home\.pcHandoff\.voiceChallenge\.phrase\} 승인/);
  assert.doesNotMatch(app, /storage\/emulated\/0\/Android\/data/);
  assert.equal(JSON.parse(mobilePackage).dependencies['expo-file-system'], '~18.1.11');
  assert.match(app, /마이크에 음성이 들어오지 않았어요/);
});
