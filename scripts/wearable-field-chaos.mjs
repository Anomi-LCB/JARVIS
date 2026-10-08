import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createBridgeServer, isAllowedBridgeCorsOrigin } from '../apps/bridge/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import {
  createBrowserBridgeRequester,
  createWearableBrowserVoiceIntent,
  createWearableHudBrowserConfig,
  createWearableHudBrowserSnapshot,
  createWearableQuickCommandPlan,
  createWearableVoiceActionPlan,
  executeWearableVoiceAction,
  pairWearableHudBrowser,
  wearableHudQuickCommands
} from '../apps/wearable-hud/src/browser-client.js';
import {
  analyzeWearableAudioFrames,
  createWearablePhysicalFieldReport,
  evaluateWearablePhysicalFieldReport
} from '../apps/wearable-hud/src/field-lab.js';
import { WearableVoiceSession } from '../apps/wearable-hud/src/voice-session.js';

const defaultReportPath = 'dist/wearable-field-chaos-report.json';
const defaultMarkdownPath = 'dist/wearable-field-chaos-report.md';
const defaultOrigin = 'http://127.0.0.1:4176';

export async function runWearableFieldChaos({
  reportPath = defaultReportPath,
  markdownPath = defaultMarkdownPath,
  burstCount = 8,
  rateLimitPressureCount = 24,
  origin = defaultOrigin,
  now = new Date()
} = {}) {
  const checks = [];
  const addCheck = (checkId, passed, detail = {}) => {
    const entry = {
      checkId,
      status: passed ? 'passed' : 'failed'
    };
    const sanitized = sanitizeDetail(detail);
    for (const [key, value] of Object.entries(sanitized)) {
      entry[key === 'status' ? 'observedStatus' : key] = value;
    }
    checks.push(entry);
    return passed;
  };

  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });

  const voice2Probe = await runVoice2RecoveryProbe();
  addCheck('voice-v2-restarts-after-network-failure-without-content-leak', voice2Probe.recognizerCount >= 2
    && voice2Probe.snapshot.recoverableErrorCount === 1
    && voice2Probe.snapshot.utteranceCount === 1
    && voice2Probe.rawTranscriptPresent === false, {
    recognizerCount: voice2Probe.recognizerCount,
    recoverableErrorCount: voice2Probe.snapshot.recoverableErrorCount,
    utteranceCount: voice2Probe.snapshot.utteranceCount,
    transcriptHash: voice2Probe.transcriptHash
  });

  const clippedSignal = analyzeWearableAudioFrames(
    Array.from({ length: 14 }, () => Float32Array.from({ length: 64 }, () => 1))
  );
  addCheck('microphone-clipping-is-rejected', clippedSignal.status === 'needs-adjustment'
    && clippedSignal.clippingRatio > clippedSignal.thresholds.maximumClippingRatio, {
    clippingRatio: clippedSignal.clippingRatio,
    threshold: clippedSignal.thresholds.maximumClippingRatio
  });

  const unconfirmedFieldGate = evaluateWearablePhysicalFieldReport(createWearablePhysicalFieldReport());
  addCheck('physical-field-gate-never-self-certifies-without-device', unconfirmedFieldGate.status === 'ready-for-physical-device'
    && unconfirmedFieldGate.checks.some((item) => item.checkId === 'physical_device_evidence_present' && item.passed === false), {
    status: unconfirmedFieldGate.status
  });

  const runtime = createAgRuntime({
    env: {
      ...process.env,
      JARVIS_LLM_INTENT: '0',
      JARVIS_LLM_PLANNER: '0',
      JARVIS_LLM_CONTENT: '0'
    }
  });
  const server = createBridgeServer(runtime.bridgeRuntime);
  const address = await listen(server);
  const bridgeUrl = `http://127.0.0.1:${address.port}`;
  const config = createWearableHudBrowserConfig({
    bridgeUrl,
    requestTimeoutMs: 30000,
    pollIntervalMs: 300
  });
  let memoryOnlyToken = '';
  const request = createBrowserBridgeRequester({
    config,
    fetchImpl: fetch,
    tokenProvider: () => memoryOnlyToken
  });

  const confidentialTranscript = '자비스 회의 녹음 시작 token=hidden C:\\Users\\user\\secret\\meeting.txt';
  const rawSecrets = ['token=hidden', 'C:\\Users\\user\\secret\\meeting.txt'];
  let uncaughtError = null;
  let paired = null;
  let quickExecutions = [];
  let pressureExecutions = [];
  let voiceExecution = null;
  let pcRequiredTask = null;
  let approvalExecution = null;
  let offlineSnapshot = null;

  try {
    const health = await request('/health', { auth: false });
    addCheck('bridge-health-ok', health?.status === 'ok' || health?.module === 'D_BRIDGE', {
      status: health?.status ?? null,
      module: health?.module ?? null
    });

    addCheck('cors-origin-localhost-allowed', isAllowedBridgeCorsOrigin(origin), { origin });
    addCheck('cors-origin-public-blocked', isAllowedBridgeCorsOrigin('https://example.com') === false);

    const preflight = await fetch(`${bridgeUrl}/pairing/start`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type'
      }
    });
    addCheck('cors-preflight-local-hud', preflight.status === 204
      && preflight.headers.get('access-control-allow-origin') === origin
      && /authorization/.test(preflight.headers.get('access-control-allow-headers') ?? ''), {
      status: preflight.status,
      allowOrigin: preflight.headers.get('access-control-allow-origin')
    });

    const blockedPreflight = await fetch(`${bridgeUrl}/pairing/start`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'POST'
      }
    });
    addCheck('cors-preflight-public-origin-blocked', blockedPreflight.status === 204
      && blockedPreflight.headers.get('access-control-allow-origin') === null, {
      status: blockedPreflight.status
    });

    const unauthenticatedTask = await request('/tasks', {
      method: 'POST',
      body: { rawText: '웨어러블 무토큰 방어 확인' },
      auth: false
    });
    addCheck('unauthenticated-task-controlled-failure', unauthenticatedTask?.success === false
      && /AUTH|TOKEN|HTTP/.test(String(unauthenticatedTask.error?.code ?? '')), {
      code: unauthenticatedTask?.error?.code ?? null
    });

    paired = await pairWearableHudBrowser({
      request,
      deviceId: 'wearable_field_chaos',
      deviceName: 'JARVIS Wearable Field Chaos'
    });
    memoryOnlyToken = paired.deviceToken ?? '';
    addCheck('wearable-pairing-memory-token-issued', paired.success === true
      && Boolean(memoryOnlyToken)
      && paired.rawBridgeTokenStored === false, {
      stage: paired.stage,
      deviceId: paired.deviceId,
      tokenHash: hashSecret(memoryOnlyToken)
    });

    const initialSnapshot = await createWearableHudBrowserSnapshot({
      config,
      fetchImpl: fetch,
      tokenProvider: () => memoryOnlyToken,
      now
    });
    addCheck('wearable-snapshot-synced-no-token-leak', initialSnapshot.status === 'synced'
      && JSON.stringify(initialSnapshot).includes(memoryOnlyToken) === false
      && initialSnapshot.privacy.rawBridgeTokenStored === false, {
      status: initialSnapshot.status,
      mode: initialSnapshot.frame?.mode,
      pendingApprovals: initialSnapshot.counts?.pendingApprovals ?? 0
    });

    quickExecutions = await runQuickCommandBurst({
      request,
      commands: buildBurstCommands(burstCount)
    });
    addCheck('quick-command-burst-created-tasks', quickExecutions.length === burstCount
      && quickExecutions.every((item) => item.execution.status === 'sent'), {
      attempted: burstCount,
      sent: quickExecutions.filter((item) => item.execution.status === 'sent').length
    });

    const voiceIntent = createWearableBrowserVoiceIntent({ transcript: confidentialTranscript, now });
    const voicePlan = createWearableVoiceActionPlan({
      intent: voiceIntent,
      rawTranscript: confidentialTranscript
    });
    voiceExecution = await executeWearableVoiceAction({
      plan: voicePlan,
      request,
      rawTranscript: confidentialTranscript
    });
    addCheck('voice-command-redacts-and-stages-task', voiceIntent.intentName === 'execute_command'
      && voicePlan.action === 'stage_task'
      && voiceExecution.status === 'sent'
      && rawSecrets.every((secret) => JSON.stringify(voicePlan).includes(secret) === false), {
      intentName: voiceIntent.intentName,
      action: voicePlan.action,
      redactionCount: voiceIntent.privacy?.redactionCount ?? 0,
      taskIdHash: hashSecret(voiceExecution.taskId ?? '')
    });

    pcRequiredTask = await request('/tasks', {
      method: 'POST',
      body: createWearableTaskForChaos('밴드에 전송해'),
      auth: true
    });
    addCheck('pc-required-approval-seeded', pcRequiredTask?.status === 'WAITING_APPROVAL'
      && Boolean(pcRequiredTask.approvalId), {
      taskIdHash: hashSecret(pcRequiredTask?.taskId ?? ''),
      approvalIdHash: hashSecret(pcRequiredTask?.approvalId ?? '')
    });

    const approvalSnapshot = await createWearableHudBrowserSnapshot({
      config,
      fetchImpl: fetch,
      tokenProvider: () => memoryOnlyToken,
      now
    });
    const approvalIntent = createWearableBrowserVoiceIntent({ transcript: '자비스 승인', now });
    const approvalPlan = createWearableVoiceActionPlan({
      intent: approvalIntent,
      approvalState: approvalSnapshot.currentApproval,
      rawTranscript: '자비스 승인'
    });
    approvalExecution = await executeWearableVoiceAction({
      plan: approvalPlan,
      request,
      rawTranscript: '자비스 승인'
    });
    addCheck('high-risk-wearable-approval-routes-to-pc-handoff', approvalSnapshot.currentApproval?.actions?.pcHandoff?.enabled === true
      && approvalPlan.action === 'request_pc_confirmation'
      && approvalExecution.status === 'sent', {
      approvalTone: approvalSnapshot.currentApproval?.tone ?? null,
      approvalRiskTier: approvalSnapshot.currentApproval?.riskTier ?? null,
      action: approvalPlan.action,
      executionStatus: approvalExecution.status,
      errorCode: approvalExecution.errorCode ?? null
    });

    pressureExecutions = await runRateLimitPressure({
      request,
      count: rateLimitPressureCount
    });
    addCheck('rate-limit-pressure-controlled', pressureExecutions.some((item) => item.execution.status === 'failed')
      && pressureExecutions.every((item) => ['sent', 'failed'].includes(item.execution.status)), {
      attempted: pressureExecutions.length,
      sent: pressureExecutions.filter((item) => item.execution.status === 'sent').length,
      failed: pressureExecutions.filter((item) => item.execution.status === 'failed').length
    });

    const offlineConfig = createWearableHudBrowserConfig({
      bridgeUrl: 'http://127.0.0.1:9',
      requestTimeoutMs: 200
    });
    offlineSnapshot = await createWearableHudBrowserSnapshot({
      config: offlineConfig,
      fetchImpl: fetch,
      tokenProvider: () => memoryOnlyToken,
      now
    });
    addCheck('offline-bridge-degrades-without-throwing', offlineSnapshot.status === 'degraded'
      && offlineSnapshot.failures.length >= 1
      && offlineSnapshot.privacy.rawBridgeTokenStored === false, {
      failureCount: offlineSnapshot.failures.length
    });
  } catch (error) {
    uncaughtError = error;
    addCheck('uncaught-error-free', false, { message: error?.message ?? 'unknown' });
  } finally {
    await closeServer(server);
  }

  if (!uncaughtError) addCheck('uncaught-error-free', true);

  const report = {
    reportVersion: 'c-d-wearable-field-chaos-report-v1',
    generatedAt: now.toISOString(),
    bridgeUrlHash: hashSecret(bridgeUrl),
    status: checks.every((item) => item.status === 'passed') ? 'passed' : 'failed',
    summary: {
      checks: checks.length,
      passed: checks.filter((item) => item.status === 'passed').length,
      failed: checks.filter((item) => item.status === 'failed').length,
      quickCommandsAttempted: quickExecutions.length,
      rateLimitPressureAttempted: pressureExecutions.length,
      pcRequiredApprovalSeeded: pcRequiredTask?.status === 'WAITING_APPROVAL',
      paired: paired?.success === true,
      offlineDegraded: offlineSnapshot?.status === 'degraded',
      voice2RecoveryPassed: voice2Probe.recognizerCount >= 2,
      physicalFieldSelfCertified: false,
      rawBridgeTokenStored: false,
      rawTranscriptStored: false
    },
    checks,
    evidence: {
      pairing: paired ? {
        success: paired.success === true,
        stage: paired.stage,
        deviceId: paired.deviceId ?? null,
        tokenHash: hashSecret(memoryOnlyToken),
        rawBridgeTokenStored: false
      } : null,
      quickBurst: quickExecutions.map((item) => ({
        commandHash: hashSecret(item.command),
        action: item.plan.action,
        status: item.execution.status,
        taskIdHash: hashSecret(item.execution.taskId ?? ''),
        errorCode: item.execution.errorCode ?? null
      })),
      voice: voiceExecution ? {
        status: voiceExecution.status,
        action: voiceExecution.action,
        taskIdHash: hashSecret(voiceExecution.taskId ?? ''),
        transcriptRedactionCount: voiceExecution.transcriptRedactionCount,
        errorCode: voiceExecution.errorCode ?? null
      } : null,
      pcRequiredTask: pcRequiredTask ? {
        status: pcRequiredTask.status ?? null,
        taskIdHash: hashSecret(pcRequiredTask.taskId ?? ''),
        approvalIdHash: hashSecret(pcRequiredTask.approvalId ?? ''),
        errorCode: pcRequiredTask.success === false ? pcRequiredTask.error?.code ?? 'WEARABLE_PC_REQUIRED_TASK_FAILED' : null
      } : null,
      approval: approvalExecution ? {
        status: approvalExecution.status,
        action: approvalExecution.action,
        pathHash: hashSecret(approvalExecution.path ?? ''),
        errorCode: approvalExecution.errorCode ?? null
      } : null,
      rateLimitPressure: {
        attempted: pressureExecutions.length,
        sent: pressureExecutions.filter((item) => item.execution.status === 'sent').length,
        failed: pressureExecutions.filter((item) => item.execution.status === 'failed').length
      },
      offline: offlineSnapshot ? {
        status: offlineSnapshot.status,
        failureCount: offlineSnapshot.failures.length,
        rawBridgeTokenStored: false
      } : null,
      voice2Recovery: {
        recognizerCount: voice2Probe.recognizerCount,
        recoverableErrorCount: voice2Probe.snapshot.recoverableErrorCount,
        utteranceCount: voice2Probe.snapshot.utteranceCount,
        transcriptHash: voice2Probe.transcriptHash,
        rawTranscriptStored: false
      },
      physicalFieldGate: {
        status: unconfirmedFieldGate.status,
        selfCertified: false
      }
    }
  };
  report.rawLeakCheck = createRawLeakCheck(report, [memoryOnlyToken, ...rawSecrets]);
  if (report.rawLeakCheck.rawLeakDetected) {
    report.status = 'failed';
    checks.push({
      checkId: 'raw-leak-check',
      status: 'failed',
      leakedKinds: report.rawLeakCheck.leakedKinds
    });
  }

  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  return report;
}

