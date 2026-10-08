export const wearableVoiceSessionVersion = 'c-d-wearable-voice-session-v2';
export const wearableVoiceCapabilityVersion = 'c-d-wearable-voice-capability-v2';

export const defaultWearableVoiceSessionConfig = Object.freeze({
  lang: 'ko-KR',
  continuous: true,
  interimResults: true,
  maxAlternatives: 3,
  endSilenceMs: 550,
  restartBaseDelayMs: 300,
  restartMaxDelayMs: 4000,
  maxRestartAttempts: 6,
  maxUtteranceMs: 8000,
  fallbackCaptureMs: 5000,
  preferLocalStt: false,
  ttsEnabled: true,
  ttsRate: 1.05,
  ttsPitch: 0.95,
  ttsVolume: 0.85,
  maxSpokenChars: 120,
  telemetryLimit: 32
});

export function createWearableVoiceSessionConfig(options = {}) {
  return {
    ...defaultWearableVoiceSessionConfig,
    ...options,
    lang: String(options.lang ?? defaultWearableVoiceSessionConfig.lang),
    continuous: options.continuous ?? defaultWearableVoiceSessionConfig.continuous,
    interimResults: options.interimResults ?? defaultWearableVoiceSessionConfig.interimResults,
    endSilenceMs: positiveNumber(options.endSilenceMs, defaultWearableVoiceSessionConfig.endSilenceMs),
    restartBaseDelayMs: positiveNumber(options.restartBaseDelayMs, defaultWearableVoiceSessionConfig.restartBaseDelayMs),
    restartMaxDelayMs: positiveNumber(options.restartMaxDelayMs, defaultWearableVoiceSessionConfig.restartMaxDelayMs),
    maxRestartAttempts: nonNegativeInteger(options.maxRestartAttempts, defaultWearableVoiceSessionConfig.maxRestartAttempts),
    maxUtteranceMs: positiveNumber(options.maxUtteranceMs, defaultWearableVoiceSessionConfig.maxUtteranceMs),
    fallbackCaptureMs: positiveNumber(options.fallbackCaptureMs, defaultWearableVoiceSessionConfig.fallbackCaptureMs),
    preferLocalStt: options.preferLocalStt === true,
    telemetryLimit: positiveInteger(options.telemetryLimit, defaultWearableVoiceSessionConfig.telemetryLimit)
  };
}

export function createWearableVoiceCapabilityReport({
  windowRef = globalThis.window,
  preferLocalStt = false,
  nativeAudioCapture = false
} = {}) {
  const navigatorRef = windowRef?.navigator ?? globalThis.navigator;
  const Recognition = windowRef?.SpeechRecognition ?? windowRef?.webkitSpeechRecognition;
  const nativeRecognition = typeof Recognition === 'function';
  const mediaRecorder = typeof windowRef?.MediaRecorder === 'function';
  const microphoneCapture = typeof navigatorRef?.mediaDevices?.getUserMedia === 'function';
  const nativeCapture = nativeAudioCapture === true;
  const speechOutput = Boolean(windowRef?.speechSynthesis && typeof windowRef?.SpeechSynthesisUtterance === 'function');
  const nativeProviders = nativeRecognition ? ['browser-speech-recognition'] : [];
  const localProviders = nativeCapture
    ? ['android-native-audio', 'local-stt-gateway']
    : mediaRecorder && microphoneCapture ? ['local-stt-gateway'] : [];
  const providerOrder = preferLocalStt
    ? [...localProviders, ...nativeProviders, 'manual-controls']
    : [...nativeProviders, ...localProviders, 'manual-controls'];
  return {
    capabilityVersion: wearableVoiceCapabilityVersion,
    status: nativeRecognition || nativeCapture || (mediaRecorder && microphoneCapture) ? 'voice-ready' : 'manual-fallback-only',
    secureContext: windowRef?.isSecureContext === true || windowRef?.location?.hostname === '127.0.0.1' || windowRef?.location?.hostname === 'localhost',
    input: {
      nativeRecognition,
      nativeAudioCapture: nativeCapture,
      microphoneCapture,
      mediaRecorder,
      permissionQuery: typeof navigatorRef?.permissions?.query === 'function'
    },
    output: {
      speechSynthesis: speechOutput
    },
    providerOrder,
    privacy: {
      rawTranscriptStored: false,
      rawAudioStored: false,
      telemetryContainsContent: false
    }
  };
}

