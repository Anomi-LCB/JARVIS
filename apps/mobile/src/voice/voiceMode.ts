// 음성 대화모드: STT(명령을 말로 입력) + TTS(계획·질문·결과를 읽어줌).
// 네이티브 모듈이 없는 환경(테스트 러너, 구 빌드)에서도 앱이 죽지 않도록
// 지연 로딩하고, 미지원이면 조용히 비활성 상태로 남긴다.

import { normalizeVoiceConfidence } from './voice-evidence.js';
import {
  buildRecognitionServiceOrder,
  isRecoverableRecognitionStartError,
  recognitionStartupTimeoutMs
} from './recognitionPolicy.js';

// Metro 런타임의 require를 지연 로딩에 사용한다 (strict TS 환경 대비 선언).
declare const require: (id: string) => any;

let Speech: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Speech = require('expo-speech');
} catch {
  Speech = null;
}

let SpeechRecognition: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SpeechRecognition = require('expo-speech-recognition');
} catch {
  SpeechRecognition = null;
}

const recognitionModule = SpeechRecognition?.ExpoSpeechRecognitionModule ?? null;
let recognitionServiceCursor = 0;
let activeRecognitionEngine = 'platform-default';
let recognitionActive = false;
let recognitionStartOperation: Promise<RecognitionStartResult> | null = null;
let recognitionAttemptSequence = 0;
let suppressRecognitionEndUntil = 0;

type RecognitionStartResult = {
  engine: string;
  attempts: number;
  recovered: boolean;
  cancelled?: boolean;
};

type RecognitionStartupError = Error & {
  code: string;
  engine: string;
};

type PendingRecognitionStart = {
  id: number;
  engine: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: RecognitionStartupError) => void;
};

let pendingRecognitionStart: PendingRecognitionStart | null = null;

export const voiceSupport = {
  tts: Boolean(Speech?.speak),
  stt: Boolean(recognitionModule?.start)
};

export function availableRecognitionServices(): string[] {
  try {
    const available = recognitionModule?.getSpeechRecognitionServices?.();
    const defaultService = recognitionModule?.getDefaultRecognitionService?.()?.packageName;
    return buildRecognitionServiceOrder({
      availableServices: Array.isArray(available) ? available : [],
      defaultService
    });
  } catch {
    return ['platform-default'];
  }
}

export function getRecognitionEngine(): string {
  const services = availableRecognitionServices();
  return services[recognitionServiceCursor % services.length];
}

export function getActiveRecognitionEngine(): string {
  return activeRecognitionEngine;
}

export function rotateRecognitionEngine(): string {
  const services = availableRecognitionServices();
  if (services.length > 1) recognitionServiceCursor = (recognitionServiceCursor + 1) % services.length;
  return getRecognitionEngine();
}

// TTS 낭독 상한: Android TTS 엔진의 4000자 제한 아래로 자른다.
const maxSpeakChars = 3600;

// 말하기 속도(0.1~1.0). 한국어 기본 TTS는 빠르게 들려서 살짝 낮춘 값을 기본으로 둔다.
// 사용자 설정으로 조절하며, SecureStore 등에서 불러온 값을 setSpeechRate로 주입한다.
export const speechRatePresets = [
  { id: 'slow', label: '느리게', rate: 0.6 },
  { id: 'normal', label: '보통', rate: 0.85 },
  { id: 'fast', label: '빠르게', rate: 1.1 }
] as const;

let currentSpeechRate = 0.85;

export function setSpeechRate(rate: number) {
  if (Number.isFinite(rate) && rate > 0) currentSpeechRate = Math.min(1.6, Math.max(0.3, rate));
}

export function getSpeechRate(): number {
  return currentSpeechRate;
}

export function speak(text: unknown, options: { enabled?: boolean } = {}) {
  if (options.enabled === false || !voiceSupport.tts) return;
  const body = String(text ?? '').trim();
  if (!body) return;
  try {
    Speech.stop();
    Speech.speak(body.slice(0, maxSpeakChars), { language: 'ko-KR', rate: currentSpeechRate });
  } catch {
    // 낭독 실패는 흐름을 막지 않는다.
  }
}

export function stopSpeaking() {
  try {
    Speech?.stop();
  } catch {
    // ignore
  }
}