async function runVoice2RecoveryProbe() {
  const recognizers = [];
  let transcriptHash = null;
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
    config: {
      restartBaseDelayMs: 2,
      restartMaxDelayMs: 2,
      endSilenceMs: 2,
      maxUtteranceMs: 1000
    },
    onFinalTranscript: (transcript) => {
      transcriptHash = hashSecret(transcript);
    }
  });
  await session.start();
  recognizers[0].onerror({ error: 'network' });
  recognizers[0].onend();
  await delay(10);
  const finalTranscript = '자비스 상태 확인 token=chaos-voice-secret';
  recognizers.at(-1).onresult({
    resultIndex: 0,
    results: [Object.assign([{ transcript: finalTranscript, confidence: 0.9 }], { isFinal: true })]
  });
  await delay(10);
  const snapshot = session.snapshot();
  const rawTranscriptPresent = JSON.stringify(snapshot).includes('chaos-voice-secret');
  session.destroy();
  return {
    recognizerCount: recognizers.length,
    snapshot,
    transcriptHash,
    rawTranscriptPresent
  };
}

async function runQuickCommandBurst({ request, commands }) {
  return Promise.all(commands.map(async (command) => {
    const plan = createWearableQuickCommandPlan({ command });
    const execution = await executeWearableVoiceAction({
      plan,
      request,
      rawTranscript: command
    });
    return { command, plan, execution };
  }));
}

