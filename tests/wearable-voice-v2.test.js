import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  WearableVoiceSession,
  classifyWearableFallbackError,
  classifyWearableVoiceError,
  createHttpAudioFallbackTranscriber,
  createWearableVoiceCapabilityReport
} from '../apps/wearable-hud/src/voice-session.js';
import {
  analyzeWearableAudioFrames,
  analyzeWearableNativeCapture,
  createWearableNativeAudioCapture,
  createWearablePhysicalFieldReport,
  decodeWearablePcm16Wav,
  evaluateWearablePhysicalFieldReport,
  measureWearableMicrophone
} from '../apps/wearable-hud/src/field-lab.js';
import {
  createWearableFieldServer,
  isFetchSafePort,
  listenWearableFieldServer,
  storeFieldEvidence
} from '../apps/wearable-hud/src/field-server.mjs';
import { runWearablePhysicalFieldGate } from '../scripts/wearable-physical-field-gate.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('Voice 2.0 finalizes native speech without persisting transcript and supports barge-in', async () => {
  let recognizer;
  let spokenText = '';
  let cancelled = 0;
  let handledTranscript = '';
  class Utterance {
    constructor(text) {
      spokenText = text;
    }
  }
  const synthesis = {
    speaking: false,
    cancel() {
      cancelled += 1;
      this.speaking = false;
    },
    speak(utterance) {
      this.speaking = true;
      utterance.onstart?.();
    }
  };
  const session = new WearableVoiceSession({
    windowRef: { speechSynthesis: synthesis, SpeechSynthesisUtterance: Utterance },
    recognitionFactory: () => {
      recognizer = {
        start() { this.onstart?.(); },
        abort() {},
        stop() { this.onend?.(); }
      };
      return recognizer;
    },
    config: { endSilenceMs: 5, maxUtteranceMs: 500 },
    onFinalTranscript: (transcript) => {
      handledTranscript = transcript;
    }
  });

  await session.start();
  assert.equal(session.speak('token=do-not-speak 상태를 확인했습니다'), true);
  assert.doesNotMatch(spokenText, /do-not-speak/);
  recognizer.onspeechstart();
  recognizer.onresult({
    resultIndex: 0,
    results: [Object.assign([{ transcript: '자비스 token=voice-secret 상태 보여줘', confidence: 0.94 }], { isFinal: true })]
  });
  await wait(20);

  assert.equal(handledTranscript, '자비스 token=voice-secret 상태 보여줘');
  assert.ok(cancelled >= 2);
  assert.equal(session.snapshot().bargeInCount, 1);
  assert.equal(session.snapshot().utteranceCount, 1);
  assert.doesNotMatch(JSON.stringify(session.snapshot()), /voice-secret/);
  assert.deepEqual(session.snapshot().privacy, {
    rawTranscriptStored: false,
    rawAudioStored: false,
    interimContentStored: false,
    telemetryContainsContent: false
  });
  session.destroy();
});

test('Voice 2.0 recovers from a transient recognizer failure with bounded restart', async () => {
  const recognizers = [];
  const session = new WearableVoiceSession({
    windowRef: {},
    recognitionFactory: () => {
      const recognizer = {
        start() { this.onstart?.(); },
        abort() {},
        stop() { this.onend?.(); }
      };
      recognizers.push(recognizer);
      return recognizer;
    },
    config: { restartBaseDelayMs: 5, restartMaxDelayMs: 5, maxUtteranceMs: 1000 }
  });

  await session.start();
  recognizers[0].onerror({ error: 'network' });
  recognizers[0].onend();
  await wait(20);

  assert.ok(recognizers.length >= 2);
  assert.equal(session.snapshot().phase, 'listening');
  assert.equal(session.snapshot().recoverableErrorCount, 1);
  assert.equal(session.snapshot().restartCount, 0);
  assert.equal(classifyWearableVoiceError('not-allowed').retryable, false);
  session.destroy();
});

test('Voice 2.0 uses a push-to-talk fallback when native recognition is unavailable', async () => {
  let transcriptHandled;
  let resolveHandled;
  const handled = new Promise((resolvePromise) => { resolveHandled = resolvePromise; });
  const session = new WearableVoiceSession({
    windowRef: {},
    fallbackTranscriber: async () => ({
      transcript: '자비스 상태 보여줘',
      confidence: 0.88,
      provider: 'test-local-stt'
    }),
    onFinalTranscript: (transcript) => {
      transcriptHandled = transcript;
      resolveHandled();
    }
  });

  await session.start();
  await handled;
  await wait(0);
  assert.equal(transcriptHandled, '자비스 상태 보여줘');
  assert.equal(session.snapshot().provider, 'test-local-stt');
  assert.equal(session.snapshot().desiredActive, false);
  assert.equal(session.snapshot().phase, 'idle');
  assert.doesNotMatch(JSON.stringify(session.snapshot()), /상태 보여줘/);
});