// 낭독이 끝날 때까지 기다리는 버전. 대화 모드의 턴테이킹(말 끝나면 듣기 시작)에 사용한다.
// 중단(onStopped)·실패(onError)도 resolve로 처리해 루프가 멈추지 않게 한다.
export function speakAsync(text: unknown, options: { enabled?: boolean } = {}): Promise<void> {
  return new Promise((resolve) => {
    if (options.enabled === false || !voiceSupport.tts) return resolve();
    const body = String(text ?? '').trim();
    if (!body) return resolve();
    try {
      Speech.stop();
      Speech.speak(body.slice(0, maxSpeakChars), {
        language: 'ko-KR',
        rate: currentSpeechRate,
        onDone: () => resolve(),
        onStopped: () => resolve(),
        onError: () => resolve()
      });
    } catch {
      resolve();
    }
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startupError(code: string, engine: string, message: string): RecognitionStartupError {
  const error = new Error(message) as RecognitionStartupError;
  error.code = String(code || 'unknown');
  error.engine = engine;
  return error;
}

function errorCode(error: unknown): string {
  return String((error as { code?: unknown })?.code ?? 'unknown');
}

function rejectPendingRecognitionStart(error: RecognitionStartupError, { expectEnd = true } = {}) {
  const pending = pendingRecognitionStart;
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingRecognitionStart = null;
  if (expectEnd) suppressRecognitionEndUntil = Date.now() + 1500;
  pending.reject(error);
  return true;
}

function waitForRecognitionStart(engine: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = ++recognitionAttemptSequence;
    const timer = setTimeout(() => {
      if (pendingRecognitionStart?.id !== id) return;
      const error = startupError(
        'startup-timeout',
        engine,
        `음성 인식 서비스가 ${recognitionStartupTimeoutMs / 1000}초 안에 준비되지 않았습니다.`
      );
      rejectPendingRecognitionStart(error);
      try {
        recognitionModule?.abort?.();
      } catch {
        // The next engine attempt remains authoritative.
      }
    }, recognitionStartupTimeoutMs);
    pendingRecognitionStart = { id, engine, timer, resolve, reject };
  });
}

function resolvePendingRecognitionStart() {
  const pending = pendingRecognitionStart;
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingRecognitionStart = null;
  suppressRecognitionEndUntil = 0;
  activeRecognitionEngine = pending.engine;
  recognitionActive = true;
  pending.resolve();
  return true;
}

function consumeSuppressedRecognitionEnd() {
  if (Date.now() > suppressRecognitionEndUntil) return false;
  suppressRecognitionEndUntil = 0;
  return true;
}

// 마이크 권한을 확인/요청한다. 이미 있으면 팝업을 띄우지 않는다.
// 방금 부여됐는지 여부(justGranted)를 함께 돌려줘 start 타이밍 보정에 쓴다.
export async function ensureMicPermission(): Promise<{ granted: boolean; justGranted: boolean }> {
  if (!voiceSupport.stt) return { granted: false, justGranted: false };
  const current = await recognitionModule.getPermissionsAsync().catch(() => null);
  if (current?.granted) return { granted: true, justGranted: false };
  const requested = await recognitionModule.requestPermissionsAsync();
  return { granted: Boolean(requested?.granted), justGranted: Boolean(requested?.granted) };
}

function recognitionOptions(recognitionEngine: string, audioSourceUri: string | null) {
  const options: any = {
    lang: 'ko-KR',
    interimResults: true,
    continuous: false,
    volumeChangeEventOptions: { enabled: true, intervalMillis: 250 }
  };
  if (recognitionEngine !== 'platform-default') {
    options.androidRecognitionServicePackage = recognitionEngine;
  }
  if (audioSourceUri) {
    options.audioSource = {
      uri: audioSourceUri,
      audioChannels: 1,
      audioEncoding: SpeechRecognition?.AudioEncodingAndroid?.ENCODING_PCM_16BIT ?? 2,
      sampleRate: 16000,
      chunkDelayMillis: 50
    };
  }
  return options;
}

async function startRecognition(audioSourceUri: string | null = null): Promise<RecognitionStartResult> {
  if (!voiceSupport.stt) {
    throw new Error('이 빌드는 음성 인식을 지원하지 않습니다. 앱을 업데이트해 주세요.');
  }
  const { granted, justGranted } = await ensureMicPermission();
  if (!granted) {
    throw new Error('마이크 권한이 필요합니다. 설정에서 허용해 주세요.');
  }
  if (justGranted) await sleep(400);

  const engines = availableRecognitionServices();
  const failures: RecognitionStartupError[] = [];
  for (let attempt = 0; attempt < engines.length; attempt += 1) {
    const recognitionEngine = getRecognitionEngine();
    activeRecognitionEngine = recognitionEngine;
    const ready = waitForRecognitionStart(recognitionEngine);
    try {
      recognitionModule.start(recognitionOptions(recognitionEngine, audioSourceUri));
    } catch (error) {
      rejectPendingRecognitionStart(startupError(
        errorCode(error),
        recognitionEngine,
        String((error as Error)?.message ?? '음성 인식 서비스를 시작하지 못했습니다.')
      ));
      try {
        recognitionModule?.abort?.();
      } catch {
        // Continue through the shared startup failure path.
      }
    }

    try {
      await ready;
      return { engine: recognitionEngine, attempts: attempt + 1, recovered: attempt > 0 };
    } catch (error) {
      const failure = error as RecognitionStartupError;
      if (failure.code === 'aborted') {
        return { engine: recognitionEngine, attempts: attempt + 1, recovered: attempt > 0, cancelled: true };
      }
      failures.push(failure);
      if (!isRecoverableRecognitionStartError(failure.code) || attempt === engines.length - 1) break;
      rotateRecognitionEngine();
      await sleep(450);
    }
  }

  const details = failures.map((failure) => `${failure.engine}:${failure.code}`).join(', ');
  throw startupError(
    'recognizer-unavailable',
    getRecognitionEngine(),
    `음성 인식 서비스를 준비하지 못했습니다. Android 음성 인식 설정을 확인해 주세요.${details ? ` (${details})` : ''}`
  );
}

export async function startListening() {
  if (recognitionActive) return { engine: activeRecognitionEngine, attempts: 0, recovered: false };
  if (recognitionStartOperation) return recognitionStartOperation;
  const operation = startRecognition();
  recognitionStartOperation = operation;
  try {
    return await operation;
  } finally {
    if (recognitionStartOperation === operation) recognitionStartOperation = null;
  }
}

export async function startListeningFromAudioFile(uri: string) {
  const normalized = String(uri ?? '').trim();
  if (!normalized.startsWith('file://')) throw new Error('로컬 음성 파일 URI가 필요합니다.');
  if (recognitionActive) return { engine: activeRecognitionEngine, attempts: 0, recovered: false };
  if (recognitionStartOperation) return recognitionStartOperation;
  const operation = startRecognition(normalized);
  recognitionStartOperation = operation;
  try {
    return await operation;
  } finally {
    if (recognitionStartOperation === operation) recognitionStartOperation = null;
  }
}

export function stopListening() {
  if (pendingRecognitionStart) {
    const engine = pendingRecognitionStart.engine;
    rejectPendingRecognitionStart(startupError('aborted', engine, '음성 인식 준비를 취소했습니다.'));
    try {
      recognitionModule?.abort?.();
    } catch {
      // ignore
    }
    return;
  }
  try {
    recognitionModule?.stop();
  } catch {
    // ignore
  }
}

// useSpeechRecognitionEvent 훅은 항상 같은 순서로 호출돼야 하므로(훅 규칙),
// 미지원 환경에서는 동일 시그니처의 no-op 훅으로 대체한다.
const useSpeechRecognitionEvent =
  SpeechRecognition?.useSpeechRecognitionEvent ?? ((_event: string, _handler: unknown) => {});

export type VoiceEventHandlers = {
  onStart?: (engine: string) => void;
  onSpeechStart?: () => void;
  onVolume?: (value: number) => void;
  onNoSpeech?: () => void;
  onResult?: (transcript: string, isFinal: boolean, evidence: VoiceRecognitionEvidence) => void;
  onEnd?: () => void;
  onError?: (message: string, code: string) => void;
};

export type VoiceRecognitionEvidence = {
  confidence: number | null;
  alternativesCount: number;
  locale: string;
  engine: string;
  confirmationMode?: 'repeat-consensus' | 'voice-readback';
  confirmationReason?: string;
  confirmationCount?: number;
  independentEngineCount?: number;
  confirmationEngine?: string;
  confirmationConfidence?: number | null;
  rawAudioStored: false;
  alternativesStored: false;
};

export function useVoiceEvents(handlers: VoiceEventHandlers) {
  const handleRecognitionReady = () => {
    const startupSettled = resolvePendingRecognitionStart();
    if (!startupSettled && recognitionActive) return;
    recognitionActive = true;
    handlers.onStart?.(activeRecognitionEngine);
  };
  // Some Samsung/Android 16 recognizers open the capture pipeline but omit
  // RecognitionListener.onReadyForSpeech. audiostart is the earliest portable
  // proof that startListening was accepted; a later start event is deduplicated.
  useSpeechRecognitionEvent('audiostart', handleRecognitionReady);
  useSpeechRecognitionEvent('start', () => {
    handleRecognitionReady();
  });
  useSpeechRecognitionEvent('speechstart', () => {
    handlers.onSpeechStart?.();
  });
  useSpeechRecognitionEvent('volumechange', (event: any) => {
    const value = Number(event?.value);
    if (Number.isFinite(value)) handlers.onVolume?.(value);
  });
  useSpeechRecognitionEvent('result', (event: any) => {
    const results = Array.isArray(event?.results) ? event.results : [];
    const primary = results[0];
    const transcript = String(primary?.transcript ?? '').trim();
    const confidence = normalizeVoiceConfidence(primary?.confidence);
    if (transcript) {
      handlers.onResult?.(transcript, event?.isFinal === true, {
        confidence,
        alternativesCount: results.length,
        locale: 'ko-KR',
        engine: activeRecognitionEngine,
        rawAudioStored: false,
        alternativesStored: false
      });
    }
  });
  useSpeechRecognitionEvent('end', () => {
    recognitionActive = false;
    if (consumeSuppressedRecognitionEnd()) return;
    if (pendingRecognitionStart) {
      const engine = pendingRecognitionStart.engine;
      rejectPendingRecognitionStart(startupError(
        'ended-before-ready',
        engine,
        '음성 인식 서비스가 준비되기 전에 종료되었습니다.'
      ), { expectEnd: false });
      return;
    }
    handlers.onEnd?.();
  });
  useSpeechRecognitionEvent('error', (event: any) => {
    const code = String(event?.error ?? 'unknown');
    const message = String(event?.message ?? event?.error ?? '음성 인식에 실패했습니다.');
    recognitionActive = false;
    if (pendingRecognitionStart) {
      const engine = pendingRecognitionStart.engine;
      rejectPendingRecognitionStart(startupError(code, engine, message));
      return;
    }
    // 'no-speech'는 일반 오류와 분리해 입력 신호 진단과 재시도 UX에 사용한다.
    if (code === 'no-speech') {
      handlers.onNoSpeech?.();
      return;
    }
    handlers.onError?.(message, code);
  });
}

// 승인카드를 음성 안내문으로 요약한다.
export function approvalSpeech(card: any): string {
  const parts: string[] = [];
  const explanation = card?.planExplanation ?? card?.interpretedIntent ?? card?.title;
  if (explanation) parts.push(String(explanation));
  const questions = Array.isArray(card?.clarifyingQuestions) ? card.clarifyingQuestions : [];
  if (questions.length) {
    parts.push('몇 가지 확인하고 싶어요.');
    for (const question of questions.slice(0, 3)) parts.push(String(question));
  } else {
    parts.push('진행할까요? 화면에서 승인을 눌러 주세요.');
  }
  return parts.join(' ');
}

// 경로에서 파일명만 뽑는다.
export function fileNameOf(path: unknown): string {
  return String(path ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

// 완료 상태를 음성 안내문으로 요약한다. 무엇을 만들었는지(파일명)를 분명히 말한다.
export function resultSpeech(status: string, result: any): string {
  if (status === 'COMPLETED') {
    const files = (result?.outputPaths ?? []).map(fileNameOf).filter(Boolean);
    const summary = result?.summary ? String(result.summary) : '';
    if (files.length) {
      const fileList = files.slice(0, 3).join(', ');
      const base = `${fileList} 파일을 만들어 PC에 저장했어요.`;
      return summary ? `${base} ${summary}` : base;
    }
    return summary ? `완료했어요. ${summary}` : '요청하신 작업을 완료했어요.';
  }
  if (status === 'CANCELLED') return '작업을 취소했어요.';
  if (status === 'BLOCKED') return '안전 정책에 걸려 작업을 진행하지 못했어요. 화면을 확인해 주세요.';
  return `작업이 ${status} 상태로 끝났어요. 화면을 확인해 주세요.`;
}