export function classifyWearableVoiceError(code = 'unknown') {
  const normalized = String(code ?? 'unknown').toLowerCase();
  const table = {
    'not-allowed': { category: 'permission', retryable: false, userAction: 'microphone-permission' },
    'service-not-allowed': { category: 'permission', retryable: false, userAction: 'speech-service-permission' },
    'audio-capture': { category: 'microphone', retryable: true, userAction: 'check-microphone' },
    network: { category: 'network', retryable: true, userAction: 'check-network' },
    'no-speech': { category: 'silence', retryable: true, userAction: null },
    aborted: { category: 'cancelled', retryable: false, userAction: null },
    'language-not-supported': { category: 'locale', retryable: false, userAction: 'change-language' }
  };
  const match = table[normalized] ?? { category: 'recognition', retryable: true, userAction: 'retry' };
  return {
    errorVersion: 'c-d-wearable-voice-error-v2',
    code: normalized,
    ...match
  };
}

export function classifyWearableFallbackError(error) {
  const code = String(error?.code ?? error?.message ?? 'unknown').toLowerCase();
  if (code === 'permission-denied' || code === 'not-allowed') {
    return classifyWearableVoiceError('not-allowed');
  }
  if (code === 'stt_empty_transcript' || code === 'empty-transcript' || code === 'empty_transcript') {
    return classifyWearableVoiceError('no-speech');
  }
  if (code.includes('native-audio') || code === 'empty-audio' || code === 'media-recorder-failed') {
    return classifyWearableVoiceError('audio-capture');
  }
  if (code.includes('network') || code.includes('fetch') || code.includes('timeout') || code.includes('http-')) {
    return classifyWearableVoiceError('network');
  }
  return classifyWearableVoiceError('recognition');
}