test('Voice 2.0 distinguishes empty local STT audio from a network failure', async () => {
  const session = new WearableVoiceSession({
    windowRef: {},
    fallbackTranscriber: async () => {
      const error = new Error('transcription returned no speech');
      error.code = 'stt_empty_transcript';
      throw error;
    }
  });

  await session.start();
  assert.equal(session.snapshot().phase, 'error');
  assert.equal(session.snapshot().lastError.code, 'no-speech');
  assert.equal(session.snapshot().lastError.category, 'silence');
  assert.equal(classifyWearableFallbackError({ code: 'native-audio-http-503' }).category, 'microphone');
  assert.equal(classifyWearableFallbackError({ code: 'voice-transcribe-http-500' }).category, 'network');
});

test('dedicated wearable runner prefers local STT over a nonfunctional WebView recognizer', async () => {
  let nativeConstructed = 0;
  let fallbackCalls = 0;
  let handledTranscript = '';
  class Recognition {
    constructor() {
      nativeConstructed += 1;
    }
  }
  const session = new WearableVoiceSession({
    windowRef: { webkitSpeechRecognition: Recognition },
    config: { preferLocalStt: true },
    fallbackTranscriber: async () => {
      fallbackCalls += 1;
      return { transcript: '자비스 상태 보여줘', confidence: 0.9, provider: 'test-local-stt' };
    },
    onFinalTranscript: (transcript) => {
      handledTranscript = transcript;
    }
  });

  await session.start();
  await wait(0);
  assert.equal(nativeConstructed, 0);
  assert.equal(fallbackCalls, 1);
  assert.equal(handledTranscript, '자비스 상태 보여줘');
  assert.equal(session.snapshot().provider, 'test-local-stt');
});

test('HTTP audio fallback uses the field-server contract and discards captured chunks', async () => {
  let receivedRequest;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() {
      this.mimeType = 'audio/webm';
    }
    start() {
      queueMicrotask(() => this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) }));
    }
    stop() {
      queueMicrotask(() => this.onstop?.());
    }
  }
  const track = { stopped: false, stop() { this.stopped = true; } };
  const transcribe = createHttpAudioFallbackTranscriber({
    windowRef: {
      MediaRecorder: Recorder,
      navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } }
    },
    fetchImpl: async (url, options) => {
      receivedRequest = { url, options };
      return { ok: true, status: 200, json: async () => ({ transcript: '완료', confidence: 0.9 }) };
    }
  });
  const result = await transcribe({ lang: 'ko-KR', maxDurationMs: 1 });

  assert.equal(result.transcript, '완료');
  assert.equal(receivedRequest.options.headers['x-jarvis-wearable-request'], 'voice-transcription-v1');
  assert.equal(receivedRequest.options.headers['x-jarvis-language'], 'ko-KR');
  assert.equal(track.stopped, true);
});

test('dedicated runner sends native WAV capture to local STT and disposes the in-memory audio', async () => {
  let disposed = false;
  let receivedRequest;
  const audio = new Uint8Array([1, 2, 3, 4]).buffer;
  const transcribe = createHttpAudioFallbackTranscriber({
    windowRef: {},
    captureAudio: async () => ({
      audio,
      mimeType: 'audio/wav',
      dispose() {
        new Uint8Array(audio).fill(0);
        disposed = true;
      }
    }),
    fetchImpl: async (url, options) => {
      receivedRequest = { url, options };
      return { ok: true, status: 200, json: async () => ({ transcript: '자비스 상태 보여줘', confidence: 0.91 }) };
    }
  });

  const result = await transcribe({ maxDurationMs: 600 });

  assert.equal(result.transcript, '자비스 상태 보여줘');
  assert.equal(receivedRequest.options.headers['content-type'], 'audio/wav');
  assert.equal(disposed, true);
  assert.deepEqual([...new Uint8Array(audio)], [0, 0, 0, 0]);
});