async function runRateLimitPressure({ request, count }) {
  const results = [];
  for (let index = 0; index < count; index += 1) {
    const command = `연속 압력 테스트 ${String(index + 1).padStart(2, '0')}`;
    const plan = createWearableQuickCommandPlan({ command });
    const execution = await executeWearableVoiceAction({ plan, request, rawTranscript: command });
    results.push({ command, plan, execution });
  }
  return results;
}

function buildBurstCommands(count) {
  return Array.from({ length: count }, (_, index) => {
    const quick = wearableHudQuickCommands[index % wearableHudQuickCommands.length];
    return `${quick.command} ${index + 1}`;
  });
}

function createWearableTaskForChaos(rawText) {
  return { rawText };
}

function sanitizeDetail(detail) {
  return JSON.parse(JSON.stringify(detail, (_key, value) => {
    if (typeof value !== 'string') return value;
    if (value.length > 120) return `${value.slice(0, 117)}...`;
    return value;
  }));
}

function createRawLeakCheck(report, rawValues) {
  const payload = JSON.stringify(report);
  const leakedKinds = rawValues
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value, index) => ({
      kind: index === 0 ? 'device-token' : `secret-${index}`,
      leaked: payload.includes(value)
    }))
    .filter((item) => item.leaked)
    .map((item) => item.kind);
  return {
    checkVersion: 'c-d-wearable-field-chaos-raw-leak-check-v1',
    rawLeakDetected: leakedKinds.length > 0,
    leakedKinds
  };
}

