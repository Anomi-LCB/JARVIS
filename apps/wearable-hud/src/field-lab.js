import { createWearableBrowserVoiceIntent } from './browser-client.js';
import {
  WearableVoiceSession,
  createHttpAudioFallbackTranscriber,
  createWearableVoiceCapabilityReport
} from './voice-session.js';

export const wearablePhysicalFieldReportVersion = 'c-d-wearable-physical-field-report-v1';
export const wearablePhysicalFieldGateVersion = 'c-d-wearable-physical-field-gate-v1';
export const wearableNativeAudioEndpoint = 'http://127.0.0.1:4186/audio/capture';

export const defaultWearablePhysicalThresholds = Object.freeze({
  minimumViewportWidth: 240,
  minimumViewportHeight: 160,
  minimumMicrophoneSnrDb: 10,
  maximumClippingRatio: 0.01,
  minimumSpeechLevelDbfs: -45,
  minimumMicrophoneFrames: 12,
  minimumNetworkAvailability: 0.95,
  maximumNetworkP95Ms: 1200,
  minimumNetworkSamples: 6
});

export function analyzeWearableAudioFrames(frames = [], thresholds = defaultWearablePhysicalThresholds) {
  const normalized = frames
    .map((frame) => Array.from(frame ?? []).map(Number).filter(Number.isFinite))
    .filter((frame) => frame.length > 0);
  const frameMetrics = normalized.map((frame) => {
    const squareMean = frame.reduce((sum, sample) => sum + (sample ** 2), 0) / frame.length;
    const rms = Math.sqrt(squareMean);
    const peak = frame.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
    const clipped = frame.filter((sample) => Math.abs(sample) >= 0.98).length;
    return {
      dbfs: rms > 0 ? 20 * Math.log10(rms) : -120,
      peak,
      clipped,
      sampleCount: frame.length
    };
  });
  const levels = frameMetrics.map((item) => item.dbfs).sort((left, right) => left - right);
  const totalSamples = frameMetrics.reduce((sum, item) => sum + item.sampleCount, 0);
  const clippedSamples = frameMetrics.reduce((sum, item) => sum + item.clipped, 0);
  const noiseFloorDbfs = round(percentile(levels, 0.2), 1);
  const speechLevelDbfs = round(percentile(levels, 0.9), 1);
  const snrDb = round(speechLevelDbfs - noiseFloorDbfs, 1);
  const clippingRatio = round(totalSamples > 0 ? clippedSamples / totalSamples : 0, 5);
  const peak = round(Math.max(0, ...frameMetrics.map((item) => item.peak)), 4);
  const passed = frameMetrics.length >= thresholds.minimumMicrophoneFrames
    && snrDb >= thresholds.minimumMicrophoneSnrDb
    && clippingRatio <= thresholds.maximumClippingRatio
    && speechLevelDbfs >= thresholds.minimumSpeechLevelDbfs;
  return {
    analysisVersion: 'c-d-wearable-microphone-signal-analysis-v1',
    status: passed ? 'passed' : 'needs-adjustment',
    frameCount: frameMetrics.length,
    sampleCount: totalSamples,
    noiseFloorDbfs,
    speechLevelDbfs,
    snrDb,
    clippingRatio,
    peak,
    thresholds: {
      minimumFrames: thresholds.minimumMicrophoneFrames,
      minimumSnrDb: thresholds.minimumMicrophoneSnrDb,
      maximumClippingRatio: thresholds.maximumClippingRatio,
      minimumSpeechLevelDbfs: thresholds.minimumSpeechLevelDbfs
    },
    privacy: {
      rawAudioStored: false,
      audioFramesStored: false
    }
  };
}

export function analyzeWearableNativeCapture(captured, {
  sampleIntervalMs = 50,
  thresholds = defaultWearablePhysicalThresholds
} = {}) {
  const decoded = decodeWearablePcm16Wav(captured?.audio ?? captured, { sampleIntervalMs });
  try {
    return {
      ...analyzeWearableAudioFrames(decoded.frames, thresholds),
      provider: 'android-native-loopback',
      audioSource: String(captured?.source ?? 'native').slice(0, 32),
      sampleRateHz: decoded.sampleRateHz,
      captureCue: String(captured?.captureCue ?? 'unknown').slice(0, 32)
    };
  } finally {
    for (const frame of decoded.frames) frame.fill(0);
  }
}

