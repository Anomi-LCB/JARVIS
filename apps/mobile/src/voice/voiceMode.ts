// 음성 대화모드: STT(명령을 말로 입력) + TTS(계획·질문·결과를 읽어줌).
// 네이티브 모듈이 없는 환경(테스트 러너, 구 빌드)에서도 앱이 죽지 않도록
// 지연 로딩하고, 미지원이면 조용히 비활성 상태로 남긴다.

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

export const voiceSupport = {
  tts: Boolean(Speech?.speak),
  stt: Boolean(recognitionModule?.start)
};

// TTS 낭독 상한: Android TTS 엔진의 4000자 제한 아래로 자른다.
const maxSpeakChars = 3600;

export function speak(text: unknown, options: { enabled?: boolean } = {}) {
  if (options.enabled === false || !voiceSupport.tts) return;
  const body = String(text ?? '').trim();
  if (!body) return;
  try {
    Speech.stop();
    Speech.speak(body.slice(0, maxSpeakChars), { language: 'ko-KR' });
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

// 마이크 권한을 확인/요청한다. 이미 있으면 팝업을 띄우지 않는다.
// 방금 부여됐는지 여부(justGranted)를 함께 돌려줘 start 타이밍 보정에 쓴다.
export async function ensureMicPermission(): Promise<{ granted: boolean; justGranted: boolean }> {
  if (!voiceSupport.stt) return { granted: false, justGranted: false };
  const current = await recognitionModule.getPermissionsAsync().catch(() => null);
  if (current?.granted) return { granted: true, justGranted: false };
  const requested = await recognitionModule.requestPermissionsAsync();
  return { granted: Boolean(requested?.granted), justGranted: Boolean(requested?.granted) };
}

export async function startListening() {
  if (!voiceSupport.stt) {
    throw new Error('이 빌드는 음성 인식을 지원하지 않습니다. 앱을 업데이트해 주세요.');
  }
  const { granted, justGranted } = await ensureMicPermission();
  if (!granted) {
    throw new Error('마이크 권한이 필요합니다. 설정에서 허용해 주세요.');
  }
  // 권한이 막 부여된 직후에는 마이크 세션이 준비되기 전이라 첫 start가 실패할 수 있다.
  // 짧게 기다린 뒤 시작하고, 그래도 실패하면 한 번 재시도한다.
  if (justGranted) await sleep(400);
  const options = { lang: 'ko-KR', interimResults: true, continuous: false };
  try {
    recognitionModule.start(options);
  } catch (error) {
    await sleep(500);
    recognitionModule.start(options);
  }
}

export function stopListening() {
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
  onResult?: (transcript: string, isFinal: boolean) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
};

export function useVoiceEvents(handlers: VoiceEventHandlers) {
  useSpeechRecognitionEvent('result', (event: any) => {
    const transcript = String(event?.results?.[0]?.transcript ?? '').trim();
    if (transcript) handlers.onResult?.(transcript, Boolean(event?.isFinal));
  });
  useSpeechRecognitionEvent('end', () => {
    handlers.onEnd?.();
  });
  useSpeechRecognitionEvent('error', (event: any) => {
    // 'no-speech'는 사용자가 말을 안 한 것 — 오류 표시 없이 종료만 처리한다.
    if (String(event?.error ?? '') === 'no-speech') {
      handlers.onEnd?.();
      return;
    }
    handlers.onError?.(String(event?.message ?? event?.error ?? '음성 인식에 실패했습니다.'));
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

// 완료 상태를 음성 안내문으로 요약한다.
export function resultSpeech(status: string, result: any): string {
  if (status === 'COMPLETED') {
    const summary = result?.summary ? String(result.summary) : '';
    return summary ? `작업을 완료했습니다. ${summary}` : '작업을 완료했습니다.';
  }
  if (status === 'CANCELLED') return '작업을 취소했습니다.';
  return `작업이 끝났지만 ${status} 상태입니다. 화면을 확인해 주세요.`;
}