function renderMarkdown(report) {
  return `# JARVIS Wearable Field Chaos

Status: ${report.status}

- Checks: ${report.summary.passed}/${report.summary.checks} passed
- Quick commands attempted: ${report.summary.quickCommandsAttempted}
- Rate-limit pressure attempted: ${report.summary.rateLimitPressureAttempted}
- Pairing: ${report.summary.paired ? 'passed' : 'failed'}
- Offline degradation: ${report.summary.offlineDegraded ? 'passed' : 'failed'}
- Raw leak detected: ${report.rawLeakCheck.rawLeakDetected}

## Checks

${report.checks.map((check) => `- ${check.checkId}: ${check.status}`).join('\n')}
`;
}

function hashSecret(value) {
  if (!value) return null;
  return createHash('sha256').update(String(value)).digest('hex');
}

async function listen(server) {
  return await listenOnFetchSafePort(server);
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseArgs(args) {
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  return {
    reportPath: option('--report', defaultReportPath),
    markdownPath: option('--markdown', defaultMarkdownPath),
    burstCount: Number(option('--burst', 8)),
    rateLimitPressureCount: Number(option('--pressure', 24)),
    origin: option('--origin', defaultOrigin)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runWearableFieldChaos(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS Wearable Field Chaos');
  console.log(`Status: ${report.status}`);
  console.log(`Checks: ${report.summary.passed}/${report.summary.checks}`);
  console.log(`Quick commands: ${report.summary.quickCommandsAttempted}`);
  console.log(`Rate-limit pressure: ${report.summary.rateLimitPressureAttempted}`);
  console.log(`Raw leak detected: ${report.rawLeakCheck.rawLeakDetected}`);
  console.log(`Reports: ${process.argv.includes('--report') ? parseArgs(process.argv.slice(2)).reportPath : defaultReportPath}, ${process.argv.includes('--markdown') ? parseArgs(process.argv.slice(2)).markdownPath : defaultMarkdownPath}`);
}
