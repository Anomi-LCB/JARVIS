import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Linking,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Pressable,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import * as Application from 'expo-application';
import * as FileSystem from 'expo-file-system';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Mic,
  AudioLines,
  Volume2,
  VolumeX,
  FileText,
  X,
  Check,
  Lightbulb,
  ChevronRight,
  CircleCheck
} from 'lucide-react-native';
import { createMobileAppShell } from './App.js';
import { BridgeClient, defaultBridgeClientTimeoutMs } from './api/BridgeClient.js';
import { normalizeBridgeUrlForPlatform } from './api/bridge-url.js';
import { openOfficialDocument } from './api/android-official-intents.js';
import { canNavigate, MobileRoutes } from './navigation/routes.js';
import { ConnectionStatusBar } from './components/ConnectionStatusBar';
import { NativeRuntimeProbe } from './components/NativeRuntimeProbe';
import { PairingQrPanel } from './components/PairingQrPanel';
import { CommandComposerPanel } from './components/CommandComposerPanel';
import { ApprovalCardView } from './components/ApprovalCardView';
import { TaskStatusPill } from './components/TaskStatusPill';
import { ResultSummaryCard } from './components/ResultSummaryCard';
import { createResultFileUri } from './components/ResultFeedbackPanel.js';
import { createSkillRevisionDiff, GrowthReviewDecisionPanel } from './components/GrowthReviewDecisionPanel';
import { PoisonQueueActionPanel } from './components/PoisonQueueActionPanel';
import { RetryPolicySettingsPanel } from './components/RetryPolicySettingsPanel';
import { approvalExpiryState } from './approval/approval-expiry.js';
import {
  appendApprovalHistory,
  approvalHistoryTone,
  createApprovalHistoryEvent,
  createApprovalTimeline
} from './approval/approval-history.js';
import { colors } from './theme/colors';
import { spacing, radius, shadow } from './theme/spacing';
import { typography } from './theme/typography';
import {
  approvalSpeech,
  getSpeechRate,
  resultSpeech,
  rotateRecognitionEngine,
  setSpeechRate,
  speak,
  speakAsync,
  speechRatePresets,
  startListening,
  startListeningFromAudioFile,
  stopListening,
  stopSpeaking,
  useVoiceEvents,
  voiceSupport
} from './voice/voiceMode';
import {
  evaluateVoiceAutoSubmit,
  evaluateVoiceReadbackConfirmation,
  evaluateVoiceRepeatConfirmation
} from './voice/voice-evidence.js';
import { createVoiceCommandTurn, observeVoiceCommandTurn } from './voice/voice-command-turn.js';
import { classifyUtterance } from './voice/conversation';
import {
  createMobileProductState,
  decisionLabels,
  feedbackLabels,
  routeMeta,
  taskStatusSteps
} from './state/mobile-product-demo.js';

const storageKeys = {
  bridgeUrl: 'jarvis.bridgeUrl',
  deviceToken: 'jarvis.deviceToken'
};
const isolatedE2EPackage = 'local.eureka.jarvis.e2e';
const isolatedE2EVoiceFixturePath = '/jarvis-e2e-voice.wav';
const isolatedE2ECommandFixtures = new Set(['list files']);

function isAllowedIsolatedVoiceFixtureSource(input: string | null) {
  if (!input) return false;
  try {
    const source = new URL(input);
    const port = Number(source.port);
    return source.protocol === 'http:'
      && source.hostname === '127.0.0.1'
      && Number.isInteger(port)
      && port >= 1
      && port <= 65535
      && source.pathname === isolatedE2EVoiceFixturePath
      && source.username === ''
      && source.password === ''
      && source.search === ''
      && source.hash === '';
  } catch {
    return false;
  }
}

type ActionButtonProps = {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'warning' | 'danger' | 'neutral';
  testID?: string;
  accessibilityHint?: string;
};

type SectionProps = {
  title: string;
  caption?: string;
  children: React.ReactNode;
  testID?: string;
};

function Section({ title, caption, children, testID }: SectionProps) {
  return (
    <View testID={testID} style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function ActionButton({ label, onPress, disabled = false, tone = 'neutral', testID, accessibilityHint }: ActionButtonProps) {
  const toneColor = tone === 'primary'
    ? colors.accent
    : tone === 'warning'
      ? colors.warning
      : tone === 'danger'
        ? colors.danger
        : colors.line;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={[
        styles.actionButton,
        { borderColor: toneColor, opacity: disabled ? 0.5 : 1 }
      ]}
    >
      <Text style={[styles.actionText, { color: disabled ? colors.muted : colors.text }]}>{label}</Text>
    </Pressable>
  );
}

const dataLabelKo: Record<string, string> = {
  'Live Bridge': '실시간 브리지',
  Token: '인증 토큰',
  'Live source': '실시간 데이터 출처',
  'Effective URL': '실제 접속 주소',
  'PC Bridge': 'PC 브리지',
  'Token sealed': '토큰 보안 저장',
  'Plaintext exposed': '평문 노출',
  'Session lock': '세션 잠금',
  'App lifecycle': '앱 실행 상태',
  'Lock reason': '잠금 사유',
  'Last lock': '최근 잠금',
  'Stored token': '저장된 토큰',
  approvalId: '승인 ID',
  taskId: '작업 ID',
  decidedBy: '결정 기기',
  paired: '페어링',
  approval: '승인',
  task: '작업',
  notifications: '알림'
};

const dataValueKo: Record<string, string> = {
  connected: '연결됨',
  'not connected': '연결되지 않음',
  disconnected: '연결 끊김',
  none: '없음',
  yes: '예',
  no: '아니요',
  locked: '잠김',
  unlocked: '잠금 해제됨',
  active: '활성',
  passed: '통과',
  failed: '실패',
  blocked: '차단됨',
  pending: '대기 중',
  queued: '대기열에 있음',
  retrying: '재시도 중',
  quarantined: '격리됨',
  retry_scheduled: '재시도 예정',
  needs_review: '검토 필요',
  ignored: '무시됨',
  running: '실행 중',
  succeeded: '완료',
  granted: '허용됨',
  denied: '거부됨',
  undetermined: '미결정',
  notDetermined: '미결정',
  not_configured: '미설정'
};

function localizedDataValue(value: string) {
  const normalized = String(value ?? '');
  if (dataValueKo[normalized]) return dataValueKo[normalized];
  const waiting = normalized.match(/^(\d+) waiting$/);
  if (waiting) return `${waiting[1]}건 대기`;
  const unread = normalized.match(/^(\d+) unread$/);
  if (unread) return `${unread[1]}건 미확인`;
  return normalized;
}

function DataRow({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'good' | 'warning' | 'danger' }) {
  const valueColor = tone === 'good'
    ? colors.accent
    : tone === 'warning'
      ? colors.warning
      : tone === 'danger'
        ? colors.danger
        : colors.text;
  return (
    <View style={styles.dataRow}>
      <Text style={styles.dataLabel}>{dataLabelKo[label] ?? label}</Text>
      <Text style={[styles.dataValue, { color: valueColor }]}>{localizedDataValue(value)}</Text>
    </View>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <View style={styles.list}>
      {items.map((item) => (
        <Text key={item} style={styles.listItem}>- {item}</Text>
      ))}
    </View>
  );
}

function appendAudit(state: any, label: string) {
  const createdAt = new Date().toISOString();
  return {
    ...state,
    auditTrail: [
      { eventId: `audit_mobile_${state.auditTrail.length + 1}`, label, createdAt },
      ...state.auditTrail
    ].slice(0, 8)
  };
}

function normalizeBridgeUrlForDevice(input: string | null | undefined) {
  return normalizeBridgeUrlForPlatform(input, { platform: Platform.OS });
}

function tokenPreview(token: string | null | undefined) {
  if (!token) return null;
  if (token.length <= 14) return `${token.slice(0, 4)}...`;
  return `${token.slice(0, 8)}...${token.slice(-6)}`;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error || 'unknown-error');
}

function parseJarvisDeepLink(rawUrl: string | null | undefined) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'jarvis:') return null;
    const segment = parsed.pathname.replace(/^\/+/, '');
    return {
      rawUrl,
      host: parsed.hostname,
      segment,
      params: parsed.searchParams
    };
  } catch {
    return null;
  }
}

function bridgeFailureMessage(result: any, fallback: string) {
  return result?.error?.message ?? result?.error?.code ?? fallback;
}

function approvalHistoryPatch(historyById: Record<string, unknown>, approvalId: string, events: unknown[]) {
  return appendApprovalHistory(historyById ?? {}, approvalId, events);
}

function appStateLockReason(nextState: string) {
  if (nextState === 'background') return 'app-backgrounded';
  if (nextState === 'inactive') return 'app-inactive';
  return null;
}

function applyLiveBridgeState(state: any, patch: Record<string, unknown>) {
  return {
    ...state,
    liveBridge: {
      ...state.liveBridge,
      ...patch
    }
  };
}

// 처음 쓰는 사람을 위한 단계별 명령 예시. 기초 → 중급 → 고급 순으로 눈높이를 올린다.
// 목회 사역 맥락(신혼교구·심방 등)을 섞어 실제로 바로 써보게 유도한다.
const commandExamples: { level: string; tone: 'basic' | 'mid' | 'adv'; items: string[] }[] = [
  { level: '기초', tone: 'basic', items: ['메모 만들어', '오늘 할 일 정리해줘'] },
  { level: '중급', tone: 'mid', items: ['이번 주 사역 점검표 엑셀로 만들어', '심방 일정 목록 정리해줘'] },
  { level: '고급', tone: 'adv', items: ['이번달 가계부 엑셀 만들고 수입·지출 항목 넣어줘', '신혼교구 새가족 명단 표로 정리해줘'] }
];

// 홈 흐름 폴링: 적응형 백오프. 대부분의 단순 작업은 1초 안에 끝나므로 초반은 아주 촘촘히(즉각 반응),
// 콘텐츠 LLM처럼 오래 걸리는 작업은 간격을 늘려 서버 부담을 줄인다. "빠를 땐 빠르게, 오래 걸리면 여유롭게".
const homePollTotalBudgetMs = 100_000;
function homeBackoffDelay(attempt: number): number {
  if (attempt < 12) return 250;   // 첫 3초: 즉각 반응
  if (attempt < 30) return 600;   // ~14초
  return 1200;                    // 그 이후: 여유
}