export class WearableVoiceSession {
  constructor({
    windowRef = globalThis.window,
    config = {},
    recognitionFactory = null,
    fallbackTranscriber = null,
    sanitizeText = defaultSanitizeText,
    onFinalTranscript = () => {},
    onInterim = () => {},
    onStateChange = () => {},
    now = () => new Date(),
    setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
    clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis)
  } = {}) {
    this.windowRef = windowRef;
    this.config = createWearableVoiceSessionConfig(config);
    this.recognitionFactory = recognitionFactory;
    this.fallbackTranscriber = fallbackTranscriber;
    this.sanitizeText = sanitizeText;
    this.onFinalTranscript = onFinalTranscript;
    this.onInterim = onInterim;
    this.onStateChange = onStateChange;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.recognition = null;
    this.restartTimer = null;
    this.endpointTimer = null;
    this.utteranceTimer = null;
    this.pendingFinalText = '';
    this.pendingFinalConfidence = null;
    this.destroyed = false;
    this.stateValue = {
      sessionVersion: wearableVoiceSessionVersion,
      phase: 'idle',
      desiredActive: false,
      provider: null,
      permission: 'unknown',
      startedAt: null,
      lastStateAt: iso(this.now()),
      lastFinalAt: null,
      lastConfidence: null,
      interimLength: 0,
      restartCount: 0,
      recoverableErrorCount: 0,
      permanentErrorCount: 0,
      bargeInCount: 0,
      utteranceCount: 0,
      outputSpeaking: false,
      lastError: null,
      telemetry: [],
      privacy: {
        rawTranscriptStored: false,
        rawAudioStored: false,
        interimContentStored: false,
        telemetryContainsContent: false
      }
    };
  }

  capabilities() {
    return createWearableVoiceCapabilityReport({ windowRef: this.windowRef });
  }

  snapshot() {
    return structuredCloneSafe(this.stateValue);
  }

  async requestMicrophonePermission() {
    const mediaDevices = this.windowRef?.navigator?.mediaDevices;
    if (typeof mediaDevices?.getUserMedia !== 'function') {
      this._patch({ permission: this.capabilities().input.nativeRecognition ? 'recognizer-managed' : 'unavailable' }, 'permission-unavailable');
      return this.stateValue.permission;
    }
    this._patch({ phase: 'requesting-permission' }, 'permission-requested');
    let stream = null;
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
      this._patch({ permission: 'granted', phase: 'idle' }, 'permission-granted');
      return 'granted';
    } catch (error) {
      const classified = classifyWearableVoiceError(error?.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture');
      this._recordError(classified);
      this._patch({ permission: 'denied', phase: 'error' }, 'permission-denied');
      return 'denied';
    } finally {
      for (const track of stream?.getTracks?.() ?? []) track.stop?.();
    }
  }

  async start({ requestPermission = false } = {}) {
    if (this.destroyed) return this.snapshot();
    if (this.stateValue.desiredActive && ['starting', 'listening', 'speech', 'processing'].includes(this.stateValue.phase)) {
      return this.snapshot();
    }
    this._patch({
      desiredActive: true,
      startedAt: this.stateValue.startedAt ?? iso(this.now()),
      lastError: null
    }, 'session-start-requested');
    if (requestPermission && this.stateValue.permission === 'unknown') {
      const permission = await this.requestMicrophonePermission();
      if (permission === 'denied') return this.snapshot();
    }
    if (this._nativeRecognitionAvailable()) {
      this._startNativeRecognition();
    } else if (typeof this.fallbackTranscriber === 'function') {
      this._runFallbackTranscriber();
    } else {
      this._patch({ phase: 'unavailable', provider: 'manual-controls' }, 'voice-unavailable');
    }
    return this.snapshot();
  }

  stop(reason = 'user') {
    this._patch({ desiredActive: false }, `session-stop:${safeEventName(reason)}`);
    this._clearTimers();
    const recognition = this.recognition;
    this.recognition = null;
    try {
      recognition?.abort?.();
    } catch {
      // The browser may already have closed the recognizer.
    }
    this._discardPendingTranscript();
    this._patch({ phase: 'idle', interimLength: 0 }, 'session-stopped');
    return this.snapshot();
  }

  toggle() {
    return this.stateValue.desiredActive ? this.stop('toggle') : this.start({ requestPermission: true });
  }

  speak(value, { interrupt = true } = {}) {
    if (this.config.ttsEnabled !== true) return false;
    const synthesis = this.windowRef?.speechSynthesis;
    const Utterance = this.windowRef?.SpeechSynthesisUtterance;
    if (!synthesis || typeof Utterance !== 'function') return false;
    const sanitized = normalizeSanitized(this.sanitizeText(value));
    const text = compactText(sanitized.text, this.config.maxSpokenChars);
    if (!text) return false;
    if (interrupt) synthesis.cancel?.();
    const utterance = new Utterance(text);
    utterance.lang = this.config.lang;
    utterance.rate = Number(this.config.ttsRate);
    utterance.pitch = Number(this.config.ttsPitch);
    utterance.volume = Number(this.config.ttsVolume);
    utterance.onstart = () => this._patch({ outputSpeaking: true }, 'speech-output-started');
    utterance.onend = () => this._patch({ outputSpeaking: false }, 'speech-output-ended');
    utterance.onerror = () => this._patch({ outputSpeaking: false }, 'speech-output-error');
    synthesis.speak(utterance);
    return true;
  }

  cancelSpeech(reason = 'barge-in') {
    const synthesis = this.windowRef?.speechSynthesis;
    if (!synthesis) return false;
    const wasSpeaking = synthesis.speaking === true || this.stateValue.outputSpeaking === true;
    synthesis.cancel?.();
    if (wasSpeaking) {
      this._patch({
        outputSpeaking: false,
        bargeInCount: this.stateValue.bargeInCount + 1
      }, `speech-output-cancelled:${safeEventName(reason)}`);
    }
    return wasSpeaking;
  }

  destroy() {
    this.stop('destroy');
    this.cancelSpeech('destroy');
    this.destroyed = true;
  }

  _nativeRecognitionAvailable() {
    return this.config.preferLocalStt !== true && (typeof this.recognitionFactory === 'function'
      || typeof this.windowRef?.SpeechRecognition === 'function'
      || typeof this.windowRef?.webkitSpeechRecognition === 'function');
  }

  _startNativeRecognition() {
    if (!this.stateValue.desiredActive || this.destroyed || this.recognition) return;
    const Recognition = this.windowRef?.SpeechRecognition ?? this.windowRef?.webkitSpeechRecognition;
    let recognition;
    try {
      recognition = typeof this.recognitionFactory === 'function'
        ? this.recognitionFactory()
        : new Recognition();
    } catch (error) {
      this._handleRecognitionError({ error: error?.name ?? 'recognition-construction' });
      return;
    }
    this.recognition = recognition;
    recognition.lang = this.config.lang;
    recognition.continuous = this.config.continuous;
    recognition.interimResults = this.config.interimResults;
    recognition.maxAlternatives = this.config.maxAlternatives;
    recognition.onstart = () => {
      this._patch({
        phase: 'listening',
        provider: 'browser-speech-recognition',
        restartCount: 0
      }, 'recognition-started');
      this._armUtteranceLimit();
    };
    recognition.onaudiostart = () => this._patch({ phase: 'listening' }, 'audio-capture-started');
    recognition.onspeechstart = () => {
      this.cancelSpeech('barge-in');
      this._patch({ phase: 'speech' }, 'speech-detected');
      this._armUtteranceLimit();
    };
    recognition.onspeechend = () => this._scheduleEndpoint();
    recognition.onresult = (event) => this._handleRecognitionResult(event);
    recognition.onerror = (event) => this._handleRecognitionError(event);
    recognition.onend = () => this._handleRecognitionEnd(recognition);
    this._patch({ phase: 'starting', provider: 'browser-speech-recognition' }, 'recognition-starting');
    try {
      recognition.start();
    } catch (error) {
      this.recognition = null;
      this._handleRecognitionError({ error: error?.name ?? 'recognition-start' });
    }
  }

  _handleRecognitionResult(event) {
    let interim = '';
    const finalParts = [];
    let confidence = null;
    const results = Array.from(event?.results ?? []);
    const startIndex = Number.isInteger(event?.resultIndex) ? event.resultIndex : 0;
    for (let index = startIndex; index < results.length; index += 1) {
      const result = results[index];
      const alternative = result?.[0];
      const text = String(alternative?.transcript ?? '').trim();
      if (!text) continue;
      if (result?.isFinal === true) {
        finalParts.push(text);
        const nextConfidence = Number(alternative?.confidence);
        if (Number.isFinite(nextConfidence)) confidence = Math.max(confidence ?? 0, nextConfidence);
      } else {
        interim = `${interim} ${text}`.trim();
      }
    }
    if (interim) {
      const sanitized = normalizeSanitized(this.sanitizeText(interim));
      this._patch({ interimLength: interim.length, phase: 'speech' }, 'interim-result');
      this.onInterim({
        preview: compactText(sanitized.text, 48),
        length: interim.length,
        redactionCount: sanitized.redactionCount
      });
    }
    if (finalParts.length > 0) {
      this.pendingFinalText = `${this.pendingFinalText} ${finalParts.join(' ')}`.trim();
      this.pendingFinalConfidence = confidence ?? this.pendingFinalConfidence;
      this._patch({ interimLength: 0, phase: 'processing' }, 'final-result-buffered');
      this._scheduleEndpoint();
    }
  }

  _scheduleEndpoint() {
    if (!this.pendingFinalText) return;
    if (this.endpointTimer) this.clearTimeoutFn?.(this.endpointTimer);
    this.endpointTimer = this.setTimeoutFn?.(() => {
      this.endpointTimer = null;
      this._commitPendingTranscript();
    }, this.config.endSilenceMs);
  }

  _commitPendingTranscript() {
    const transcript = this.pendingFinalText;
    const confidence = this.pendingFinalConfidence;
    this._discardPendingTranscript();
    if (!transcript) return;
    const sanitized = normalizeSanitized(this.sanitizeText(transcript));
    this._patch({
      phase: this.stateValue.desiredActive ? 'listening' : 'idle',
      lastFinalAt: iso(this.now()),
      lastConfidence: confidence,
      utteranceCount: this.stateValue.utteranceCount + 1,
      interimLength: 0
    }, 'transcript-finalized');
    try {
      const result = this.onFinalTranscript(transcript, {
        provider: this.stateValue.provider,
        confidence,
        length: transcript.length,
        redactionCount: sanitized.redactionCount,
        rawTranscriptStored: false
      });
      Promise.resolve(result).catch(() => {
        this._patch({}, 'transcript-handler-failed');
      });
    } finally {
      // The raw transcript is only passed to the immediate command handler.
    }
  }

  _handleRecognitionError(event) {
    const classified = classifyWearableVoiceError(event?.error ?? 'unknown');
    if (classified.code === 'aborted' && this.stateValue.desiredActive === false) return;
    this._recordError(classified);
    this._patch({ phase: classified.retryable ? 'recovering' : 'error' }, `recognition-error:${safeEventName(classified.code)}`);
    if (classified.retryable) this._scheduleRestart();
    else this._patch({ desiredActive: false }, 'recognition-stopped-permanently');
  }

  _handleRecognitionEnd(recognition) {
    if (this.recognition === recognition) this.recognition = null;
    if (this.utteranceTimer) this.clearTimeoutFn?.(this.utteranceTimer);
    this.utteranceTimer = null;
    if (this.pendingFinalText) this._commitPendingTranscript();
    if (this.stateValue.desiredActive) this._scheduleRestart();
    else this._patch({ phase: 'idle' }, 'recognition-ended');
  }

  _scheduleRestart() {
    if (!this.stateValue.desiredActive || this.restartTimer || this.destroyed) return;
    if (this.stateValue.restartCount >= this.config.maxRestartAttempts) {
      if (typeof this.fallbackTranscriber === 'function') {
        this._runFallbackTranscriber();
      } else {
        this._patch({ desiredActive: false, phase: 'error' }, 'restart-budget-exhausted');
      }
      return;
    }
    const nextCount = this.stateValue.restartCount + 1;
    const delayMs = Math.min(
      this.config.restartMaxDelayMs,
      this.config.restartBaseDelayMs * (2 ** Math.max(0, nextCount - 1))
    );
    this._patch({ phase: 'recovering', restartCount: nextCount }, 'recognition-restart-scheduled');
    this.restartTimer = this.setTimeoutFn?.(() => {
      this.restartTimer = null;
      this._startNativeRecognition();
    }, delayMs);
  }

  async _runFallbackTranscriber() {
    if (!this.stateValue.desiredActive || typeof this.fallbackTranscriber !== 'function') return;
    this._patch({ phase: 'processing', provider: 'local-stt-gateway' }, 'fallback-transcriber-started');
    try {
      const result = await this.fallbackTranscriber({
        lang: this.config.lang,
        maxDurationMs: this.config.fallbackCaptureMs
      });
      const transcript = String(result?.transcript ?? result?.text ?? '').trim();
      if (!transcript) throw new Error('empty-transcript');
      this.pendingFinalText = transcript;
      this.pendingFinalConfidence = Number.isFinite(Number(result?.confidence)) ? Number(result.confidence) : null;
      this._patch({ provider: result?.provider ?? 'local-stt-gateway' }, 'fallback-transcriber-completed');
      this._commitPendingTranscript();
    } catch (error) {
      const classified = classifyWearableFallbackError(error);
      this._recordError(classified);
      this._patch({ phase: 'error', desiredActive: false }, 'fallback-transcriber-failed');
      return;
    }
    // Fallback capture is deliberately push-to-talk, avoiding unattended microphone loops.
    this._patch({ phase: 'idle', desiredActive: false }, 'fallback-session-completed');
  }

  _recordError(classified) {
    const patch = classified.retryable
      ? { recoverableErrorCount: this.stateValue.recoverableErrorCount + 1 }
      : { permanentErrorCount: this.stateValue.permanentErrorCount + 1 };
    this._patch({
      ...patch,
      lastError: {
        code: classified.code,
        category: classified.category,
        retryable: classified.retryable,
        userAction: classified.userAction,
        at: iso(this.now())
      }
    }, 'voice-error-recorded');
  }

  _armUtteranceLimit() {
    if (this.utteranceTimer) this.clearTimeoutFn?.(this.utteranceTimer);
    this.utteranceTimer = this.setTimeoutFn?.(() => {
      this.utteranceTimer = null;
      try {
        this.recognition?.stop?.();
      } catch {
        this._scheduleRestart();
      }
    }, this.config.maxUtteranceMs);
  }

  _discardPendingTranscript() {
    this.pendingFinalText = '';
    this.pendingFinalConfidence = null;
  }

  _clearTimers() {
    for (const timer of [this.restartTimer, this.endpointTimer, this.utteranceTimer]) {
      if (timer) this.clearTimeoutFn?.(timer);
    }
    this.restartTimer = null;
    this.endpointTimer = null;
    this.utteranceTimer = null;
  }

  _patch(patch, eventType) {
    const at = iso(this.now());
    const event = {
      type: safeEventName(eventType),
      at,
      phase: patch.phase ?? this.stateValue.phase
    };
    this.stateValue = {
      ...this.stateValue,
      ...patch,
      lastStateAt: at,
      telemetry: [...this.stateValue.telemetry, event].slice(-this.config.telemetryLimit),
      privacy: {
        rawTranscriptStored: false,
        rawAudioStored: false,
        interimContentStored: false,
        telemetryContainsContent: false
      }
    };
    try {
      this.onStateChange(this.snapshot());
    } catch {
      // UI observers cannot break the voice lifecycle.
    }
  }
}