export async function measureWearableMicrophone({
  windowRef = globalThis.window,
  durationMs = 3500,
  sampleIntervalMs = 50,
  thresholds = defaultWearablePhysicalThresholds,
  captureAudio = null
} = {}) {
  if (typeof captureAudio === 'function') {
    let captured = null;
    try {
      captured = await captureAudio({ maxDurationMs: durationMs });
      return analyzeWearableNativeCapture(captured, { sampleIntervalMs, thresholds });
    } catch {
      return {
        analysisVersion: 'c-d-wearable-microphone-signal-analysis-v1',
        status: 'failed',
        reason: 'native-microphone-measurement-failed',
        provider: 'android-native-loopback',
        privacy: { rawAudioStored: false, audioFramesStored: false }
      };
    } finally {
      captured?.dispose?.();
    }
  }
  const mediaDevices = windowRef?.navigator?.mediaDevices;
  const AudioContext = windowRef?.AudioContext ?? windowRef?.webkitAudioContext;
  if (typeof mediaDevices?.getUserMedia !== 'function' || typeof AudioContext !== 'function') {
    return {
      analysisVersion: 'c-d-wearable-microphone-signal-analysis-v1',
      status: 'unavailable',
      reason: 'web-audio-or-microphone-unavailable',
      privacy: { rawAudioStored: false, audioFramesStored: false }
    };
  }
  let stream = null;
  let context = null;
  const frames = [];
  try {
    stream = await mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.25;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const startedAt = performanceNow(windowRef);
    while (performanceNow(windowRef) - startedAt < durationMs) {
      analyser.getFloatTimeDomainData(data);
      frames.push(Float32Array.from(data));
      await delay(sampleIntervalMs);
    }
    return analyzeWearableAudioFrames(frames, thresholds);
  } catch (error) {
    return {
      analysisVersion: 'c-d-wearable-microphone-signal-analysis-v1',
      status: 'failed',
      reason: error?.name === 'NotAllowedError' ? 'microphone-permission-denied' : 'microphone-measurement-failed',
      privacy: { rawAudioStored: false, audioFramesStored: false }
    };
  } finally {
    frames.length = 0;
    for (const track of stream?.getTracks?.() ?? []) track.stop?.();
    await context?.close?.().catch?.(() => {});
  }
}