function AppInner() {
  const insets = useSafeAreaInsets();
  const shell = useMemo(() => createMobileAppShell(), []);
  const appStateRef = useRef(AppState.currentState);
  const deepLinkHandlerRef = useRef<(url: string) => boolean>(() => false);
  const [route, setRoute] = useState<string>(MobileRoutes.HomeScreen);
  const [state, setState] = useState<any>(() => createMobileProductState());
  const [skillRegistryReview, setSkillRegistryReview] = useState<any>(null);
  const [skillRevisionSteps, setSkillRevisionSteps] = useState<Record<string, string>>({});
  const [skillRevisionBusy, setSkillRevisionBusy] = useState(false);
  const [skillRevisionMessage, setSkillRevisionMessage] = useState<string | null>(null);
  // 홈(가면) 화면 전용 대화 흐름 상태. 명령→승인→실행→결과를 한 화면에서 따라간다.
  const [home, setHome] = useState<any>({
    phase: 'idle',
    text: '',
    answer: '',
    taskId: null,
    approval: null,
    pcHandoff: null,
    taskStatus: null,
    result: null,
    error: null,
    notice: null,
    listening: false,
    voicePhase: 'idle',
    voicePeak: -2,
    voiceEngine: null,
    voiceOn: true
  });
  const homeFlowSeq = useRef(0);
  // TTS on/off는 비동기 흐름(승인 폴링/완료)에서도 최신값을 읽어야 하므로 ref로 미러링한다.
  const homeVoiceOnRef = useRef(true);
  // 말하기 속도 프리셋 선택 상태. 저장된 값을 불러와 voiceMode에 주입한다.
  const [speechRateId, setSpeechRateId] = useState<string>('normal');
  useEffect(() => {
    void (async () => {
      try {
        const saved = await SecureStore.getItemAsync('jarvis_speech_rate');
        const preset = speechRatePresets.find((p) => p.id === saved);
        if (preset) {
          setSpeechRateId(preset.id);
          setSpeechRate(preset.rate);
        } else {
          setSpeechRate(getSpeechRate());
        }
      } catch {
        // 저장값 없음 — 기본 속도 유지
      }
    })();
  }, []);

  function homeSelectRate(preset: { id: string; rate: number }) {
    setSpeechRateId(preset.id);
    setSpeechRate(preset.rate);
    void SecureStore.setItemAsync('jarvis_speech_rate', preset.id).catch(() => {});
    // 선택한 속도를 바로 체감하도록 짧게 시연한다.
    speak('이 속도로 말할게요.', { enabled: true });
  }

  // ── 온보딩 예시 추천 on/off (기본 켜짐, SecureStore에 저장) ──
  const [examplesOn, setExamplesOn] = useState<boolean>(true);
  useEffect(() => {
    void (async () => {
      try {
        const saved = await SecureStore.getItemAsync('jarvis_examples_on');
        if (saved === '0') setExamplesOn(false);
      } catch {
        // 저장값 없음 — 기본 켜짐 유지
      }
    })();
  }, []);
  function toggleExamples(next: boolean) {
    setExamplesOn(next);
    void SecureStore.setItemAsync('jarvis_examples_on', next ? '1' : '0').catch(() => {});
  }

  // ── 반복 작업 추천: 실행한 명령을 로컬에 누적해 자주(2회+) 하는 일을 홈에 추천한다 ──
  const [suggestions, setSuggestions] = useState<{ text: string; count: number }[]>([]);

  async function loadCommandHistory(): Promise<{ text: string; count: number; lastAt: number }[]> {
    try {
      const raw = await SecureStore.getItemAsync('jarvis_command_history');
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function computeSuggestions(list: { text: string; count: number; lastAt: number }[]) {
    return list
      .filter((entry) => entry.count >= 2)
      .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
      .slice(0, 4)
      .map((entry) => ({ text: entry.text, count: entry.count }));
  }

  useEffect(() => {
    void (async () => setSuggestions(computeSuggestions(await loadCommandHistory())))();
  }, []);

  async function recordCommand(text: string) {
    const trimmed = String(text ?? '').trim();
    // 너무 길거나 추가정보가 붙은 재계획 명령은 추천 후보에서 제외한다.
    if (!trimmed || trimmed.length > 60 || trimmed.includes('(추가 정보:')) return;
    const list = await loadCommandHistory();
    const existing = list.find((entry) => entry.text === trimmed);
    if (existing) {
      existing.count += 1;
      existing.lastAt = Date.now();
    } else {
      list.push({ text: trimmed, count: 1, lastAt: Date.now() });
    }
    const kept = list.sort((a, b) => b.lastAt - a.lastAt).slice(0, 40);
    try {
      await SecureStore.setItemAsync('jarvis_command_history', JSON.stringify(kept));
    } catch {
      // 저장 실패는 무시 — 추천은 부가 기능이다.
    }
    setSuggestions(computeSuggestions(kept));
  }

  // ── 대화 모드(연속 음성 대화) 상태: 듣기 → 생각 → 말하기 턴이 자동 순환한다 ──
  const [conv, setConv] = useState<{ active: boolean; phase: 'listening' | 'thinking' | 'speaking'; transcript: string }>({
    active: false,
    phase: 'listening',
    transcript: ''
  });
  const convRef = useRef(conv);
  useEffect(() => { convRef.current = conv; }, [conv]);
  const homeRef = useRef(home);
  useEffect(() => { homeRef.current = home; }, [home]);
  // 같은 승인카드/결과를 중복 낭독하지 않기 위한 키.
  const convSpokenKeyRef = useRef('');
  // 인식 오류 연속 재시도 상한 (음성 결과가 나오면 리셋).
  const convRetryRef = useRef(0);
  // 일부 Android STT 엔진은 같은 최종 결과를 연속 방출한다. 중복 작업 생성을 짧은 창에서 차단한다.
  const voiceFinalRef = useRef({ key: '', at: 0 });
  const voiceConfirmationRef = useRef<any>(null);
  const voiceSessionRef = useRef({
    peak: -2,
    speechDetected: false,
    resultReceived: false,
    finalReceived: false,
    cancelled: false,
    engineRotated: false
  });
  const voiceCommandTurnRef = useRef(createVoiceCommandTurn());
  const isolatedVoiceFixtureRef = useRef<{ localUri: string; sourceUrl: string } | null>(null);

  async function cleanupIsolatedVoiceFixture() {
    const fixture = isolatedVoiceFixtureRef.current;
    if (!fixture) return;
    isolatedVoiceFixtureRef.current = null;
    await FileSystem.deleteAsync(fixture.localUri, { idempotent: true }).catch(() => undefined);
    try {
      const cleanupUrl = new URL('/jarvis-e2e-voice-cleanup', fixture.sourceUrl);
      await fetch(cleanupUrl.toString(), { method: 'POST' });
    } catch {
      // The disposable E2E server may already be closed; local deletion is authoritative.
    }
  }

  // ── 음성 이벤트 라우팅: 단발 마이크(홈 입력)와 대화 모드를 함께 처리한다 ──
  useVoiceEvents({
    onStart: (engine) => {
      voiceCommandTurnRef.current = createVoiceCommandTurn();
      if (!convRef.current.active) {
        voiceSessionRef.current = {
          peak: -2,
          speechDetected: false,
          resultReceived: false,
          finalReceived: false,
          cancelled: false,
          engineRotated: false
        };
        setHome((current: any) => ({ ...current, listening: true, voicePhase: 'ready', voicePeak: -2, voiceEngine: engine, error: null }));
      }
    },
    onSpeechStart: () => {
      if (!convRef.current.active) {
        voiceSessionRef.current.speechDetected = true;
        setHome((current: any) => ({ ...current, listening: true, voicePhase: 'speech' }));
      }
    },
    onVolume: (value) => {
      if (convRef.current.active || value <= voiceSessionRef.current.peak) return;
      voiceSessionRef.current.peak = value;
      if (value > 0) voiceSessionRef.current.speechDetected = true;
      setHome((current: any) => ({
        ...current,
        voicePeak: value,
        voicePhase: value > 0 ? 'speech' : current.voicePhase
      }));
    },
    onNoSpeech: () => {
      if (convRef.current.active || voiceSessionRef.current.cancelled) return;
      const heardAudio = voiceSessionRef.current.speechDetected || voiceSessionRef.current.peak > 0;
      if (!voiceSessionRef.current.engineRotated) {
        rotateRecognitionEngine();
        voiceSessionRef.current.engineRotated = true;
      }
      setHome((current: any) => ({
        ...current,
        listening: false,
        voicePhase: 'idle',
        error: heardAudio
          ? '음성은 들었지만 명령으로 인식하지 못했어요. 다른 인식 방식으로 전환했으니 다시 말씀해 주세요.'
          : '마이크에 음성이 들어오지 않았어요. 가까이에서 다시 말씀해 주세요.'
      }));
    },
    onResult: (transcript, isFinal, voiceEvidence) => {
      if (!convRef.current.active) {
        voiceSessionRef.current.resultReceived = true;
        if (isFinal) voiceSessionRef.current.finalReceived = true;
      }
      const autoSubmit = isFinal ? evaluateVoiceAutoSubmit(voiceEvidence) : null;
      let acceptedTranscript = transcript;
      let acceptedVoiceEvidence = voiceEvidence;
      const pendingConfirmation = voiceConfirmationRef.current;
      const isolatedFixtureActive = Boolean(isolatedVoiceFixtureRef.current);
      if (isFinal && pendingConfirmation) {
        const readback = evaluateVoiceReadbackConfirmation(pendingConfirmation, {
          transcript,
          engine: voiceEvidence.engine,
          evidence: voiceEvidence
        });
        if (readback.handled && readback.rejected) {
          voiceConfirmationRef.current = null;
          rotateRecognitionEngine();
          voiceSessionRef.current.engineRotated = true;
          const retryMessage = '알겠습니다. 명령을 다시 말씀해 주세요.';
          if (convRef.current.active) {
            setConv((current) => ({ ...current, transcript: '' }));
            void convSayThenListen(retryMessage);
            return;
          }
          setHome((current: any) => ({
            ...current,
            text: '',
            listening: false,
            voicePhase: 'idle',
            error: retryMessage
          }));
          if (!isolatedFixtureActive) void homeSayThenListen(retryMessage, { requireConfirmation: false });
          return;
        }
        if (readback.handled && readback.accepted) {
          acceptedTranscript = readback.transcript;
          acceptedVoiceEvidence = {
            ...(readback.evidence ?? voiceEvidence),
            confirmationMode: 'voice-readback',
            confirmationReason: readback.reason,
            confirmationCount: readback.confirmationCount,
            independentEngineCount: readback.independentEngineCount,
            confirmationEngine: readback.confirmationEngine,
            confirmationConfidence: readback.confirmationConfidence
          };
          voiceConfirmationRef.current = null;
        } else if (readback.handled) {
          rotateRecognitionEngine();
          voiceSessionRef.current.engineRotated = true;
          const retryMessage = '확인 응답이 불확실합니다. 맞으면 네, 틀리면 아니요라고 다시 말해 주세요.';
          if (convRef.current.active) {
            setConv((current) => ({ ...current, transcript: '' }));
            void convSayThenListen(retryMessage);
            return;
          }
          setHome((current: any) => ({
            ...current,
            text: pendingConfirmation.transcript,
            listening: false,
            voicePhase: 'idle',
            error: retryMessage
          }));
          if (!isolatedFixtureActive) void homeSayThenListen(retryMessage);
          return;
        } else {
          const confirmation = evaluateVoiceRepeatConfirmation(pendingConfirmation.repeatCandidate, {
            transcript,
            engine: voiceEvidence.engine
          });
          if (confirmation.accepted) {
            acceptedVoiceEvidence = {
              ...voiceEvidence,
              confirmationMode: 'repeat-consensus',
              confirmationReason: confirmation.reason,
              confirmationCount: confirmation.count,
              independentEngineCount: confirmation.independentEngineCount
            };
            voiceConfirmationRef.current = null;
          } else {
            voiceConfirmationRef.current = {
              ...pendingConfirmation,
              repeatCandidate: confirmation.candidate
            };
            rotateRecognitionEngine();
            voiceSessionRef.current.engineRotated = true;
            const retryMessage = `앞서 ${pendingConfirmation.transcript}로 들었습니다. 맞으면 네, 틀리면 아니요라고 말해 주세요.`;
            if (convRef.current.active) {
              setConv((current) => ({ ...current, transcript: '' }));
              void convSayThenListen(retryMessage);
              return;
            }
            setHome((current: any) => ({
              ...current,
              text: pendingConfirmation.transcript,
              listening: false,
              voicePhase: 'idle',
              error: retryMessage
            }));
            if (!isolatedFixtureActive) void homeSayThenListen(retryMessage);
            return;
          }
        }
      } else if (isFinal && autoSubmit?.accepted === false) {
        const confirmation = evaluateVoiceRepeatConfirmation(null, {
          transcript,
          engine: voiceEvidence.engine
        });
        const now = Date.now();
        voiceConfirmationRef.current = {
          at: now,
          transcript,
          evidence: voiceEvidence,
          repeatCandidate: confirmation.candidate
        };
        rotateRecognitionEngine();
        voiceSessionRef.current.engineRotated = true;
        const spokenTranscript = transcript.length > 180 ? `${transcript.slice(0, 180)}. 이하 생략` : transcript;
        const retryMessage = `${spokenTranscript}로 들었습니다. 맞으면 네, 틀리면 아니요라고 말해 주세요.`;
        if (convRef.current.active) {
          setConv((current) => ({ ...current, transcript: '' }));
          void convSayThenListen(retryMessage);
          return;
        }
        setHome((current: any) => ({
          ...current,
          text: transcript,
          listening: false,
          voicePhase: 'idle',
          error: retryMessage
        }));
        if (!isolatedFixtureActive) void homeSayThenListen(retryMessage);
        return;
      } else if (isFinal && autoSubmit?.accepted === true) {
        voiceConfirmationRef.current = null;
      }
      const turnResult = observeVoiceCommandTurn(voiceCommandTurnRef.current, { transcript: acceptedTranscript, isFinal });
      voiceCommandTurnRef.current = turnResult.turn;
      if (!turnResult.accepted) return;
      acceptedTranscript = turnResult.transcript ?? acceptedTranscript;
      if (turnResult.correctionApplied) {
        acceptedVoiceEvidence = { ...acceptedVoiceEvidence, correctionApplied: true, supersededDraftDiscarded: true };
      }
      if (isFinal && !turnResult.committed) return;
      if (convRef.current.active) {
        setConv((current) => ({ ...current, transcript: acceptedTranscript }));
        if (isFinal && acceptVoiceFinal(acceptedTranscript)) {
          void convHandleUtterance(acceptedTranscript, acceptedVoiceEvidence);
        }
        return;
      }
      setHome((current: any) => ({ ...current, text: acceptedTranscript, voicePhase: 'speech', error: null }));
      if (isFinal && acceptVoiceFinal(acceptedTranscript)) {
        setHome((current: any) => ({ ...current, listening: false, voicePhase: 'idle' }));
        void homeSubmit(acceptedTranscript, { inputMode: 'voice', voiceEvidence: acceptedVoiceEvidence });
      }
    },
    onEnd: () => {
      void cleanupIsolatedVoiceFixture();
      if (convRef.current.active) {
        // 침묵 등으로 인식이 끝났으면 대화가 이어지도록 조용히 다시 듣는다.
        if (convRef.current.phase === 'listening') void convListen(600);
        return;
      }
      const session = voiceSessionRef.current;
      const heardAudio = session.speechDetected || session.peak > 0;
      if (!session.finalReceived && !session.cancelled && !session.engineRotated) {
        rotateRecognitionEngine();
        session.engineRotated = true;
      }
      setHome((current: any) => ({
        ...current,
        listening: false,
        voicePhase: 'idle',
        error: session.cancelled || session.finalReceived || current.error
          ? current.error
          : heardAudio
            ? '음성은 들었지만 명령으로 인식하지 못했어요. 다른 인식 방식으로 전환했으니 다시 말씀해 주세요.'
            : '마이크에 음성이 들어오지 않았어요. 가까이에서 다시 말씀해 주세요.'
      }));
    },
    onError: (message, code) => {
      void cleanupIsolatedVoiceFixture();
      if (convRef.current.active) {
        if (convRef.current.phase === 'listening') {
          if (!['aborted', 'not-allowed'].includes(code)) rotateRecognitionEngine();
          convRetryRef.current += 1;
          if (convRetryRef.current > 8) {
            convExit(false);
            setHome((current: any) => ({ ...current, error: `음성 인식이 계속 실패해 대화 모드를 종료했습니다. (${message})` }));
            return;
          }
        }
        return;
      }
      const canRotate = !voiceSessionRef.current.cancelled && !['aborted', 'not-allowed'].includes(code);
      if (canRotate && !voiceSessionRef.current.engineRotated) {
        rotateRecognitionEngine();
        voiceSessionRef.current.engineRotated = true;
      }
      setHome((current: any) => ({
        ...current,
        listening: false,
        voicePhase: 'idle',
        error: canRotate ? '음성 인식 엔진을 다른 방식으로 전환했어요. 다시 말씀해 주세요.' : message
      }));
    }
  });

  function acceptVoiceFinal(transcript: string) {
    const key = String(transcript ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const now = Date.now();
    if (key && voiceFinalRef.current.key === key && now - voiceFinalRef.current.at < 2500) return false;
    voiceFinalRef.current = { key, at: now };
    return true;
  }

  async function convListen(delayMs = 0) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    if (!convRef.current.active) return;
    stopSpeaking();
    try {
      await startListening();
      setConv((current) => ({ ...current, phase: 'listening', transcript: '' }));
    } catch (error) {
      // 마이크 권한 거부 등 — 대화 모드를 접고 사유를 홈에 표시한다.
      convExit(false);
      setHome((current: any) => ({ ...current, error: errorMessage(error) }));
    }
  }

  async function convSay(text: string) {
    stopListening();
    setConv((current) => ({ ...current, phase: 'speaking' }));
    await speakAsync(text);
  }

  async function convSayThenListen(text: string) {
    await convSay(text);
    await convListen();
  }

  async function convHandleUtterance(transcript: string, voiceEvidence: any = null) {
    convRetryRef.current = 0;
    setConv((current) => ({ ...current, phase: 'thinking', transcript }));
    const h = homeRef.current;
    const awaitingDecision = h.phase === 'approval' && h.approval;
    const intent = classifyUtterance(transcript, { awaitingDecision: Boolean(awaitingDecision) });
    if (intent === 'exit') {
      convExit(true);
      return;
    }
    if (awaitingDecision) {
      if (intent === 'approve') {
        await convSay('네, 진행합니다.');
        void homeDecide('approve');
        return;
      }
      if (intent === 'reject') {
        await convSay('알겠습니다. 취소합니다.');
        void homeDecide('reject');
        return;
      }
      // 명료화 답변/추가 정보 → 그 내용으로 다시 계획한다.
      await convSay('그 정보로 다시 계획해 볼게요.');
      void homeResubmitWithAnswer(transcript, 'voice', voiceEvidence);
      return;
    }
    void homeSubmit(transcript, { inputMode: 'voice', voiceEvidence });
  }

  function convEnter() {
    if (!voiceSupport.stt) {
      setHome((current: any) => ({ ...current, error: '이 빌드는 음성 인식을 지원하지 않습니다.' }));
      return;
    }
    stopListening();
    convSpokenKeyRef.current = '';
    setConv({ active: true, phase: 'speaking', transcript: '' });
    void (async () => {
      await speakAsync('대화 모드를 시작합니다. 무엇을 도와드릴까요?');
      await convListen();
    })();
  }

  function convExit(sayGoodbye: boolean) {
    stopListening();
    stopSpeaking();
    setConv({ active: false, phase: 'listening', transcript: '' });
    if (sayGoodbye) speak('대화 모드를 종료합니다.', { enabled: true });
  }

  // 홈 흐름의 국면 전환을 대화 모드가 뒤따라 말한다: 승인카드 도착 → 낭독+결정 듣기, 완료 → 결과 낭독+다음 명령 듣기.
  useEffect(() => {
    if (!conv.active) return;
    if (home.phase === 'approval' && home.approval) {
      const key = `approval:${home.approval.approvalId ?? home.taskId}`;
      if (!convSpokenKeyRef.current.startsWith(key)) {
        convSpokenKeyRef.current = key;
        const hasQuestions = (home.approval.clarifyingQuestions ?? []).length > 0;
        const prompt = hasQuestions ? ' 답을 말씀해 주세요.' : ' 진행하려면 승인, 멈추려면 거절이라고 말씀해 주세요.';
        void convSayThenListen(approvalSpeech(home.approval) + prompt);
        return;
      }
      // 카드 낭독 후 생긴 공지(예: 고위험이라 모바일 승인 차단)도 말해줘야 대화가 멈추지 않는다.
      if (home.notice) {
        const noticeKey = `${key}:notice:${home.notice}`;
        if (convSpokenKeyRef.current !== noticeKey) {
          convSpokenKeyRef.current = noticeKey;
          void convSayThenListen(`${home.notice} 다른 명령을 말씀하거나 거절이라고 해주세요.`);
        }
      }
      return;
    }
    if (home.phase === 'pc-confirmation' && home.pcHandoff) {
      const challenge = String(home.pcHandoff.voiceChallenge?.phrase ?? '').trim();
      const key = `pc-confirmation:${home.pcHandoff.handoffId}:${challenge}`;
      if (convSpokenKeyRef.current !== key) {
        convSpokenKeyRef.current = key;
        const phrase = challenge
          ? `PC 앞에서 자비스 ${challenge} 승인이라고 말씀해 주세요.`
          : 'PC의 자비스 화면에서 음성 확인을 진행해 주세요.';
        void convSay(`${phrase} 완료될 때까지 상태를 확인하겠습니다.`);
      }
      return;
    }
    if (home.phase === 'done') {
      const key = `done:${home.taskId ?? ''}:${home.taskStatus ?? ''}`;
      if (convSpokenKeyRef.current !== key) {
        convSpokenKeyRef.current = key;
        void (async () => {
          await convSay(resultSpeech(home.taskStatus, home.result) + ' 다음 할 일을 말씀해 주세요.');
          homeReset();
          await convListen();
        })();
      }
      return;
    }
    if (home.phase === 'idle' && home.error) {
      const key = `error:${home.error}`;
      if (convSpokenKeyRef.current !== key) {
        convSpokenKeyRef.current = key;
        void convSayThenListen(`문제가 있었어요. ${home.error} 다시 말씀해 주세요.`);
      }
    }
  }, [conv.active, home.phase, home.approval, home.pcHandoff, home.taskStatus, home.error, home.notice]);

  // 듣는 중 상태를 시각화하는 맥동 애니메이션.
  const convPulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (conv.active && conv.phase === 'listening') {
      const loop = Animated.loop(Animated.sequence([
        Animated.timing(convPulse, { toValue: 1.22, duration: 650, useNativeDriver: true }),
        Animated.timing(convPulse, { toValue: 1, duration: 650, useNativeDriver: true })
      ]));
      loop.start();
      return () => loop.stop();
    }
    convPulse.setValue(conv.phase === 'speaking' ? 1.1 : 1);
    return undefined;
  }, [conv.active, conv.phase]);

  function prepareHomeVoiceSession() {
    voiceSessionRef.current = {
      peak: -2,
      speechDetected: false,
      resultReceived: false,
      finalReceived: false,
      cancelled: false,
      engineRotated: false
    };
    setHome((current: any) => ({ ...current, listening: true, voicePhase: 'starting', voicePeak: -2, error: null, text: '' }));
  }

  async function homeSayThenListen(prompt: string, { requireConfirmation = true } = {}) {
    stopListening();
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (requireConfirmation && !voiceConfirmationRef.current) return;
    await speakAsync(prompt);
    if (requireConfirmation && !voiceConfirmationRef.current) return;
    prepareHomeVoiceSession();
    try {
      await startListening();
    } catch (error) {
      setHome((current: any) => ({ ...current, listening: false, voicePhase: 'idle', error: errorMessage(error) }));
    }
  }

  async function homeSetListening(nextListening: boolean) {
    if (!nextListening) {
      if (!homeRef.current.listening) return;
      voiceSessionRef.current.cancelled = true;
      stopListening();
      setHome((current: any) => ({ ...current, listening: false, voicePhase: 'idle' }));
      return;
    }
    if (homeRef.current.listening) return;
    stopSpeaking();
    prepareHomeVoiceSession();
    try {
      await startListening();
    } catch (error) {
      setHome((current: any) => ({ ...current, listening: false, voicePhase: 'idle', error: errorMessage(error) }));
    }
  }

  async function homeToggleListening() {
    await homeSetListening(!homeRef.current.listening);
  }

  async function homeStartIsolatedVoiceFixture(sourceUrl: string) {
    stopSpeaking();
    prepareHomeVoiceSession();
    try {
      await cleanupIsolatedVoiceFixture();
      if (!FileSystem.cacheDirectory) throw new Error('앱 내부 음성 캐시를 사용할 수 없습니다.');
      const localUri = `${FileSystem.cacheDirectory}jarvis-e2e-voice-${Date.now()}.wav`;
      const downloaded = await FileSystem.downloadAsync(sourceUrl, localUri);
      if (downloaded.status !== 200) {
        await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => undefined);
        throw new Error(`음성 검증 파일 다운로드 실패 (${downloaded.status})`);
      }
      isolatedVoiceFixtureRef.current = { localUri: downloaded.uri, sourceUrl };
      await startListeningFromAudioFile(downloaded.uri);
    } catch (error) {
      await cleanupIsolatedVoiceFixture();
      setHome((current: any) => ({ ...current, listening: false, voicePhase: 'idle', error: errorMessage(error) }));
    }
  }

  function homeToggleVoice() {
    setHome((current: any) => {
      const next = !current.voiceOn;
      homeVoiceOnRef.current = next;
      if (!next) stopSpeaking();
      return { ...current, voiceOn: next };
    });
  }

  function homeSpeak(text: string) {
    // 대화 모드에서는 대화 컨트롤러가 턴에 맞춰 낭독하므로 단발 낭독은 건너뛴다.
    if (convRef.current.active) return;
    speak(text, { enabled: homeVoiceOnRef.current });
  }
  const effectiveBridgeUrl = normalizeBridgeUrlForDevice(state.connection.bridgeUrl);

  const selectedApproval = state.approvals.items.find((item: any) => item.approvalId === state.approvals.selectedApprovalId)
    ?? state.approvals.items[0];
  const selectedPoisonItem = state.poisonQueue.items.find((item: any) => item.queueId === state.poisonQueue.selectedQueueId)
    ?? state.poisonQueue.items[0]
    ?? null;

  function createBridgeClient(token = state.liveBridge.deviceToken ?? null) {
    return new BridgeClient({
      bridgeUrl: effectiveBridgeUrl,
      tokenProvider: () => token,
      timeoutMs: defaultBridgeClientTimeoutMs
    });
  }

  useEffect(() => {
    let mounted = true;
    async function restoreLiveBridgeState() {
      try {
        const [storedBridgeUrl, storedToken] = await Promise.all([
          SecureStore.getItemAsync(storageKeys.bridgeUrl),
          SecureStore.getItemAsync(storageKeys.deviceToken)
        ]);
        if (!mounted) return;
        setState((current: any) => applyLiveBridgeState({
          ...current,
          connection: {
            ...current.connection,
            bridgeUrl: storedBridgeUrl ?? current.connection.bridgeUrl,
            effectiveBridgeUrl: normalizeBridgeUrlForDevice(storedBridgeUrl ?? current.connection.bridgeUrl)
          },
          device: storedToken
            ? {
                ...current.device,
                paired: true,
                pairingStatus: 'paired',
                authTokenExists: true,
                tokenStorage: {
                  ...current.device.tokenStorage,
                  exists: true,
                  sealed: true,
                  plaintextExposed: false,
                  backendName: 'expo-secure-store'
                }
              }
            : current.device
        }, {
          restored: true,
          deviceToken: storedToken,
          deviceTokenLoaded: Boolean(storedToken),
          deviceTokenPreview: tokenPreview(storedToken),
          error: null
        }));
      } catch (error) {
        if (!mounted) return;
        setState((current: any) => applyLiveBridgeState(current, {
          restored: true,
          error: `보안 저장소 복원 실패: ${errorMessage(error)}`
        }));
      }
    }
    restoreLiveBridgeState();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const previousAppState = appStateRef.current;
      appStateRef.current = nextAppState;
      const reason = appStateLockReason(nextAppState);
      const changedAt = new Date().toISOString();
      setState((current: any) => {
        const security = {
          ...current.security,
          lifecycle: nextAppState,
          lastAppState: previousAppState,
          lastAppStateChangedAt: changedAt,
          ...(reason
            ? {
                locked: true,
                sensitiveActionReady: false,
                lastLifecycleLockReason: reason,
                lastLifecycleLockAt: changedAt
              }
            : {})
        };
        const nextState = {
          ...current,
          security,
          screenMessage: reason
            ? '앱 상태 변경으로 세션을 잠갔습니다. 민감 작업은 다시 PIN/생체 인증이 필요합니다.'
            : current.screenMessage
        };
        return reason
          ? appendAudit(nextState, `기기 앱 상태 변경으로 모바일 세션이 잠겼습니다: ${reason}`)
          : nextState;
      });
    });
    return () => subscription.remove();
  }, []);

  deepLinkHandlerRef.current = handleJarvisDeepLink;

  useEffect(() => {
    let mounted = true;
    const consumeUrl = (url: string | null) => {
      if (!mounted || !url) return;
      deepLinkHandlerRef.current(url);
    };
    Linking.getInitialURL()
      .then(consumeUrl)
      .catch(() => undefined);
    const subscription = Linking.addEventListener('url', ({ url }) => consumeUrl(url));
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  function navigate(nextRoute: string) {
    setRoute(nextRoute);
  }

  function updateMessage(message: string) {
    setState((current: any) => ({ ...current, screenMessage: message }));
  }

  function handleJarvisDeepLink(rawUrl: string) {
    const link = parseJarvisDeepLink(rawUrl);
    if (!link) return false;

    if (link.host === 'route') {
      const nextRoute = decodeURIComponent(link.segment);
      if (canNavigate(nextRoute)) {
        navigate(nextRoute);
        updateMessage(`바로 가기 화면을 열었습니다: ${routeMeta[nextRoute as keyof typeof routeMeta]?.label ?? nextRoute}`);
        return true;
      }
      updateMessage(`지원하지 않는 바로 가기 화면을 무시했습니다: ${nextRoute || '경로 없음'}`);
      return false;
    }

    if (link.host === 'pair') {
      const pairingCode = link.params.get('code');
      const bridgeUrl = link.params.get('bridge');
      setState((current: any) => ({
        ...current,
        connection: {
          ...current.connection,
          bridgeUrl: bridgeUrl ?? current.connection.bridgeUrl,
          effectiveBridgeUrl: normalizeBridgeUrlForDevice(bridgeUrl ?? current.connection.bridgeUrl)
        },
        device: {
          ...current.device,
          pairingCode: pairingCode ?? current.device.pairingCode,
          pairingStatus: pairingCode ? 'pairing' : current.device.pairingStatus
        },
        screenMessage: `페어링 바로 가기를 불러왔습니다: ${pairingCode ?? '코드 없음'}`
      }));
      // 코드와 브리지 주소가 모두 담긴 링크는 원터치 페어링으로 바로 확정한다.
      if (pairingCode && bridgeUrl) {
        void confirmPairing(pairingCode, bridgeUrl);
        navigate(MobileRoutes.HomeScreen);
        return true;
      }
      navigate(MobileRoutes.PairingScreen);
      return true;
    }

    if (link.host === 'bridge' && link.segment === 'health') {
      void checkBridgeHealth();
      return true;
    }

    if (link.host === 'pairing' && link.segment === 'start') {
      void startLivePairing();
      return true;
    }

    if (link.host === 'pairing' && link.segment === 'confirm') {
      const pairingCode = link.params.get('code');
      void confirmPairing(pairingCode);
      return true;
    }

    if (link.host === 'e2e-voice' && link.segment === 'transcribe') {
      const source = link.params.get('source');
      if (Application.applicationId !== isolatedE2EPackage || !isAllowedIsolatedVoiceFixtureSource(source)) {
        updateMessage('격리된 음성 시험 파일 바로 가기를 차단했습니다.');
        return false;
      }
      navigate(MobileRoutes.HomeScreen);
      void homeStartIsolatedVoiceFixture(source as string);
      return true;
    }

    if (link.host === 'e2e-voice' && ['start', 'stop'].includes(link.segment)) {
      if (Application.applicationId !== isolatedE2EPackage) {
        updateMessage('격리된 음성 입력 시험 바로 가기를 차단했습니다.');
        return false;
      }
      navigate(MobileRoutes.HomeScreen);
      void homeSetListening(link.segment === 'start');
      return true;
    }

    if (link.host === 'e2e-command' && link.segment === 'create') {
      const commandText = String(link.params.get('text') ?? '').trim();
      if (Application.applicationId !== isolatedE2EPackage || !isolatedE2ECommandFixtures.has(commandText)) {
        updateMessage('격리된 명령 제출 시험 바로 가기를 차단했습니다.');
        return false;
      }
      navigate(MobileRoutes.HomeScreen);
      setHome((current: any) => ({ ...current, text: commandText, error: null }));
      void homeSubmit(commandText);
      return true;
    }

    if (link.host === 'e2e-approval' && ['approve', 'reject'].includes(link.segment)) {
      if (Application.applicationId !== isolatedE2EPackage || !homeRef.current.approval) {
        updateMessage('격리된 승인 결정 시험 바로 가기를 차단했습니다.');
        return false;
      }
      navigate(MobileRoutes.HomeScreen);
      void homeDecide(link.segment === 'approve' ? 'approve' : 'reject');
      return true;
    }

    if (link.host === 'task' && link.segment === 'create') {
      void submitCommand();
      return true;
    }

    if (link.host === 'approvals' && link.segment === 'refresh') {
      void refreshLiveApprovals();
      return true;
    }

    if (link.host === 'approval' && link.segment === 'open') {
      const approvalId = link.params.get('approvalId') ?? state.approvals.selectedApprovalId;
      if (!approvalId) {
        updateMessage('승인 ID가 없어 승인 바로 가기를 무시했습니다.');
        return false;
      }
      void chooseApproval(approvalId);
      return true;
    }

    if (link.host === 'approval' && ['approve', 'edit', 'reject', 'respond'].includes(link.segment)) {
      void sendApprovalDecision(link.segment);
      return true;
    }

    if (link.host === 'device' && link.segment === 'disconnect') {
      void disconnect();
      return true;
    }

    updateMessage(`지원하지 않는 바로 가기를 무시했습니다: ${rawUrl}`);
    return false;
  }

  async function checkBridgeHealth() {
    const startedAt = Date.now();
    setState((current: any) => applyLiveBridgeState(current, {
      loading: true,
      lastAction: 'health',
      error: null,
      lastResponse: null
    }));
    updateMessage(`D 브리지 연결 상태 확인 중: ${effectiveBridgeUrl}`);
    try {
      await SecureStore.setItemAsync(storageKeys.bridgeUrl, state.connection.bridgeUrl);
      const result = await createBridgeClient().getHealth();
      if (result?.success === false) {
        throw new Error(bridgeFailureMessage(result, 'bridge-health-failed'));
      }
      const connected = result?.status === 'ok';
      setState((current: any) => applyLiveBridgeState({
        ...current,
        connection: {
          ...current.connection,
          connected,
          effectiveBridgeUrl,
          lastCheckedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          error: connected ? null : 'D_BRIDGE_HEALTH_NOT_OK'
        },
        screenMessage: connected
          ? `D 브리지 연결 성공: ${effectiveBridgeUrl}`
          : 'D 브리지가 응답했지만 정상 상태가 아닙니다.'
      }, {
        loading: false,
        lastAction: 'health',
        lastResponse: result,
        error: connected ? null : 'D_BRIDGE_HEALTH_NOT_OK'
      }));
      return result;
    } catch (error) {
      const message = errorMessage(error);
      setState((current: any) => applyLiveBridgeState({
        ...current,
        connection: {
          ...current.connection,
          connected: false,
          effectiveBridgeUrl,
          lastCheckedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          error: message
        },
        screenMessage: `D 브리지 연결 실패: ${message}`
      }, {
        loading: false,
        lastAction: 'health',
        error: message
      }));
      return null;
    }
  }

  async function startLivePairing() {
    setState((current: any) => applyLiveBridgeState(current, {
      loading: true,
      lastAction: 'pairing.start',
      error: null,
      lastResponse: null
    }));
    updateMessage(`D 브리지 페어링 시작 요청 중: ${effectiveBridgeUrl}`);
    try {
      await SecureStore.setItemAsync(storageKeys.bridgeUrl, state.connection.bridgeUrl);
      const result = await createBridgeClient(null).startPairing();
      if (result?.success === false || !result?.pairingCode) {
        throw new Error(bridgeFailureMessage(result, 'pairing-start-failed'));
      }
      setState((current: any) => applyLiveBridgeState({
        ...current,
        connection: {
          ...current.connection,
          effectiveBridgeUrl,
          lastCheckedAt: new Date().toISOString(),
          error: null
        },
        device: {
          ...current.device,
          pairingCode: result?.pairingCode ?? current.device.pairingCode,
          pairingStatus: 'pairing'
        },
        screenMessage: `D 브리지 페어링 코드 발급: ${result?.pairingCode ?? '확인 불가'}`
      }, {
        loading: false,
        lastAction: 'pairing.start',
        startSession: result,
        lastResponse: result,
        error: null
      }));
      return result;
    } catch (error) {
      const message = errorMessage(error);
      setState((current: any) => applyLiveBridgeState({
        ...current,
        screenMessage: `페어링 시작 실패: ${message}`
      }, {
        loading: false,
        lastAction: 'pairing.start',
        error: message
      }));
      return null;
    }
  }

  async function confirmPairing(pairingCodeOverride: string | null = null, bridgeUrlOverride: string | null = null) {
    const pairingCode = pairingCodeOverride || state.device.pairingCode;
    const targetBridgeUrl = bridgeUrlOverride ?? state.connection.bridgeUrl;
    const targetEffectiveUrl = normalizeBridgeUrlForDevice(targetBridgeUrl);
    setState((current: any) => applyLiveBridgeState(current, {
      loading: true,
      lastAction: 'pairing.confirm',
      error: null,
      lastResponse: null
    }));
    updateMessage(`D 브리지 페어링 확인 요청 중: ${pairingCode}`);
    try {
      await SecureStore.setItemAsync(storageKeys.bridgeUrl, targetBridgeUrl);
      const result = await new BridgeClient({
        bridgeUrl: targetEffectiveUrl,
        tokenProvider: () => null,
        timeoutMs: defaultBridgeClientTimeoutMs
      }).confirmPairing({
        deviceId: state.device.deviceId,
        deviceName: state.device.deviceName,
        pairingCode
      });
      if (result?.success === false || !result?.deviceToken) {
        throw new Error(result?.error?.message ?? result?.error?.code ?? 'pairing-confirm-failed');
      }
      await SecureStore.setItemAsync(storageKeys.deviceToken, result.deviceToken);
      setState((current: any) => applyLiveBridgeState(appendAudit({
        ...current,
        connection: {
          ...current.connection,
          connected: true,
          bridgeUrl: targetBridgeUrl,
          effectiveBridgeUrl: targetEffectiveUrl,
          lastCheckedAt: new Date().toISOString(),
          latencyMs: 0,
          error: null
        },
        device: {
          ...current.device,
          pairingCode,
          paired: true,
          pairingStatus: 'paired',
          authTokenExists: true,
          tokenStorage: {
            ...current.device.tokenStorage,
            exists: true,
            sealed: true,
            plaintextExposed: false,
            backendName: 'expo-secure-store'
          }
        },
        screenMessage: 'D 브리지 페어링을 완료하고 기기 토큰을 보안 저장소에 저장했습니다.'
      }, 'D 브리지 페어링을 완료하고 기기 토큰을 보안 저장소에 저장했습니다.'), {
        loading: false,
        lastAction: 'pairing.confirm',
        lastResponse: { ...result, deviceToken: tokenPreview(result.deviceToken) },
        deviceToken: result.deviceToken,
        deviceTokenLoaded: true,
        deviceTokenPreview: tokenPreview(result.deviceToken),
        error: null
      }));
      navigate(MobileRoutes.HomeScreen);
      return result;
    } catch (error) {
      const message = errorMessage(error);
      setState((current: any) => applyLiveBridgeState({
        ...current,
        connection: {
          ...current.connection,
          connected: false,
          effectiveBridgeUrl,
          lastCheckedAt: new Date().toISOString(),
          error: message
        },
        screenMessage: `실제 페어링 실패: ${message}`
      }, {
        loading: false,
        lastAction: 'pairing.confirm',
        error: message
      }));
      return null;
    }
  }

  function confirmDemoPairing() {
    setState((current: any) => appendAudit({
      ...current,
      connection: {
        ...current.connection,
        connected: true,
        effectiveBridgeUrl,
        lastCheckedAt: new Date().toISOString(),
        latencyMs: 18,
        error: null
      },
      device: {
        ...current.device,
        paired: true,
        pairingStatus: 'paired',
        authTokenExists: true,
        tokenStorage: {
          ...current.device.tokenStorage,
          exists: true,
          sealed: true,
          plaintextExposed: false
        }
      },
      screenMessage: '페어링 완료. 이후 요청은 기기 인증 토큰과 함께 D 브리지로 전달됩니다.'
    }, 'D 브리지 페어링을 확인하고 기기 토큰을 보안 저장소에 저장했습니다.'));
    navigate(MobileRoutes.CommandScreen);
  }

  async function disconnect() {
    let revokeResult = null;
    let revokeError = null;
    if (state.liveBridge.deviceToken) {
      setState((current: any) => applyLiveBridgeState(current, {
        loading: true,
        lastAction: 'device.revoke',
        error: null
      }));
      try {
        const result = await createBridgeClient(state.liveBridge.deviceToken).revokeDevice(state.device.deviceId);
        if (result?.success === false) {
          throw new Error(bridgeFailureMessage(result, 'device-revoke-failed'));
        }
        revokeResult = result;
      } catch (error) {
        revokeError = errorMessage(error);
      }
    }
    await Promise.all([
      SecureStore.deleteItemAsync(storageKeys.deviceToken).catch(() => undefined),
      SecureStore.deleteItemAsync(storageKeys.bridgeUrl).catch(() => undefined)
    ]);
    setState((current: any) => applyLiveBridgeState(appendAudit({
      ...current,
      connection: {
        ...current.connection,
        connected: false,
        effectiveBridgeUrl,
        latencyMs: null,
        lastCheckedAt: new Date().toISOString(),
        error: 'manual_disconnect'
      },
      device: {
        ...current.device,
        paired: false,
        pairingStatus: 'unpaired',
        pairingCode: '',
        authTokenExists: false,
        tokenStorage: {
          ...current.device.tokenStorage,
          exists: false,
          sealed: false
        }
      },
      screenMessage: revokeError
        ? `로컬 토큰은 제거했지만 D 브리지의 기기 해제에 실패했습니다: ${revokeError}`
        : '기기 연결을 해제하고 D 브리지 등록과 로컬 토큰을 제거했습니다.'
    }, revokeError ? '기기 해제 실패 후 로컬 토큰만 제거했습니다.' : 'D 브리지에서 기기를 해제하고 모바일 토큰을 제거했습니다.'), {
      loading: false,
      deviceToken: null,
      deviceTokenLoaded: false,
      deviceTokenPreview: null,
      lastAction: revokeResult ? 'device.revoke' : 'disconnect',
      lastResponse: revokeResult ?? current.liveBridge.lastResponse,
      error: revokeError
    }));
    navigate(MobileRoutes.PairingScreen);
  }

  async function submitCommand() {
    const rawText = String(state.command.rawText ?? '').trim();
    if (!rawText) {
      setState((current: any) => ({
        ...current,
        command: { ...current.command, error: '명령을 입력해야 합니다.' },
        screenMessage: '빈 명령은 작업 요청으로 전송하지 않습니다.'
      }));
      return;
    }

    if (!state.connection.connected || !state.liveBridge.deviceToken) {
      setState((current: any) => appendAudit({
        ...current,
        offline: {
          ...current.offline,
          pending: [
            {
              localId: `local_${current.offline.pending.length + 1}`,
              rawText,
              createdAt: new Date().toISOString(),
              syncStatus: 'pending',
              attachments: []
            },
            ...current.offline.pending
          ]
        },
        screenMessage: state.connection.connected
          ? 'deviceToken이 없어 명령을 오프라인 큐에 저장했습니다. 먼저 페어링이 필요합니다.'
          : 'PC Bridge가 연결되지 않아 명령을 오프라인 큐에 저장했습니다. 자동 전송은 하지 않습니다.'
      }, '오프라인 명령을 대기열에 저장했습니다. 안전 정책에 따라 자동 전송하지 않습니다.'));
      return;
    }

    const request = {
      requestId: `req_mobile_${Date.now()}`,
      createdAt: new Date().toISOString(),
      source: {
        module: 'C_MOBILE',
        deviceId: state.device.deviceId,
        inputMode: 'text'
      },
      command: {
        rawText,
        locale: 'ko-KR'
      },
      context: {
        currentScreen: route,
        userTimezone: 'Asia/Seoul'
      }
    };
    setState((current: any) => ({
      ...current,
      command: {
        ...current.command,
        sending: true,
        error: null
      }
    }));
    try {
      const result = await createBridgeClient().createTask(request);
      if (result?.success === false || !result?.taskId) {
        throw new Error(result?.error?.message ?? result?.error?.code ?? 'task-create-failed');
      }
      setState((current: any) => applyLiveBridgeState(appendAudit({
        ...current,
        command: {
          ...current.command,
          sending: false,
          lastRequest: request,
          error: null
        },
        task: {
          ...current.task,
          current: {
            ...current.task.current,
            taskId: result.taskId,
            status: result.status ?? 'WAITING_APPROVAL',
            summary: 'POST /tasks 응답 후 승인 카드 검토가 필요합니다.',
            updatedAt: new Date().toISOString(),
            progress: {
              currentStep: '승인 확인',
              stepIndex: 3,
              totalSteps: 5
            }
          }
        },
        screenMessage: '작업 요청을 D 브리지로 전송했습니다.'
      }, '작업 요청을 D 브리지로 전송했습니다.'), {
        lastAction: 'tasks.create',
        lastResponse: result,
        error: null
      }));
      navigate(MobileRoutes.ApprovalQueueScreen);
    } catch (error) {
      const message = errorMessage(error);
      setState((current: any) => applyLiveBridgeState({
        ...current,
        command: {
          ...current.command,
          sending: false,
          error: message
        },
        screenMessage: `작업 요청 전송 실패: ${message}`
      }, {
        lastAction: 'tasks.create',
        error: message
      }));
    }
  }

  async function chooseApproval(approvalId: string) {
    setState((current: any) => ({
      ...current,
      approvals: {
        ...current.approvals,
        selectedApprovalId: approvalId
      }
    }));
    navigate(MobileRoutes.ApprovalDetailScreen);
    if (!state.connection.connected || !state.liveBridge.deviceToken) {
      return null;
    }
    setState((current: any) => applyLiveBridgeState(current, {
      loading: true,
      lastAction: 'approval.history',
      error: null
    }));
    try {
      const historyResult = await createBridgeClient().getApprovalHistory(approvalId);
      if (historyResult?.success === false) {
        throw new Error(bridgeFailureMessage(historyResult, 'approval-history-failed'));
      }
      setState((current: any) => applyLiveBridgeState({
        ...current,
        approvals: {
          ...current.approvals,
          historyById: {
            ...(current.approvals.historyById ?? {}),
            [approvalId]: historyResult.items ?? []
          },
          error: null
        }
      }, {
        loading: false,
        lastAction: 'approval.history',
        lastResponse: historyResult,
        error: null
      }));
      return historyResult;
    } catch (error) {
      const message = errorMessage(error);
      setState((current: any) => applyLiveBridgeState({
        ...current,
        approvals: {
          ...current.approvals,
          error: message
        }
      }, {
        loading: false,
        lastAction: 'approval.history',
        error: message
      }));
      return null;
    }
  }

  async function refreshLiveApprovals() {
    if (!state.connection.connected || !state.liveBridge.deviceToken) {
      updateMessage('승인 목록을 가져오려면 먼저 D 브리지 페어링이 필요합니다.');
      return null;
    }
    setState((current: any) => applyLiveBridgeState(current, {
      loading: true,
      lastAction: 'approvals.list',
      error: null
    }));
    try {
      const result = await createBridgeClient().getApprovals();
      if (result?.success === false) {
        throw new Error(result?.error?.message ?? result?.error?.code ?? 'approval-list-failed');
      }
      const items = result?.items ?? [];
      setState((current: any) => applyLiveBridgeState({
        ...current,
        approvals: {
          ...current.approvals,
          items: items.length ? items : current.approvals.items,
          selectedApprovalId: items[0]?.approvalId ?? current.approvals.selectedApprovalId,
          loading: false,
          error: null
        },
        screenMessage: `D 브리지 승인 목록 조회 완료: ${items.length}건`
      }, {
        loading: false,
        lastAction: 'approvals.list',
        lastResponse: result,
        error: null
      }));
      return result;
    } catch (error) {
      const message = errorMessage(error);
      setState((current: any) => applyLiveBridgeState({
        ...current,
        approvals: {
          ...current.approvals,
          loading: false,
          error: message
        },
        screenMessage: `승인 목록 조회 실패: ${message}`
      }, {
        loading: false,
        lastAction: 'approvals.list',
        error: message
      }));
      return null;
    }
  }

  async function sendApprovalDecision(decision: string) {
    const card = selectedApproval;
    const expiry = approvalExpiryState(card);
    if (expiry.expired) {
      setState((current: any) => appendAudit({
        ...current,
        task: {
          ...current.task,
          current: {
            ...current.task.current,
            taskId: card.taskId,
            title: card.title,
            status: 'EXPIRED',
            summary: '승인 카드가 만료되어 모바일 결정을 전송하지 않았습니다.',
            blockedReason: expiry.blockedReason,
            updatedAt: new Date().toISOString(),
            progress: {
              currentStep: '승인 만료',
              stepIndex: 3,
              totalSteps: 5
            }
          }
        },
        approvals: {
          ...current.approvals,
          historyById: approvalHistoryPatch(current.approvals.historyById, card.approvalId, [
            createApprovalHistoryEvent({
              approvalId: card.approvalId,
              taskId: card.taskId,
              eventType: 'approval.expired.blocked',
              status: 'blocked',
              actor: 'C_MOBILE',
              detail: decision,
              reason: 'C_APPROVAL_EXPIRED',
              createdAt: new Date().toISOString()
            })
          ]),
          lastDecision: {
            approvalId: card.approvalId,
            taskId: card.taskId,
            decision,
            blocked: true,
            reason: 'C_APPROVAL_EXPIRED',
            decidedAt: new Date().toISOString()
          }
        },
        screenMessage: '승인 카드가 만료되어 결정을 전송하지 않았습니다. 새 승인을 요청하거나 만료 연장을 진행하세요.'
      }, '만료된 승인 결정을 D 브리지로 보내기 전에 모바일에서 차단했습니다.'));
      navigate(MobileRoutes.TaskStatusScreen);
      return;
    }
    const mobileBlocked = decision === 'approve' && card.riskTier <= 3;
    if (mobileBlocked) {
      setState((current: any) => appendAudit({
        ...current,
        task: {
          ...current.task,
          current: {
            ...current.task.current,
            taskId: card.taskId,
            title: card.title,
            status: 'BLOCKED',
            summary: '위험 3단계 이상이거나 외부 전송이 포함된 작업은 모바일 단독 승인이 차단됩니다.',
            blockedReason: 'PC에서 직접 확인이 필요합니다.',
            updatedAt: new Date().toISOString(),
            progress: {
              currentStep: 'PC 직접 확인 필요',
              stepIndex: 3,
              totalSteps: 5
            }
          }
        },
        approvals: {
          ...current.approvals,
          historyById: approvalHistoryPatch(current.approvals.historyById, card.approvalId, [
            createApprovalHistoryEvent({
              approvalId: card.approvalId,
              taskId: card.taskId,
              eventType: 'approval.decision.blocked',
              status: 'blocked',
              actor: 'E_POLICY_SECURITY',
              detail: decision,
              reason: 'PC_CONFIRMATION_REQUIRED',
              createdAt: new Date().toISOString()
            })
          ]),
          lastDecision: {
            approvalId: card.approvalId,
            taskId: card.taskId,
            decision,
            blocked: true,
            decidedAt: new Date().toISOString()
          }
        },
        screenMessage: '고위험 작업은 모바일에서 최종 승인하지 않고 PC 확인으로 넘겼습니다.'
      }, '고위험 모바일 승인을 차단하고 PC 확인을 요청했습니다.'));
      navigate(MobileRoutes.TaskStatusScreen);
      return;
    }

    let liveResult = null;
    if (state.connection.connected && state.liveBridge.deviceToken) {
      setState((current: any) => applyLiveBridgeState(current, {
        loading: true,
        lastAction: 'approval.decision',
        error: null
      }));
      try {
        liveResult = await createBridgeClient().sendApprovalDecision(card.approvalId, {
          decision,
          editRequest: decision === 'edit' ? '모바일에서 저장 위치를 JARVIS workspace로 조정 요청' : undefined,
          responseText: decision === 'respond' ? '기존 파일을 덮어쓰지 않는지 확인해줘.' : undefined
        });
        if (liveResult?.success === false) {
          throw new Error(liveResult?.error?.message ?? liveResult?.error?.code ?? 'approval-decision-failed');
        }
      } catch (error) {
        const message = errorMessage(error);
        setState((current: any) => applyLiveBridgeState({
          ...current,
          screenMessage: `승인 결정 전송 실패: ${message}`
        }, {
          loading: false,
          lastAction: 'approval.decision',
          error: message
        }));
        return;
      }
    }

    setState((current: any) => appendAudit({
      ...current,
      approvals: {
        ...current.approvals,
        historyById: approvalHistoryPatch(current.approvals.historyById, card.approvalId, [
          createApprovalHistoryEvent({
            approvalId: card.approvalId,
            taskId: liveResult?.taskId ?? card.taskId,
            eventType: 'approval.decision.sent',
            status: liveResult?.status ?? decision,
            actor: 'C_MOBILE',
            detail: decision,
            createdAt: new Date().toISOString(),
            metadata: {
              handoffId: liveResult?.handoffId ?? null
            }
          })
        ]),
        lastDecision: {
          approvalId: card.approvalId,
          taskId: card.taskId,
          decision,
          decidedAt: new Date().toISOString(),
          decidedBy: {
            module: 'C_MOBILE',
            deviceId: current.device.deviceId
          }
        }
      },
      task: {
        ...current.task,
        current: {
          ...current.task.current,
          taskId: liveResult?.taskId ?? card.taskId,
          title: card.title,
          status: liveResult?.status ?? (decision === 'reject' ? 'CANCELLED' : 'EXECUTING'),
          summary: decision === 'approve'
            ? '승인 결정이 D 브리지로 전송되어 PC 실행 대기열로 넘어갔습니다.'
            : `${decisionLabels[decision as keyof typeof decisionLabels] ?? decision} 결정이 A 재계획/중단 흐름으로 전달되었습니다.`,
          blockedReason: null,
          updatedAt: new Date().toISOString(),
          progress: {
            currentStep: decision === 'approve' ? 'PC 실행' : '재계획/중단',
            stepIndex: decision === 'approve' ? 4 : 3,
            totalSteps: 5
          }
        }
      },
      screenMessage: `${decisionLabels[decision as keyof typeof decisionLabels] ?? decision} 결정을 감사 가능한 승인 기록으로 남겼습니다.`
    }, `${decisionLabels[decision as keyof typeof decisionLabels] ?? decision} 결정을 D 브리지로 전송했습니다.`));
    setState((current: any) => applyLiveBridgeState(current, {
      loading: false,
      lastAction: liveResult ? 'approval.decision' : current.liveBridge.lastAction,
      lastResponse: liveResult ?? current.liveBridge.lastResponse,
      error: null
    }));
    navigate(MobileRoutes.TaskStatusScreen);
  }

  async function renewSelectedApproval() {
    if (!state.connection.connected || !state.liveBridge.deviceToken) {
      updateMessage('승인 만료 연장은 D 브리지 페어링 후 사용할 수 있습니다.');
      return null;
    }
    setState((current: any) => applyLiveBridgeState(current, {
      loading: true,
      lastAction: 'approval.renew',
      error: null
    }));
    try {
      const result = await createBridgeClient().renewApproval(selectedApproval.approvalId);
      if (result?.success === false) {
        throw new Error(bridgeFailureMessage(result, 'approval-renew-failed'));
      }
      setState((current: any) => applyLiveBridgeState(appendAudit({
        ...current,
        approvals: {
          ...current.approvals,
          items: current.approvals.items.map((item: any) => (
            item.approvalId === result.approvalId ? result : item
          )),
          selectedApprovalId: result.approvalId,
          historyById: approvalHistoryPatch(current.approvals.historyById, result.approvalId, [
            createApprovalHistoryEvent({
              approvalId: result.approvalId,
              taskId: result.taskId,
              eventType: 'approval.renewed',
              status: result.status ?? 'pending',
              actor: 'C_MOBILE',
              detail: `expiresAt=${result.expiresAt}`,
              createdAt: new Date().toISOString(),
              metadata: {
                expiresAt: result.expiresAt
              }
            })
          ]),
          error: null
        },
        screenMessage: `승인 카드 만료 시간이 ${result.expiresAt}까지 연장되었습니다.`
      }, '만료된 승인 카드를 D 브리지를 통해 연장했습니다.'), {
        loading: false,
        lastAction: 'approval.renew',
        lastResponse: result,
        error: null
      }));
      return result;
    } catch (error) {
      const message = errorMessage(error);
      setState((current: any) => applyLiveBridgeState({
        ...current,
        approvals: {
          ...current.approvals,
          error: message
        },
        screenMessage: `승인 만료 연장 실패: ${message}`
      }, {
        loading: false,
        lastAction: 'approval.renew',
        error: message
      }));
      return null;
    }
  }

  async function requestPcConfirmationForSelectedApproval() {
    const reason = 'mobile_user_requested_pc_confirmation_for_high_risk_approval';
    if (!state.connection.connected || !state.liveBridge.deviceToken) {
      updateMessage('PC 확인 요청은 D 브리지 페어링 후 사용할 수 있습니다.');
      return null;
    }
    setState((current: any) => applyLiveBridgeState(current, {
      loading: true,
      lastAction: 'approval.pc_handoff',
      error: null
    }));
    try {
      const result = await createBridgeClient().requestPcConfirmation(selectedApproval.approvalId, { reason });
      if (result?.success === false) {
        throw new Error(bridgeFailureMessage(result, 'approval-pc-handoff-failed'));
      }
      const historyResult = await createBridgeClient().getApprovalHistory(selectedApproval.approvalId);
      setState((current: any) => applyLiveBridgeState(appendAudit({
        ...current,
        approvals: {
          ...current.approvals,
          items: current.approvals.items.map((item: any) => (
            item.approvalId === result.approvalId
              ? {
                  ...item,
                  pcConfirmation: {
                    status: result.status,
                    handoffId: result.handoffId,
                    requestedAt: result.createdAt,
                    reason
                  }
                }
              : item
          )),
          historyById: {
            ...approvalHistoryPatch(current.approvals.historyById, result.approvalId, [
              createApprovalHistoryEvent({
                approvalId: result.approvalId,
                taskId: result.taskId,
                eventType: 'approval.pc_handoff.requested',
                status: result.status,
                actor: 'C_MOBILE',
                reason,
                createdAt: result.createdAt,
                metadata: {
                  handoffId: result.handoffId
                }
              })
            ]),
            ...(historyResult?.success === false ? {} : { [result.approvalId]: historyResult?.items ?? [] })
          },
          lastDecision: {
            approvalId: result.approvalId,
            taskId: result.taskId,
            decision: 'pc_handoff',
            blocked: true,
            reason,
            decidedAt: result.createdAt,
            handoffId: result.handoffId
          },
          error: null
        },
        task: {
          ...current.task,
          current: {
            ...current.task.current,
            taskId: result.taskId,
            title: selectedApproval.title,
            status: 'BLOCKED',
            summary: '모바일 단독 승인을 중단하고 PC 직접 확인 대기로 넘겼습니다.',
            blockedReason: 'PC에서 영향 범위와 외부 전송 여부를 직접 확인해야 합니다.',
            updatedAt: result.createdAt,
            progress: {
              currentStep: 'PC 직접 확인 대기',
              stepIndex: 3,
              totalSteps: 5
            }
          }
        },
        screenMessage: 'PC 확인 요청이 기록되었습니다. 모바일은 이 작업을 단독 승인하지 않습니다.'
      }, '고위험 승인을 PC 확인 절차로 전달했습니다.'), {
        loading: false,
        lastAction: 'approval.pc_handoff',
        lastResponse: result,
        error: null
      }));
      navigate(MobileRoutes.TaskStatusScreen);
      return result;
    } catch (error) {
      const message = errorMessage(error);
      setState((current: any) => applyLiveBridgeState({
        ...current,
        approvals: {
          ...current.approvals,
          error: message
        },
        screenMessage: `PC 확인 요청 실패: ${message}`
      }, {
        loading: false,
        lastAction: 'approval.pc_handoff',
        error: message
      }));
      return null;
    }
  }

  async function cancelSelectedApproval() {
    const reason = 'mobile_user_cancelled_expired_or_unneeded_approval';
    if (!state.connection.connected || !state.liveBridge.deviceToken) {
      setState((current: any) => appendAudit({
        ...current,
        approvals: {
          ...current.approvals,
          items: current.approvals.items.map((item: any) => (
            item.approvalId === selectedApproval.approvalId
              ? { ...item, status: 'cancelled', cancelReason: reason, cancelledAt: new Date().toISOString() }
              : item
          )),
          historyById: approvalHistoryPatch(current.approvals.historyById, selectedApproval.approvalId, [
            createApprovalHistoryEvent({
              approvalId: selectedApproval.approvalId,
              taskId: selectedApproval.taskId,
              eventType: 'approval.cancelled',
              status: 'cancelled',
              actor: 'C_MOBILE',
              reason,
              createdAt: new Date().toISOString()
            })
          ]),
          lastDecision: {
            approvalId: selectedApproval.approvalId,
            taskId: selectedApproval.taskId,
            decision: 'cancel',
            blocked: false,
            decidedAt: new Date().toISOString()
          }
        },
        task: {
          ...current.task,
          current: {
            ...current.task.current,
            taskId: selectedApproval.taskId,
            title: selectedApproval.title,
            status: 'CANCELLED',
            summary: '모바일에서 승인 카드를 취소했습니다.',
            blockedReason: null,
            updatedAt: new Date().toISOString()
          }
        },
        screenMessage: '오프라인 상태에서 로컬 승인 카드를 취소했습니다.'
      }, '모바일에서 승인을 취소했습니다.'));
      navigate(MobileRoutes.TaskStatusScreen);
      return null;
    }
    setState((current: any) => applyLiveBridgeState(current, {
      loading: true,
      lastAction: 'approval.cancel',
      error: null
    }));
    try {
      const result = await createBridgeClient().cancelApproval(selectedApproval.approvalId, { reason });
      if (result?.success === false) {
        throw new Error(bridgeFailureMessage(result, 'approval-cancel-failed'));
      }
      setState((current: any) => applyLiveBridgeState(appendAudit({
        ...current,
        approvals: {
          ...current.approvals,
          items: current.approvals.items.map((item: any) => (
            item.approvalId === result.approvalId
              ? { ...item, status: 'cancelled', cancelReason: result.reason, cancelledAt: result.cancelledAt }
              : item
          )),
          historyById: approvalHistoryPatch(current.approvals.historyById, result.approvalId, [
            createApprovalHistoryEvent({
              approvalId: result.approvalId,
              taskId: result.taskId,
              eventType: 'approval.cancelled',
              status: result.status,
              actor: 'C_MOBILE',
              reason: result.reason,
              createdAt: result.cancelledAt
            })
          ]),
          lastDecision: {
            approvalId: result.approvalId,
            taskId: result.taskId,
            decision: 'cancel',
            decidedAt: result.cancelledAt
          },
          error: null
        },
        task: {
          ...current.task,
          current: {
            ...current.task.current,
            taskId: result.taskId,
            title: selectedApproval.title,
            status: result.status,
            summary: 'D 브리지에 승인 카드 취소를 기록했습니다.',
            blockedReason: null,
            updatedAt: result.cancelledAt
          }
        },
        screenMessage: '승인 카드가 취소되어 실행으로 넘어가지 않습니다.'
      }, 'D 브리지를 통해 승인을 취소했습니다.'), {
        loading: false,
        lastAction: 'approval.cancel',
        lastResponse: result,
        error: null
      }));
      navigate(MobileRoutes.TaskStatusScreen);
      return result;
    } catch (error) {
      const message = errorMessage(error);
      setState((current: any) => applyLiveBridgeState({
        ...current,
        approvals: {
          ...current.approvals,
          error: message
        },
        screenMessage: `승인 취소 실패: ${message}`
      }, {
        loading: false,
        lastAction: 'approval.cancel',
        error: message
      }));
      return null;
    }
  }

  async function reRequestSelectedApproval() {
    const reason = 'mobile_user_requested_fresh_approval';
    if (!state.connection.connected || !state.liveBridge.deviceToken) {
      updateMessage('새 승인 재요청은 D 브리지 페어링 후 사용할 수 있습니다.');
      return null;
    }
    setState((current: any) => applyLiveBridgeState(current, {
      loading: true,
      lastAction: 'approval.re_request',
      error: null
    }));
    try {
      const result = await createBridgeClient().reRequestApproval(selectedApproval.approvalId, { reason });
      if (result?.success === false) {
        throw new Error(bridgeFailureMessage(result, 'approval-rerequest-failed'));
      }
      const replacementApproval = result.replacement?.approvalId
        ? await createBridgeClient().getApproval(result.replacement.approvalId)
        : null;
      const replacementHistory = result.replacement?.approvalId
        ? await createBridgeClient().getApprovalHistory(result.replacement.approvalId)
        : null;
      const previousHistory = await createBridgeClient().getApprovalHistory(selectedApproval.approvalId);
      const replacementCard = replacementApproval?.success === false ? null : replacementApproval;
      setState((current: any) => applyLiveBridgeState(appendAudit({
        ...current,
        approvals: {
          ...current.approvals,
          items: [
            ...(replacementCard ? [replacementCard] : []),
            ...current.approvals.items.map((item: any) => (
              item.approvalId === selectedApproval.approvalId
                ? { ...item, status: 'cancelled', cancelReason: reason, cancelledAt: result.previous?.cancelledAt }
                : item
            ))
          ],
          selectedApprovalId: replacementCard?.approvalId ?? result.replacement?.approvalId ?? current.approvals.selectedApprovalId,
          historyById: {
            ...approvalHistoryPatch(current.approvals.historyById, selectedApproval.approvalId, [
              createApprovalHistoryEvent({
                approvalId: selectedApproval.approvalId,
                taskId: selectedApproval.taskId,
                eventType: 'approval.re_requested',
                status: 're_requested',
                actor: 'C_MOBILE',
                reason,
                createdAt: new Date().toISOString(),
                metadata: {
                  replacementApprovalId: result.replacement?.approvalId,
                  replacementTaskId: result.replacement?.taskId
                }
              })
            ]),
            ...(previousHistory?.success === false ? {} : { [selectedApproval.approvalId]: previousHistory?.items ?? [] }),
            ...(replacementHistory?.success === false || !result.replacement?.approvalId
              ? {}
              : { [result.replacement.approvalId]: replacementHistory?.items ?? [] })
          },
          lastDecision: {
            approvalId: selectedApproval.approvalId,
            taskId: selectedApproval.taskId,
            decision: 're_request',
            decidedAt: new Date().toISOString(),
            replacementApprovalId: result.replacement?.approvalId
          },
          error: null
        },
        task: {
          ...current.task,
          current: {
            ...current.task.current,
            taskId: result.replacement?.taskId ?? current.task.current.taskId,
            title: replacementCard?.title ?? current.task.current.title,
            status: result.replacement?.status ?? current.task.current.status,
            summary: '기존 승인 카드를 닫고 새 승인 카드를 요청했습니다.',
            blockedReason: null,
            updatedAt: new Date().toISOString()
          }
        },
        screenMessage: '새 승인 카드가 생성되었습니다. 최신 카드에서 다시 검토하세요.'
      }, 'D 브리지를 통해 새 승인을 요청했습니다.'), {
        loading: false,
        lastAction: 'approval.re_request',
        lastResponse: result,
        error: null
      }));
      navigate(MobileRoutes.ApprovalDetailScreen);
      return result;
    } catch (error) {
      const message = errorMessage(error);
      setState((current: any) => applyLiveBridgeState({
        ...current,
        approvals: {
          ...current.approvals,
          error: message
        },
        screenMessage: `새 승인 재요청 실패: ${message}`
      }, {
        loading: false,
        lastAction: 'approval.re_request',
        error: message
      }));
      return null;
    }
  }

  // ── 홈(가면) 대화 흐름: 명령 → 계획/승인 → 실행 → 결과를 한 화면에서 자동 추적 ──
  function homeClient(timeoutMs = defaultBridgeClientTimeoutMs) {
    return new BridgeClient({
      bridgeUrl: effectiveBridgeUrl,
      tokenProvider: () => state.liveBridge.deviceToken ?? null,
      timeoutMs
    });
  }

  async function refreshSkillRegistryReview() {
    if (!state.liveBridge.deviceToken) return null;
    try {
      const review = await homeClient().getGrowthReview();
      if (review?.success === false) throw new Error(review.error?.message ?? review.error?.code ?? '검토 자료를 가져오지 못했습니다.');
      setSkillRegistryReview(review);
      setSkillRevisionMessage(null);
      return review;
    } catch (error) {
      setSkillRevisionMessage(`업무 절차를 불러오지 못했습니다: ${errorMessage(error)}`);
      return null;
    }
  }

  async function runSkillRevisionAction(action: 'create' | 'evaluate' | 'review' | 'promote' | 'rollback', entry: any, revisionId?: string, reviewDecision: 'approve' | 'reject' = 'approve') {
    if (skillRevisionBusy) return;
    setSkillRevisionBusy(true);
    setSkillRevisionMessage(null);
    try {
      const client = homeClient();
      const pendingId = revisionId ?? entry.pendingRevisionId;
      let result: any;
      if (action === 'create') {
        const suggestedSteps = String(skillRevisionSteps[entry.skillId] ?? '').split(/\r?\n/).map((step) => step.trim()).filter(Boolean);
        result = await client.createGrowthSkillRevision(entry.skillId, {
          expectedActiveRevisionId: entry.activeRevisionId,
          suggestedSteps,
          reason: '모바일에서 사용자가 수정한 업무 절차'
        });
      } else if (action === 'evaluate') {
        result = await client.evaluateGrowthSkillRevision(entry.skillId, pendingId);
      } else if (action === 'review') {
        result = await client.reviewGrowthSkillRevision(entry.skillId, pendingId, {
          decision: reviewDecision, reason: '사용자가 모바일 화면에서 절차 변경을 검토했습니다.'
        });
      } else if (action === 'promote') {
        result = await client.promoteGrowthSkillRevision(entry.skillId, pendingId, {
          expectedActiveRevisionId: entry.activeRevisionId,
          reason: '검토 승인된 절차 버전을 사용자가 승격했습니다.'
        });
      } else {
        result = await client.rollbackGrowthSkillRevision(entry.skillId, entry.activeRevisionId, {
          expectedActiveRevisionId: entry.activeRevisionId,
          targetRevisionId: entry.revisions?.find((revision: any) => revision.revisionId !== entry.activeRevisionId
            && ['superseded', 'active'].includes(revision.status))?.revisionId,
          reason: '사용자가 이전 활성 버전으로 복원했습니다.'
        });
      }
      if (result?.success === false) throw new Error(result.error?.message ?? result.error?.code ?? '업무 절차 변경을 완료하지 못했습니다.');
      setSkillRevisionMessage(action === 'create'
        ? '수정 초안을 만들었습니다. 자동으로 실행되지는 않습니다.'
        : action === 'review' && reviewDecision === 'reject'
          ? '수정안을 거절했습니다. 활성 절차는 그대로 유지됩니다.'
        : '업무 절차 상태를 갱신했습니다.');
      if (action === 'create') setSkillRevisionSteps((current) => ({ ...current, [entry.skillId]: '' }));
      await refreshSkillRegistryReview();
    } catch (error) {
      setSkillRevisionMessage(`업무 절차 작업 실패: ${errorMessage(error)}`);
    } finally {
      setSkillRevisionBusy(false);
    }
  }

  useEffect(() => {
    if (!state.device.paired || !state.liveBridge.deviceToken) {
      setSkillRegistryReview(null);
      return;
    }
    void refreshSkillRegistryReview();
  }, [state.device.paired, state.liveBridge.deviceToken, effectiveBridgeUrl]);

  function homeSleep(ms: number) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  function homeTaskStatusOf(statusResult: any) {
    return statusResult?.status ?? statusResult?.task?.status ?? null;
  }

  async function homeSubmit(
    overrideText: string | null = null,
    { inputMode = 'text', voiceEvidence = null }: { inputMode?: 'text' | 'voice'; voiceEvidence?: any } = {}
  ) {
    const rawText = String(overrideText ?? home.text ?? '').trim();
    if (!rawText) {
      setHome((current: any) => ({ ...current, error: '자비스에게 시킬 일을 입력해 주세요.' }));
      return;
    }
    if (!state.device.paired || !state.liveBridge.deviceToken) {
      setHome((current: any) => ({ ...current, error: '먼저 아래에서 PC와 연결해 주세요.' }));
      return;
    }
    const seq = ++homeFlowSeq.current;
    setHome((current: any) => ({
      ...current,
      phase: 'submitting',
      taskId: null,
      approval: null,
      taskStatus: null,
      result: null,
      error: null,
      notice: '자비스가 명령을 이해하고 계획을 세우는 중입니다...'
    }));
    try {
      const request = {
        requestId: `req_home_${Date.now()}`,
        createdAt: new Date().toISOString(),
        source: { type: 'mobile', module: 'C_MOBILE', deviceId: state.device.deviceId, inputMode },
        command: { rawText, locale: 'ko-KR' },
        context: { currentScreen: MobileRoutes.HomeScreen, userTimezone: 'Asia/Seoul' },
        metadata: inputMode === 'voice'
          ? {
              voiceRecognition: {
                confidence: voiceEvidence?.confidence ?? null,
                alternativesCount: voiceEvidence?.alternativesCount ?? 1,
                locale: voiceEvidence?.locale ?? 'ko-KR',
                engine: voiceEvidence?.engine ?? 'expo-speech-recognition',
                confirmationMode: voiceEvidence?.confirmationMode ?? null,
                confirmationReason: voiceEvidence?.confirmationReason ?? null,
                confirmationCount: voiceEvidence?.confirmationCount ?? 0,
                independentEngineCount: voiceEvidence?.independentEngineCount ?? 0,
                confirmationEngine: voiceEvidence?.confirmationEngine ?? null,
                confirmationConfidence: voiceEvidence?.confirmationConfidence ?? null,
                correctionApplied: voiceEvidence?.correctionApplied === true,
                supersededDraftDiscarded: voiceEvidence?.supersededDraftDiscarded === true,
                confirmationTranscriptStored: false,
                rawAudioStored: false,
                alternativesStored: false,
                commandTextRetainedAsTask: true
              }
            }
          : {}
      };
      // 복합 명령(여러 단계 + 문서 내용 생성)은 계획에 시간이 더 걸릴 수 있어 타임아웃을 넉넉히 잡는다.
      const created = await homeClient(240000).createTask(request);
      if (created?.success === false || !created?.taskId) {
        throw new Error(bridgeFailureMessage(created, 'task-create-failed'));
      }
      // 성공적으로 접수된 명령만 추천 히스토리에 기록한다.
      void recordCommand(rawText);
      if (homeFlowSeq.current !== seq) return;
      setHome((current: any) => ({
        ...current,
        phase: 'waiting-approval',
        taskId: created.taskId,
        notice: '계획이 준비되었습니다. 승인 카드를 불러오는 중...'
      }));
      await homeTrackApproval(created.taskId, seq);
    } catch (error) {
      if (homeFlowSeq.current !== seq) return;
      setHome((current: any) => ({ ...current, phase: 'idle', notice: null, error: errorMessage(error) }));
    }
  }

  async function homeTrackApproval(taskId: string, seq: number) {
    const client = homeClient();
    // 적응형 백오프로 폴링: 승인 카드가 준비되는 즉시(초반 250ms) 띄우고,
    // 오래 걸리는 콘텐츠 LLM 작업은 점차 간격을 늘린다.
    let elapsed = 0;
    for (let attempt = 0; elapsed < homePollTotalBudgetMs; attempt += 1) {
      if (homeFlowSeq.current !== seq) return;
      try {
        const approvals = await client.getApprovals();
        const card = (approvals?.items ?? []).find((item: any) => (
          item.taskId === taskId && !['cancelled', 'expired', 'decided'].includes(String(item.status ?? 'pending'))
        ));
        if (card) {
          setHome((current: any) => ({ ...current, phase: 'approval', approval: card, notice: null }));
          homeSpeak(approvalSpeech(card));
          return;
        }
        const status = homeTaskStatusOf(await client.getTaskStatus(taskId));
        if (['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(String(status))) {
          await homeFinish(taskId, String(status), seq);
          return;
        }
      } catch {
        // 폴링 중 일시 오류는 다음 시도에서 회복한다.
      }
      const delay = homeBackoffDelay(attempt);
      await homeSleep(delay);
      elapsed += delay;
    }
    if (homeFlowSeq.current !== seq) return;
    setHome((current: any) => ({
      ...current,
      phase: 'idle',
      notice: null,
      error: '승인 카드를 기다리다 시간이 초과됐습니다. 전문가 모드의 승인 대기 화면을 확인해 주세요.'
    }));
  }

  async function homeDecide(decision: 'approve' | 'reject') {
    const card = home.approval;
    if (!card) return;
    if (decision === 'approve' && Number(card.riskTier ?? 5) <= 3) {
      const seq = homeFlowSeq.current;
      setHome((current: any) => ({
        ...current,
        phase: 'deciding',
        notice: '고위험 작업을 PC 음성 확인으로 넘기는 중입니다...',
        error: null
      }));
      try {
        const handoff = await homeClient().requestPcConfirmation(card.approvalId, {
          reason: 'mobile_voice_conversation_requires_pc_confirmation'
        });
        if (handoff?.success === false) {
          throw new Error(bridgeFailureMessage(handoff, 'approval-pc-handoff-failed'));
        }
        if (homeFlowSeq.current !== seq) return;
        const phrase = String(handoff.voiceChallenge?.phrase ?? '').trim();
        setHome((current: any) => ({
          ...current,
          phase: 'pc-confirmation',
          pcHandoff: handoff,
          notice: phrase
            ? `PC에서 "자비스 ${phrase} 승인"이라고 말해 주세요.`
            : 'PC 자비스 화면에서 음성 확인을 진행해 주세요.'
        }));
        await homeTrackPcConfirmation(card.taskId, seq);
      } catch (error) {
        if (homeFlowSeq.current !== seq) return;
        setHome((current: any) => ({
          ...current,
          phase: 'approval',
          notice: null,
          error: errorMessage(error)
        }));
      }
      return;
    }
    const seq = homeFlowSeq.current;
    setHome((current: any) => ({
      ...current,
      phase: 'deciding',
      error: null,
      notice: decision === 'approve' ? '승인을 전송하는 중...' : '거절을 전송하는 중...'
    }));
    try {
      const client = homeClient();
      const result = await client.sendApprovalDecision(card.approvalId, { decision });
      if (result?.success === false) {
        throw new Error(bridgeFailureMessage(result, 'approval-decision-failed'));
      }
      if (decision !== 'approve') {
        setHome((current: any) => ({
          ...current,
          phase: 'done',
          taskStatus: 'CANCELLED',
          notice: '작업을 거절했습니다. 실행되지 않습니다.'
        }));
        return;
      }
      if (result?.handoffId) {
        const confirmed = await client.confirmExecution(result.handoffId);
        if (confirmed?.success === false) {
          throw new Error(bridgeFailureMessage(confirmed, 'execution-confirm-failed'));
        }
      }
      setHome((current: any) => ({ ...current, phase: 'executing', notice: 'PC에서 실행하는 중입니다...' }));
      let elapsed = 0;
      for (let attempt = 0; elapsed < homePollTotalBudgetMs; attempt += 1) {
        if (homeFlowSeq.current !== seq) return;
        const status = homeTaskStatusOf(await client.getTaskStatus(card.taskId).catch(() => null));
        if (['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(String(status))) {
          await homeFinish(card.taskId, String(status), seq);
          return;
        }
        const delay = homeBackoffDelay(attempt);
        await homeSleep(delay);
        elapsed += delay;
      }
      setHome((current: any) => ({
        ...current,
        notice: '실행이 오래 걸리고 있습니다. 잠시 후 전문가 모드의 작업 상태 화면에서 확인할 수 있어요.'
      }));
    } catch (error) {
      setHome((current: any) => ({ ...current, phase: 'approval', notice: null, error: errorMessage(error) }));
    }
  }

  async function homeTrackPcConfirmation(taskId: string, seq: number) {
    const client = homeClient();
    let elapsed = 0;
    let approvedAt: number | null = null;
    for (let attempt = 0; elapsed < homePollTotalBudgetMs; attempt += 1) {
      if (homeFlowSeq.current !== seq) return;
      try {
        const status = String(homeTaskStatusOf(await client.getTaskStatus(taskId)) ?? '');
        if (['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(status)) {
          await homeFinish(taskId, status, seq);
          return;
        }
        if (status === 'APPROVED') {
          approvedAt ??= elapsed;
          setHome((current: any) => ({
            ...current,
            notice: 'PC 음성 승인이 확인되었습니다. 실행 결과를 기다리는 중입니다...'
          }));
          if (elapsed - approvedAt >= 8_000) {
            await homeFinish(taskId, status, seq);
            return;
          }
        }
      } catch {
        // A brief bridge interruption is retried within the existing bounded poll budget.
      }
      const delay = homeBackoffDelay(attempt);
      await homeSleep(delay);
      elapsed += delay;
    }
    if (homeFlowSeq.current !== seq) return;
    setHome((current: any) => ({
      ...current,
      phase: 'pc-confirmation',
      notice: null,
      error: 'PC 음성 확인 시간이 초과되었습니다. PC의 승인 대기 화면에서 상태를 확인해 주세요.'
    }));
  }

  async function homeFinish(taskId: string, status: string, seq: number) {
    let result: any = null;
    try {
      const fetched = await homeClient().getResult(taskId);
      if (fetched?.success !== false && fetched) {
        const execution = fetched.executionResult ?? fetched.execution?.executionResult ?? {};
        result = {
          command: String(homeRef.current.text ?? '').trim(),
          summary: execution.summary ?? fetched.summary ?? null,
          outputPaths: execution.outputPaths ?? fetched.outputPaths ?? [],
          rollbackAvailable: execution.rollbackAvailable ?? fetched.rollbackAvailable ?? false
        };
      }
    } catch {
      // 결과 조회 실패 시 상태만 표시한다.
    }
    if (homeFlowSeq.current !== seq) return;
    setHome((current: any) => ({
      ...current,
      phase: 'done',
      taskStatus: status,
      result,
      notice: status === 'COMPLETED'
        ? '작업이 완료되었습니다.'
        : status === 'APPROVED'
          ? 'PC 확인은 완료되었지만 이 작업은 검토 전용이거나 실행 인계가 필요합니다.'
          : null,
      error: ['COMPLETED', 'APPROVED'].includes(status) ? null : `작업이 ${status} 상태로 끝났습니다.`
    }));
    homeSpeak(resultSpeech(status, result));
  }

  function homeReset() {
    homeFlowSeq.current += 1;
    setHome((current: any) => ({
      ...current,
      phase: 'idle',
      text: '',
      answer: '',
      taskId: null,
      approval: null,
      pcHandoff: null,
      taskStatus: null,
      result: null,
      error: null,
      notice: null,
      listening: false,
      voicePhase: 'idle',
      voicePeak: -2,
      voiceEngine: null
    }));
  }

  // 명료화 질문에 답하면 원 명령에 답을 덧붙여 더 정확한 계획으로 다시 제출한다.
  // 대화 모드에서는 음성으로 받은 답을 overrideAnswer로 넘긴다.
  async function homeResubmitWithAnswer(
    overrideAnswer: string | null = null,
    inputMode: 'text' | 'voice' = 'text',
    voiceEvidence: any = null
  ) {
    const answer = String(overrideAnswer ?? home.answer ?? '').trim();
    if (!answer) return;
    const baseText = String(homeRef.current.text ?? home.text ?? '').trim();
    const composed = `${baseText} (추가 정보: ${answer})`;
    setHome((current: any) => ({ ...current, text: composed, answer: '', approval: null }));
    await homeSubmit(composed, { inputMode, voiceEvidence });
  }

  function completeTask() {
    setState((current: any) => appendAudit({
      ...current,
      task: {
        ...current.task,
        current: {
          ...current.task.current,
          status: 'COMPLETED',
          summary: 'B 실행과 G 검증이 완료되었습니다.',
          updatedAt: new Date().toISOString(),
          progress: {
            currentStep: '결과 검증',
            stepIndex: 5,
            totalSteps: 5
          }
        }
      },
      screenMessage: '작업이 완료되었습니다. 결과 화면에서 산출물과 피드백을 확인할 수 있습니다.'
    }, 'PC 에이전트가 작업을 완료하고 검증 시스템이 확인했습니다.'));
  }

  function submitFeedback(feedbackType: string) {
    setState((current: any) => appendAudit({
      ...current,
      feedback: {
        ...current.feedback,
        lastSent: {
          taskId: current.result.taskId,
          feedbackType,
          text: current.feedback.text,
          timestamp: new Date().toISOString()
        }
      },
      screenMessage: `${feedbackLabels[feedbackType as keyof typeof feedbackLabels] ?? feedbackType} 피드백을 성장형 기억 후보로 전달했습니다.`
    }, `${feedbackLabels[feedbackType as keyof typeof feedbackLabels] ?? feedbackType} 피드백을 D 브리지를 통해 기억 시스템으로 전송했습니다.`));
  }

  async function previewResultFile(previewId: string, path: string) {
    const uri = createResultFileUri(path);
    const viewResult = await openOfficialDocument({ uri, openURL: (selected: string) => Linking.openURL(selected) });
    const action: any = {
      actionVersion: 'c-native-document-action-v1',
      previewId,
      path: viewResult.status === 'blocked' ? null : path,
      uri: viewResult.uri,
      actionType: 'preview',
      ...viewResult,
      fallbackUsed: false,
      actedAt: new Date().toISOString()
    };
    setState((current: any) => appendAudit({
      ...current,
      feedback: {
        ...current.feedback,
        lastFileAction: action
      },
      screenMessage: action.status === 'opened'
        ? '산출물 미리보기를 네이티브 앱으로 열었습니다.'
        : action.status === 'blocked'
          ? '이 주소는 문서 보기에서 열 수 없습니다. 검증된 산출물을 다시 선택해 주세요.'
          : '미리보기 앱을 열지 못했습니다. 산출물 경로를 확인하거나 다른 앱을 사용해 주세요.'
    }, `Result file preview ${action.status}`));
  }

  async function shareResultFile(previewId: string, path: string) {
    const uri = createResultFileUri(path);
    let action: any = {
      actionVersion: 'c-native-document-action-v1',
      previewId,
      path,
      uri,
      actionType: 'share',
      status: 'contract-fallback',
      fallbackUsed: true,
      actedAt: new Date().toISOString()
    };
    try {
      const available = await Sharing.isAvailableAsync();
      if (available && uri) {
        await Sharing.shareAsync(uri, { dialogTitle: path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'JARVIS result' });
        action = { ...action, status: 'shared', fallbackUsed: false };
      }
    } catch (error) {
      action = {
        ...action,
        status: 'contract-fallback',
        fallbackUsed: true,
        error: errorMessage(error)
      };
    }
    setState((current: any) => appendAudit({
      ...current,
      feedback: {
        ...current.feedback,
        lastFileAction: action
      },
      screenMessage: action.status === 'shared'
        ? '산출물 공유 시트를 열었습니다.'
        : '공유 시트를 사용할 수 없어 산출물 경로를 화면에 유지합니다.'
    }, `Result file share ${action.status}: ${path}`));
  }

  function requestResultRollback() {
    setState((current: any) => appendAudit({
      ...current,
      feedback: {
        ...current.feedback,
        rollbackConfirmation: {
          confirmationVersion: 'c-result-rollback-confirmation-v1',
          visible: true,
          confirmed: false,
          pending: false,
          requestedAt: new Date().toISOString(),
          affectedItemCount: current.result.changedItems.length,
          outputPathCount: current.result.outputPaths.length
        }
      },
      screenMessage: '되돌리기 전에 PC 에이전트의 복구 근거와 변경 항목을 확인하세요.'
    }, '결과 화면에서 되돌리기 확인을 요청했습니다.'));
  }

  function cancelResultRollback() {
    setState((current: any) => appendAudit({
      ...current,
      feedback: {
        ...current.feedback,
        rollbackConfirmation: {
          ...current.feedback.rollbackConfirmation,
          visible: false,
          cancelledAt: new Date().toISOString()
        }
      },
      screenMessage: '되돌리기 확인을 취소했습니다.'
    }, '결과 되돌리기 확인을 취소했습니다.'));
  }

  function confirmResultRollback() {
    setState((current: any) => appendAudit({
      ...current,
      result: {
        ...current.result,
        status: 'rolled_back',
        summary: `${current.result.summary} 되돌리기 확인이 완료되었습니다.`,
        rollbackAvailable: false,
        rollback: {
          success: true,
          reason: 'mobile_result_confirmation',
          confirmedAt: new Date().toISOString(),
          affectedItemCount: current.result.changedItems.length
        }
      },
      feedback: {
        ...current.feedback,
        rollbackConfirmation: {
          ...current.feedback.rollbackConfirmation,
          visible: false,
          confirmed: true,
          completedAt: new Date().toISOString()
        }
      },
      screenMessage: '되돌리기 확인을 완료했습니다. 실제 실행은 D 브리지를 통해 PC 에이전트의 되돌리기 기능으로 전달됩니다.'
    }, '모바일 확인 화면에서 결과 되돌리기를 확정했습니다.'));
  }

  function decideGrowthPreference(hypothesisId: string, decision: string) {
    setState((current: any) => appendAudit({
      ...current,
      growth: {
        ...current.growth,
        review: {
          ...current.growth.review,
          preferenceCandidates: current.growth.review.preferenceCandidates.map((candidate: any) => (
            candidate.hypothesisId === hypothesisId
              ? { ...candidate, status: decision === 'confirm' ? 'confirmed' : 'rejected' }
              : candidate
          ))
        },
        lastDecision: { hypothesisId, decision, decidedAt: new Date().toISOString() }
      },
      screenMessage: '성장 리뷰 결정은 기억 시스템으로 전달되는 사용자 검토 신호입니다. 모바일 앱이 기억 저장소를 직접 수정하지는 않습니다.'
    }, `Growth preference ${decision} recorded for ${hypothesisId}.`));
  }

  function handlePoisonAction(action: 'review' | 'requeue' | 'ignore', queueId: string) {
    const nextStatus = action === 'requeue' ? 'retry_scheduled' : action === 'ignore' ? 'ignored' : 'quarantined';
    const nextReview = action === 'review' ? 'reviewed' : action === 'requeue' ? 'requeued' : 'ignored';
    setState((current: any) => appendAudit({
      ...current,
      poisonQueue: {
        ...current.poisonQueue,
        items: current.poisonQueue.items.map((item: any) => (
          item.queueId === queueId
            ? {
                ...item,
                status: nextStatus,
                reviewStatus: nextReview,
                reviewedAt: new Date().toISOString(),
                reviewedBy: current.device.deviceId
              }
            : item
        )),
        lastAction: { action, queueId, actedAt: new Date().toISOString() }
      },
      screenMessage: '격리 대기열 조치는 PC 실행 대기열에 대한 검토 신호입니다. 모바일 앱이 작업을 직접 실행하지는 않습니다.'
    }, `Poison packet ${queueId} ${action} action sent.`));
  }

  function verifyPoisonQueueDrain() {
    setState((current: any) => {
      const queued = current.poisonQueue.queue?.queued ?? 0;
      const retryScheduled = current.poisonQueue.queue?.retryScheduled ?? 0;
      const processed = queued + retryScheduled;
      return appendAudit({
        ...current,
        poisonQueue: {
          ...current.poisonQueue,
          queue: {
            ...current.poisonQueue.queue,
            queued: 0,
            retryScheduled: 0,
            succeeded: (current.poisonQueue.queue?.succeeded ?? 0) + processed
          },
          refreshState: {
            lastRefreshedAt: new Date().toISOString(),
            processed,
            visualSnapshot: {
              tone: current.poisonQueue.queue?.quarantined > 0 ? 'warning' : 'clear',
              badgeLabel: current.poisonQueue.queue?.quarantined > 0 ? `${current.poisonQueue.queue.quarantined}건 검토` : '정상'
            }
          }
        },
        screenMessage: `PC 에이전트 대기열 처리 결과 ${processed}건을 반영했습니다.`
      }, '모바일 화면에서 격리 대기열 처리 결과를 검증했습니다.');
    });
  }

  function saveRetryPolicy(draft: { maxAttempts: number; baseBackoffMs: number; reason: string }) {
    setState((current: any) => appendAudit({
      ...current,
      queuePolicy: {
        ...current.queuePolicy,
        ...draft,
        updatedAt: new Date().toISOString()
      },
      poisonQueue: {
        ...current.poisonQueue,
        queue: {
          ...current.poisonQueue.queue,
          maxAttempts: draft.maxAttempts,
          baseBackoffMs: draft.baseBackoffMs
        }
      },
      screenMessage: '재시도 정책 변경 요청을 D 브리지를 통해 PC 에이전트로 보냈습니다.'
    }, '설정 화면에서 대기열 재시도 정책 변경을 요청했습니다.'));
  }

  function requestNotifications() {
    setState((current: any) => appendAudit({
      ...current,
      notifications: {
        ...current.notifications,
        permission: {
          ...current.notifications.permission,
          status: 'granted',
          granted: true,
          changedAt: new Date().toISOString(),
          promptRequested: true,
          lastPrompt: {
            promptId: `notification_prompt_${Date.now()}`,
            source: 'expo-notifications',
            nativePromptAvailable: false,
            requestedAt: new Date().toISOString(),
            result: 'granted'
          }
        },
        unreadCount: current.notifications.items.length
      },
      screenMessage: '알림 권한이 허용되었습니다. 현재 버전은 앱 내부 배지와 로컬 기록을 우선 사용합니다.'
    }, '모바일 설정에서 알림 권한을 허용했습니다.'));
  }

  function verifyNotificationReceipts() {
    setState((current: any) => {
      const checkedAt = new Date().toISOString();
      const receiptLog = (current.notifications.receiptLog?.length ? current.notifications.receiptLog : current.notifications.items.map((item: any) => ({
        receiptId: `receipt_${item.notificationId}`,
        deliveryId: item.deliveryId ?? `delivery_${item.notificationId}`,
        notificationId: item.notificationId,
        status: item.deliveryStatus === 'blocked' ? 'queued' : 'ok',
        provider: 'local-fallback',
        appState: current.notifications.appState ?? 'active',
        retryable: item.deliveryStatus === 'blocked',
        checkedAt
      }))).map((receipt: any) => ({
        ...receipt,
        status: 'ok',
        retryable: false,
        verifiedAt: checkedAt
      }));
      return appendAudit({
        ...current,
        notifications: {
          ...current.notifications,
          receiptLog,
          issueQueue: []
        },
        screenMessage: `${receiptLog.length}건의 알림 수신 기록을 확인했습니다.`
      }, '설정 화면에서 알림 수신 기록을 검증했습니다.');
    });
  }

  function toggleSessionLock() {
    setState((current: any) => appendAudit({
      ...current,
      security: {
        ...current.security,
        locked: !current.security.locked,
        sensitiveActionReady: current.security.locked
      },
      screenMessage: current.security.locked
        ? '세션 잠금을 해제했습니다. 민감 작업 승인 전 재확인을 통과한 상태입니다.'
        : '세션을 잠갔습니다. 민감 작업은 다시 PIN/생체 인증이 필요합니다.'
    }, current.security.locked ? 'Mobile session unlocked.' : 'Mobile session locked.'));
  }

  function renderHomeScreen() {
    const busy = ['submitting', 'waiting-approval', 'deciding', 'pc-confirmation', 'executing'].includes(home.phase);
    const approvalCard = home.phase === 'approval' ? home.approval : null;
    return (
      <View testID="screen-content-HomeScreen" style={styles.screenStack}>
        {!paired ? (
          <View style={styles.homeCard}>
            <Text style={styles.homeCardTitle}>PC와 연결하기</Text>
            <Text style={styles.homeHint}>
              PC에서 발급한 8자리 코드를 입력하세요. QR이나 링크로 열면 자동으로 연결됩니다.
            </Text>
            <TextInput
              testID="home-bridge-url-input"
              value={state.connection.bridgeUrl}
              onChangeText={(value) => setState((current: any) => ({
                ...current,
                connection: {
                  ...current.connection,
                  bridgeUrl: value,
                  effectiveBridgeUrl: normalizeBridgeUrlForDevice(value)
                }
              }))}
              placeholder="브리지 주소 (http://...)"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              style={styles.input}
            />
            <TextInput
              testID="home-pairing-code-input"
              value={state.device.pairingCode}
              onChangeText={(value) => setState((current: any) => ({
                ...current,
                device: { ...current.device, pairingCode: value, pairingStatus: 'pairing' }
              }))}
              placeholder="페어링 코드 8자리"
              placeholderTextColor={colors.muted}
              keyboardType="number-pad"
              style={styles.input}
            />
            <Pressable
              testID="home-pair-button"
              accessibilityRole="button"
              accessibilityLabel="PC와 연결"
              disabled={state.liveBridge.loading}
              onPress={() => void confirmPairing()}
              style={[styles.homePrimaryButton, state.liveBridge.loading ? styles.homeButtonDisabled : null]}
            >
              <Text style={styles.homePrimaryButtonText}>{state.liveBridge.loading ? '연결 중...' : '연결하기'}</Text>
            </Pressable>
            {state.liveBridge.error ? <Text style={styles.warningText}>{state.liveBridge.error}</Text> : null}
          </View>
        ) : null}

        <View style={styles.homeCard}>
          <View style={styles.homeCardTitleRow}>
            <Text style={styles.homeCardTitle}>무엇을 할까요?</Text>
            {voiceSupport.tts ? (
              <Pressable
                testID="home-voice-toggle"
                accessibilityRole="button"
                accessibilityLabel={home.voiceOn ? '음성 답변 끄기' : '음성 답변 켜기'}
                onPress={homeToggleVoice}
                style={styles.homeVoiceToggle}
              >
                {home.voiceOn
                  ? <Volume2 size={16} color={colors.muted} strokeWidth={2} />
                  : <VolumeX size={16} color={colors.muted} strokeWidth={2} />}
                <Text style={styles.homeVoiceToggleText}>{home.voiceOn ? '음성 답변' : '음소거'}</Text>
              </Pressable>
            ) : null}
          </View>
          <TextInput
            testID="home-command-input"
            value={home.text}
            onChangeText={(value) => setHome((current: any) => ({ ...current, text: value, error: null }))}
            placeholder={home.voicePhase === 'starting'
              ? '마이크를 준비하고 있어요...'
              : home.listening ? '듣고 있어요... 말씀해 주세요' : '예: 주간 정산표 엑셀로 만들어줘'}
            placeholderTextColor={colors.muted}
            multiline
            editable={!busy && !home.listening}
            style={styles.homeInput}
          />
          <View style={styles.homeCommandButtonRow}>
            {voiceSupport.stt ? (
              <Pressable
                testID="home-mic-button"
                accessibilityRole="button"
                accessibilityLabel={!home.listening
                  ? '말로 시키기'
                  : home.voicePhase === 'starting'
                    ? '음성 인식 준비 중'
                    : home.voicePhase === 'speech' ? '음성 감지됨' : '음성 인식 중지'}
                disabled={busy || !paired}
                onPress={() => void homeToggleListening()}
                style={[
                  styles.homeMicButton,
                  home.listening ? styles.homeMicButtonActive : null,
                  busy || !paired ? styles.homeButtonDisabled : null
                ]}
              >
                <Mic size={18} color={home.listening ? colors.onAccent : colors.text} strokeWidth={2.2} />
                <Text style={home.listening ? styles.homePrimaryButtonText : styles.homeMicButtonText}>
                  {home.voicePhase === 'starting' ? '준비 중' : home.listening ? '듣는 중' : '음성입력'}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              testID="home-submit-button"
              accessibilityRole="button"
              accessibilityLabel="자비스에게 시키기"
              disabled={busy || !paired}
              onPress={() => void homeSubmit()}
              style={[styles.homePrimaryButton, styles.homeSubmitButton, busy || !paired ? styles.homeButtonDisabled : null]}
            >
              <Text style={styles.homePrimaryButtonText}>{busy ? '처리 중...' : '실행'}</Text>
            </Pressable>
          </View>
          {home.listening ? (
            <Text
              testID="home-voice-status"
              accessibilityLabel="음성 인식 사용 중"
              style={styles.homeNotice}
            >
              {home.voicePhase === 'starting'
                ? '마이크 준비 중'
                : home.voicePhase === 'speech' ? '음성 감지됨' : '말씀해 주세요'}
            </Text>
          ) : null}
          {voiceSupport.stt ? (
            <Pressable
              testID="home-conversation-button"
              accessibilityRole="button"
              accessibilityLabel="대화 모드 시작"
              disabled={!paired}
              onPress={convEnter}
              style={[styles.convEnterButton, !paired ? styles.homeButtonDisabled : null]}
            >
              <AudioLines size={18} color={colors.accent} strokeWidth={2.2} />
              <Text style={styles.convEnterButtonText}>대화모드</Text>
            </Pressable>
          ) : null}
          {voiceSupport.tts ? (
            <View style={styles.homeRateRow}>
              <Text style={styles.homeRateLabel}>말 속도</Text>
              {speechRatePresets.map((preset) => (
                <Pressable
                  key={preset.id}
                  testID={`home-rate-${preset.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`말 속도 ${preset.label}`}
                  onPress={() => homeSelectRate(preset)}
                  style={[styles.homeRateChip, speechRateId === preset.id ? styles.homeRateChipActive : null]}
                >
                  <Text style={[styles.homeRateChipText, speechRateId === preset.id ? styles.homeRateChipTextActive : null]}>
                    {preset.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {home.notice ? <Text style={styles.homeNotice}>{home.notice}</Text> : null}
          {home.error ? (
            <Text
              testID="home-error"
              accessibilityLabel={home.voiceEngine ? '음성 인식 오류' : undefined}
              style={styles.warningText}
            >
              {home.error}
            </Text>
          ) : null}
        </View>

        {paired ? (
          <View style={styles.homeCard} testID="home-skill-revision-review">
            <Text style={styles.homeCardTitle}>내 업무 절차</Text>
            <Text style={styles.homeHint}>절차를 고치고 검사할 수 있습니다. 검토 승인·승격·복원은 PC에서 소유자 모드를 켜면 사용할 수 있습니다. 승격해도 자동 실행 권한은 생기지 않습니다.</Text>
            <ActionButton label={skillRevisionBusy ? '갱신 중...' : '절차 목록 새로고침'} onPress={() => void refreshSkillRegistryReview()} disabled={skillRevisionBusy} testID="skill-registry-refresh" />
            {(skillRegistryReview?.skillRegistry?.registryEntries ?? []).length === 0 ? (
              <Text style={styles.mutedText}>검토를 마친 업무 절차가 아직 없습니다.</Text>
            ) : (skillRegistryReview.skillRegistry.registryEntries ?? []).slice(0, 5).map((entry: any) => {
              const pendingRevision = entry.revisions?.find((revision: any) => revision.revisionId === entry.pendingRevisionId);
              const activeRevision = entry.revisions?.find((revision: any) => revision.revisionId === entry.activeRevisionId);
              const previousRevision = entry.revisions?.find((revision: any) => revision.revisionId !== entry.activeRevisionId && revision.status === 'superseded');
              return (
                <View key={entry.skillId} style={styles.compactCard} testID={`skill-registry-entry-${entry.skillId}`}>
                  <Text style={styles.cardTitle}>{entry.title ?? entry.skillId}</Text>
                  <Text style={styles.mutedText}>활성 버전 {entry.activeRevisionId ?? '없음'} · 자동 실행 꺼짐</Text>
                  <Text style={styles.mutedText}>현재 절차: {activeRevision?.suggestedSteps?.join(' → ') ?? entry.suggestedSteps?.join(' → ') ?? '없음'}</Text>
                  <TextInput
                    testID={`skill-revision-steps-${entry.skillId}`}
                    value={skillRevisionSteps[entry.skillId] ?? ''}
                    onChangeText={(value) => setSkillRevisionSteps((current) => ({ ...current, [entry.skillId]: value }))}
                    placeholder="수정할 절차를 한 줄씩 입력"
                    placeholderTextColor={colors.muted}
                    multiline
                    style={styles.homeInput}
                  />
                  <ActionButton label="수정 초안 만들기" onPress={() => void runSkillRevisionAction('create', entry)} disabled={skillRevisionBusy || !String(skillRevisionSteps[entry.skillId] ?? '').trim()} testID={`skill-revision-create-${entry.skillId}`} />
                  {pendingRevision ? (
                    <>
                      <Text style={styles.mutedText}>변경안 비교 · 상태: {pendingRevision.status}</Text>
                      {createSkillRevisionDiff(activeRevision?.suggestedSteps ?? entry.suggestedSteps, pendingRevision.suggestedSteps).map((line, index) => (
                        <Text key={`${pendingRevision.revisionId}-${index}`} style={styles.homeHint}>
                          {line.status === 'added' ? '+ ' : line.status === 'removed' ? '− ' : '= '}{line.text}
                        </Text>
                      ))}
                      {pendingRevision.status === 'draft' ? <ActionButton label="정적 계약 검사" onPress={() => void runSkillRevisionAction('evaluate', entry, pendingRevision.revisionId)} disabled={skillRevisionBusy} testID={`skill-revision-evaluate-${entry.skillId}`} /> : null}
                      {pendingRevision.status === 'awaiting_user_review' ? (
                        <>
                          <ActionButton label="검사 결과 검토 승인" onPress={() => void runSkillRevisionAction('review', entry, pendingRevision.revisionId, 'approve')} disabled={skillRevisionBusy} testID={`skill-revision-review-${entry.skillId}`} />
                          <ActionButton label="수정안 거절" onPress={() => void runSkillRevisionAction('review', entry, pendingRevision.revisionId, 'reject')} disabled={skillRevisionBusy} testID={`skill-revision-reject-${entry.skillId}`} />
                        </>
                      ) : null}
                      {pendingRevision.status === 'review_approved' ? <ActionButton label="새 절차 버전 승격" onPress={() => void runSkillRevisionAction('promote', entry, pendingRevision.revisionId)} disabled={skillRevisionBusy} tone="primary" testID={`skill-revision-promote-${entry.skillId}`} /> : null}
                    </>
                  ) : null}
                  {previousRevision ? <ActionButton label="이전 버전 복원" onPress={() => void runSkillRevisionAction('rollback', entry)} disabled={skillRevisionBusy} testID={`skill-revision-rollback-${entry.skillId}`} /> : null}
                </View>
              );
            })}
            {skillRevisionMessage ? <Text style={styles.mutedText}>{skillRevisionMessage}</Text> : null}
          </View>
        ) : null}

        {paired && suggestions.length && home.phase === 'idle' ? (
          <View style={styles.homeSuggestCard}>
            <Text style={styles.homeSuggestTitle}>자주 하는 일</Text>
            <View style={styles.homeSuggestWrap}>
              {suggestions.map((item) => (
                <Pressable
                  key={item.text}
                  testID={`home-suggest-${item.text}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.text} 실행`}
                  disabled={busy}
                  onPress={() => {
                    setHome((current: any) => ({ ...current, text: item.text }));
                    void homeSubmit(item.text);
                  }}
                  style={styles.homeSuggestChip}
                >
                  <Text style={styles.homeSuggestChipText} numberOfLines={1}>{item.text}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {home.phase === 'idle' ? (
          examplesOn ? (
            <View style={styles.homeExampleCard}>
              <View style={styles.homeExampleHeader}>
                <View style={styles.homeExampleHeaderLeft}>
                  <Lightbulb size={16} color={colors.accent} strokeWidth={2} />
                  <Text style={styles.homeExampleTitle}>이런 걸 시켜보세요</Text>
                </View>
                <Pressable
                  testID="home-examples-off"
                  accessibilityRole="button"
                  accessibilityLabel="예시 숨기기"
                  hitSlop={8}
                  onPress={() => toggleExamples(false)}
                  style={styles.homeExampleClose}
                >
                  <X size={15} color={colors.muted} strokeWidth={2.2} />
                </Pressable>
              </View>
              {commandExamples.map((group) => (
                <View key={group.level} style={styles.homeExampleGroup}>
                  <View style={[styles.homeExampleBadge, styles[`exampleBadge_${group.tone}` as const]]}>
                    <Text style={[styles.homeExampleBadgeText, styles[`exampleBadgeText_${group.tone}` as const]]}>{group.level}</Text>
                  </View>
                  <View style={styles.homeExampleItems}>
                    {group.items.map((text) => (
                      <Pressable
                        key={text}
                        testID={`home-example-${text}`}
                        accessibilityRole="button"
                        accessibilityLabel={`예시 실행: ${text}`}
                        disabled={busy}
                        onPress={() => {
                          setHome((current: any) => ({ ...current, text }));
                          if (paired) void homeSubmit(text);
                        }}
                        style={styles.homeExampleItem}
                      >
                        <Text style={styles.homeExampleItemText}>{text}</Text>
                        <ChevronRight size={15} color={colors.muted} strokeWidth={2} />
                      </Pressable>
                    ))}
                  </View>
                </View>
              ))}
            </View>
          ) : (
            <Pressable
              testID="home-examples-on"
              accessibilityRole="button"
              accessibilityLabel="명령 예시 보기"
              onPress={() => toggleExamples(true)}
              style={styles.homeExampleReopen}
            >
              <Lightbulb size={15} color={colors.muted} strokeWidth={2} />
              <Text style={styles.homeExampleReopenText}>명령 예시 보기</Text>
            </Pressable>
          )
        ) : null}

        {approvalCard ? (
          <View style={[styles.homeCard, styles.homeApprovalCard]}>
            <Text style={styles.homeCardTitle}>이렇게 진행할까요?</Text>
            <Text style={styles.homeApprovalTitle}>{approvalCard.title}</Text>
            {approvalCard.planExplanation ? (
              <Text style={styles.homeHint}>{approvalCard.planExplanation}</Text>
            ) : approvalCard.interpretedIntent ? (
              <Text style={styles.homeHint}>{approvalCard.interpretedIntent}</Text>
            ) : null}
            {(approvalCard.planSteps ?? []).slice(0, 3).map((step: string, index: number) => (
              <Text key={`${index}-${step}`} style={styles.homePlanStep}>· {step}</Text>
            ))}
            {(approvalCard.clarifyingQuestions ?? []).length ? (
              <View style={styles.homeClarifyBox}>
                <Text style={styles.homeClarifyTitle}>몇 가지 확인하고 싶어요</Text>
                {approvalCard.clarifyingQuestions.map((q: string, i: number) => (
                  <Text key={`q-${i}`} style={styles.homeClarifyQuestion}>? {q}</Text>
                ))}
                <TextInput
                  testID="home-clarify-answer"
                  value={home.answer}
                  onChangeText={(value) => setHome((current: any) => ({ ...current, answer: value }))}
                  placeholder="답을 적으면 그 정보로 다시 계획해요 (선택)"
                  placeholderTextColor={colors.muted}
                  multiline
                  style={styles.homeClarifyInput}
                />
                <Pressable
                  testID="home-clarify-resubmit"
                  accessibilityRole="button"
                  accessibilityLabel="이 정보로 다시 계획"
                  disabled={!String(home.answer ?? '').trim()}
                  onPress={() => void homeResubmitWithAnswer()}
                  style={[styles.homePrimaryButton, !String(home.answer ?? '').trim() ? styles.homeButtonDisabled : null]}
                >
                  <Text style={styles.homePrimaryButtonText}>이 정보로 다시 계획</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={styles.homeDecideRow}>
              <Pressable
                testID="home-approve-button"
                accessibilityRole="button"
                accessibilityLabel="승인"
                onPress={() => void homeDecide('approve')}
                style={[styles.homeDecideButton, styles.homeApproveButton]}
              >
                <Check size={18} color={colors.onAccent} strokeWidth={2.6} />
                <Text style={styles.homePrimaryButtonText}>승인</Text>
              </Pressable>
              <Pressable
                testID="home-reject-button"
                accessibilityRole="button"
                accessibilityLabel="거절"
                onPress={() => void homeDecide('reject')}
                style={[styles.homeDecideButton, styles.homeRejectButton]}
              >
                <X size={18} color={colors.onAccent} strokeWidth={2.6} />
                <Text style={styles.homePrimaryButtonText}>거절</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {home.phase === 'pc-confirmation' && home.pcHandoff ? (
          <View style={[styles.homeCard, styles.homeApprovalCard]} testID="home-pc-voice-confirmation">
            <Text style={styles.homeCardTitle}>PC 음성 확인 대기</Text>
            <Text style={styles.homeHint}>{home.approval?.title ?? '고위험 작업'}</Text>
            {home.pcHandoff.voiceChallenge?.phrase ? (
              <View style={styles.homeClarifyBox}>
                <Text style={styles.homeClarifyTitle}>PC에서 말할 문구</Text>
                <Text style={styles.homeApprovalTitle}>
                  자비스 {home.pcHandoff.voiceChallenge.phrase} 승인
                </Text>
              </View>
            ) : null}
            <Text style={styles.homeNotice}>{home.notice ?? 'PC 확인 상태를 기다리고 있습니다.'}</Text>
          </View>
        ) : null}

        {home.phase === 'done' ? (
          <View style={[styles.homeCard, home.taskStatus === 'COMPLETED' ? styles.homeDoneCard : null]}>
            <View style={styles.homeDoneTitleRow}>
              {home.taskStatus === 'COMPLETED' ? <CircleCheck size={20} color={colors.success} strokeWidth={2.2} /> : null}
              <Text style={styles.homeCardTitle}>
                {home.taskStatus === 'COMPLETED' ? '완료했어요' : `결과: ${home.taskStatus ?? '알 수 없음'}`}
              </Text>
            </View>
            {home.result?.command ? (
              <Text style={styles.homeDoneCommand}>요청: "{home.result.command}"</Text>
            ) : null}
            {(home.result?.outputPaths ?? []).length ? (
              <View style={styles.homeDoneFilesBox}>
                <Text style={styles.homeDoneLabel}>만든 파일</Text>
                {(home.result?.outputPaths ?? []).map((path: string) => (
                  <View key={path} style={styles.homeDoneFileRow}>
                    <FileText size={16} color={colors.text} strokeWidth={2} />
                    <Text style={styles.homeDoneFile}>{String(path).split(/[\\/]/).filter(Boolean).at(-1)}</Text>
                  </View>
                ))}
                <Text style={styles.homeDoneWhere}>PC에 저장되고 화면에 열렸어요.</Text>
              </View>
            ) : null}
            {home.result?.summary ? <Text style={styles.homeHint}>{home.result.summary}</Text> : null}
            {home.taskStatus === 'COMPLETED' && !(home.result?.outputPaths ?? []).length && !home.result?.summary ? (
              <Text style={styles.homeHint}>요청하신 작업을 처리했어요.</Text>
            ) : null}
            <Pressable
              testID="home-new-command-button"
              accessibilityRole="button"
              accessibilityLabel="새 명령"
              onPress={homeReset}
              style={styles.homePrimaryButton}
            >
              <Text style={styles.homePrimaryButtonText}>새 명령 시키기</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  }

  function renderPairingScreen() {
    return (
      <View testID="screen-content-PairingScreen" style={styles.screenStack}>
        <Section title="PC 브리지 페어링" caption="모바일 연결">
          <DataRow label="실제 호출 URL" value={effectiveBridgeUrl} />
          <DataRow label="Live Bridge" value={state.connection.connected ? 'connected' : 'not connected'} tone={state.connection.connected ? 'good' : 'warning'} />
          <DataRow label="Token" value={state.liveBridge.deviceTokenPreview ?? 'none'} tone={state.liveBridge.deviceTokenPreview ? 'good' : 'warning'} />
          <View style={styles.buttonRow}>
            <ActionButton testID="bridge-health-button" label={state.liveBridge.loading ? '확인 중' : '연결 상태 확인'} tone="primary" onPress={checkBridgeHealth} disabled={state.liveBridge.loading} />
            <ActionButton testID="pairing-start-button" label="페어링 시작" onPress={startLivePairing} disabled={state.liveBridge.loading} />
            <ActionButton testID="pairing-confirm-button" label="페어링 확인" tone="primary" onPress={() => confirmPairing()} disabled={state.liveBridge.loading} />
            <ActionButton testID="demo-pairing-confirm-button" label="데모 페어링" onPress={confirmDemoPairing} />
          </View>
          <PairingQrPanel
            pairingCode={state.device.pairingCode}
            bridgeUrl={state.connection.bridgeUrl}
            expiresAt="2026-12-31T23:59:00+09:00"
          />
          <TextInput
            testID="pairing-bridge-url-input"
            value={state.connection.bridgeUrl}
            onChangeText={(value) => setState((current: any) => ({
              ...current,
              connection: {
                ...current.connection,
                bridgeUrl: value,
                effectiveBridgeUrl: normalizeBridgeUrlForDevice(value)
              }
            }))}
            placeholder="브리지 접속 주소"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />
          <TextInput
            testID="pairing-code-input"
            value={state.device.pairingCode}
            onChangeText={(value) => setState((current: any) => ({
              ...current,
              device: { ...current.device, pairingCode: value, pairingStatus: 'pairing' }
            }))}
            placeholder="페어링 코드"
            placeholderTextColor={colors.muted}
            keyboardType="number-pad"
            style={styles.input}
          />
          {state.liveBridge.error ? <Text style={styles.warningText}>실시간 연결 오류: {state.liveBridge.error}</Text> : null}
          {state.liveBridge.lastResponse ? (
            <Text style={styles.mutedText}>
              최근 응답: {localizedDataValue(state.liveBridge.lastResponse.status ?? state.liveBridge.lastResponse.module ?? state.liveBridge.lastAction)}
            </Text>
          ) : null}
        </Section>

        <Section title="모바일 안전 원칙" caption="모바일은 요청하고 PC가 실행합니다">
          <BulletList
            items={[
              '모바일 앱은 D 브리지와만 통신합니다.',
              '모바일 앱은 권한 토큰을 직접 생성하지 않습니다.',
              '모바일 앱은 PC 파일이나 브라우저를 직접 조작하지 않습니다.',
              '기기 토큰은 보안 저장소에 암호화해 보관합니다.'
            ]}
          />
        </Section>
      </View>
    );
  }

  function renderCommandScreen() {
    return (
      <View testID="screen-content-CommandScreen" style={styles.screenStack}>
        <Section title="자연어 명령 입력" caption="명령 작성">
          <CommandComposerPanel
            rawText={state.command.rawText}
            connected={state.connection.connected}
            pendingOfflineCount={state.offline.pending.length}
            submitTestID="command-submit-button"
            onChangeText={(value) => setState((current: any) => ({
              ...current,
              command: { ...current.command, rawText: value, error: null }
            }))}
            onSubmit={submitCommand}
          />
          {state.command.error ? <Text style={styles.warningText}>{state.command.error}</Text> : null}
          {state.command.lastRequest ? (
            <View style={styles.payloadPreview}>
              <Text style={styles.payloadTitle}>최근 작업 요청</Text>
              <Text style={styles.mutedText}>{state.command.lastRequest.requestId}</Text>
              <Text style={styles.mutedText}>{state.command.lastRequest.command.rawText}</Text>
            </View>
          ) : null}
        </Section>

        <Section title="오프라인 대기열" caption="연결 복구 후 전송">
          <DataRow label="자동 전송" value={state.offline.autoSend ? '허용' : '금지'} tone={state.offline.autoSend ? 'danger' : 'good'} />
          <DataRow label="대기 명령" value={`${state.offline.pending.length}건`} tone={state.offline.pending.length ? 'warning' : 'good'} />
          {state.offline.pending.map((item: any) => (
            <View key={item.localId} style={styles.compactCard}>
              <Text style={styles.cardTitle}>{item.rawText}</Text>
              <Text style={styles.mutedText}>{item.syncStatus} · {item.createdAt}</Text>
            </View>
          ))}
        </Section>

        <Section title="빠른 이동" caption="승인 중심 작업 흐름">
          <View style={styles.buttonRow}>
            <ActionButton label="승인 대기 보기" tone="primary" onPress={() => navigate(MobileRoutes.ApprovalQueueScreen)} />
            <ActionButton label="작업 상태" onPress={() => navigate(MobileRoutes.TaskStatusScreen)} />
            <ActionButton label="설정" onPress={() => navigate(MobileRoutes.SettingsScreen)} />
          </View>
        </Section>
      </View>
    );
  }

  function renderApprovalQueueScreen() {
    return (
      <View testID="screen-content-ApprovalQueueScreen" style={styles.screenStack}>
        <Section title="승인 대기 작업" caption="승인 목록">
          <DataRow label="대기 카드" value={`${state.approvals.items.length}건`} tone={state.approvals.items.length ? 'warning' : 'good'} />
          <DataRow label="Live source" value={state.connection.connected && state.liveBridge.deviceToken ? 'D 브리지 승인 목록' : '로컬 데모 상태'} />
          {state.approvals.error ? <Text style={styles.warningText}>{state.approvals.error}</Text> : null}
          <ActionButton
            testID="approvals-refresh-button"
            label={state.liveBridge.loading ? '불러오는 중' : '승인 목록 새로고침'}
            tone="primary"
            onPress={refreshLiveApprovals}
            disabled={state.liveBridge.loading}
          />
          {state.approvals.items.map((item: any) => {
            const expiry = approvalExpiryState(item);
            return (
              <TouchableOpacity
                key={item.approvalId}
                testID={`approval-row-${item.approvalId}`}
                accessibilityRole="button"
                accessibilityLabel={`승인 카드 ${item.title}`}
                onPress={() => chooseApproval(item.approvalId)}
                style={[styles.approvalRow, expiry.expired ? styles.expiredRow : null]}
              >
                <View style={styles.rowTop}>
                  <Text style={styles.cardTitle}>{item.title}</Text>
                  <Text style={[styles.badgeText, { color: item.riskTier <= 3 || expiry.expired ? colors.warning : colors.accent }]}>
                    {expiry.expired ? '만료됨' : `위험 ${item.riskTier}단계`}
                  </Text>
                </View>
                <Text style={styles.mutedText} numberOfLines={2}>{item.interpretedIntent}</Text>
                <Text style={styles.mutedText}>외부 전송 {item.externalTransfer ? '있음' : '없음'} · 되돌리기 {item.rollbackAvailable ? '가능' : '불가'}</Text>
                <Text style={expiry.expired ? styles.warningText : styles.mutedText}>{expiry.label}</Text>
              </TouchableOpacity>
            );
          })}
        </Section>
      </View>
    );
  }

  function renderApprovalDetailScreen() {
    const expiry = approvalExpiryState(selectedApproval);
    const safety = {
      mobileApprovalAllowed: selectedApproval.riskTier > 3 && !expiry.expired,
      requiresPcConfirmation: selectedApproval.riskTier <= 3,
      externalTransfer: selectedApproval.externalTransfer,
      rollbackAvailable: selectedApproval.rollbackAvailable,
      affectedItemCount: selectedApproval.affectedItems.length,
      expiry,
      expired: expiry.expired,
      expiresAt: expiry.expiresAt
    };
    const approveReadiness = {
      allowed: !state.security.locked && !expiry.expired,
      session: state.security,
      error: expiry.expired
        ? { code: 'C_APPROVAL_EXPIRED' }
        : state.security.locked
          ? { code: 'C_SESSION_LOCKED' }
          : null
    };
    const timeline = createApprovalTimeline(selectedApproval, {
      history: state.approvals.historyById?.[selectedApproval.approvalId] ?? [],
      lastDecision: state.approvals.lastDecision
    });

    return (
      <View testID="screen-content-ApprovalDetailScreen" style={styles.screenStack}>
        <Section title="승인 카드 상세" caption="승인 검토">
          <ApprovalCardView
            card={selectedApproval}
            safety={safety}
            approveReadiness={approveReadiness}
            onDecision={sendApprovalDecision}
          />
          {selectedApproval.riskTier <= 3 ? (
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>이 작업은 현재 모바일 앱에서 승인할 수 없습니다.</Text>
              <Text style={styles.mutedText}>PC에서 직접 확인이 필요합니다.</Text>
              <View style={styles.buttonRow}>
                <ActionButton
                  testID="approval-pc-handoff-button"
                  label={state.liveBridge.loading ? '요청 중' : 'PC 확인 요청'}
                  tone="warning"
                  accessibilityHint="모바일 단독 승인을 중단하고 PC에서 직접 확인하도록 요청합니다."
                  onPress={requestPcConfirmationForSelectedApproval}
                  disabled={state.liveBridge.loading}
                />
              </View>
            </View>
          ) : null}
          {expiry.expired ? (
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>승인 카드가 만료되었습니다.</Text>
              <Text style={styles.mutedText}>만료된 결정은 D 브리지로 전송하지 않습니다.</Text>
              <View style={styles.buttonRow}>
                <ActionButton
                  testID="approval-renew-button"
                  label={state.liveBridge.loading ? '연장 중' : '승인 만료 연장'}
                  tone="primary"
                  onPress={renewSelectedApproval}
                  disabled={state.liveBridge.loading}
                />
                <ActionButton
                  testID="approval-rerequest-button"
                  label={state.liveBridge.loading ? '재요청 중' : '새 승인 재요청'}
                  onPress={reRequestSelectedApproval}
                  disabled={state.liveBridge.loading}
                />
                <ActionButton
                  testID="approval-cancel-button"
                  label={state.liveBridge.loading ? '취소 중' : '승인 취소'}
                  tone="danger"
                  onPress={cancelSelectedApproval}
                  disabled={state.liveBridge.loading}
                />
              </View>
            </View>
          ) : null}
        </Section>

        <Section title="승인 이력" caption="카드 처리 과정" testID="approval-history-timeline">
          {timeline.map((item: any, index: number) => {
            const tone = approvalHistoryTone(item);
            const markerColor = tone === 'good'
              ? colors.accent
              : tone === 'warning'
                ? colors.warning
                : tone === 'danger'
                  ? colors.danger
                  : colors.line;
            return (
              <View
                key={item.eventId ?? `${item.eventType}-${index}`}
                testID={`approval-history-item-${index}`}
                style={styles.timelineItem}
              >
                <View style={[styles.timelineMarker, { backgroundColor: markerColor }]} />
                <View style={styles.timelineContent}>
                  <View style={styles.timelineHeader}>
                    <Text style={styles.cardTitle}>{item.label}</Text>
                    <Text style={[styles.badgeText, { color: markerColor }]}>{item.status ?? item.eventType}</Text>
                  </View>
                  <Text style={styles.mutedText}>{item.createdAt}</Text>
                  {item.actor ? <Text style={styles.mutedText}>처리 주체: {item.actor}</Text> : null}
                  {item.detail ? <Text style={styles.bodyText}>{item.detail}</Text> : null}
                  {item.reason ? <Text style={styles.warningText}>사유: {item.reason}</Text> : null}
                </View>
              </View>
            );
          })}
        </Section>

        <Section title="승인 결정 데이터" caption="D 브리지로 전송">
          <DataRow label="approvalId" value={selectedApproval.approvalId} />
          <DataRow label="taskId" value={selectedApproval.taskId} />
          <DataRow label="decidedBy" value={`${state.device.deviceId} / C_MOBILE`} />
          {state.approvals.lastDecision ? (
            <Text style={styles.mutedText}>최근 결정: {decisionLabels[state.approvals.lastDecision.decision as keyof typeof decisionLabels] ?? state.approvals.lastDecision.decision}</Text>
          ) : null}
        </Section>
      </View>
    );
  }

  function renderTaskStatusScreen() {
    const current = state.task.current;
    return (
      <View testID="screen-content-TaskStatusScreen" style={styles.screenStack}>
        <Section title="작업 진행 상태" caption="실행 추적">
          <View style={styles.statusHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{current.title}</Text>
              <Text style={styles.mutedText}>{current.taskId}</Text>
            </View>
            <TaskStatusPill status={current.status} />
          </View>
          <Text style={styles.bodyText}>{current.summary}</Text>
          {current.blockedReason ? <Text style={styles.warningText}>사유: {current.blockedReason}</Text> : null}
          <DataRow label="현재 단계" value={`${current.progress.stepIndex} / ${current.progress.totalSteps}`} />
          <DataRow label="단계명" value={current.progress.currentStep} />
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.min(100, (current.progress.stepIndex / current.progress.totalSteps) * 100)}%` }]} />
          </View>
          <BulletList items={taskStatusSteps.map((step, index) => `${index + 1}. ${step}${index + 1 === current.progress.stepIndex ? ' (현재)' : ''}`)} />
          <View style={styles.buttonRow}>
            <ActionButton
              testID="task-complete-button"
              label="검증 완료 처리"
              tone="primary"
              onPress={completeTask}
              disabled={current.status === 'COMPLETED' || current.status === 'BLOCKED' || current.status === 'CANCELLED'}
            />
            <ActionButton
              testID="open-result-button"
              label="결과 보기"
              onPress={() => navigate(MobileRoutes.ResultScreen)}
              disabled={current.status !== 'COMPLETED'}
            />
            <ActionButton label="승인 목록" onPress={() => navigate(MobileRoutes.ApprovalQueueScreen)} />
          </View>
        </Section>
      </View>
    );
  }

  function renderResultScreen() {
    return (
      <View testID="screen-content-ResultScreen" style={styles.screenStack}>
        <Section title="실행 결과" caption="결과 확인">
          <ResultSummaryCard
            result={state.result}
            feedbackText={state.feedback.text}
            onFeedback={submitFeedback}
            onPreview={previewResultFile}
            onShare={shareResultFile}
            onRollback={requestResultRollback}
          />
          <TextInput
            testID="feedback-text-input"
            value={state.feedback.text}
            onChangeText={(value) => setState((current: any) => ({
              ...current,
              feedback: { ...current.feedback, text: value }
            }))}
            placeholder="피드백 입력"
            placeholderTextColor={colors.muted}
            multiline
            style={[styles.input, styles.feedbackInput]}
          />
        </Section>

        <Section title="산출물과 변경 항목" caption="모바일은 경로만 표시">
          <DataRow label="검증" value={state.result.verificationStatus} tone={state.result.verificationStatus === 'passed' ? 'good' : 'warning'} />
          <DataRow label="되돌리기" value={state.result.rollbackAvailable ? '가능' : '불가'} tone={state.result.rollbackAvailable ? 'good' : 'warning'} />
          <BulletList items={[...state.result.outputPaths, ...state.result.changedItems.map((item: any) => item.path ?? item.label)]} />
          {state.feedback.lastFileAction ? (
            <DataRow
              label={state.feedback.lastFileAction.actionType === 'share' ? '파일 공유' : '파일 미리보기'}
              value={state.feedback.lastFileAction.status}
              tone={state.feedback.lastFileAction.fallbackUsed ? 'warning' : 'good'}
            />
          ) : null}
          {state.feedback.rollbackConfirmation?.visible ? (
            <View style={styles.confirmationPanel} testID="result-rollback-confirmation">
              <Text style={styles.bodyText}>되돌리기 확인</Text>
              <Text style={styles.mutedText}>
                변경 {state.feedback.rollbackConfirmation.affectedItemCount}건 · 산출물 {state.feedback.rollbackConfirmation.outputPathCount}건
              </Text>
              <View style={styles.buttonRow}>
                <ActionButton label="취소" onPress={cancelResultRollback} />
                <ActionButton label="되돌리기 실행" tone="warning" onPress={confirmResultRollback} />
              </View>
            </View>
          ) : null}
          {state.feedback.lastSent ? (
            <Text style={styles.mutedText}>최근 피드백: {feedbackLabels[state.feedback.lastSent.feedbackType as keyof typeof feedbackLabels]}</Text>
          ) : null}
        </Section>
      </View>
    );
  }

  function renderSettingsScreen() {
    const retryDraft = {
      maxAttempts: state.queuePolicy.maxAttempts === 4 ? 5 : 4,
      baseBackoffMs: state.queuePolicy.baseBackoffMs,
      reason: 'mobile setting review'
    };
    return (
      <View testID="screen-content-SettingsScreen" style={styles.screenStack}>
        <Section title="연결 및 보안" caption="기기 연결과 세션 보호">
          <TextInput
            testID="settings-bridge-url-input"
            value={state.connection.bridgeUrl}
            onChangeText={(value) => setState((current: any) => ({
              ...current,
              connection: {
                ...current.connection,
                bridgeUrl: value,
                effectiveBridgeUrl: normalizeBridgeUrlForDevice(value)
              }
            }))}
            placeholder="브리지 접속 주소"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />
          <DataRow label="Effective URL" value={effectiveBridgeUrl} />
          <DataRow label="PC Bridge" value={state.connection.connected ? 'connected' : 'disconnected'} tone={state.connection.connected ? 'good' : 'warning'} />
          <DataRow label="Token sealed" value={state.device.tokenStorage.sealed ? 'yes' : 'no'} tone={state.device.tokenStorage.sealed ? 'good' : 'warning'} />
          <DataRow label="Plaintext exposed" value={state.device.tokenStorage.plaintextExposed ? 'yes' : 'no'} tone={state.device.tokenStorage.plaintextExposed ? 'danger' : 'good'} />
          <DataRow label="Session lock" value={state.security.locked ? 'locked' : 'unlocked'} tone={state.security.locked ? 'warning' : 'good'} />
          <DataRow label="App lifecycle" value={state.security.lifecycle ?? 'active'} tone={state.security.lifecycle === 'active' ? 'good' : 'warning'} />
          <DataRow label="Lock reason" value={state.security.lastLifecycleLockReason ?? 'none'} tone={state.security.lastLifecycleLockReason ? 'warning' : 'good'} />
          <DataRow label="Last lock" value={state.security.lastLifecycleLockAt ?? 'none'} />
          <DataRow label="Stored token" value={state.liveBridge.deviceTokenPreview ?? 'none'} tone={state.liveBridge.deviceTokenPreview ? 'good' : 'warning'} />
          {state.liveBridge.error ? <Text style={styles.warningText}>실시간 연결 오류: {state.liveBridge.error}</Text> : null}
          <View style={styles.buttonRow}>
            <ActionButton label={state.liveBridge.loading ? '확인 중' : '연결 테스트'} tone="primary" onPress={checkBridgeHealth} disabled={state.liveBridge.loading} />
            <ActionButton label="페어링 코드 발급" onPress={startLivePairing} disabled={state.liveBridge.loading} />
            <ActionButton label={state.security.locked ? '세션 잠금 해제' : '세션 잠금'} onPress={toggleSessionLock} />
            <ActionButton testID="device-disconnect-button" label="기기 연결 해제" tone="danger" onPress={disconnect} />
          </View>
        </Section>

        <Section title="알림" caption="알림 및 수신 검증">
          <DataRow label="권한" value={state.notifications.permission.status} tone={state.notifications.permission.granted ? 'good' : 'warning'} />
          <DataRow label="미확인 알림" value={`${state.notifications.unreadCount}건`} />
          <DataRow label="수신 검증" value={`${state.notifications.receiptLog?.length ?? 0}건`} />
          <DataRow label="재시도 큐" value={`${state.notifications.issueQueue?.length ?? 0}건`} tone={(state.notifications.issueQueue?.length ?? 0) > 0 ? 'warning' : 'good'} />
          <ActionButton label="알림 권한 허용" tone="primary" onPress={requestNotifications} disabled={state.notifications.permission.granted} />
          <ActionButton label="수신 검증" onPress={verifyNotificationReceipts} disabled={!state.notifications.permission.granted} />
          {state.notifications.items.map((item: any) => (
            <View key={item.notificationId} style={styles.compactCard}>
              <Text style={styles.cardTitle}>{item.title}</Text>
              <Text style={styles.mutedText}>{item.body}</Text>
            </View>
          ))}
        </Section>

        <Section title="실행 대기열 정책" caption="PC 에이전트 재시도 설정">
          <RetryPolicySettingsPanel
            policy={state.queuePolicy}
            readiness={{ allowed: !state.security.locked }}
            draft={retryDraft}
            onSave={saveRetryPolicy}
            onReset={() => updateMessage('재시도 정책 초안을 초기화했습니다.')}
          />
        </Section>
      </View>
    );
  }

  function renderGrowthReviewScreen() {
    const review = state.growth.review;
    const maturityScore = review.maturityScore ?? {};
    const maturityAlerts = maturityScore.thresholdAlerts ?? [];
    const learningVerification = maturityScore.learningVerification ?? {};
    return (
      <View testID="screen-content-GrowthReviewScreen" style={styles.screenStack}>
        <Section title="성장 리뷰" caption="읽기 전용 검토">
          <Text style={styles.bodyText}>{review.summary}</Text>
          <DataRow label="기간" value={review.period} />
          <DataRow label="반복 작업" value={`${review.repeatedTasks.length}건`} />
          <DataRow label="선호 후보" value={`${review.preferenceCandidates.length}건`} />
          <DataRow label="성숙도" value={`${maturityScore.total ?? 0}점 · ${maturityScore.level ?? '-'}`} tone={(maturityScore.total ?? 0) >= 80 ? 'good' : 'neutral'} />
          <DataRow label="G 검증" value={`${learningVerification.status ?? 'not_configured'} · ${Math.round((learningVerification.passRate ?? 0) * 100)}%`} tone={learningVerification.status === 'failed' ? 'danger' : 'good'} />
          <DataRow label="임계 알림" value={`${maturityAlerts.length}건`} tone={maturityAlerts.length ? 'warning' : 'good'} />
          <GrowthReviewDecisionPanel review={review} onDecision={decideGrowthPreference} />
          {state.growth.lastDecision ? (
            <Text style={styles.mutedText}>최근 결정: {state.growth.lastDecision.hypothesisId} / {state.growth.lastDecision.decision}</Text>
          ) : null}
        </Section>

        <Section title="F로 보내는 신호" caption="직접 DB 수정 금지">
          <BulletList
            items={[
              '승인, 수정, 거부, 되묻기',
              '결과 좋음, 수정 필요, 다시 실행',
              '기억하지 마 신호',
              '선호 후보 확정/거절'
            ]}
          />
        </Section>
      </View>
    );
  }

  function renderPoisonQueueScreen() {
    return (
      <View testID="screen-content-PoisonQueueScreen" style={styles.screenStack}>
        <Section title="PC 에이전트 격리 대기열" caption="모바일 검토">
          <DataRow label="상태" value={state.poisonQueue.refreshState?.visualSnapshot?.badgeLabel ?? '정상'} tone={(state.poisonQueue.queue?.quarantined ?? 0) > 0 ? 'warning' : 'good'} />
          <DataRow label="최근 갱신" value={state.poisonQueue.refreshState?.lastRefreshedAt ?? '-'} />
          <ActionButton label="큐 갱신 검증" onPress={verifyPoisonQueueDrain} />
          <PoisonQueueActionPanel
            queue={state.poisonQueue.queue}
            items={state.poisonQueue.items}
            selectedItem={selectedPoisonItem}
            readiness={{ allowed: !state.security.locked }}
            onAction={handlePoisonAction}
          />
          {state.poisonQueue.items.map((item: any) => (
            <TouchableOpacity
              key={item.queueId}
              accessibilityRole="button"
              accessibilityLabel={`격리된 작업 ${item.queueId} 선택`}
              onPress={() => setState((current: any) => ({
                ...current,
                poisonQueue: { ...current.poisonQueue, selectedQueueId: item.queueId }
              }))}
              style={styles.compactCard}
            >
              <Text style={styles.cardTitle}>{item.queueId}</Text>
              <Text style={styles.mutedText}>{localizedDataValue(item.status)} · {localizedDataValue(item.reviewStatus)}</Text>
            </TouchableOpacity>
          ))}
        </Section>
      </View>
    );
  }

  function renderScreen() {
    // 사용자 앱은 집사 홈 화면만 노출한다. 전문가(엔지니어링) 화면 렌더러는
    // 코드에 남아 있지만 UI 어떤 경로로도 도달하지 않는다(문제 발생 시 개발자가 코드로 수정).
    return renderHomeScreen();
  }

  function renderRouteDock() {
    return (
      <View testID="route-dock" style={styles.routeDock}>
        <Pressable
          key={MobileRoutes.HomeScreen}
          testID={`route-button-${MobileRoutes.HomeScreen}`}
          accessibilityRole="button"
          accessibilityLabel="홈 화면으로 이동"
          accessibilityState={{ selected: route === MobileRoutes.HomeScreen }}
          hitSlop={6}
          onPress={() => navigate(MobileRoutes.HomeScreen)}
          style={[styles.routeButton, route === MobileRoutes.HomeScreen ? styles.routeButtonActive : null]}
        >
          <Text style={[styles.routeButtonText, route === MobileRoutes.HomeScreen ? styles.routeButtonTextActive : null]}>
            홈
          </Text>
        </Pressable>
        {shell.routes.map((item: string) => (
          <Pressable
            key={item}
            testID={`route-button-${item}`}
            accessibilityRole="button"
            accessibilityLabel={`${routeMeta[item as keyof typeof routeMeta]?.label ?? '선택한'} 화면으로 이동`}
            accessibilityState={{ selected: route === item }}
            hitSlop={6}
            onPress={() => navigate(item)}
            style={[styles.routeButton, route === item ? styles.routeButtonActive : null]}
          >
            <Text style={[styles.routeButtonText, route === item ? styles.routeButtonTextActive : null]}>
              {routeMeta[item as keyof typeof routeMeta]?.label ?? item}
            </Text>
          </Pressable>
        ))}
      </View>
    );
  }

  // 사용자 앱은 항상 홈 레이아웃(집사 화면)만 사용한다.
  const isHome = true;

  // edge-to-edge에서 상태바/제스처 영역과 콘텐츠가 겹치지 않도록 실제 인셋을 적용한다.
  // useSafeAreaInsets는 레이아웃 이후 정확한 값을 주므로 StatusBar.currentHeight보다 안정적이다.
  const topInset = Math.max(insets.top, Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0) + spacing.sm;
  const bottomInset = Math.max(insets.bottom, spacing.md);
  const paired = state.device.paired && Boolean(state.liveBridge.deviceToken);

  return (
    <View
      testID="jarvis-mobile-root"
      accessibilityLabel={`JARVIS 모바일 앱, ${paired ? '연결됨' : '연결 필요'}`}
      style={[styles.root, { paddingTop: topInset }]}
    >
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + spacing.xl }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <Text testID="jarvis-mobile-title" accessibilityRole="header" style={styles.title}>
              {isHome ? 'JARVIS' : 'JARVIS 모바일'}
            </Text>
            {isHome ? (
              <View style={[styles.connPill, paired ? styles.connPillOn : styles.connPillOff]}>
                <View style={[styles.connDot, paired ? styles.connDotOn : styles.connDotOff]} />
                <Text style={[styles.connPillText, paired ? styles.connPillTextOn : styles.connPillTextOff]}>
                  {paired ? '연결됨' : '연결 필요'}
                </Text>
              </View>
            ) : null}
          </View>
          <Text
            testID="jarvis-current-route"
            accessibilityLabel={`현재 화면 ${routeMeta[route as keyof typeof routeMeta]?.label ?? '홈'}`}
            style={isHome ? styles.homeSubtitle : styles.currentRoute}
          >
            {isHome ? '무엇을 도와드릴까요?' : `현재 화면: ${route}`}
          </Text>
          {!isHome ? (
            <Text style={styles.routeDescription}>{routeMeta[route as keyof typeof routeMeta]?.description}</Text>
          ) : null}
        </View>

        {!isHome ? <ConnectionStatusBar connected={state.connection.connected} bridgeUrl={state.connection.bridgeUrl} /> : null}

        {!isHome ? <NativeRuntimeProbe /> : null}

        {!isHome ? renderRouteDock() : null}

        {!isHome ? (
          <View style={styles.statusStrip}>
            <DataRow label="paired" value={state.device.paired ? 'yes' : 'no'} tone={state.device.paired ? 'good' : 'warning'} />
            <DataRow label="approval" value={`${state.approvals.items.length} waiting`} tone="warning" />
            <DataRow label="task" value={state.task.current.status} tone={state.task.current.status === 'COMPLETED' ? 'good' : 'neutral'} />
            <DataRow label="notifications" value={`${state.notifications.unreadCount} unread`} />
          </View>
        ) : null}

        {!isHome ? (
          <View style={styles.messageBox}>
            <Text testID="screen-message" style={styles.messageText}>{state.screenMessage}</Text>
          </View>
        ) : null}

        {renderScreen()}

        {!isHome ? (
          <Section title="감사 로그" caption="C 입력은 최종 의사로 기록">
            {state.auditTrail.map((item: any) => (
              <Text key={item.eventId} style={styles.mutedText}>{item.createdAt} · {item.label}</Text>
            ))}
          </Section>
        ) : null}
      </ScrollView>

      {conv.active ? (
        <View testID="conversation-overlay" style={[styles.convOverlay, { paddingTop: topInset + spacing.lg, paddingBottom: bottomInset + spacing.lg }]}>
          <View style={styles.convTopRow}>
            <Text style={styles.convHint}>"종료"라고 말해도 닫혀요</Text>
            <Pressable
              testID="conv-exit-button"
              accessibilityRole="button"
              accessibilityLabel="대화 모드 종료"
              onPress={() => convExit(false)}
              style={styles.convExitButton}
            >
              <X size={16} color={colors.textSecondary} strokeWidth={2.4} />
              <Text style={styles.convExitButtonText}>종료</Text>
            </Pressable>
          </View>

          <Pressable
            testID="conv-orb-area"
            accessibilityRole="button"
            accessibilityLabel={conv.phase === 'speaking' ? '탭해서 말 끊고 말하기' : '대화 상태'}
            onPress={() => { if (conv.phase === 'speaking') stopSpeaking(); }}
            style={styles.convCenter}
          >
            <Animated.View
              style={[
                styles.convOrb,
                conv.phase === 'listening' ? styles.convOrbListening : null,
                conv.phase === 'thinking' ? styles.convOrbThinking : null,
                conv.phase === 'speaking' ? styles.convOrbSpeaking : null,
                { transform: [{ scale: convPulse }] }
              ]}
            />
            <Text style={styles.convStatusText}>
              {conv.phase === 'listening' ? '듣고 있어요' : conv.phase === 'thinking' ? '자비스가 생각하는 중...' : '말하는 중 — 탭하면 끊고 말할 수 있어요'}
            </Text>
            {conv.transcript ? <Text style={styles.convTranscript}>"{conv.transcript}"</Text> : null}
            {home.notice && conv.phase === 'thinking' ? <Text style={styles.convNotice}>{home.notice}</Text> : null}
          </Pressable>

          {home.phase === 'approval' && home.approval ? (
            <View style={styles.convApprovalBox}>
              <Text style={styles.convApprovalTitle}>{home.approval.title}</Text>
              <View style={styles.homeDecideRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="승인"
                  onPress={() => void homeDecide('approve')}
                  style={[styles.homeDecideButton, styles.homeApproveButton]}
                >
                  <Text style={styles.homePrimaryButtonText}>승인</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="거절"
                  onPress={() => void homeDecide('reject')}
                  style={[styles.homeDecideButton, styles.homeRejectButton]}
                >
                  <Text style={styles.homePrimaryButtonText}>거절</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background
  },
  header: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.xs
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  title: {
    color: colors.text,
    fontSize: typography.largeTitle,
    fontWeight: '800',
    letterSpacing: typography.tightTracking
  },
  homeSubtitle: {
    color: colors.muted,
    fontSize: typography.subtitle
  },
  connPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill
  },
  connPillOn: { backgroundColor: colors.successSoft },
  connPillOff: { backgroundColor: colors.warningSoft },
  connDot: { width: 8, height: 8, borderRadius: 4 },
  connDotOn: { backgroundColor: colors.success },
  connDotOff: { backgroundColor: colors.warning },
  connPillText: { fontSize: typography.caption, fontWeight: '700' },
  connPillTextOn: { color: colors.success },
  connPillTextOff: { color: colors.warning },
  homeCard: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    ...shadow.card
  },
  homeCardTitle: {
    color: colors.text,
    fontSize: typography.headline,
    fontWeight: '700',
    letterSpacing: -0.2
  },
  homeHint: {
    color: colors.muted,
    fontSize: typography.callout,
    lineHeight: 21
  },
  homeInput: {
    minHeight: 96,
    padding: spacing.md,
    borderRadius: radius.lg,
    color: colors.text,
    fontSize: typography.subtitle,
    lineHeight: 22,
    textAlignVertical: 'top',
    backgroundColor: colors.surfaceMuted
  },
  homePrimaryButton: {
    minHeight: 54,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    backgroundColor: colors.accent
  },
  homeCardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  homeVoiceToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted
  },
  homeVoiceToggleText: {
    color: colors.muted,
    fontSize: typography.caption,
    fontWeight: '600'
  },
  homeExampleCard: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    ...shadow.card
  },
  homeExampleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  homeExampleHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  homeExampleTitle: {
    color: colors.text,
    fontSize: typography.subtitle,
    fontWeight: '700'
  },
  homeExampleClose: {
    padding: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted
  },
  homeExampleGroup: {
    gap: spacing.sm
  },
  homeExampleBadge: {
    alignSelf: 'flex-start',
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm
  },
  exampleBadge_basic: { backgroundColor: colors.successSoft },
  exampleBadge_mid: { backgroundColor: 'rgba(100,210,255,0.16)' },
  exampleBadge_adv: { backgroundColor: colors.accentSoft },
  homeExampleBadgeText: {
    fontSize: typography.caption,
    fontWeight: '700'
  },
  exampleBadgeText_basic: { color: colors.success },
  exampleBadgeText_mid: { color: colors.info },
  exampleBadgeText_adv: { color: colors.accent },
  homeExampleItems: {
    gap: spacing.xs
  },
  homeExampleItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: 11,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted
  },
  homeExampleItemText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.callout,
    fontWeight: '500'
  },
  homeExampleReopen: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface
  },
  homeExampleReopenText: {
    color: colors.muted,
    fontSize: typography.callout,
    fontWeight: '600'
  },
  homeSuggestCard: {
    gap: spacing.sm,
    paddingHorizontal: spacing.xs
  },
  homeSuggestTitle: {
    color: colors.muted,
    fontSize: typography.caption,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  homeSuggestWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm
  },
  homeSuggestChip: {
    maxWidth: '100%',
    paddingVertical: 9,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surface
  },
  homeSuggestChipText: {
    color: colors.textSecondary,
    fontSize: typography.callout,
    fontWeight: '500'
  },
  homeDoneCard: {
    borderWidth: 1,
    borderColor: colors.successSoft
  },
  homeDoneTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7
  },
  homeDoneCommand: {
    color: colors.muted,
    fontSize: typography.callout,
    fontStyle: 'italic'
  },
  homeDoneFilesBox: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted
  },
  homeDoneLabel: {
    color: colors.muted,
    fontSize: typography.caption,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  homeDoneFile: {
    color: colors.text,
    fontSize: typography.subtitle,
    fontWeight: '600'
  },
  homeDoneWhere: {
    color: colors.muted,
    fontSize: typography.caption
  },
  homeRateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexWrap: 'wrap'
  },
  homeRateLabel: {
    color: colors.muted,
    fontSize: typography.caption,
    marginRight: spacing.xs
  },
  homeRateChip: {
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted
  },
  homeRateChipActive: {
    backgroundColor: colors.accent
  },
  homeRateChipText: {
    color: colors.muted,
    fontSize: typography.caption,
    fontWeight: '600'
  },
  homeRateChipTextActive: {
    color: colors.onAccent,
    fontWeight: '700'
  },
  homeCommandButtonRow: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  homeMicButton: {
    minHeight: 54,
    minWidth: 118,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceMuted
  },
  homeMicButtonActive: {
    backgroundColor: colors.danger
  },
  homeMicButtonText: {
    color: colors.text,
    fontSize: typography.subtitle,
    fontWeight: '700'
  },
  convEnterButton: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: radius.lg,
    backgroundColor: colors.accentSoft
  },
  convEnterButtonText: {
    color: colors.accent,
    fontSize: typography.callout,
    fontWeight: '700'
  },
  convOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
    justifyContent: 'space-between'
  },
  convTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  convHint: {
    color: colors.muted,
    fontSize: typography.caption
  },
  convExitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted
  },
  homeDoneFileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  convExitButtonText: {
    color: colors.textSecondary,
    fontSize: typography.callout,
    fontWeight: '600'
  },
  convCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xl
  },
  convOrb: {
    width: 168,
    height: 168,
    borderRadius: 84,
    backgroundColor: colors.surfaceMuted
  },
  convOrbListening: {
    backgroundColor: colors.accent,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 32,
    elevation: 10
  },
  convOrbThinking: {
    backgroundColor: colors.surfaceMuted
  },
  convOrbSpeaking: {
    backgroundColor: colors.info,
    shadowColor: colors.info,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 28,
    elevation: 10
  },
  convStatusText: {
    color: colors.text,
    fontSize: typography.headline,
    fontWeight: '600',
    textAlign: 'center'
  },
  convTranscript: {
    color: colors.textSecondary,
    fontSize: typography.subtitle,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
    lineHeight: 24
  },
  convNotice: {
    color: colors.accent,
    fontSize: typography.callout,
    textAlign: 'center',
    paddingHorizontal: spacing.lg
  },
  convApprovalBox: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    ...shadow.floating
  },
  convApprovalTitle: {
    color: colors.text,
    fontSize: typography.subtitle,
    fontWeight: '600',
    textAlign: 'center'
  },
  homeSubmitButton: {
    flex: 1
  },
  homeButtonDisabled: {
    opacity: 0.4
  },
  homePrimaryButtonText: {
    color: colors.onAccent,
    fontSize: typography.subtitle,
    fontWeight: '700'
  },
  homeNotice: {
    color: colors.accent,
    fontSize: typography.callout,
    lineHeight: 20
  },
  homeApprovalCard: {
    borderWidth: 1,
    borderColor: colors.accentSoft
  },
  homeClarifyBox: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.warningSoft
  },
  homeClarifyTitle: {
    color: colors.warning,
    fontSize: typography.callout,
    fontWeight: '700'
  },
  homeClarifyQuestion: {
    color: colors.text,
    fontSize: typography.callout,
    lineHeight: 20
  },
  homeClarifyInput: {
    minHeight: 64,
    padding: spacing.md,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: typography.callout,
    textAlignVertical: 'top',
    backgroundColor: colors.surfaceMuted
  },
  homeApprovalTitle: {
    color: colors.text,
    fontSize: typography.subtitle,
    fontWeight: '600'
  },
  homePlanStep: {
    color: colors.muted,
    fontSize: typography.callout,
    lineHeight: 19
  },
  homeDecideRow: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  homeDecideButton: {
    flex: 1,
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: radius.lg
  },
  homeApproveButton: {
    backgroundColor: colors.accent
  },
  homeRejectButton: {
    backgroundColor: colors.danger
  },
  homePath: {
    color: colors.text,
    fontSize: 13
  },
  homeExpertLink: {
    alignItems: 'center',
    paddingVertical: spacing.sm
  },
  homeExpertLinkText: {
    color: colors.muted,
    fontSize: 14
  },
  homeProbeFooter: {
    opacity: 0.55
  },
  content: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl
  },
  currentRoute: {
    color: colors.text,
    fontSize: 15
  },
  routeDescription: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18
  },
  statusStrip: {
    gap: spacing.xs,
    padding: spacing.sm,
    borderColor: colors.line,
    borderWidth: 1,
    backgroundColor: colors.surface
  },
  routeDock: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm
  },
  routeButton: {
    minHeight: 38,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderColor: colors.line,
    borderWidth: 1,
    backgroundColor: colors.surface
  },
  routeButtonActive: {
    borderColor: colors.accent,
    backgroundColor: colors.surfaceMuted
  },
  routeButtonText: {
    color: colors.muted,
    fontSize: 13
  },
  routeButtonTextActive: {
    color: colors.text
  },
  messageBox: {
    padding: spacing.md,
    borderColor: colors.line,
    borderWidth: 1,
    backgroundColor: colors.surfaceMuted
  },
  messageText: {
    color: colors.text,
    lineHeight: 20
  },
  screenStack: {
    gap: spacing.md
  },
  section: {
    gap: spacing.md,
    padding: spacing.md,
    borderColor: colors.line,
    borderWidth: 1,
    backgroundColor: colors.background
  },
  sectionHeader: {
    gap: spacing.xs
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700'
  },
  caption: {
    color: colors.muted,
    fontSize: 12
  },
  bodyText: {
    color: colors.text,
    lineHeight: 21
  },
  mutedText: {
    color: colors.muted,
    lineHeight: 20
  },
  warningText: {
    color: colors.warning,
    lineHeight: 20
  },
  input: {
    color: colors.text,
    borderColor: colors.line,
    borderWidth: 1,
    padding: spacing.md,
    minHeight: 46,
    backgroundColor: colors.surface
  },
  feedbackInput: {
    minHeight: 88,
    textAlignVertical: 'top'
  },
  confirmationPanel: {
    gap: spacing.sm,
    padding: spacing.md,
    borderColor: colors.warning,
    borderWidth: 1,
    backgroundColor: colors.surface
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm
  },
  actionButton: {
    minHeight: 40,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    justifyContent: 'center'
  },
  actionText: {
    fontSize: 13
  },
  dataRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  dataLabel: {
    color: colors.muted,
    fontSize: 12,
    minWidth: 104
  },
  dataValue: {
    flex: 1,
    textAlign: 'right',
    fontSize: 12
  },
  list: {
    gap: spacing.xs
  },
  listItem: {
    color: colors.muted,
    lineHeight: 20
  },
  payloadPreview: {
    padding: spacing.sm,
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    gap: spacing.xs
  },
  payloadTitle: {
    color: colors.text,
    fontWeight: '700'
  },
  compactCard: {
    padding: spacing.sm,
    gap: spacing.xs,
    borderColor: colors.line,
    borderWidth: 1,
    backgroundColor: colors.surface
  },
  approvalRow: {
    padding: spacing.md,
    gap: spacing.sm,
    borderColor: colors.line,
    borderWidth: 1,
    backgroundColor: colors.surface
  },
  expiredRow: {
    borderColor: colors.warning,
    backgroundColor: colors.surfaceMuted
  },
  rowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  cardTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    flexShrink: 1
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700'
  },
  warningBox: {
    padding: spacing.md,
    borderColor: colors.warning,
    borderWidth: 1,
    backgroundColor: colors.surface
  },
  timelineItem: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start'
  },
  timelineMarker: {
    width: 10,
    height: 10,
    marginTop: 5
  },
  timelineContent: {
    flex: 1,
    paddingBottom: spacing.sm,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    gap: spacing.xs
  },
  timelineHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  statusHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md
  },
  progressTrack: {
    height: 8,
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.accent
  }
});