export function createHttpAudioFallbackTranscriber({
  windowRef = globalThis.window,
  endpoint = '/voice/transcribe',
  fetchImpl = windowRef?.fetch?.bind(windowRef),
  captureAudio = null
} = {}) {
  return async function transcribe({ lang = 'ko-KR', maxDurationMs = 5000 } = {}) {
    const mediaDevices = windowRef?.navigator?.mediaDevices;
    const MediaRecorder = windowRef?.MediaRecorder;
    const customCapture = typeof captureAudio === 'function';
    if (!customCapture && (typeof mediaDevices?.getUserMedia !== 'function' || typeof MediaRecorder !== 'function')) {
      const error = new Error('media-recorder-unavailable');
      error.code = 'media-recorder-unavailable';
      throw error;
    }
    let stream = null;
    let chunks = [];
    let captured = null;
    try {
      let mimeType;
      let audio;
      if (customCapture) {
        captured = await captureAudio({ lang, maxDurationMs });
        audio = captured?.audio ?? captured;
        mimeType = String(captured?.mimeType ?? audio?.type ?? 'application/octet-stream');
      } else {
        stream = await mediaDevices.getUserMedia({ audio: true, video: false });
        const recorder = new MediaRecorder(stream, preferredRecorderOptions(MediaRecorder));
        const stopped = new Promise((resolve, reject) => {
          recorder.ondataavailable = (event) => {
            if (event?.data?.size > 0) chunks.push(event.data);
          };
          recorder.onerror = () => reject(new Error('media-recorder-failed'));
          recorder.onstop = resolve;
        });
        recorder.start(250);
        await delay(Math.max(500, Number(maxDurationMs) || 5000));
        recorder.stop();
        await stopped;
        mimeType = recorder.mimeType || chunks[0]?.type || 'audio/webm';
        audio = new Blob(chunks, { type: mimeType });
      }
      if (audioByteLength(audio) === 0) throw new Error('empty-audio');
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': mimeType,
          'x-jarvis-wearable-request': 'voice-transcription-v1',
          'x-jarvis-language': lang
        },
        body: audio
      });
      const payload = await response.json();
      if (!response.ok || payload?.success === false) {
        const error = new Error(payload?.error?.message ?? `voice-transcribe-http-${response.status}`);
        error.code = payload?.error?.code ?? 'voice-transcribe-failed';
        throw error;
      }
      return {
        transcript: String(payload.transcript ?? ''),
        confidence: payload.confidence ?? null,
        provider: payload.provider ?? 'local-stt-gateway',
        rawAudioStored: false
      };
    } catch (error) {
      if (error?.name === 'NotAllowedError') error.code = 'permission-denied';
      throw error;
    } finally {
      chunks = [];
      for (const track of stream?.getTracks?.() ?? []) track.stop?.();
      captured?.dispose?.();
    }
  };
}