export function createWearableNativeAudioCapture({
  windowRef = globalThis.window,
  endpoint = wearableNativeAudioEndpoint,
  fetchImpl = windowRef?.fetch?.bind(windowRef),
  cue = true
} = {}) {
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== 'http:'
    || endpointUrl.hostname !== '127.0.0.1'
    || Number(endpointUrl.port) !== 4186
    || endpointUrl.pathname !== '/audio/capture') {
    throw new Error('native-audio-endpoint-not-allowed');
  }
  if (typeof fetchImpl !== 'function') throw new Error('native-audio-fetch-unavailable');
  return async function capture({ maxDurationMs = 3500, deviceCue = cue } = {}) {
    const durationMs = Math.max(500, Math.min(8000, Math.round(Number(maxDurationMs) || 3500)));
    const Controller = windowRef?.AbortController ?? globalThis.AbortController;
    const controller = typeof Controller === 'function' ? new Controller() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), durationMs + 6000) : null;
    try {
      endpointUrl.searchParams.set('durationMs', String(durationMs));
      endpointUrl.searchParams.set('cue', deviceCue ? '1' : '0');
      const response = await fetchImpl(endpointUrl.toString(), {
        method: 'POST',
        cache: 'no-store',
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!response?.ok) throw new Error(`native-audio-http-${response?.status ?? 0}`);
      const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
      if (!contentType.startsWith('audio/wav')) throw new Error('native-audio-type-invalid');
      const audio = await response.arrayBuffer();
      if (audio.byteLength <= 44 || audio.byteLength > 1024 * 1024) throw new Error('native-audio-size-invalid');
      const bytes = new Uint8Array(audio);
      if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') throw new Error('native-audio-wav-invalid');
      let disposed = false;
      return {
        audio,
        mimeType: 'audio/wav',
        source: String(response.headers?.get?.('x-jarvis-audio-source') ?? 'android-native'),
        sampleRateHz: Number(response.headers?.get?.('x-jarvis-sample-rate') ?? 0) || null,
        captureCue: String(response.headers?.get?.('x-jarvis-capture-cue') ?? 'unknown'),
        rawAudioStored: false,
        dispose() {
          if (disposed) return;
          bytes.fill(0);
          disposed = true;
        }
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}

export function decodeWearablePcm16Wav(audio, { sampleIntervalMs = 50 } = {}) {
  const bytes = audio instanceof Uint8Array
    ? audio
    : audio instanceof ArrayBuffer ? new Uint8Array(audio) : new Uint8Array(audio?.buffer ?? 0);
  if (bytes.byteLength < 44 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('invalid-pcm-wav');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format = null;
  let dataOffset = -1;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const id = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    if (bodyOffset + length > bytes.byteLength) throw new Error('invalid-wav-chunk');
    if (id === 'fmt ' && length >= 16) {
      format = {
        encoding: view.getUint16(bodyOffset, true),
        channels: view.getUint16(bodyOffset + 2, true),
        sampleRateHz: view.getUint32(bodyOffset + 4, true),
        blockAlign: view.getUint16(bodyOffset + 12, true),
        bitsPerSample: view.getUint16(bodyOffset + 14, true)
      };
    } else if (id === 'data') {
      dataOffset = bodyOffset;
      dataLength = length;
      break;
    }
    offset = bodyOffset + length + (length % 2);
  }
  if (!format || format.encoding !== 1 || format.channels < 1 || format.bitsPerSample !== 16
    || format.blockAlign < format.channels * 2 || dataOffset < 0 || dataLength < format.blockAlign) {
    throw new Error('unsupported-pcm-wav');
  }
  const sampleCount = Math.floor(dataLength / format.blockAlign);
  const samplesPerFrame = Math.max(128, Math.round(format.sampleRateHz * Math.max(10, Number(sampleIntervalMs) || 50) / 1000));
  const frames = [];
  for (let start = 0; start < sampleCount; start += samplesPerFrame) {
    const length = Math.min(samplesPerFrame, sampleCount - start);
    const frame = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      frame[index] = view.getInt16(dataOffset + ((start + index) * format.blockAlign), true) / 32768;
    }
    frames.push(frame);
  }
  return {
    frames,
    sampleRateHz: format.sampleRateHz,
    channelCount: format.channels,
    sampleCount,
    rawAudioStored: false
  };
}

export async function measureWearableBridgeLatency({
  fetchImpl = globalThis.fetch,
  bridgeUrl = 'http://127.0.0.1:17777',
  sampleCount = 8,
  timeoutMs = 3000,
  thresholds = defaultWearablePhysicalThresholds,
  nowMs = () => Date.now()
} = {}) {
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const startedAt = nowMs();
    try {
      const response = await fetchImpl(`${String(bridgeUrl).replace(/\/$/, '')}/health`, {
        method: 'GET',
        cache: 'no-store',
        ...(controller ? { signal: controller.signal } : {})
      });
      samples.push({ ok: response.ok !== false && Number(response.status ?? 200) < 400, latencyMs: Math.max(0, nowMs() - startedAt) });
    } catch (error) {
      samples.push({ ok: false, latencyMs: Math.max(0, nowMs() - startedAt), category: error?.name === 'AbortError' ? 'timeout' : 'network' });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  const successful = samples.filter((item) => item.ok).map((item) => item.latencyMs).sort((left, right) => left - right);
  const availability = round(samples.length > 0 ? successful.length / samples.length : 0, 4);
  const p50Ms = Math.round(percentile(successful, 0.5));
  const p95Ms = Math.round(percentile(successful, 0.95));
  const passed = samples.length >= thresholds.minimumNetworkSamples
    && availability >= thresholds.minimumNetworkAvailability
    && p95Ms <= thresholds.maximumNetworkP95Ms;
  return {
    measurementVersion: 'c-d-wearable-bridge-latency-measurement-v1',
    status: passed ? 'passed' : 'needs-adjustment',
    sampleCount: samples.length,
    successCount: successful.length,
    availability,
    p50Ms,
    p95Ms,
    failureCategories: samples.filter((item) => !item.ok).reduce((counts, item) => ({
      ...counts,
      [item.category ?? 'http']: (counts[item.category ?? 'http'] ?? 0) + 1
    }), {}),
    thresholds: {
      minimumSamples: thresholds.minimumNetworkSamples,
      minimumAvailability: thresholds.minimumNetworkAvailability,
      maximumP95Ms: thresholds.maximumNetworkP95Ms
    },
    privacy: {
      bridgeTokenStored: false,
      requestBodyStored: false
    }
  };
}

export function captureWearableDisplayMeasurement({ windowRef = globalThis.window, root = null } = {}) {
  const viewport = windowRef?.visualViewport;
  const width = Math.round(viewport?.width ?? windowRef?.innerWidth ?? 0);
  const height = Math.round(viewport?.height ?? windowRef?.innerHeight ?? 0);
  const clientWidth = Number(root?.clientWidth ?? width);
  const clientHeight = Number(root?.clientHeight ?? height);
  const scrollWidth = Number(root?.scrollWidth ?? clientWidth);
  const scrollHeight = Number(root?.scrollHeight ?? clientHeight);
  return {
    measurementVersion: 'c-d-wearable-display-measurement-v1',
    capturedAt: new Date().toISOString(),
    viewport: {
      width,
      height,
      devicePixelRatio: round(Number(windowRef?.devicePixelRatio ?? 1), 2),
      orientation: width >= height ? 'landscape' : 'portrait'
    },
    layout: {
      horizontalOverflowPx: Math.max(0, scrollWidth - clientWidth),
      verticalOverflowPx: Math.max(0, scrollHeight - clientHeight),
      fullscreenSupported: Boolean(windowRef?.document?.fullscreenEnabled)
    },
    privacy: {
      screenshotStored: false,
      userAgentStored: false
    }
  };
}

export function createWearablePhysicalFieldReport({
  deviceAlias = 'jarvis-glasses-field',
  physicalDeviceConfirmed = false,
  display = null,
  microphone = null,
  voice = null,
  network = null,
  scenarios = {},
  capability = null,
  thresholds = defaultWearablePhysicalThresholds,
  now = new Date()
} = {}) {
  const normalizedScenarios = {
    indoorReadability: scenarios.indoorReadability === true,
    outdoorReadability: scenarios.outdoorReadability === true,
    motionComfort: scenarios.motionComfort === true,
    offlineRecovery: scenarios.offlineRecovery === true,
    thermalBattery: scenarios.thermalBattery === true
  };
  const checks = [
    fieldCheck('physical_device_confirmed', physicalDeviceConfirmed === true),
    fieldCheck('secure_context_ready', capability?.secureContext === true),
    fieldCheck('display_geometry_ready', Boolean(display)
      && display.viewport?.width >= thresholds.minimumViewportWidth
      && display.viewport?.height >= thresholds.minimumViewportHeight
      && display.layout?.horizontalOverflowPx === 0),
    fieldCheck('microphone_signal_ready', microphone?.status === 'passed'),
    fieldCheck('voice_command_ready', voice?.status === 'passed'
      && voice.activationDetected === true
      && voice.rawTranscriptStored === false),
    fieldCheck('bridge_latency_ready', network?.status === 'passed'),
    ...Object.entries(normalizedScenarios).map(([key, passed]) => fieldCheck(`scenario_${camelToSnake(key)}`, passed)),
    fieldCheck('privacy_contract_ready', microphone?.privacy?.rawAudioStored === false
      && display?.privacy?.screenshotStored === false
      && voice?.rawTranscriptStored === false
      && network?.privacy?.bridgeTokenStored === false)
  ];
  const passed = checks.every((item) => item.passed);
  return {
    reportVersion: wearablePhysicalFieldReportVersion,
    generatedAt: iso(now),
    status: passed ? 'passed' : physicalDeviceConfirmed ? 'needs-adjustment' : 'ready-for-physical-device',
    source: {
      deviceAlias: sanitizeAlias(deviceAlias),
      physicalDeviceConfirmed: physicalDeviceConfirmed === true,
      interactiveFieldRun: true
    },
    capability: capability ?? null,
    display,
    microphone,
    voice,
    network,
    scenarios: normalizedScenarios,
    checks,
    summary: {
      passedChecks: checks.filter((item) => item.passed).length,
      totalChecks: checks.length,
      blockingChecks: checks.filter((item) => !item.passed).map((item) => item.checkId)
    },
    privacy: {
      rawTranscriptStored: false,
      rawAudioStored: false,
      rawBridgeTokenStored: false,
      screenshotStored: false,
      userAgentStored: false
    }
  };
}

export function evaluateWearablePhysicalFieldReport(report = {}) {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const requiredCheckIds = [
    'physical_device_confirmed',
    'secure_context_ready',
    'display_geometry_ready',
    'microphone_signal_ready',
    'voice_command_ready',
    'bridge_latency_ready',
    'scenario_indoor_readability',
    'scenario_outdoor_readability',
    'scenario_motion_comfort',
    'scenario_offline_recovery',
    'scenario_thermal_battery',
    'privacy_contract_ready'
  ];
  const schemaReady = report.reportVersion === wearablePhysicalFieldReportVersion
    && report.source?.interactiveFieldRun === true;
  const privacyReady = report.privacy?.rawTranscriptStored === false
    && report.privacy?.rawAudioStored === false
    && report.privacy?.rawBridgeTokenStored === false
    && report.privacy?.screenshotStored === false;
  const physicalReady = report.source?.physicalDeviceConfirmed === true;
  const checksReady = requiredCheckIds.every((checkId) => (
    checks.some((item) => item.checkId === checkId && item.passed === true)
  ));
  const gateChecks = [
    fieldCheck('report_schema_ready', schemaReady),
    fieldCheck('physical_device_evidence_present', physicalReady),
    fieldCheck('all_field_checks_passed', checksReady),
    fieldCheck('field_privacy_contract_ready', privacyReady)
  ];
  return {
    gateVersion: wearablePhysicalFieldGateVersion,
    status: gateChecks.every((item) => item.passed) ? 'passed' : physicalReady ? 'blocked' : 'ready-for-physical-device',
    checks: gateChecks,
    evidenceGeneratedAt: report.generatedAt ?? null,
    deviceAlias: report.source?.deviceAlias ?? null,
    privacy: {
      rawFieldContentStored: false
    }
  };
}

export function installWearableFieldLab({
  windowRef = globalThis.window,
  documentRef = globalThis.document,
  rootId = 'jarvis-wearable-field-lab',
  initialBridgeUrl = 'http://127.0.0.1:17777'
} = {}) {
  const root = documentRef?.getElementById(rootId);
  if (!root || !windowRef) return null;
  root.innerHTML = fieldLabMarkup(initialBridgeUrl);
  const preferLocalStt = /JARVIS-Wearable-Field\//i.test(String(windowRef.navigator?.userAgent ?? ''));
  const nativeAudioCapture = /JARVIS-Native-Audio\//i.test(String(windowRef.navigator?.userAgent ?? ''))
    ? createWearableNativeAudioCapture({ windowRef })
    : null;
  const state = {
    display: null,
    microphone: null,
    voice: null,
    network: null,
    capability: createWearableVoiceCapabilityReport({
      windowRef,
      preferLocalStt,
      nativeAudioCapture: Boolean(nativeAudioCapture)
    })
  };
  const statusNode = root.querySelector('[data-field-status]');
  const progressNode = root.querySelector('[data-field-progress]');
  const resultNode = root.querySelector('[data-field-result]');
  const bridgeInput = root.querySelector('[data-field-bridge]');
  const aliasInput = root.querySelector('[data-device-alias]');
  const voiceButton = root.querySelector('[data-test-voice]');
  const microphoneButton = root.querySelector('[data-test-microphone]');
  const displayButton = root.querySelector('[data-test-display]');
  const networkButton = root.querySelector('[data-test-network]');
  const setStatus = (text) => {
    if (statusNode) statusNode.textContent = text;
  };
  const scenarioValues = () => Object.fromEntries(
    Array.from(root.querySelectorAll('[data-field-scenario]')).map((input) => [input.value, input.checked])
  );
  const currentReport = () => createWearablePhysicalFieldReport({
    deviceAlias: aliasInput?.value,
    physicalDeviceConfirmed: root.querySelector('[data-physical-device]')?.checked === true,
    display: state.display,
    microphone: state.microphone,
    voice: state.voice,
    network: state.network,
    scenarios: scenarioValues(),
    capability: state.capability
  });
  const updateProgress = () => {
    const report = currentReport();
    if (progressNode) progressNode.textContent = `${report.summary.passedChecks}/${report.summary.totalChecks}`;
    return report;
  };
  let draftSaveTimer = null;
  const persistDraft = () => {
    if (draftSaveTimer) windowRef.clearTimeout(draftSaveTimer);
    draftSaveTimer = windowRef.setTimeout(async () => {
      draftSaveTimer = null;
      const report = updateProgress();
      await windowRef.fetch('/field-draft', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-jarvis-wearable-request': 'physical-field-draft-v1' },
        body: JSON.stringify(report)
      }).catch(() => null);
    }, 180);
  };
  const showResult = (label, value, passed = null) => {
    if (!resultNode) return;
    resultNode.textContent = `${label} · ${value}`;
    resultNode.dataset.passed = passed === null ? 'pending' : String(passed);
  };
  const showMeasurement = (button, value, passed) => {
    const detail = button?.querySelector('small');
    if (detail) detail.textContent = value;
    if (button) button.dataset.passed = String(Boolean(passed));
  };
  const prepareCapture = async (button, prompt) => {
    if (button) button.disabled = true;
    for (const count of [3, 2, 1]) {
      setStatus(`${prompt} · ${count}`);
      showMeasurement(button, `${count}`, false);
      await delay(650);
    }
    setStatus('안경 시작음 뒤에 말해 주세요');
    showMeasurement(button, '시작음 대기', false);
  };
  const voiceAudioCapture = nativeAudioCapture
    ? async (options) => {
        let captured = null;
        try {
          captured = await nativeAudioCapture(options);
          state.microphone = analyzeWearableNativeCapture(captured);
          return captured;
        } catch (error) {
          captured?.dispose?.();
          throw error;
        }
      }
    : null;
  const voiceSession = new WearableVoiceSession({
    windowRef,
    config: { continuous: false, endSilenceMs: 350, maxRestartAttempts: 1, preferLocalStt },
    fallbackTranscriber: createHttpAudioFallbackTranscriber({
      windowRef,
      endpoint: '/voice/transcribe',
      captureAudio: voiceAudioCapture
    }),
    onFinalTranscript: (transcript, metadata) => {
      const startedAt = Number(voiceButton?.dataset.startedAt ?? Date.now());
      const intent = createWearableBrowserVoiceIntent({ transcript });
      state.voice = {
        measurementVersion: 'c-d-wearable-voice-command-measurement-v1',
        status: intent.activationDetected && intent.intentName === 'show_status' ? 'passed' : 'needs-adjustment',
        activationDetected: intent.activationDetected,
        intentName: intent.intentName,
        confidence: metadata.confidence,
        recognitionLatencyMs: Math.max(0, Date.now() - startedAt),
        provider: metadata.provider,
        redactionCount: metadata.redactionCount,
        rawTranscriptStored: false
      };
      showMeasurement(voiceButton, state.voice.status === 'passed' ? '명령 확인' : '다시 말하기', state.voice.status === 'passed');
      showResult('음성', state.voice.status === 'passed' ? '명령 확인' : '다시 측정', state.voice.status === 'passed');
      setStatus('음성 측정 완료');
      persistDraft();
      voiceSession.stop('field-voice-complete');
    },
    onStateChange: (voiceState) => {
      if (voiceState.phase === 'error') {
        const category = voiceState.lastError?.category;
        if (category === 'silence' && state.microphone) {
          const value = `음성 ${state.microphone.speechLevelDbfs}dB · SNR ${state.microphone.snrDb}dB`;
          showMeasurement(voiceButton, value, false);
          showResult('음성', '발화가 감지되지 않음', false);
          setStatus('음성 신호가 약합니다');
        } else if (category === 'microphone') {
          showMeasurement(voiceButton, '마이크 입력 재확인', false);
          setStatus('마이크 입력 점검');
        } else if (category === 'network') {
          showMeasurement(voiceButton, '음성 서비스 연결 재확인', false);
          setStatus('음성 서비스 연결 점검');
        } else {
          showMeasurement(voiceButton, '음성 인식 재시도', false);
          setStatus('음성 인식 점검');
        }
      }
    }
  });

  if (state.capability.secureContext !== true) {
    if (microphoneButton) microphoneButton.disabled = true;
    if (voiceButton) voiceButton.disabled = true;
    showResult('보안 연결', 'ADB localhost 또는 HTTPS 필요', false);
    setStatus('마이크 보호 · 보안 연결 필요');
  }

  displayButton?.addEventListener('click', async () => {
    try {
      await documentRef.documentElement?.requestFullscreen?.();
    } catch {
      // Fullscreen may require a device-specific browser setting.
    }
    state.display = captureWearableDisplayMeasurement({ windowRef, root });
    const passed = state.display.viewport.width >= defaultWearablePhysicalThresholds.minimumViewportWidth
      && state.display.viewport.height >= defaultWearablePhysicalThresholds.minimumViewportHeight
      && state.display.layout.horizontalOverflowPx === 0;
    showMeasurement(displayButton, `${state.display.viewport.width}×${state.display.viewport.height} · 넘침 ${state.display.layout.horizontalOverflowPx}px`, passed);
    showResult('화면', `${state.display.viewport.width}×${state.display.viewport.height}`, passed);
    setStatus('화면 측정 완료');
    persistDraft();
  });

  microphoneButton?.addEventListener('click', async () => {
    await prepareCapture(microphoneButton, '마이크 준비');
    try {
      state.microphone = await measureWearableMicrophone({ windowRef, captureAudio: nativeAudioCapture });
      const value = state.microphone.status === 'passed'
        ? `SNR ${state.microphone.snrDb}dB`
        : state.microphone.reason ?? `음성 ${state.microphone.speechLevelDbfs ?? '-'}dB · 더 크게 말하기`;
      showMeasurement(microphoneButton, value, state.microphone.status === 'passed');
      showResult('마이크', value, state.microphone.status === 'passed');
      setStatus('마이크 측정 완료');
      persistDraft();
    } finally {
      microphoneButton.disabled = false;
    }
  });

  voiceButton?.addEventListener('click', async () => {
    await prepareCapture(voiceButton, '음성 명령 준비');
    try {
      setStatus('시작음 뒤 “자비스 상태 보여줘”');
      voiceButton.dataset.startedAt = String(Date.now());
      await voiceSession.start({ requestPermission: !nativeAudioCapture });
    } finally {
      voiceButton.disabled = false;
    }
  });

  networkButton?.addEventListener('click', async () => {
    setStatus('브리지 지연 측정 중');
    state.network = await measureWearableBridgeLatency({
      fetchImpl: windowRef.fetch.bind(windowRef),
      bridgeUrl: bridgeInput?.value || initialBridgeUrl
    });
    showMeasurement(networkButton, `p50 ${state.network.p50Ms} · p95 ${state.network.p95Ms}ms`, state.network.status === 'passed');
    showResult('네트워크', `p95 ${state.network.p95Ms}ms`, state.network.status === 'passed');
    setStatus('네트워크 측정 완료');
    persistDraft();
  });

  root.querySelectorAll('[data-field-scenario], [data-physical-device]').forEach((input) => {
    input.addEventListener('change', persistDraft);
  });
  aliasInput?.addEventListener('change', persistDraft);

  const restoreDraft = async () => {
    try {
      const response = await windowRef.fetch('/field-draft', {
        headers: { 'x-jarvis-wearable-request': 'physical-field-draft-v1' }
      });
      if (!response.ok) {
        updateProgress();
        return;
      }
      const envelope = await response.json();
      const report = envelope?.report;
      if (report?.reportVersion !== wearablePhysicalFieldReportVersion) return;
      state.display = report.display ?? null;
      state.microphone = report.microphone ?? null;
      state.voice = report.voice ?? null;
      state.network = report.network ?? null;
      if (aliasInput && report.source?.deviceAlias) aliasInput.value = report.source.deviceAlias;
      const physical = root.querySelector('[data-physical-device]');
      if (physical) physical.checked = report.source?.physicalDeviceConfirmed === true;
      root.querySelectorAll('[data-field-scenario]').forEach((input) => {
        input.checked = report.scenarios?.[input.value] === true;
      });
      if (state.display) showMeasurement(displayButton, `${state.display.viewport?.width ?? '-'}×${state.display.viewport?.height ?? '-'}`, state.display.layout?.horizontalOverflowPx === 0);
      if (state.microphone) showMeasurement(microphoneButton, state.microphone.status === 'passed' ? `SNR ${state.microphone.snrDb}dB` : '다시 측정', state.microphone.status === 'passed');
      if (state.voice) showMeasurement(voiceButton, state.voice.status === 'passed' ? '명령 확인' : '다시 측정', state.voice.status === 'passed');
      if (state.network) showMeasurement(networkButton, `p95 ${state.network.p95Ms}ms`, state.network.status === 'passed');
      const restored = updateProgress();
      setStatus(`이전 측정 복원 · ${restored.summary.passedChecks}/${restored.summary.totalChecks}`);
    } catch {
      updateProgress();
    }
  };

  root.querySelector('[data-save-field]')?.addEventListener('click', async () => {
    const report = currentReport();
    setStatus('증거 저장 중');
    try {
      const response = await windowRef.fetch('/field-evidence', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jarvis-wearable-request': 'physical-field-evidence-v1' },
        body: JSON.stringify(report)
      });
      const payload = await response.json();
      if (!response.ok || payload.success === false) throw new Error(payload?.error?.message ?? 'field-evidence-save-failed');
      showResult('필드 게이트', report.status === 'passed' ? '통과' : '보완 필요', report.status === 'passed');
      setStatus(`저장됨 · ${payload.evidenceId?.slice(0, 12) ?? '확인'}`);
      if (report.status === 'passed') {
        await windowRef.fetch('/field-draft', {
          method: 'DELETE',
          headers: { 'x-jarvis-wearable-request': 'physical-field-draft-v1' }
        }).catch(() => null);
      } else {
        persistDraft();
      }
    } catch {
      downloadFieldReport(windowRef, report);
      showResult('필드 게이트', '로컬 파일로 저장', report.status === 'passed');
      setStatus('서버 저장 실패 · 파일 저장됨');
    }
  });

  restoreDraft();

  return {
    labVersion: 'c-d-wearable-physical-field-lab-v1',
    state: () => ({ ...state, rawTranscriptStored: false, rawAudioStored: false }),
    report() {
      return currentReport();
    },
    destroy() {
      if (draftSaveTimer) windowRef.clearTimeout(draftSaveTimer);
      voiceSession.destroy();
    }
  };
}