test('native runner WAV is decoded and measured without retaining raw audio', async () => {
  const samples = Int16Array.from({ length: 16000 * 2 }, (_, index) => {
    if (index < 16000 / 2) return index % 2 === 0 ? 18 : -18;
    return Math.round(Math.sin(index / 9) * 9000);
  });
  const wav = createPcm16Wav(samples, 16000);
  let disposed = false;
  const microphone = await measureWearableMicrophone({
    durationMs: 2000,
    captureAudio: async () => ({
      audio: wav.buffer,
      source: 'voice-recognition',
      dispose() { disposed = true; }
    })
  });

  assert.equal(microphone.status, 'passed');
  assert.equal(microphone.provider, 'android-native-loopback');
  assert.equal(microphone.audioSource, 'voice-recognition');
  assert.equal(microphone.sampleRateHz, 16000);
  assert.equal(disposed, true);
  assert.equal(microphone.privacy.rawAudioStored, false);
  assert.equal(decodeWearablePcm16Wav(wav.buffer).sampleCount, samples.length);
  const direct = analyzeWearableNativeCapture({
    audio: wav.buffer.slice(0),
    source: 'rokid-array-4ch-ch4',
    captureCue: 'device-tone'
  });
  assert.equal(direct.audioSource, 'rokid-array-4ch-ch4');
  assert.equal(direct.captureCue, 'device-tone');
});

test('native audio client allows only the dedicated loopback endpoint and erases capture on dispose', async () => {
  const wav = createPcm16Wav(Int16Array.from({ length: 1600 }, (_, index) => index % 2 === 0 ? 200 : -200), 16000);
  const capture = createWearableNativeAudioCapture({
    windowRef: {},
    fetchImpl: async (url, options) => {
      assert.match(url, /^http:\/\/127\.0\.0\.1:4186\/audio\/capture\?durationMs=500&cue=1$/);
      assert.equal(options.method, 'POST');
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => ({
          'content-type': 'audio/wav',
          'x-jarvis-audio-source': 'voice-recognition',
          'x-jarvis-sample-rate': '16000',
          'x-jarvis-capture-cue': 'device-tone'
        })[name] ?? null },
        arrayBuffer: async () => wav.buffer.slice(0)
      };
    }
  });
  const result = await capture({ maxDurationMs: 100 });
  assert.equal(result.source, 'voice-recognition');
  assert.equal(result.captureCue, 'device-tone');
  const bytes = new Uint8Array(result.audio);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  result.dispose();
  assert.ok(bytes.every((value) => value === 0));
  assert.throws(() => createWearableNativeAudioCapture({ endpoint: 'http://example.com:4186/audio/capture', fetchImpl: fetch }), /not-allowed/);
});

test('wearable physical report requires measured signal, privacy, scenarios, and real-device confirmation', () => {
  const noiseFrame = Float32Array.from({ length: 128 }, (_, index) => (index % 2 === 0 ? 0.003 : -0.003));
  const speechFrame = Float32Array.from({ length: 128 }, (_, index) => Math.sin(index / 3) * 0.2);
  const microphone = analyzeWearableAudioFrames([
    ...Array.from({ length: 4 }, () => noiseFrame),
    ...Array.from({ length: 10 }, () => speechFrame)
  ]);
  assert.equal(microphone.status, 'passed');

  const pending = createWearablePhysicalFieldReport({
    ...validFieldInputs(microphone),
    physicalDeviceConfirmed: false
  });
  assert.equal(evaluateWearablePhysicalFieldReport(pending).status, 'ready-for-physical-device');

  const insecure = createWearablePhysicalFieldReport({
    ...validFieldInputs(microphone),
    capability: { secureContext: false },
    physicalDeviceConfirmed: true
  });
  assert.equal(insecure.status, 'needs-adjustment');
  assert.equal(evaluateWearablePhysicalFieldReport(insecure).status, 'blocked');

  const passed = createWearablePhysicalFieldReport({
    ...validFieldInputs(microphone),
    physicalDeviceConfirmed: true
  });
  assert.equal(passed.status, 'passed');
  assert.equal(evaluateWearablePhysicalFieldReport(passed).status, 'passed');
});

test('field server stores integrity-addressed evidence and rejects unmarked writes', async () => {
  const root = await temporaryDirectory();
  await writeFile(resolve(root, 'index.html'), '<h1>field</h1>', 'utf8');
  const report = createWearablePhysicalFieldReport({
    ...validFieldInputs(passingMicrophone()),
    physicalDeviceConfirmed: true
  });
  const server = createWearableFieldServer({ root });
  const address = await listen(server);
  try {
    const rejected = await fetch(`http://127.0.0.1:${address.port}/field-evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report)
    });
    assert.equal(rejected.status, 403);

    const stored = await fetch(`http://127.0.0.1:${address.port}/field-evidence`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-jarvis-wearable-request': 'physical-field-evidence-v1'
      },
      body: JSON.stringify(report)
    });
    assert.equal(stored.status, 201);
    const result = await stored.json();
    assert.equal(result.evidenceId.length, 64);

    const latest = await fetch(`http://127.0.0.1:${address.port}/field-evidence/latest`);
    const metadata = await latest.json();
    assert.equal(metadata.evidenceId, result.evidenceId);
    assert.equal(metadata.reportStatus, 'passed');
  } finally {
    await close(server);
  }
});