function audioByteLength(value) {
  return Number(value?.size ?? value?.byteLength ?? value?.length ?? 0);
}

function preferredRecorderOptions(MediaRecorder) {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const mimeType = candidates.find((candidate) => typeof MediaRecorder.isTypeSupported !== 'function' || MediaRecorder.isTypeSupported(candidate));
  return mimeType ? { mimeType } : undefined;
}

function defaultSanitizeText(value) {
  let text = String(value ?? '');
  let redactionCount = 0;
  const redact = (pattern, replacement) => {
    text = text.replace(pattern, () => {
      redactionCount += 1;
      return replacement;
    });
  };
  redact(/\b(?:bearer|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s]+/gi, '[SECRET]');
  redact(/\b[A-Z]:[\\/][^\s]+/gi, '[PATH]');
  redact(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]');
  return { text, redactionCount };
}

function normalizeSanitized(value) {
  if (value && typeof value === 'object') {
    return {
      text: String(value.text ?? ''),
      redactionCount: Number(value.redactionCount ?? value.redactions?.length ?? 0)
    };
  }
  return { text: String(value ?? ''), redactionCount: 0 };
}

function compactText(value, maxChars) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function structuredCloneSafe(value) {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function safeEventName(value) {
  return String(value ?? 'unknown').replace(/[^a-z0-9:_-]/gi, '_').slice(0, 96);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  return Math.max(1, Math.floor(positiveNumber(value, fallback)));
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}