function fieldLabMarkup(bridgeUrl) {
  const scenarios = [
    ['indoorReadability', '실내 가독성'],
    ['outdoorReadability', '실외 가독성'],
    ['motionComfort', '이동 중 편안함'],
    ['offlineRecovery', '연결 복구'],
    ['thermalBattery', '발열·배터리']
  ];
  return `
    <header class="field-header">
      <div><strong>JARVIS</strong><span>물리 안경 검증 · <b data-field-progress>0/12</b></span></div>
      <output data-field-status>측정 대기</output>
    </header>
    <section class="field-identity">
      <label>기기 별칭<input data-device-alias value="jarvis-glasses-field" autocomplete="off" /></label>
      <label>브리지<input data-field-bridge value="${escapeHtml(bridgeUrl)}" inputmode="url" /></label>
      <label class="field-check"><input type="checkbox" data-physical-device />실제 안경에서 실행</label>
    </section>
    <main class="field-tests">
      <button type="button" data-test-display><span>01</span><strong>화면</strong><small>크기·넘침·전체화면</small></button>
      <button type="button" data-test-microphone><span>02</span><strong>마이크</strong><small>3초간 문장 발화</small></button>
      <button type="button" data-test-voice><span>03</span><strong>음성</strong><small>“자비스 상태 보여줘”</small></button>
      <button type="button" data-test-network><span>04</span><strong>연결</strong><small>브리지 p50·p95</small></button>
    </main>
    <section class="field-scenarios" aria-label="현장 시나리오">
      ${scenarios.map(([value, label]) => `<label><input type="checkbox" data-field-scenario value="${value}" /><span>${label}</span></label>`).join('')}
    </section>
    <footer class="field-footer">
      <output data-field-result data-passed="pending">측정 결과가 여기에 표시됩니다</output>
      <button type="button" data-save-field>검증 저장</button>
    </footer>
  `;
}

function downloadFieldReport(windowRef, report) {
  const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' });
  const url = windowRef.URL.createObjectURL(blob);
  const anchor = windowRef.document.createElement('a');
  anchor.href = url;
  anchor.download = 'wearable-physical-field-report.json';
  anchor.click();
  windowRef.URL.revokeObjectURL(url);
}

function fieldCheck(checkId, passed) {
  return { checkId, passed: Boolean(passed), severity: 'blocking' };
}

function percentile(values, ratio) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
  return Number(values[index] ?? 0);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function performanceNow(windowRef) {
  return Number(windowRef?.performance?.now?.() ?? Date.now());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function camelToSnake(value) {
  return String(value).replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

function sanitizeAlias(value) {
  return String(value ?? 'jarvis-glasses-field').replace(/[^a-z0-9가-힣._-]/gi, '_').slice(0, 64) || 'jarvis-glasses-field';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function ascii(bytes, offset, length) {
  let value = '';
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index] ?? 0);
  return value;
}