test('field server rejects sensitive evidence content before it reaches disk', async () => {
  const root = await temporaryDirectory();
  const report = createWearablePhysicalFieldReport({
    ...validFieldInputs(passingMicrophone()),
    physicalDeviceConfirmed: true
  });
  report.debug = { rawTranscript: 'token=must-not-persist' };
  const server = createWearableFieldServer({ root });
  const address = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/field-evidence`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-jarvis-wearable-request': 'physical-field-evidence-v1'
      },
      body: JSON.stringify(report)
    });
    assert.equal(response.status, 422);
    const evidencePath = resolve(root, 'field-evidence', 'latest-field-evidence.json');
    await assert.rejects(stat(evidencePath), { code: 'ENOENT' });
  } finally {
    await close(server);
  }
});

test('field server invokes configured STT without a shell and removes temporary audio', async () => {
  const root = await temporaryDirectory();
  let observedInputPath = null;
  let observedOptions = null;
  const server = createWearableFieldServer({
    root,
    sttCommand: 'fake-stt',
    sttArgsJson: '["--input","{inputPath}","--language","{language}"]',
    executeFile: async (command, args, options) => {
      assert.equal(command, 'fake-stt');
      observedInputPath = args[1];
      observedOptions = options;
      assert.equal(args[3], 'ko-KR');
      assert.equal((await stat(observedInputPath)).isFile(), true);
      return { stdout: JSON.stringify({ text: '자비스 준비', confidence: 0.91 }), stderr: '' };
    }
  });
  const address = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/voice/transcribe`, {
      method: 'POST',
      headers: {
        'content-type': 'audio/webm',
        'x-jarvis-wearable-request': 'voice-transcription-v1',
        'x-jarvis-language': 'ko-KR'
      },
      body: Buffer.from('test-audio')
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.transcript, '자비스 준비');
    assert.equal(result.privacy.rawAudioStored, false);
    assert.equal(observedOptions.shell, false);
    await assert.rejects(stat(observedInputPath), { code: 'ENOENT' });
  } finally {
    await close(server);
  }
});

test('field server returns an allowlisted empty-speech code without exposing STT internals', async () => {
  const root = await temporaryDirectory();
  const server = createWearableFieldServer({
    root,
    sttCommand: 'fake-stt',
    executeFile: async () => ({ stdout: JSON.stringify({ transcript: '' }), stderr: 'private-provider-detail' })
  });
  const address = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/voice/transcribe`, {
      method: 'POST',
      headers: {
        'content-type': 'audio/wav',
        'x-jarvis-wearable-request': 'voice-transcription-v1'
      },
      body: Buffer.from('quiet-audio')
    });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.deepEqual(payload, { error: { code: 'stt_empty_transcript', message: 'stt_empty_transcript' } });
    assert.doesNotMatch(JSON.stringify(payload), /private-provider-detail/);
  } finally {
    await close(server);
  }
});

test('field server keeps one local STT daemon warm across requests', async () => {
  const root = await temporaryDirectory();
  const daemonPath = resolve('tests/fixtures/fake-stt-daemon.mjs');
  const server = createWearableFieldServer({
    root,
    sttCommand: process.execPath,
    sttArgsJson: JSON.stringify([daemonPath]),
    sttMode: 'daemon'
  });
  const address = await listen(server);
  const endpoint = `http://127.0.0.1:${address.port}`;
  const headers = {
    'content-type': 'audio/webm',
    'x-jarvis-wearable-request': 'voice-transcription-v1',
    'x-jarvis-language': 'ko-KR'
  };
  try {
    const first = await fetch(`${endpoint}/voice/transcribe`, {
      method: 'POST',
      headers,
      body: Buffer.from('first-audio')
    });
    const second = await fetch(`${endpoint}/voice/transcribe`, {
      method: 'POST',
      headers,
      body: Buffer.from('second-audio')
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await first.json()).transcript, 'daemon-1');
    assert.equal((await second.json()).transcript, 'daemon-2');

    const health = await fetch(`${endpoint}/health`).then((response) => response.json());
    assert.equal(health.voice.mode, 'persistent-local');
    assert.equal(health.voice.state, 'ready');
    assert.deepEqual(health.privacy, { rawAudioStored: false, rawTranscriptLogged: false });
  } finally {
    await close(server);
  }
});

