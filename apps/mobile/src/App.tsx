import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Linking,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Pressable,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import { createMobileAppShell } from './App.js';
import { BridgeClient, defaultBridgeClientTimeoutMs } from './api/BridgeClient.js';
import { canNavigate, MobileRoutes } from './navigation/routes.js';
import { ConnectionStatusBar } from './components/ConnectionStatusBar';
import { NativeRuntimeProbe } from './components/NativeRuntimeProbe';
import { PairingQrPanel } from './components/PairingQrPanel';
import { CommandComposerPanel } from './components/CommandComposerPanel';
import { ApprovalCardView } from './components/ApprovalCardView';
import { TaskStatusPill } from './components/TaskStatusPill';
import { ResultSummaryCard } from './components/ResultSummaryCard';
import { createResultFileUri } from './components/ResultFeedbackPanel.js';
import { GrowthReviewDecisionPanel } from './components/GrowthReviewDecisionPanel';
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
import { spacing } from './theme/spacing';
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
      <Text style={styles.dataLabel}>{label}</Text>
      <Text style={[styles.dataValue, { color: valueColor }]}>{value}</Text>
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
  const fallback = 'http://127.0.0.1:17777';
  const raw = String(input || fallback).trim().replace(/\/+$/, '');
  try {
    const url = new URL(raw);
    if (Platform.OS === 'android' && ['localhost', '127.0.0.1'].includes(url.hostname)) {
      url.hostname = '10.0.2.2';
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
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

export default function App() {
  const shell = useMemo(() => createMobileAppShell(), []);
  const appStateRef = useRef(AppState.currentState);
  const deepLinkHandlerRef = useRef<(url: string) => boolean>(() => false);
  const [route, setRoute] = useState<string>(MobileRoutes.HomeScreen);
  const [state, setState] = useState<any>(() => createMobileProductState());
  // 홈(가면) 화면 전용 대화 흐름 상태. 명령→승인→실행→결과를 한 화면에서 따라간다.
  const [home, setHome] = useState<any>({
    phase: 'idle',
    text: '',
    taskId: null,
    approval: null,
    taskStatus: null,
    result: null,
    error: null,
    notice: null
  });
  const homeFlowSeq = useRef(0);
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
          error: `SecureStore restore failed: ${errorMessage(error)}`
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
          ? appendAudit(nextState, `Mobile session locked by native AppState ${reason}.`)
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
        updateMessage(`Deep link route opened: ${nextRoute}`);
        return true;
      }
      updateMessage(`Deep link route ignored: ${nextRoute || 'missing'}`);
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
        screenMessage: `Pairing deep link loaded: ${pairingCode ?? 'no-code'}`
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
        updateMessage('Approval deep link ignored: missing approvalId');
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

    updateMessage(`Deep link ignored: ${rawUrl}`);
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
    updateMessage(`D Bridge /health 확인 중: ${effectiveBridgeUrl}`);
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
          ? `D Bridge /health 연결 성공: ${effectiveBridgeUrl}`
          : 'D Bridge가 응답했지만 status=ok가 아닙니다.'
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
        screenMessage: `D Bridge /health 연결 실패: ${message}`
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
    updateMessage(`D Bridge pairing/start 요청 중: ${effectiveBridgeUrl}`);
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
        screenMessage: `D Bridge pairing code 발급: ${result?.pairingCode ?? 'unknown'}`
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
        screenMessage: `pairing/start 실패: ${message}`
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
    updateMessage(`D Bridge pairing/confirm 요청 중: ${pairingCode}`);
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
        screenMessage: '실제 D Bridge 페어링 완료. deviceToken을 SecureStore에 저장했습니다.'
      }, 'Live D Bridge pairing confirmed; token sealed in Expo SecureStore.'), {
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
      screenMessage: '페어링 완료. 이후 요청은 Authorization: Bearer deviceToken 형태로 D Bridge에 전달됩니다.'
    }, 'Pairing confirmed through D Bridge; token sealed in SecureStore.'));
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
        authTokenExists: false,
        tokenStorage: {
          ...current.device.tokenStorage,
          exists: false,
          sealed: false
        }
      },
      screenMessage: revokeError
        ? `로컬 토큰은 제거했습니다. D Bridge revoke는 실패했습니다: ${revokeError}`
        : '기기 연결이 해제되었습니다. D Bridge device revoke와 로컬 토큰 제거가 완료되었습니다.'
    }, revokeError ? 'Device local token removed after revoke failure.' : 'Device revoked through D Bridge and mobile token removed.'), {
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
        screenMessage: '빈 명령은 TaskRequest로 전송하지 않습니다.'
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
      }, 'Offline command queued; auto-send is disabled by C policy.'));
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
        screenMessage: '실제 TaskRequest가 D Bridge /tasks로 전송되었습니다.'
      }, 'Live TaskRequest sent to D Bridge /tasks.'), {
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
        screenMessage: `TaskRequest 전송 실패: ${message}`
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
      updateMessage('승인 목록을 가져오려면 먼저 D Bridge 페어링이 필요합니다.');
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
        screenMessage: `D Bridge /approvals 조회 완료: ${items.length}건`
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
      }, 'Expired approval decision blocked on mobile before D Bridge submit.'));
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
            summary: 'Tier 3 이상 또는 외부 전송 포함 작업은 모바일 단순 승인이 차단됩니다.',
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
      }, 'High-risk mobile approval blocked; PC confirmation required.'));
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
          screenMessage: `ApprovalDecision 전송 실패: ${message}`
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
            ? 'ApprovalDecision이 D Bridge로 전송되어 B 실행 대기열로 넘어갔습니다.'
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
      screenMessage: `${decisionLabels[decision as keyof typeof decisionLabels] ?? decision} 결정이 감사 가능한 ApprovalDecision으로 기록되었습니다.`
    }, `ApprovalDecision ${decision} sent through D Bridge.`));
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
      updateMessage('승인 만료 연장은 D Bridge 페어링 후 사용할 수 있습니다.');
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
      }, 'Expired approval card renewed through D Bridge.'), {
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
      updateMessage('PC 확인 요청은 D Bridge 페어링 후 사용할 수 있습니다.');
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
      }, 'High-risk approval routed to PC confirmation handoff.'), {
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
      }, 'Approval cancelled locally on mobile.'));
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
            summary: 'D Bridge에서 승인 카드 취소가 기록되었습니다.',
            blockedReason: null,
            updatedAt: result.cancelledAt
          }
        },
        screenMessage: '승인 카드가 취소되어 실행으로 넘어가지 않습니다.'
      }, 'Approval cancelled through D Bridge.'), {
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
      updateMessage('새 승인 재요청은 D Bridge 페어링 후 사용할 수 있습니다.');
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
      }, 'Approval re-requested through D Bridge.'), {
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

  function homeSleep(ms: number) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  function homeTaskStatusOf(statusResult: any) {
    return statusResult?.status ?? statusResult?.task?.status ?? null;
  }

  async function homeSubmit() {
    const rawText = String(home.text ?? '').trim();
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
        source: { module: 'C_MOBILE', deviceId: state.device.deviceId, inputMode: 'text' },
        command: { rawText, locale: 'ko-KR' },
        context: { currentScreen: MobileRoutes.HomeScreen, userTimezone: 'Asia/Seoul' }
      };
      // LLM 계획/초안 생성이 수십 초 걸릴 수 있어 홈 제출은 타임아웃을 길게 잡는다.
      const created = await homeClient(120000).createTask(request);
      if (created?.success === false || !created?.taskId) {
        throw new Error(bridgeFailureMessage(created, 'task-create-failed'));
      }
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
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (homeFlowSeq.current !== seq) return;
      try {
        const approvals = await client.getApprovals();
        const card = (approvals?.items ?? []).find((item: any) => (
          item.taskId === taskId && !['cancelled', 'expired', 'decided'].includes(String(item.status ?? 'pending'))
        ));
        if (card) {
          setHome((current: any) => ({ ...current, phase: 'approval', approval: card, notice: null }));
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
      await homeSleep(1500);
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
      setHome((current: any) => ({
        ...current,
        notice: '위험도가 높은 작업이라 모바일 단독 승인이 차단됩니다. PC에서 직접 확인해 주세요.'
      }));
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
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (homeFlowSeq.current !== seq) return;
        const status = homeTaskStatusOf(await client.getTaskStatus(card.taskId).catch(() => null));
        if (['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(String(status))) {
          await homeFinish(card.taskId, String(status), seq);
          return;
        }
        await homeSleep(1500);
      }
      setHome((current: any) => ({
        ...current,
        notice: '실행이 오래 걸리고 있습니다. 잠시 후 전문가 모드의 작업 상태 화면에서 확인할 수 있어요.'
      }));
    } catch (error) {
      setHome((current: any) => ({ ...current, phase: 'approval', notice: null, error: errorMessage(error) }));
    }
  }

  async function homeFinish(taskId: string, status: string, seq: number) {
    let result: any = null;
    try {
      const fetched = await homeClient().getResult(taskId);
      if (fetched?.success !== false && fetched) {
        const execution = fetched.executionResult ?? fetched.execution?.executionResult ?? {};
        result = {
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
      notice: status === 'COMPLETED' ? '작업이 완료되었습니다.' : null,
      error: status === 'COMPLETED' ? null : `작업이 ${status} 상태로 끝났습니다.`
    }));
  }

  function homeReset() {
    homeFlowSeq.current += 1;
    setHome((current: any) => ({
      ...current,
      phase: 'idle',
      text: '',
      taskId: null,
      approval: null,
      taskStatus: null,
      result: null,
      error: null,
      notice: null
    }));
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
    }, 'Task completed by B and verified by G.'));
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
      screenMessage: `${feedbackLabels[feedbackType as keyof typeof feedbackLabels] ?? feedbackType} 피드백을 F 성장형 기억 후보로 전달했습니다.`
    }, `Feedback ${feedbackType} sent to F through D Bridge.`));
  }

  async function previewResultFile(previewId: string, path: string) {
    const uri = createResultFileUri(path);
    let action: any = {
      actionVersion: 'c-native-document-action-v1',
      previewId,
      path,
      uri,
      actionType: 'preview',
      status: 'contract-fallback',
      fallbackUsed: true,
      actedAt: new Date().toISOString()
    };
    try {
      if (uri) {
        await Linking.openURL(uri);
        action = { ...action, status: 'opened', fallbackUsed: false };
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
      screenMessage: action.status === 'opened'
        ? '산출물 미리보기를 네이티브 앱으로 열었습니다.'
        : '네이티브 미리보기를 사용할 수 없어 산출물 경로를 화면에 유지합니다.'
    }, `Result file preview ${action.status}: ${path}`));
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
      screenMessage: '되돌리기 전 B rollback 증거와 변경 항목을 확인하세요.'
    }, 'Result rollback confirmation requested from ResultScreen.'));
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
    }, 'Result rollback confirmation cancelled.'));
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
      screenMessage: '되돌리기 확인이 완료되었습니다. 실제 실행은 D Bridge를 통해 B rollback API로 전달됩니다.'
    }, 'Result rollback confirmed with mobile confirmation panel.'));
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
      screenMessage: '성장 리뷰 결정은 F로 전달되는 사용자 검토 신호입니다. C가 기억 DB를 직접 수정하지는 않습니다.'
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
      screenMessage: '격리 큐 조치는 B 실행 큐에 대한 검토 신호입니다. 모바일이 직접 패킷을 실행하지는 않습니다.'
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
        screenMessage: `${processed}건의 PC Agent 큐 drain 결과를 반영했습니다.`
      }, 'Poison queue drain refresh verified from mobile screen.');
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
      screenMessage: '재시도 정책 변경 요청을 D Bridge를 통해 B queue policy로 보냈습니다.'
    }, 'Queue retry policy update requested from SettingsScreen.'));
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
      screenMessage: '알림 권한이 허용되었습니다. MVP에서는 앱 내부 배지와 로컬 로그를 우선 사용합니다.'
    }, 'Notification permission granted in mobile settings.'));
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
      }, 'Notification receipts verified from SettingsScreen.');
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
    const paired = state.device.paired && Boolean(state.liveBridge.deviceToken);
    const busy = ['submitting', 'waiting-approval', 'deciding', 'executing'].includes(home.phase);
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
          <Text style={styles.homeCardTitle}>무엇을 할까요?</Text>
          <TextInput
            testID="home-command-input"
            value={home.text}
            onChangeText={(value) => setHome((current: any) => ({ ...current, text: value, error: null }))}
            placeholder="예: 주간 정산표 엑셀로 만들어줘"
            placeholderTextColor={colors.muted}
            multiline
            editable={!busy}
            style={styles.homeInput}
          />
          <Pressable
            testID="home-submit-button"
            accessibilityRole="button"
            accessibilityLabel="자비스에게 시키기"
            disabled={busy || !paired}
            onPress={() => void homeSubmit()}
            style={[styles.homePrimaryButton, busy || !paired ? styles.homeButtonDisabled : null]}
          >
            <Text style={styles.homePrimaryButtonText}>{busy ? '자비스가 일하는 중...' : '자비스에게 시키기'}</Text>
          </Pressable>
          {home.notice ? <Text style={styles.homeNotice}>{home.notice}</Text> : null}
          {home.error ? <Text style={styles.warningText}>{home.error}</Text> : null}
        </View>

        {approvalCard ? (
          <View style={[styles.homeCard, styles.homeApprovalCard]}>
            <Text style={styles.homeCardTitle}>이렇게 진행할까요?</Text>
            <Text style={styles.homeApprovalTitle}>{approvalCard.title}</Text>
            {approvalCard.interpretedIntent ? (
              <Text style={styles.homeHint}>{approvalCard.interpretedIntent}</Text>
            ) : null}
            {(approvalCard.planSteps ?? []).slice(0, 3).map((step: string, index: number) => (
              <Text key={`${index}-${step}`} style={styles.homePlanStep}>· {step}</Text>
            ))}
            <View style={styles.homeDecideRow}>
              <Pressable
                testID="home-approve-button"
                accessibilityRole="button"
                accessibilityLabel="승인"
                onPress={() => void homeDecide('approve')}
                style={[styles.homeDecideButton, styles.homeApproveButton]}
              >
                <Text style={styles.homePrimaryButtonText}>승인</Text>
              </Pressable>
              <Pressable
                testID="home-reject-button"
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

        {home.phase === 'done' ? (
          <View style={styles.homeCard}>
            <Text style={styles.homeCardTitle}>
              {home.taskStatus === 'COMPLETED' ? '✅ 완료했습니다' : `결과: ${home.taskStatus ?? '알 수 없음'}`}
            </Text>
            {home.result?.summary ? <Text style={styles.homeHint}>{home.result.summary}</Text> : null}
            {(home.result?.outputPaths ?? []).length ? (
              <Text style={styles.homeHint}>PC에 결과가 저장되어 화면에 열렸습니다.</Text>
            ) : null}
            {(home.result?.outputPaths ?? []).map((path: string) => (
              <Text key={path} style={styles.homePath}>{path.split(/[\\/]/).filter(Boolean).at(-1)}</Text>
            ))}
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
        <Section title="PC Bridge 페어링" caption="Phase C-6">
          <DataRow label="실제 호출 URL" value={effectiveBridgeUrl} />
          <DataRow label="Live Bridge" value={state.connection.connected ? 'connected' : 'not connected'} tone={state.connection.connected ? 'good' : 'warning'} />
          <DataRow label="Token" value={state.liveBridge.deviceTokenPreview ?? 'none'} tone={state.liveBridge.deviceTokenPreview ? 'good' : 'warning'} />
          <View style={styles.buttonRow}>
            <ActionButton testID="bridge-health-button" label={state.liveBridge.loading ? '확인 중' : '/health'} tone="primary" onPress={checkBridgeHealth} disabled={state.liveBridge.loading} />
            <ActionButton testID="pairing-start-button" label="pairing/start" onPress={startLivePairing} disabled={state.liveBridge.loading} />
            <ActionButton testID="pairing-confirm-button" label="pairing/confirm" tone="primary" onPress={() => confirmPairing()} disabled={state.liveBridge.loading} />
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
            placeholder="Bridge URL"
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
            placeholder="Pairing code"
            placeholderTextColor={colors.muted}
            keyboardType="number-pad"
            style={styles.input}
          />
          {state.liveBridge.error ? <Text style={styles.warningText}>Live error: {state.liveBridge.error}</Text> : null}
          {state.liveBridge.lastResponse ? (
            <Text style={styles.mutedText}>
              Last response: {state.liveBridge.lastResponse.status ?? state.liveBridge.lastResponse.module ?? state.liveBridge.lastAction}
            </Text>
          ) : null}
        </Section>

        <Section title="C 안전 원칙" caption="Mobile First, Execution Never">
          <BulletList
            items={[
              'C는 D Bridge와만 통신합니다.',
              'C는 권한 토큰을 직접 생성하지 않습니다.',
              'C는 PC 파일/브라우저를 직접 조작하지 않습니다.',
              'deviceToken은 SecureStore에 sealed 상태로 저장합니다.'
            ]}
          />
        </Section>
      </View>
    );
  }

  function renderCommandScreen() {
    return (
      <View testID="screen-content-CommandScreen" style={styles.screenStack}>
        <Section title="자연어 명령 입력" caption="Phase C-2">
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
              <Text style={styles.payloadTitle}>최근 TaskRequest</Text>
              <Text style={styles.mutedText}>{state.command.lastRequest.requestId}</Text>
              <Text style={styles.mutedText}>{state.command.lastRequest.command.rawText}</Text>
            </View>
          ) : null}
        </Section>

        <Section title="오프라인 큐" caption="Phase C-7">
          <DataRow label="자동 전송" value={state.offline.autoSend ? '허용' : '금지'} tone={state.offline.autoSend ? 'danger' : 'good'} />
          <DataRow label="대기 명령" value={`${state.offline.pending.length}건`} tone={state.offline.pending.length ? 'warning' : 'good'} />
          {state.offline.pending.map((item: any) => (
            <View key={item.localId} style={styles.compactCard}>
              <Text style={styles.cardTitle}>{item.rawText}</Text>
              <Text style={styles.mutedText}>{item.syncStatus} · {item.createdAt}</Text>
            </View>
          ))}
        </Section>

        <Section title="빠른 이동" caption="Approval-centric UX">
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
        <Section title="승인 대기 작업" caption="Phase C-3">
          <DataRow label="대기 카드" value={`${state.approvals.items.length}건`} tone={state.approvals.items.length ? 'warning' : 'good'} />
          <DataRow label="Live source" value={state.connection.connected && state.liveBridge.deviceToken ? 'D Bridge /approvals' : 'local demo state'} />
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
                accessibilityLabel={`approval card ${item.title}`}
                onPress={() => chooseApproval(item.approvalId)}
                style={[styles.approvalRow, expiry.expired ? styles.expiredRow : null]}
              >
                <View style={styles.rowTop}>
                  <Text style={styles.cardTitle}>{item.title}</Text>
                  <Text style={[styles.badgeText, { color: item.riskTier <= 3 || expiry.expired ? colors.warning : colors.accent }]}>
                    {expiry.expired ? 'EXPIRED' : `Tier ${item.riskTier}`}
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
        <Section title="승인 카드 상세" caption="Phase C-4">
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
              <Text style={styles.mutedText}>만료된 결정은 D Bridge로 전송하지 않습니다.</Text>
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

        <Section title="승인 이력" caption="카드 생애주기 timeline" testID="approval-history-timeline">
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
                  {item.actor ? <Text style={styles.mutedText}>actor: {item.actor}</Text> : null}
                  {item.detail ? <Text style={styles.bodyText}>{item.detail}</Text> : null}
                  {item.reason ? <Text style={styles.warningText}>reason: {item.reason}</Text> : null}
                </View>
              </View>
            );
          })}
        </Section>

        <Section title="승인 결정 payload" caption="D Bridge로 전송">
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
        <Section title="작업 진행 상태" caption="Phase C-5">
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
        <Section title="실행 결과" caption="Phase C-5">
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
        <Section title="연결 및 보안" caption="Phase C-1 / C-6">
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
            placeholder="Bridge URL"
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
          {state.liveBridge.error ? <Text style={styles.warningText}>Live error: {state.liveBridge.error}</Text> : null}
          <View style={styles.buttonRow}>
            <ActionButton label={state.liveBridge.loading ? '확인 중' : '연결 테스트'} tone="primary" onPress={checkBridgeHealth} disabled={state.liveBridge.loading} />
            <ActionButton label="페어링 코드 발급" onPress={startLivePairing} disabled={state.liveBridge.loading} />
            <ActionButton label={state.security.locked ? '세션 잠금 해제' : '세션 잠금'} onPress={toggleSessionLock} />
            <ActionButton testID="device-disconnect-button" label="기기 연결 해제" tone="danger" onPress={disconnect} />
          </View>
        </Section>

        <Section title="알림" caption="Phase C-알림 MVP">
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

        <Section title="실행 큐 정책" caption="B queue retry policy">
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
        <Section title="성장 리뷰" caption="Phase C-8 읽기 전용">
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
        <Section title="PC Agent 격리 큐" caption="B/D/C 결합">
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
              accessibilityLabel={`select poison packet ${item.queueId}`}
              onPress={() => setState((current: any) => ({
                ...current,
                poisonQueue: { ...current.poisonQueue, selectedQueueId: item.queueId }
              }))}
              style={styles.compactCard}
            >
              <Text style={styles.cardTitle}>{item.queueId}</Text>
              <Text style={styles.mutedText}>{item.status} · {item.reviewStatus}</Text>
            </TouchableOpacity>
          ))}
        </Section>
      </View>
    );
  }

  function renderScreen() {
    switch (route) {
      case MobileRoutes.HomeScreen:
        return renderHomeScreen();
      case MobileRoutes.PairingScreen:
        return renderPairingScreen();
      case MobileRoutes.CommandScreen:
        return renderCommandScreen();
      case MobileRoutes.ApprovalQueueScreen:
        return renderApprovalQueueScreen();
      case MobileRoutes.ApprovalDetailScreen:
        return renderApprovalDetailScreen();
      case MobileRoutes.TaskStatusScreen:
        return renderTaskStatusScreen();
      case MobileRoutes.ResultScreen:
        return renderResultScreen();
      case MobileRoutes.SettingsScreen:
        return renderSettingsScreen();
      case MobileRoutes.GrowthReviewScreen:
        return renderGrowthReviewScreen();
      case MobileRoutes.PoisonQueueScreen:
        return renderPoisonQueueScreen();
      default:
        return renderCommandScreen();
    }
  }

  function renderRouteDock() {
    return (
      <View testID="route-dock" style={styles.routeDock}>
        <Pressable
          key={MobileRoutes.HomeScreen}
          testID={`route-button-${MobileRoutes.HomeScreen}`}
          accessibilityRole="button"
          accessibilityLabel="navigate to HomeScreen"
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
            accessibilityLabel={`navigate to ${item}`}
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

  const isHome = route === MobileRoutes.HomeScreen;

  return (
    <SafeAreaView testID="jarvis-mobile-root" accessibilityLabel="JARVIS Mobile root" style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text testID="jarvis-mobile-title" accessibilityRole="header" style={styles.title}>
            {isHome ? 'JARVIS' : 'JARVIS Mobile'}
          </Text>
          <Text
            testID="jarvis-current-route"
            accessibilityLabel={`current route ${route}`}
            style={isHome ? styles.homeSubtitle : styles.currentRoute}
          >
            {isHome ? '무엇이든 시키세요' : `현재 화면: ${route}`}
          </Text>
          {!isHome ? (
            <Text style={styles.routeDescription}>{routeMeta[route as keyof typeof routeMeta]?.description}</Text>
          ) : null}
        </View>

        <ConnectionStatusBar connected={state.connection.connected} bridgeUrl={state.connection.bridgeUrl} />

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
        ) : (
          <View style={styles.homeProbeFooter}>
            <NativeRuntimeProbe />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background
  },
  homeSubtitle: {
    color: colors.muted,
    fontSize: 15
  },
  homeCard: {
    gap: spacing.sm,
    padding: spacing.md,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    backgroundColor: colors.surface
  },
  homeCardTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700'
  },
  homeHint: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20
  },
  homeInput: {
    minHeight: 88,
    padding: spacing.sm,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.text,
    fontSize: 17,
    textAlignVertical: 'top',
    backgroundColor: colors.background
  },
  homePrimaryButton: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: colors.accent
  },
  homeButtonDisabled: {
    opacity: 0.45
  },
  homePrimaryButtonText: {
    color: colors.background,
    fontSize: 17,
    fontWeight: '700'
  },
  homeNotice: {
    color: colors.accent,
    fontSize: 14,
    lineHeight: 20
  },
  homeApprovalCard: {
    borderColor: colors.accent
  },
  homeApprovalTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600'
  },
  homePlanStep: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18
  },
  homeDecideRow: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  homeDecideButton: {
    flex: 1,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10
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
    padding: spacing.md,
    gap: spacing.md,
    paddingBottom: spacing.xl
  },
  header: {
    gap: spacing.xs
  },
  title: {
    color: colors.accent,
    fontSize: 26,
    fontWeight: '700'
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