test('field server blocks cross-origin STT and applies a privacy-preserving request rate limit', async () => {
  const root = await temporaryDirectory();
  let executionCount = 0;
  const server = createWearableFieldServer({
    root,
    sttCommand: 'fake-stt',
    executeFile: async () => {
      executionCount += 1;
      return { stdout: '상태 확인', stderr: '' };
    }
  });
  const address = await listen(server);
  const url = `http://127.0.0.1:${address.port}/voice/transcribe`;
  const headers = {
    'content-type': 'audio/webm',
    'x-jarvis-wearable-request': 'voice-transcription-v1'
  };
  try {
    const crossOrigin = await fetch(url, {
      method: 'POST',
      headers: { ...headers, origin: 'https://example.com' },
      body: Buffer.from('audio')
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(executionCount, 0);

    const statuses = [];
    for (let index = 0; index < 7; index += 1) {
      const response = await fetch(url, { method: 'POST', headers, body: Buffer.from(`audio-${index}`) });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429]);
    assert.equal(executionCount, 6);
  } finally {
    await close(server);
  }
});

test('physical field gate distinguishes missing, valid, and tampered evidence', async () => {
  const root = await temporaryDirectory();
  const evidenceDir = resolve(root, 'evidence');
  const evidencePath = resolve(evidenceDir, 'latest-field-evidence.json');
  const jsonPath = resolve(root, 'gate.json');
  const markdownPath = resolve(root, 'gate.md');
  const missing = await runWearablePhysicalFieldGate({ evidencePath, jsonPath, markdownPath });
  assert.equal(missing.status, 'ready-for-physical-device');

  const report = createWearablePhysicalFieldReport({
    ...validFieldInputs(passingMicrophone()),
    physicalDeviceConfirmed: true
  });
  await storeFieldEvidence({ payload: report, evidenceDir });
  const valid = await runWearablePhysicalFieldGate({ evidencePath, jsonPath, markdownPath });
  assert.equal(valid.status, 'passed');

  const envelope = JSON.parse(await readFile(evidencePath, 'utf8'));
  envelope.report.status = 'tampered';
  await writeFile(evidencePath, JSON.stringify(envelope), 'utf8');
  const tampered = await runWearablePhysicalFieldGate({ evidencePath, jsonPath, markdownPath });
  assert.equal(tampered.status, 'blocked');
  assert.equal(tampered.integrity.state, 'invalid');
});

test('voice capability report exposes providers but no content-bearing telemetry', () => {
  const report = createWearableVoiceCapabilityReport({
    windowRef: {
      SpeechRecognition: class {},
      MediaRecorder: class {},
      navigator: { mediaDevices: { getUserMedia() {} }, permissions: { query() {} } },
      location: { hostname: '127.0.0.1' }
    }
  });
  assert.equal(report.status, 'voice-ready');
  assert.deepEqual(report.providerOrder, ['browser-speech-recognition', 'local-stt-gateway', 'manual-controls']);
  assert.equal(report.privacy.telemetryContainsContent, false);
});

function validFieldInputs(microphone) {
  return {
    capability: { secureContext: true },
    display: {
      viewport: { width: 320, height: 240 },
      layout: { horizontalOverflowPx: 0 },
      privacy: { screenshotStored: false, userAgentStored: false }
    },
    microphone,
    voice: {
      status: 'passed',
      activationDetected: true,
      intentName: 'show_status',
      rawTranscriptStored: false
    },
    network: {
      status: 'passed',
      privacy: { bridgeTokenStored: false }
    },
    scenarios: {
      indoorReadability: true,
      outdoorReadability: true,
      motionComfort: true,
      offlineRecovery: true,
      thermalBattery: true
    }
  };
}

function passingMicrophone() {
  return {
    status: 'passed',
    privacy: { rawAudioStored: false, audioFramesStored: false }
  };
}

function createPcm16Wav(samples, sampleRate) {
  const dataLength = samples.length * 2;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataLength, true);
  for (let index = 0; index < samples.length; index += 1) view.setInt16(44 + (index * 2), samples[index], true);
  return bytes;
}

async function temporaryDirectory() {
  const path = await mkdtemp(resolve(tmpdir(), 'jarvis-wearable-v2-'));
  temporaryDirectories.push(path);
  return path;
}

async function listen(server) {
  const address = await listenWearableFieldServer(server);
  assert.equal(isFetchSafePort(address.port), true);
  return address;
}

async function close(server) {
  await new Promise((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose())));
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}
