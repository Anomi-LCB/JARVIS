import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createBridgeServer } from '../apps/bridge/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { listAndroidDevices, resolveAdbCommand } from './mobile-device-smoke.mjs';
import { selectMobileE2EDevice } from './mobile-e2e-install.mjs';

const execFileAsync = promisify(execFile);
const androidPackageName = 'local.eureka.jarvis.e2e';
const androidActivityName = 'local.eureka.jarvis.MainActivity';
const defaultArtifactDir = 'dist/mobile-live-bridge-e2e';
const defaultPort = 0;
const acousticVoiceFixture = '파일 목록 보여줘';
const acousticVoiceConfirmationFixture = '네 맞아요';
const pcVoiceHandoffFixture = '회의 메모 파일을 외부 이메일로 보내줘';
const e2eVoiceFixtureRoute = '/jarvis-e2e-voice.wav';
const e2eVoiceCleanupRoute = '/jarvis-e2e-voice-cleanup';
const androidDisplaySizeCache = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function speakWithWindowsTts(utterance) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Speech',
    '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$voice = $speaker.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | Where-Object { $_.Culture.Name -eq 'ko-KR' } | Select-Object -First 1",
    "if (-not $voice) { throw 'windows-korean-tts-voice-not-installed' }",
    '$speaker.SelectVoice($voice.Name)',
    '$speaker.Rate = -2',
    '$speaker.Volume = 100',
    '$tempBase = [IO.Path]::GetTempFileName()',
    'Remove-Item -LiteralPath $tempBase -Force',
    '$wavePath = "$tempBase.wav"',
    '$format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$speaker.SetOutputToWaveFile($wavePath, $format)',
    '$speaker.Speak($env:JARVIS_ACOUSTIC_UTTERANCE)',
    '$waveBytes = (Get-Item -LiteralPath $wavePath).Length',
    '$speaker.SetOutputToDefaultAudioDevice()',
    '$speaker.Speak($env:JARVIS_ACOUSTIC_UTTERANCE)',
    'Start-Sleep -Milliseconds 650',
    '$speaker.Speak($env:JARVIS_ACOUSTIC_UTTERANCE)',
    '$speaker.Dispose()',
    'Remove-Item -LiteralPath $wavePath -Force',
    '[pscustomobject]@{ voiceName = $voice.Name; waveBytes = $waveBytes } | ConvertTo-Json -Compress'
  ].join('; ');
  let stdout;
  try {
    ({ stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: {
        ...process.env,
        JARVIS_ACOUSTIC_UTTERANCE: String(utterance)
      }
    }));
  } catch (error) {
    const detail = String(error?.stderr ?? error?.stdout ?? error?.message ?? 'unknown-windows-tts-error').trim();
    throw new Error(`windows TTS synthesis failed: ${detail}`);
  }
  const synthesis = JSON.parse(String(stdout).trim());
  return {
    provider: 'windows-system-speech',
    culture: 'ko-KR',
    voiceName: synthesis.voiceName ?? null,
    waveBytes: synthesis.waveBytes ?? 0,
    playCount: 2,
    utteranceSha256: createHash('sha256').update(String(utterance)).digest('hex'),
    rawUtteranceStoredInReport: false,
    synthesizedAudioRetained: false
  };
}

async function createWindowsTtsWaveFixture(outputPath, utterance) {
  await mkdir(dirname(outputPath), { recursive: true });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Speech',
    '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$voice = $speaker.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | Where-Object { $_.Culture.Name -eq 'ko-KR' } | Select-Object -First 1",
    "if (-not $voice) { throw 'windows-korean-tts-voice-not-installed' }",
    '$speaker.SelectVoice($voice.Name)',
    '$speaker.Rate = -2',
    '$speaker.Volume = 100',
    '$format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$speaker.SetOutputToWaveFile($env:JARVIS_VOICE_FIXTURE_PATH, $format)',
    '$speaker.Speak($env:JARVIS_ACOUSTIC_UTTERANCE)',
    '$speaker.Dispose()',
    '$voice.Name'
  ].join('; ');
  let stdout;
  try {
    ({ stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: {
        ...process.env,
        JARVIS_ACOUSTIC_UTTERANCE: String(utterance),
        JARVIS_VOICE_FIXTURE_PATH: outputPath
      }
    }));
  } catch (error) {
    const detail = String(error?.stderr ?? error?.stdout ?? error?.message ?? 'unknown-windows-tts-error').trim();
    throw new Error(`windows TTS fixture synthesis failed: ${detail}`);
  }
  const audio = await readFile(outputPath);
  if (audio.length <= 44 || audio.subarray(0, 4).toString('ascii') !== 'RIFF') {
    throw new Error('windows TTS fixture was not a valid PCM WAV file');
  }
  return {
    provider: 'windows-system-speech-wave-fixture',
    culture: 'ko-KR',
    voiceName: String(stdout).trim() || null,
    waveBytes: audio.length,
    waveSha256: createHash('sha256').update(audio).digest('hex'),
    utteranceSha256: createHash('sha256').update(String(utterance)).digest('hex'),
    sampleRate: 16000,
    bitsPerSample: 16,
    channels: 1,
    syntheticAudio: true,
    rawUserAudioStored: false
  };
}

function createVoiceFixtureServer(initialAudio, initialVariant = 'command') {
  let activeAudio = initialAudio;
  let activeVariant = initialVariant;
  const telemetry = {
    fixtureRequests: 0,
    fixtureRequestsByVariant: {},
    cleanupSignals: 0,
    bytesServed: 0,
    bytesServedByVariant: {}
  };
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === e2eVoiceFixtureRoute) {
      telemetry.fixtureRequests += 1;
      telemetry.fixtureRequestsByVariant[activeVariant] = (telemetry.fixtureRequestsByVariant[activeVariant] ?? 0) + 1;
      telemetry.bytesServed += activeAudio.length;
      telemetry.bytesServedByVariant[activeVariant] = (telemetry.bytesServedByVariant[activeVariant] ?? 0) + activeAudio.length;
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': activeAudio.length,
        'Content-Type': 'audio/wav'
      });
      response.end(activeAudio);
      return;
    }
    if (request.method === 'POST' && url.pathname === e2eVoiceCleanupRoute) {
      telemetry.cleanupSignals += 1;
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    response.writeHead(404, { 'Cache-Control': 'no-store' });
    response.end();
  });
  return {
    server,
    telemetry,
    setAudio(audio, variant) {
      activeAudio = audio;
      activeVariant = variant;
    }
  };
}

function acousticVoiceTaskEvidence(task, { expectedActionType = 'LIST_FILES' } = {}) {
  const inputMode = task?.request?.source?.inputMode ?? null;
  const recognition = task?.request?.metadata?.voiceRecognition ?? null;
  const actionType = task?.intent?.actionType ?? null;
  const recognizedText = String(task?.request?.command?.rawText ?? '').trim();
  if (inputMode !== 'voice') throw new Error('acoustic voice task did not preserve inputMode=voice');
  if (!recognition || recognition.rawAudioStored !== false) {
    throw new Error('acoustic voice task did not preserve privacy-safe recognition evidence');
  }
  const confidence = recognition.confidence ?? null;
  if (confidence !== null && confidence < 0.5) {
    const confirmationCount = Number(recognition.confirmationCount ?? 0);
    const independentEngineCount = Number(recognition.independentEngineCount ?? 0);
    const validRepeatConsensus = recognition.confirmationMode === 'repeat-consensus'
      && (independentEngineCount >= 2 || confirmationCount >= 3);
    const validReadback = recognition.confirmationMode === 'voice-readback'
      && recognition.confirmationReason === 'explicit-affirmation'
      && confirmationCount >= 2
      && typeof recognition.confirmationEngine === 'string'
      && recognition.confirmationEngine.length > 0
      && recognition.confirmationTranscriptStored === false
      && (recognition.confirmationConfidence === null || recognition.confirmationConfidence >= 0.5);
    if (!(validRepeatConsensus || validReadback)) {
      throw new Error('low-confidence voice task did not preserve repeat or readback confirmation evidence');
    }
  }
  if (!recognizedText) throw new Error('acoustic voice recognizer produced an empty final transcript');
  if (expectedActionType === 'LIST_FILES' && actionType !== 'LIST_FILES') {
    throw new Error(`acoustic voice semantic intent mismatch:${actionType ?? 'none'}`);
  }
  if (expectedActionType !== 'LIST_FILES' && actionType !== expectedActionType) {
    throw new Error(`voice semantic intent mismatch:${actionType ?? 'none'} expected:${expectedActionType}`);
  }
  return {
    taskId: task.taskId,
    taskStatus: task.status,
    inputMode,
    actionType,
    recognition: {
      confidence,
      alternativesCount: recognition.alternativesCount ?? null,
      locale: recognition.locale ?? null,
      engine: recognition.engine ?? null,
      confirmationMode: recognition.confirmationMode ?? null,
      confirmationReason: recognition.confirmationReason ?? null,
      confirmationCount: recognition.confirmationCount ?? 0,
      independentEngineCount: recognition.independentEngineCount ?? 0,
      confirmationEngine: recognition.confirmationEngine ?? null,
      confirmationConfidence: recognition.confirmationConfidence ?? null,
      confirmationTranscriptStored: recognition.confirmationTranscriptStored ?? null,
      rawAudioStored: recognition.rawAudioStored,
      alternativesStored: recognition.alternativesStored ?? null
    },
    recognizedTranscriptSha256: createHash('sha256').update(recognizedText).digest('hex'),
    rawVoiceTranscriptStoredInReport: false
  };
}

function acousticDiagnosticFromXml(xml, outputPath) {
  const audioNotDetected = xml.includes('마이크에 음성이 들어오지 않았어요');
  const audioDetectedNoResult = xml.includes('음성은 들었지만 명령으로 인식하지 못했어요');
  const readbackPending = xml.includes('맞으면 네') && xml.includes('아니요');
  const lowConfidenceBlocked = xml.includes('음성 인식이 불확실합니다')
    || xml.includes('음성 신뢰도가 낮습니다')
    || readbackPending;
  const engineSwitched = xml.includes('음성 인식 엔진을 다른 방식으로 전환했어요');
  const engine = xml.match(/content-desc="음성 엔진 ([^"]+)"/)?.[1] ?? null;
  return {
    audioDetected: audioDetectedNoResult || lowConfidenceBlocked ? true : audioNotDetected ? false : null,
    noSemanticResult: audioDetectedNoResult || lowConfidenceBlocked,
    lowConfidenceBlocked,
    readbackPending,
    engineSwitched,
    recognitionEngine: engine,
    diagnosticOutputPath: outputPath,
    rawDiagnosticXmlStoredInReport: false
  };
}

async function runIsolatedVoiceTaskFixture({
  serial,
  packageName,
  artifactDir,
  bridgeRuntime,
  commandText,
  expectedActionType,
  labelPrefix
}) {
  if (packageName !== androidPackageName) {
    throw new Error('file voice fixture requires the isolated E2E package');
  }
  const safeLabel = String(labelPrefix ?? 'isolated-voice').replace(/[^a-zA-Z0-9_.-]/g, '-');
  const commandPath = join(artifactDir, `${safeLabel}-command.wav`);
  const confirmationPath = join(artifactDir, `${safeLabel}-confirmation.wav`);
  let fixtureServer = null;
  let fixtureTelemetry = null;
  let fixtureReverseBinding = null;
  let result = null;
  try {
    const fixture = await createWindowsTtsWaveFixture(commandPath, commandText);
    const confirmationFixture = await createWindowsTtsWaveFixture(
      confirmationPath,
      acousticVoiceConfirmationFixture
    );
    const fixtureAudio = await readFile(commandPath);
    const confirmationAudio = await readFile(confirmationPath);
    const fixtureHttp = createVoiceFixtureServer(fixtureAudio, 'command');
    fixtureServer = fixtureHttp.server;
    fixtureTelemetry = fixtureHttp.telemetry;
    const fixtureAddress = await listen(fixtureServer, { host: '127.0.0.1', port: 0 });
    fixtureReverseBinding = `tcp:${fixtureAddress.port}`;
    await adb(['-s', serial, 'reverse', fixtureReverseBinding, fixtureReverseBinding], { timeout: 15_000 });
    const sourceUrl = `http://127.0.0.1:${fixtureAddress.port}${e2eVoiceFixtureRoute}`;
    const initialTaskIds = new Set(bridgeRuntime.coreFacade.tasks.keys());
    const attempts = [];
    let runtime = null;
    let fixtureVariant = 'command';

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      fixtureHttp.setAudio(
        fixtureVariant === 'confirmation' ? confirmationAudio : fixtureAudio,
        fixtureVariant
      );
      const activation = await openDeepLink(
        serial,
        packageName,
        `jarvis://e2e-voice/transcribe?source=${encodeURIComponent(sourceUrl)}`
      );
      const taskWait = await waitForRuntime(`${safeLabel} task created attempt ${attempt}`, () => (
        [...bridgeRuntime.coreFacade.tasks.values()].find((task) => !initialTaskIds.has(task.taskId)) ?? null
      ), { timeoutMs: 25_000, intervalMs: 500 });
      if (taskWait.matched) {
        runtime = taskWait;
        attempts.push({ attempt, status: 'recognized', fixtureVariant, activation });
        break;
      }
      const diagnostic = await dumpXml(serial, artifactDir, `${safeLabel}-diagnostic-${attempt}`);
      const diagnosticState = acousticDiagnosticFromXml(diagnostic.xml, diagnostic.outputPath);
      attempts.push({
        attempt,
        status: 'no-semantic-result',
        fixtureVariant,
        activation,
        ...diagnosticState
      });
      fixtureVariant = diagnosticState.readbackPending ? 'confirmation' : 'command';
      if (attempt < 3) await delay(900);
    }

    if (!runtime?.matched) throw new Error(`${safeLabel} synthetic voice input produced no semantic task`);
    const taskEvidence = acousticVoiceTaskEvidence(runtime.value, { expectedActionType });
    const approvalScreen = await waitForXml(serial, artifactDir, `${safeLabel}-approval`, (xml) => (
      xml.includes('home-approve-button')
      && xml.includes('home-reject-button')
      && xml.includes('이렇게 진행할까요?')
    ), { timeoutMs: 60_000, intervalMs: 800 });
    if (!approvalScreen.matched) throw new Error(`${safeLabel} task did not reach the approval screen`);
    const cleanupSignal = await waitForRuntime(`${safeLabel} app cache cleanup signal`, () => (
      fixtureTelemetry.cleanupSignals > 0 ? { cleanupSignals: fixtureTelemetry.cleanupSignals } : null
    ), { timeoutMs: 10_000, intervalMs: 250 });
    if (!cleanupSignal.matched) throw new Error(`${safeLabel} app cache cleanup was not confirmed`);

    result = {
      fixture,
      confirmationFixture,
      attempts,
      maxAttempts: 3,
      sourceTransport: 'adb-reverse-http-to-app-cache',
      ...taskEvidence,
      approvalScreen,
      cleanupSignal: cleanupSignal.value,
      transcriptTaskCreated: true,
      voiceTransport: 'synthetic-file-audio-source',
      fixedIsolatedRoute: true,
      externalDeviceFixtureCreated: false,
      rawUserAudioStored: false,
      rawVoiceTranscriptStored: false,
      rawCommandStoredInReport: false
    };
  } finally {
    if (fixtureReverseBinding) {
      await adb(['-s', serial, 'reverse', '--remove', fixtureReverseBinding], { timeout: 10_000 }).catch(() => null);
    }
    if (fixtureServer) await close(fixtureServer).catch(() => undefined);
    await rm(commandPath, { force: true }).catch(() => undefined);
    await rm(confirmationPath, { force: true }).catch(() => undefined);
    if (result) {
      result.fixtureTelemetry = {
        fixtureRequests: fixtureTelemetry?.fixtureRequests ?? 0,
        fixtureRequestsByVariant: fixtureTelemetry?.fixtureRequestsByVariant ?? {},
        cleanupSignals: fixtureTelemetry?.cleanupSignals ?? 0,
        bytesServed: fixtureTelemetry?.bytesServed ?? 0,
        bytesServedByVariant: fixtureTelemetry?.bytesServedByVariant ?? {},
        appCacheCleanupSignalVerified: (fixtureTelemetry?.cleanupSignals ?? 0) > 0,
        sourceReverseRemoved: fixtureReverseBinding !== null,
        sourceServerClosed: fixtureServer !== null,
        localFixtureDeleted: true,
        localConfirmationFixtureDeleted: true,
        syntheticFixtureRetained: false
      };
    }
  }
  return result;
}

function sanitizeSerial(serial) {
  return String(serial).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export function androidUiPackage(xml) {
  return parseNodes(xml).map((node) => node.attrs.package).find(Boolean) ?? null;
}

export function parseAndroidFocusedPackage(output) {
  const match = String(output ?? '').match(/\bu\d+\s+([a-zA-Z0-9._]+)\/[a-zA-Z0-9.$_]+/);
  return match?.[1] ?? null;
}

export function hasActiveAndroidTouchState(output) {
  const text = String(output ?? '');
  if (!text.includes('TouchStatesByDisplay:')) return false;
  return !/TouchStatesByDisplay:\s*<no displays touched>/i.test(text);
}

function hasHomeConnectionState(xml, state) {
  const label = state === 'connected' ? '연결됨' : '연결 필요';
  return xml.includes(`content-desc="JARVIS 모바일 앱, ${label}"`)
    || xml.includes(`text="${label}"`)
    || xml.includes(`content-desc="${label}"`);
}

export function isUnpairedHomeScreen(xml) {
  const pairingCode = findNodeByResourceId(xml, 'home-pairing-code-input');
  const pairingCodeText = String(pairingCode?.attrs.text ?? '');
  const pairingCodeHint = String(pairingCode?.attrs.hint ?? '');
  const pairingCodeIsEmpty = pairingCodeText === '' || pairingCodeText === pairingCodeHint;
  return xml.includes('screen-content-HomeScreen')
    && xml.includes('home-bridge-url-input')
    && xml.includes('home-pairing-code-input')
    && xml.includes('home-pair-button')
    && pairingCodeIsEmpty
    && hasHomeConnectionState(xml, 'unpaired');
}

export function isPairedHomeScreen(xml) {
  const commandSurfaceReady = xml.includes('screen-content-HomeScreen')
    && xml.includes('home-command-input')
    && xml.includes('home-submit-button');
  const pairingSurfaceGone = !xml.includes('home-bridge-url-input')
    && !xml.includes('home-pairing-code-input')
    && !xml.includes('home-pair-button');
  return commandSurfaceReady && pairingSurfaceGone && hasHomeConnectionState(xml, 'connected');
}

async function adb(args, options = {}) {
  const adbResolution = options.adbResolution ?? await resolveAdbCommand();
  return execFileAsync(adbResolution.command, args, {
    windowsHide: true,
    timeout: options.timeout ?? 9000,
    maxBuffer: options.maxBuffer ?? 12 * 1024 * 1024,
    encoding: options.encoding ?? 'utf8'
  });
}

async function shell(serial, command, options = {}) {
  try {
    const { stdout } = await adb(['-s', serial, 'shell', command], options);
    return String(stdout).trim();
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout).trim() : '';
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    const details = [error.message, stdout && `stdout: ${stdout}`, stderr && `stderr: ${stderr}`]
      .filter(Boolean)
      .join('\n');
    throw new Error(details);
  }
}

async function collapseSystemOverlays(serial) {
  await shell(serial, 'cmd statusbar collapse', { timeout: 5000 }).catch(() => '');
}

async function readFocusedPackage(serial) {
  const output = await shell(
    serial,
    'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"',
    { timeout: 10000 }
  ).catch(() => '');
  return {
    packageName: parseAndroidFocusedPackage(output),
    output
  };
}

async function bringAppToForeground(serial, packageName, activityName) {
  await collapseSystemOverlays(serial);
  const before = await readFocusedPackage(serial);
  if (before.packageName === packageName) {
    return { recovered: false, before: before.packageName, after: before.packageName, output: null };
  }
  const output = await shell(
    serial,
    `am start -W -n ${packageName}/${activityName}`,
    { timeout: 45000 }
  );
  await delay(900);
  await collapseSystemOverlays(serial);
  const after = await readFocusedPackage(serial);
  return {
    recovered: after.packageName === packageName,
    before: before.packageName,
    after: after.packageName,
    output: String(output).slice(0, 2000)
  };
}

async function recoverStaleAndroidTouchState(serial) {
  const first = await shell(serial, 'dumpsys input', { timeout: 15000 }).catch(() => '');
  if (!hasActiveAndroidTouchState(first)) {
    return { detected: false, recovered: false };
  }
  await delay(900);
  const confirmed = await shell(serial, 'dumpsys input', { timeout: 15000 }).catch(() => '');
  if (!hasActiveAndroidTouchState(confirmed)) {
    return { detected: true, recovered: true, method: 'settled-without-reset' };
  }
  await shell(serial, 'input keyevent KEYCODE_SLEEP', { timeout: 5000 }).catch(() => '');
  await delay(1200);
  await shell(serial, 'input keyevent KEYCODE_WAKEUP', { timeout: 5000 }).catch(() => '');
  await delay(700);
  await shell(serial, 'wm dismiss-keyguard', { timeout: 5000 }).catch(() => '');
  await collapseSystemOverlays(serial);
  const finalState = await shell(serial, 'dumpsys input', { timeout: 15000 }).catch(() => '');
  return {
    detected: true,
    recovered: !hasActiveAndroidTouchState(finalState),
    method: 'display-sleep-wake-cycle'
  };
}

async function prepareInteractiveDevice(serial) {
  const previousStayOnSetting = await shell(serial, 'settings get global stay_on_while_plugged_in').catch(() => '0');
  await shell(serial, 'svc power stayon usb');
  await shell(serial, 'input keyevent KEYCODE_WAKEUP');
  await delay(500);
  await shell(serial, 'wm dismiss-keyguard').catch(() => '');
  await collapseSystemOverlays(serial);
  await delay(700);
  let power = await shell(serial, 'dumpsys power');
  if (!/mWakefulness=Awake/i.test(power)) {
    await shell(serial, 'input keyevent KEYCODE_WAKEUP');
    await delay(700);
    power = await shell(serial, 'dumpsys power');
  }
  if (!/mWakefulness=Awake/i.test(power)) {
    throw new Error('android-device-screen-not-interactive');
  }
  const staleTouch = await recoverStaleAndroidTouchState(serial);
  if (staleTouch.detected && !staleTouch.recovered) {
    throw new Error('android-stale-touch-state-not-recovered');
  }
  return {
    previousStayOnSetting,
    wakefulness: 'Awake',
    temporaryStayAwake: true,
    staleTouch
  };
}

async function restoreInteractiveDevice(serial, previousStayOnSetting) {
  const normalized = String(previousStayOnSetting ?? '').trim();
  if (/^\d+$/.test(normalized)) {
    await shell(serial, `settings put global stay_on_while_plugged_in ${normalized}`).catch(() => '');
    return;
  }
  await shell(serial, 'settings delete global stay_on_while_plugged_in').catch(() => '');
}

async function readUiXml(serial) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const dumpOutput = await shell(serial, 'uiautomator dump /sdcard/jarvis-live-e2e-window.xml', { timeout: 30000 });
      if (/ERROR:|null root node/i.test(dumpOutput)) throw new Error(dumpOutput);
      const { stdout } = await adb(['-s', serial, 'exec-out', 'cat', '/sdcard/jarvis-live-e2e-window.xml'], {
        timeout: 12000,
        maxBuffer: 12 * 1024 * 1024
      });
      if (String(stdout).includes('<hierarchy')) return stdout;
      lastError = new Error('uiautomator dump did not contain a hierarchy document');
    } catch (error) {
      lastError = error;
    }
    await delay(700 + attempt * 300);
  }
  throw lastError ?? new Error('uiautomator dump failed');
}

async function captureScreenshot(serial, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  const { stdout } = await adb(
    ['-s', serial, 'exec-out', 'screencap', '-p'],
    { encoding: 'buffer', timeout: 10000, maxBuffer: 16 * 1024 * 1024 }
  );
  const png = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  await writeFile(outputPath, png);
  return {
    outputPath,
    bytes: png.length,
    hasPngHeader: png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47
  };
}

function parseBounds(value = '') {
  const match = value.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  return {
    left,
    top,
    right,
    bottom,
    centerX: Math.round((left + right) / 2),
    centerY: Math.round((top + bottom) / 2)
  };
}

function parseNodes(xml) {
  return [...xml.matchAll(/<node\b[^>]*>/g)].map((match) => {
    const tag = match[0];
    const attrs = {};
    for (const attr of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs[attr[1]] = attr[2];
    }
    return {
      tag,
      attrs,
      bounds: parseBounds(attrs.bounds)
    };
  });
}

function resourceIdMatches(actual, expected) {
  if (!actual) return false;
  return actual === expected || actual.endsWith(`/${expected}`) || actual.endsWith(`:id/${expected}`);
}

function findNodeByResourceId(xml, resourceId) {
  return parseNodes(xml).find((node) => node.bounds && resourceIdMatches(node.attrs['resource-id'], resourceId)) ?? null;
}

function findNodeByResourcePrefix(xml, resourcePrefix) {
  return parseNodes(xml).find((node) => {
    const resourceId = node.attrs['resource-id'] ?? '';
    return node.bounds && (resourceId.startsWith(resourcePrefix) || resourceId.includes(`/${resourcePrefix}`) || resourceId.includes(`:id/${resourcePrefix}`));
  }) ?? null;
}

function findSystemWaitNode(xml) {
  return parseNodes(xml).find((node) => (
    node.bounds
    && (
      resourceIdMatches(node.attrs['resource-id'], 'android:id/aerr_wait')
      || node.attrs.text === 'Wait'
    )
  )) ?? null;
}

function findUnintentionalTouchFilter(xml) {
  if (!xml.includes('com.android.systemui')) return null;
  const title = findNodeByResourceId(xml, 'unintentional_title');
  const dragHint = findNodeByResourceId(xml, 'unintentional_drag_to_unlock');
  const ring = findNodeByResourceId(xml, 'locker_image_ring')
    ?? findNodeByResourceId(xml, 'locker_img_view');
  if (!title || !dragHint) return null;
  const screen = parseNodes(xml)[0]?.bounds ?? null;
  return { title, dragHint, ring, screen };
}

async function dismissUnintentionalTouchFilter(serial, filter) {
  const screen = filter?.screen;
  const startX = filter?.ring?.bounds?.centerX ?? screen?.centerX ?? 360;
  const startY = filter?.ring?.bounds?.centerY ?? Math.round((screen?.bottom ?? 1544) * 0.68);
  const endY = Math.max(120, Math.round((screen?.bottom ?? 1544) * 0.18));
  await shell(serial, `input touchscreen swipe ${startX} ${startY} ${startX} ${endY} 750`).catch(async () => {
    await shell(serial, `input swipe ${startX} ${startY} ${startX} ${endY} 750`).catch(() => '');
  });
  await delay(1400);
}

async function dumpXml(serial, artifactDir, name, {
  packageName = androidPackageName,
  activityName = androidActivityName,
  recoverForeground = true
} = {}) {
  let xml = null;
  const systemRecoveries = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    xml = await readUiXml(serial);
    const touchFilter = findUnintentionalTouchFilter(xml);
    if (touchFilter) {
      const filterPath = join(
        artifactDir,
        `${sanitizeSerial(serial)}-${name}-unintentional-touch-filter-${attempt}.xml`
      );
      await writeFile(filterPath, xml, 'utf8');
      await dismissUnintentionalTouchFilter(serial, touchFilter);
      await delay(500);
      systemRecoveries.push({
        type: 'android-unintentional-touch-filter',
        dismissed: true,
        evidencePath: filterPath
      });
      continue;
    }
    const waitNode = findSystemWaitNode(xml);
    if (waitNode?.bounds) {
      const dialogPath = join(artifactDir, `${sanitizeSerial(serial)}-${name}-system-dialog-${attempt}.xml`);
      await writeFile(dialogPath, xml, 'utf8');
      await tapAt(serial, waitNode.bounds).catch(() => '');
      await delay(1500);
      systemRecoveries.push({ type: 'android-system-wait-dialog', dismissed: true, evidencePath: dialogPath });
      continue;
    }
    const observedPackage = androidUiPackage(xml);
    if (recoverForeground && observedPackage !== packageName) {
      const unexpectedPath = join(
        artifactDir,
        `${sanitizeSerial(serial)}-${name}-unexpected-foreground-${attempt}.xml`
      );
      await writeFile(unexpectedPath, xml, 'utf8');
      const foreground = await bringAppToForeground(serial, packageName, activityName);
      systemRecoveries.push({
        type: 'android-foreground-app',
        expectedPackage: packageName,
        observedPackage,
        ...foreground,
        evidencePath: unexpectedPath
      });
      if (!foreground.recovered) {
        await delay(500);
      }
      continue;
    }
    break;
  }
  if (!xml) throw new Error('android-ui-document-unavailable');
  const finalPackage = androidUiPackage(xml);
  if (recoverForeground && finalPackage !== packageName) {
    throw new Error(`android-foreground-recovery-failed:${finalPackage ?? 'unknown'}`);
  }
  const outputPath = join(artifactDir, `${sanitizeSerial(serial)}-${name}.xml`);
  await writeFile(outputPath, xml, 'utf8');
  return { xml, outputPath, systemRecoveries };
}

export function parseAndroidDisplaySize(output) {
  const matches = [...String(output ?? '').matchAll(/(?:Physical|Override)\s+size:\s*(\d+)\s*x\s*(\d+)/gi)];
  const match = matches.at(-1);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || height < 100) return null;
  return { width, height };
}

export function computeAndroidScrollGesture(displaySize, direction = 'down') {
  const width = Number(displaySize?.width);
  const height = Number(displaySize?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) {
    throw new Error('android-display-size-invalid');
  }
  const x = Math.min(width - 2, Math.max(2, Math.round(width * 0.75)));
  const upperY = Math.min(height - 2, Math.max(2, Math.round(height * 0.3)));
  const lowerY = Math.min(height - 2, Math.max(2, Math.round(height * 0.78)));
  const upward = direction === 'up';
  return {
    startX: x,
    startY: upward ? upperY : lowerY,
    endX: x,
    endY: upward ? lowerY : upperY,
    durationMs: 450
  };
}

async function readAndroidDisplaySize(serial) {
  if (androidDisplaySizeCache.has(serial)) return androidDisplaySizeCache.get(serial);
  const output = await shell(serial, 'wm size', { timeout: 5000 });
  const displaySize = parseAndroidDisplaySize(output);
  if (!displaySize) throw new Error('android-display-size-unavailable');
  androidDisplaySizeCache.set(serial, displaySize);
  return displaySize;
}

async function scroll(serial, direction = 'down') {
  const displaySize = await readAndroidDisplaySize(serial);
  const gesture = computeAndroidScrollGesture(displaySize, direction);
  const coordinates = `${gesture.startX} ${gesture.startY} ${gesture.endX} ${gesture.endY} ${gesture.durationMs}`;
  await shell(serial, `input touchscreen swipe ${coordinates}`).catch(async () => {
    await shell(serial, `input swipe ${coordinates}`).catch(() => '');
  });
  await delay(450);
}

async function scrollToTop(serial, artifactDir, {
  packageName = androidPackageName,
  activityName = androidActivityName,
  predicate = (xml) => xml.includes('jarvis-mobile-title'),
  maxAttempts = 8
} = {}) {
  let latest = null;
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    latest = await dumpXml(serial, artifactDir, `scroll-top-${Date.now()}-${attempt}`, {
      packageName,
      activityName
    });
    if (predicate(latest.xml)) {
      return {
        matched: true,
        attempts: attempt,
        outputPath: latest.outputPath,
        systemRecoveries: latest.systemRecoveries
      };
    }
    if (attempt < maxAttempts) await scroll(serial, 'up');
  }
  return {
    matched: false,
    attempts: maxAttempts,
    outputPath: latest?.outputPath ?? null,
    systemRecoveries: latest?.systemRecoveries ?? []
  };
}

async function tapNode(serial, artifactDir, {
  resourceId,
  resourcePrefix,
  label,
  maxScrolls = 8,
  packageName = androidPackageName,
  activityName = androidActivityName
}) {
  for (let attempt = 0; attempt <= maxScrolls; attempt += 1) {
    const { xml, outputPath, systemRecoveries } = await dumpXml(
      serial,
      artifactDir,
      `tap-${label}-attempt-${attempt}`,
      { packageName, activityName }
    );
    const node = resourceId
      ? findNodeByResourceId(xml, resourceId)
      : findNodeByResourcePrefix(xml, resourcePrefix);
    if (node?.bounds) {
      const foreground = await bringAppToForeground(serial, packageName, activityName);
      if (!foreground.recovered && foreground.after !== packageName) {
        throw new Error(`android-input-target-not-foreground:${foreground.after ?? 'unknown'}`);
      }
      await tapAt(serial, node.bounds);
      await delay(900);
      return {
        tapped: true,
        label,
        resourceId: node.attrs['resource-id'],
        text: node.attrs.text ?? null,
        bounds: node.bounds,
        outputPath,
        foreground,
        systemRecoveries
      };
    }
    await scroll(serial, 'down');
  }
  throw new Error(`UI node not found for ${label}`);
}

async function tapAt(serial, bounds) {
  try {
    await shell(serial, `input touchscreen tap ${bounds.centerX} ${bounds.centerY}`);
  } catch {
    await shell(serial, `input tap ${bounds.centerX} ${bounds.centerY}`);
  }
}

async function enterHomeCommand(serial, packageName, artifactDir, value, activityName = androidActivityName) {
  const activation = await tapNode(serial, artifactDir, {
    resourceId: 'home-command-input',
    label: 'home-command-input',
    maxScrolls: 1,
    packageName,
    activityName
  });
  const encoded = String(value).replaceAll(' ', '%s');
  await shell(serial, `input text "${encoded}"`, { timeout: 10000 });
  await delay(500);
  const evidence = await dumpXml(serial, artifactDir, 'home-command-entered', { packageName, activityName });
  if (!evidence.xml.includes(`text="${value}"`)) {
    if (packageName !== androidPackageName) {
      throw new Error('home command input did not contain the E2E fixture text');
    }
    return {
      activation: {
        ...activation,
        activationTransport: 'adb-shell-text',
        physicalInputAccepted: false
      },
      entered: false,
      fixtureCommandHash: createHash('sha256').update(value).digest('hex'),
      rawCommandStoredInReport: false,
      outputPath: evidence.outputPath
    };
  }
  return {
    activation: {
      ...activation,
      activationTransport: 'adb-shell-text',
      physicalInputAccepted: true
    },
    entered: true,
    fixtureCommandHash: createHash('sha256').update(value).digest('hex'),
    rawCommandStoredInReport: false,
    outputPath: evidence.outputPath
  };
}

async function waitForXml(serial, artifactDir, label, predicate, {
  timeoutMs = 12_000,
  intervalMs = 700,
  packageName = androidPackageName,
  activityName = androidActivityName
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  const systemRecoveries = [];
  while (Date.now() < deadline) {
    latest = await dumpXml(serial, artifactDir, `wait-${label}-${Date.now()}`, {
      packageName,
      activityName
    });
    systemRecoveries.push(...(latest.systemRecoveries ?? []));
    if (predicate(latest.xml)) {
      return {
        matched: true,
        label,
        outputPath: latest.outputPath,
        systemRecoveries
      };
    }
    await delay(intervalMs);
  }
  return {
    matched: false,
    label,
    outputPath: latest?.outputPath ?? null,
    systemRecoveries
  };
}

function isHomeVoiceStarting(xml) {
  return xml.includes('content-desc="음성 인식 준비 중"') || xml.includes('text="준비 중"');
}

function isHomeVoiceListening(xml) {
  return xml.includes('content-desc="음성 인식 중지"') || xml.includes('content-desc="음성 감지됨"');
}

function isHomeVoiceIdle(xml) {
  return xml.includes('content-desc="말로 시키기"') || xml.includes('text="음성입력"');
}

async function setHomeVoiceInputState(serial, packageName, artifactDir, {
  listening,
  label,
  maxScrolls = 3,
  activityName = androidActivityName
}) {
  const targetPredicate = listening ? isHomeVoiceListening : isHomeVoiceIdle;
  const initial = await dumpXml(serial, artifactDir, `${label}-initial`, { packageName, activityName });
  if (targetPredicate(initial.xml)) {
    return {
      activation: {
        activationTransport: 'state-already-satisfied',
        physicalTapAccepted: null,
        isolatedFallbackUsed: false,
        outputPath: initial.outputPath
      },
      state: {
        matched: true,
        label,
        outputPath: initial.outputPath,
        systemRecoveries: initial.systemRecoveries ?? []
      }
    };
  }

  const touchActivation = await tapNode(serial, artifactDir, {
    resourceId: 'home-mic-button',
    label: `${label}-touch`,
    maxScrolls,
    packageName,
    activityName
  });
  const touchProbe = await waitForXml(
    serial,
    artifactDir,
    `${label}-touch-probe`,
    listening ? (xml) => isHomeVoiceStarting(xml) || isHomeVoiceListening(xml) : isHomeVoiceIdle,
    { timeoutMs: 2800, intervalMs: 300, packageName, activityName }
  );

  let activation = {
    ...touchActivation,
    activationTransport: 'adb-shell-touch',
    physicalTapAccepted: touchProbe.matched,
    isolatedFallbackUsed: false,
    touchProbe
  };

  if (!touchProbe.matched && packageName === androidPackageName) {
    const deepLinkActivation = await openDeepLink(
      serial,
      packageName,
      `jarvis://e2e-voice/${listening ? 'start' : 'stop'}`
    );
    activation = {
      ...activation,
      activationTransport: 'isolated-e2e-deep-link',
      physicalTapAccepted: false,
      isolatedFallbackUsed: true,
      deepLinkActivation
    };
  }

  const state = await waitForXml(
    serial,
    artifactDir,
    label,
    targetPredicate,
    { timeoutMs: listening ? 20_000 : 12_000, intervalMs: 350, packageName, activityName }
  );
  return { activation, state };
}

async function waitForRuntime(label, predicate, { timeoutMs = 10_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return { matched: true, label, value };
    await delay(intervalMs);
  }
  return { matched: false, label, value: predicate() };
}

function runtimeSnapshot(bridgeRuntime) {
  const tasks = [...bridgeRuntime.coreFacade.tasks.values()].map((task) => ({
    taskId: task.taskId,
    status: task.status,
    approvalId: task.approvalCard?.approvalId ?? null,
    riskTier: task.approvalCard?.riskTier ?? null
  }));
  const cache = bridgeRuntime.stateCache.snapshot();
  return {
    health: bridgeRuntime.health(),
    execution: {
      realExecutionEnabled: bridgeRuntime.realExecutionEnabled === true,
      orchestrationWorkerAttached: Boolean(bridgeRuntime.orchestrationWorker)
    },
    devices: bridgeRuntime.registry.list(),
    cache: {
      persistence: cache.persistence,
      taskCount: cache.tasks?.length ?? 0,
      resultCount: cache.results?.length ?? 0,
      requestIdCount: cache.requestIds?.length ?? 0,
      rawTaskBodiesStoredInReport: false
    },
    tasks,
    events: bridgeRuntime.eventRelay.status()
  };
}

async function listen(server, { host, port }) {
  return await listenOnFetchSafePort(server, { host, port });
}

async function openDeepLink(serial, packageName, url) {
  const output = await shell(
    serial,
    `am start -W -a android.intent.action.VIEW -d "${url}" ${packageName}`,
    { timeout: 45000 }
  );
  await delay(900);
  return {
    route: new URL(url).hostname,
    containsPairingCode: new URL(url).searchParams.has('code'),
    success: /Status:\s*ok|Complete|Warning: Activity not started/i.test(output) && !/Error:/i.test(output),
    rawDeepLinkStored: false,
    rawCommandOutputStored: false
  };
}

async function close(server, { timeoutMs = 5000 } = {}) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, timeoutMs);
    timer.unref?.();
    server.close((error) => finish(error));
    server.closeIdleConnections?.();
    setTimeout(() => server.closeAllConnections?.(), 250).unref?.();
  });
}

async function launchApp(serial, packageName, { clearData = false, launchWaitMs = 5000, activityName = androidActivityName } = {}) {
  await shell(serial, `am force-stop ${packageName}`).catch(() => '');
  await collapseSystemOverlays(serial);
  let dataClear = { requested: clearData, verified: false, output: null };
  if (clearData) {
    const clearOutput = await shell(serial, `pm clear ${packageName}`, { timeout: 30000 });
    dataClear = {
      requested: true,
      verified: /^Success$/im.test(clearOutput),
      output: String(clearOutput).slice(0, 500)
    };
    if (!dataClear.verified) {
      throw new Error(`android-app-data-clear-not-verified:${clearOutput || 'empty-output'}`);
    }
  }
  try {
    const output = await shell(serial, `am start -W -n ${packageName}/${activityName}`, { timeout: 45000 });
    await delay(launchWaitMs);
    await collapseSystemOverlays(serial);
    const focused = await readFocusedPackage(serial);
    return {
      output,
      method: 'am-start-wait',
      success: /Status:\s*ok|Complete/i.test(output) && !/Error:/i.test(output),
      dataClear,
      focusedPackage: focused.packageName
    };
  } catch (error) {
    const explicitError = error.code ?? error.message;
    const monkeyOutput = await shell(serial, `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 }).catch((fallbackError) => String(fallbackError.code ?? fallbackError.message));
    await delay(launchWaitMs);
    await collapseSystemOverlays(serial);
    const focused = await shell(serial, 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"', { timeout: 10000 }).catch(() => '');
    return {
      output: error.stdout ? String(error.stdout).trim() : '',
      method: 'monkey-launcher-fallback',
      explicitError,
      monkeyOutput,
      focused,
      dataClear,
      success: String(monkeyOutput).includes('Events injected: 1') || String(focused).includes(packageName)
    };
  }
}

async function runStep(report, id, fn) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  try {
    const result = await fn();
    const step = {
      id,
      status: 'passed',
      startedAt,
      durationMs: Date.now() - startedMs,
      ...result
    };
    report.steps.push(step);
    return step;
  } catch (error) {
    const failure = classifyMobileLiveBridgeE2EFailure(error, { deviceReady: true });
    const step = {
      id,
      status: 'failed',
      startedAt,
      durationMs: Date.now() - startedMs,
      error: failure.reason
    };
    report.steps.push(step);
    throw error;
  }
}

export function classifyMobileLiveBridgeE2EFailure(error, { deviceReady = false } = {}) {
  const message = String(error?.message ?? error ?? 'unknown-mobile-e2e-error');
  const deviceDisconnected = /device\s+['"]?.+['"]?\s+not found|no devices\/emulators found|device offline|transport error|device disconnected/i.test(message);
  if (!deviceReady) {
    return { status: 'external-blocked', reason: 'android-device-not-ready' };
  }
  if (deviceDisconnected) {
    return { status: 'external-blocked', reason: 'android-device-disconnected-during-e2e' };
  }
  const stableCode = typeof error?.code === 'string' && error.code.trim() ? error.code : null;
  return { status: 'failed', reason: stableCode ?? message };
}

export async function runMobileLiveBridgeE2E({
  artifactDir = defaultArtifactDir,
  packageName = androidPackageName,
  activityName = androidActivityName,
  port = Number(process.env.JARVIS_MOBILE_E2E_PORT ?? defaultPort),
  host = process.env.JARVIS_MOBILE_E2E_HOST ?? '127.0.0.1',
  requestedSerial = process.env.JARVIS_MOBILE_DEVICE_SERIAL ?? '',
  allowPrimaryAppDataReset = false,
  acousticVoice = process.env.JARVIS_MOBILE_ACOUSTIC_VOICE === '1',
  fileVoice = process.env.JARVIS_MOBILE_FILE_VOICE === '1',
  pcVoiceHandoff = process.env.JARVIS_MOBILE_PC_VOICE_HANDOFF === '1'
} = {}) {
  if (acousticVoice && fileVoice) throw new Error('choose only one live voice transport');
  if (pcVoiceHandoff && !fileVoice) throw new Error('PC voice handoff E2E requires file voice mode');
  const artifactRoot = artifactDir;
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  artifactDir = join(artifactRoot, 'runs', runId);
  await mkdir(artifactDir, { recursive: true });
  const report = {
    reportVersion: 'c-mobile-live-bridge-home-e2e-v6',
    generatedAt: new Date().toISOString(),
    status: 'running',
    runId,
    packageName,
    bridge: {
      host,
      port,
      deviceUrl: null,
      localUrl: `http://127.0.0.1:${port}`,
      adbReverse: null
    },
    steps: [],
    artifacts: {
      rootDirectory: artifactRoot,
      directory: artifactDir,
      isolatedRuntimeState: true
    },
    runtime: null,
    actualDeviceVerified: false,
    liveBridgeVerified: false,
    acousticVoiceRequested: acousticVoice === true,
    fileVoiceRequested: fileVoice === true,
    pcVoiceHandoffRequested: pcVoiceHandoff === true,
    pcVoiceHandoffVerified: false,
    voiceInputVerified: false,
    voiceTranscriptVerified: false,
    voiceAudioSourceVerified: false,
    secureStoreRestoreVerified: false,
    deviceRevokeVerified: false,
    secureStoreCleanupVerified: false,
    privacy: {
      isolatedPackage: packageName !== 'local.eureka.jarvis',
      primaryAppDataReset: packageName === 'local.eureka.jarvis',
      rawPairingCodeStored: false,
      rawDeviceTokenStored: false,
      rawCommandStoredInReport: false,
      rawVoiceTranscriptStored: false
    }
  };

  const { bridgeRuntime } = createAgRuntime({
    auditRoot: join(artifactDir, 'audit'),
    outputPath: join('workspace', `mobile-live-e2e-${runId}.txt`),
    bridgeRealExecution: true,
    env: {
      ...process.env,
      JARVIS_LLM_INTENT: '0',
      JARVIS_LLM_PLANNER: '0',
      JARVIS_LLM_CONTENT: '0'
    }
  });
  const server = createBridgeServer(bridgeRuntime);
  let serial = null;
  let reversePort = null;
  let previousStayOnSetting = null;
  let pcConsoleDeviceToken = null;
  let pcConsoleDeviceId = null;

  try {
    await runStep(report, 'bridge.listen', async () => {
      const address = await listen(server, { host, port });
      report.bridge.port = address.port;
      report.bridge.localUrl = `http://127.0.0.1:${address.port}`;
      report.bridge.deviceUrl = `http://adb.localhost:${address.port}`;
      return { address };
    });

    const probe = await runStep(report, 'adb.ready-device', async () => {
      const deviceProbe = await listAndroidDevices();
      if (!deviceProbe.available) throw new Error('adb-not-available');
      const device = selectMobileE2EDevice({ devices: deviceProbe.devices, requestedSerial });
      return { adb: deviceProbe.adb, device };
    });
    serial = probe.device.serial;
    report.device = { serial };

    await runStep(report, 'adb.interactive-device', async () => {
      const interactive = await prepareInteractiveDevice(serial);
      previousStayOnSetting = interactive.previousStayOnSetting;
      return {
        wakefulness: interactive.wakefulness,
        temporaryStayAwake: interactive.temporaryStayAwake,
        staleTouch: interactive.staleTouch,
        settingRestoredAfterRun: true
      };
    });

    await runStep(report, 'adb.reverse-bridge', async () => {
      reversePort = report.bridge.port;
      const binding = `tcp:${reversePort}`;
      await adb(['-s', serial, 'reverse', binding, binding], { timeout: 15000 });
      report.bridge.adbReverse = { device: binding, host: binding, active: true };
      return { binding, rawCommandStored: false };
    });

    await runStep(report, 'app.installed', async () => {
      const installedPath = await shell(serial, `pm path ${packageName}`).catch(() => '');
      if (!installedPath.includes(packageName)) throw new Error(`${packageName} is not installed`);
      return { installedPath };
    });

    await runStep(report, 'app.launch-clean', async () => {
      if (packageName === 'local.eureka.jarvis' && !allowPrimaryAppDataReset) {
        throw new Error('refusing-to-clear-primary-mobile-app-data');
      }
      const launch = await launchApp(serial, packageName, { clearData: true, launchWaitMs: 7000, activityName });
      if (!launch.success) throw new Error(`launch failed: ${launch.output}`);
      const scrollTop = await scrollToTop(serial, artifactDir, {
        packageName,
        activityName,
        predicate: isUnpairedHomeScreen
      });
      const screen = await waitForXml(
        serial,
        artifactDir,
        'unpaired-home',
        isUnpairedHomeScreen,
        { timeoutMs: 30_000, intervalMs: 900, packageName, activityName }
      );
      if (!screen.matched) throw new Error('unpaired production home was not visible after clean launch');
      return { launch, scrollTop, screen };
    });

    await runStep(report, 'ui.pairing-confirm', async () => {
      const pairing = bridgeRuntime.pairing.start();
      const activation = await openDeepLink(
        serial,
        packageName,
        `jarvis://pair?bridge=${encodeURIComponent(report.bridge.deviceUrl)}&code=${encodeURIComponent(pairing.pairingCode)}`
      );
      const runtime = await waitForRuntime(
        'device paired',
        () => bridgeRuntime.registry.list().some((device) => device.status === 'active'),
        { timeoutMs: 60_000, intervalMs: 500 }
      );
      if (!runtime.matched) throw new Error('device was not registered after pairing confirm');
      const scrollTop = await scrollToTop(serial, artifactDir, { packageName, activityName });
      const screen = await waitForXml(serial, artifactDir, 'paired-home-after-pairing', isPairedHomeScreen, {
        timeoutMs: 20_000,
        packageName,
        activityName
      });
      if (!screen.matched) throw new Error('paired production home was not visible after pairing');
      return {
        activation,
        pairedDeviceCount: bridgeRuntime.registry.list().filter((device) => device.status === 'active').length,
        pairingCodeHash: createHash('sha256').update(pairing.pairingCode).digest('hex'),
        rawPairingCodeStored: false,
        scrollTop,
        screen
      };
    });

    await runStep(report, 'ui.voice-input-start-stop', async () => {
      await shell(serial, `pm grant ${packageName} android.permission.RECORD_AUDIO`, { timeout: 15000 });
      const packageDump = await shell(serial, `dumpsys package ${packageName}`, { timeout: 15000 });
      const permissionGranted = /android\.permission\.RECORD_AUDIO:[^\r\n]*granted=true/i.test(packageDump);
      if (!permissionGranted) throw new Error('microphone runtime permission was not granted');

      if (fileVoice) {
        if (packageName !== androidPackageName) throw new Error('file voice fixture requires the isolated E2E package');
        const localFixturePath = join(artifactDir, 'jarvis-e2e-voice.wav');
        const localConfirmationFixturePath = join(artifactDir, 'jarvis-e2e-voice-confirmation.wav');
        let fixtureServer = null;
        let fixtureTelemetry = null;
        let fixtureReverseBinding = null;
        try {
          const fixture = await createWindowsTtsWaveFixture(localFixturePath, acousticVoiceFixture);
          const confirmationFixture = await createWindowsTtsWaveFixture(
            localConfirmationFixturePath,
            acousticVoiceConfirmationFixture
          );
          const fixtureAudio = await readFile(localFixturePath);
          const confirmationFixtureAudio = await readFile(localConfirmationFixturePath);
          const fixtureHttp = createVoiceFixtureServer(fixtureAudio, 'command');
          fixtureServer = fixtureHttp.server;
          fixtureTelemetry = fixtureHttp.telemetry;
          const fixtureAddress = await listen(fixtureServer, { host: '127.0.0.1', port: 0 });
          fixtureReverseBinding = `tcp:${fixtureAddress.port}`;
          await adb(['-s', serial, 'reverse', fixtureReverseBinding, fixtureReverseBinding], { timeout: 15_000 });
          const fixtureSourceUrl = `http://127.0.0.1:${fixtureAddress.port}${e2eVoiceFixtureRoute}`;

          const initialTaskIds = new Set(bridgeRuntime.coreFacade.tasks.keys());
          const attempts = [];
          let runtime = null;
          let fixtureVariant = 'command';
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            fixtureHttp.setAudio(
              fixtureVariant === 'confirmation' ? confirmationFixtureAudio : fixtureAudio,
              fixtureVariant
            );
            const activation = await openDeepLink(
              serial,
              packageName,
              `jarvis://e2e-voice/transcribe?source=${encodeURIComponent(fixtureSourceUrl)}`
            );
            const taskWait = await waitForRuntime(`file voice task created attempt ${attempt}`, () => (
              [...bridgeRuntime.coreFacade.tasks.values()].find((task) => !initialTaskIds.has(task.taskId)) ?? null
            ), { timeoutMs: 25_000, intervalMs: 500 });
            if (taskWait.matched) {
              runtime = taskWait;
              attempts.push({ attempt, status: 'recognized', fixtureVariant, activation });
              break;
            }
            const diagnostic = await dumpXml(serial, artifactDir, `home-file-voice-diagnostic-${attempt}`);
            const diagnosticState = acousticDiagnosticFromXml(diagnostic.xml, diagnostic.outputPath);
            attempts.push({
              attempt,
              status: 'no-semantic-result',
              fixtureVariant,
              activation,
              ...diagnosticState
            });
            fixtureVariant = diagnosticState.readbackPending ? 'confirmation' : 'command';
            if (attempt < 3) await delay(900);
          }

          report.fileVoice = {
            fixture,
            confirmationFixture,
            attempts,
            maxAttempts: 3,
            sourceTransport: 'adb-reverse-http-to-app-cache',
            fixtureRequests: fixtureTelemetry.fixtureRequests,
            fixtureRequestsByVariant: fixtureTelemetry.fixtureRequestsByVariant,
            cleanupSignals: fixtureTelemetry.cleanupSignals,
            bytesServed: fixtureTelemetry.bytesServed,
            bytesServedByVariant: fixtureTelemetry.bytesServedByVariant,
            semanticResultCreated: Boolean(runtime?.matched),
            enginesAttempted: [...new Set(attempts.map((attempt) => attempt.recognitionEngine).filter(Boolean))],
            fixedIsolatedRoute: true,
            externalDeviceFixtureCreated: false,
            rawUserAudioStored: false,
            syntheticFixtureRetained: false
          };
          if (!runtime?.matched) throw new Error('synthetic file voice input produced no semantic task');

          const taskEvidence = acousticVoiceTaskEvidence(runtime.value);
          report.fileVoice = {
            ...report.fileVoice,
            recognitionEngine: taskEvidence.recognition.engine,
            confirmationEngine: taskEvidence.recognition.confirmationEngine,
            enginesAttempted: [...new Set([
              ...(report.fileVoice.enginesAttempted ?? []),
              taskEvidence.recognition.engine,
              taskEvidence.recognition.confirmationEngine
            ].filter(Boolean))],
            recognizedTranscriptSha256: taskEvidence.recognizedTranscriptSha256
          };
          const approvalScreen = await waitForXml(serial, artifactDir, 'home-approval-after-file-voice', (xml) => (
            xml.includes('home-approve-button')
            && xml.includes('home-reject-button')
            && xml.includes('이렇게 진행할까요?')
          ), { timeoutMs: 60_000, intervalMs: 800 });
          if (!approvalScreen.matched) throw new Error('file voice task did not reach the approval screen');
          const cleanupSignal = await waitForRuntime('file voice app cache cleanup signal', () => (
            fixtureTelemetry.cleanupSignals > 0 ? { cleanupSignals: fixtureTelemetry.cleanupSignals } : null
          ), { timeoutMs: 10_000, intervalMs: 250 });
          if (!cleanupSignal.matched) throw new Error('file voice app cache cleanup was not confirmed');
          return {
            permissionGranted,
            startActivation: attempts.at(-1)?.activation ?? null,
            listening: { matched: true, label: 'synthetic-audio-source' },
            ...taskEvidence,
            approvalScreen,
            cleanupSignal: cleanupSignal.value,
            transcriptTaskCreated: true,
            voiceTransport: 'synthetic-file-audio-source',
            rawVoiceTranscriptStored: false
          };
        } finally {
          if (fixtureReverseBinding) {
            await adb(['-s', serial, 'reverse', '--remove', fixtureReverseBinding], { timeout: 10_000 }).catch(() => null);
          }
          if (fixtureServer) await close(fixtureServer).catch(() => undefined);
          await rm(localFixturePath, { force: true }).catch(() => undefined);
          await rm(localConfirmationFixturePath, { force: true }).catch(() => undefined);
          report.fileVoice = {
            ...(report.fileVoice ?? {}),
            fixtureRequests: fixtureTelemetry?.fixtureRequests ?? 0,
            fixtureRequestsByVariant: fixtureTelemetry?.fixtureRequestsByVariant ?? {},
            cleanupSignals: fixtureTelemetry?.cleanupSignals ?? 0,
            bytesServed: fixtureTelemetry?.bytesServed ?? 0,
            bytesServedByVariant: fixtureTelemetry?.bytesServedByVariant ?? {},
            appCacheCleanupSignalVerified: (fixtureTelemetry?.cleanupSignals ?? 0) > 0,
            sourceReverseRemoved: fixtureReverseBinding !== null,
            sourceServerClosed: fixtureServer !== null,
            localFixtureDeleted: true,
            localConfirmationFixtureDeleted: true,
            syntheticFixtureRetained: false
          };
        }
      }

      await scrollToTop(serial, artifactDir, { packageName, activityName });
      const startedVoiceInput = await setHomeVoiceInputState(serial, packageName, artifactDir, {
        listening: true,
        label: 'home-mic-start',
        maxScrolls: 3,
        activityName
      });
      const startActivation = startedVoiceInput.activation;
      const listening = startedVoiceInput.state;
      if (!listening.matched && !acousticVoice) throw new Error('mobile native voice recognizer did not enter ready state');

      if (acousticVoice) {
        const initialTaskIds = new Set(bridgeRuntime.coreFacade.tasks.keys());
        const attempts = [];
        let currentActivation = startActivation;
        let currentListening = listening;
        let runtime = null;

        for (let attempt = 1; attempt <= 3; attempt += 1) {
          if (attempt > 1) {
            await scrollToTop(serial, artifactDir, { packageName, activityName });
            const retriedVoiceInput = await setHomeVoiceInputState(serial, packageName, artifactDir, {
              listening: true,
              label: `home-mic-acoustic-retry-${attempt}`,
              maxScrolls: 3,
              activityName
            });
            currentActivation = retriedVoiceInput.activation;
            currentListening = retriedVoiceInput.state;
          }

          if (!currentListening.matched) {
            const diagnostic = await dumpXml(serial, artifactDir, `home-acoustic-voice-not-ready-${attempt}`);
            attempts.push({
              attempt,
              status: 'recognizer-not-ready',
              activation: currentActivation,
              listening: currentListening,
              ...acousticDiagnosticFromXml(diagnostic.xml, diagnostic.outputPath)
            });
            if (attempt < 3) {
              await delay(900);
              continue;
            }
            break;
          }

          await delay(1_200);
          const tts = await speakWithWindowsTts(acousticVoiceFixture);
          const taskWait = await waitForRuntime(`acoustic voice task created attempt ${attempt}`, () => (
            [...bridgeRuntime.coreFacade.tasks.values()].find((task) => !initialTaskIds.has(task.taskId)) ?? null
          ), { timeoutMs: 18_000, intervalMs: 500 });
          if (taskWait.matched) {
            runtime = taskWait;
            attempts.push({
              attempt,
              status: 'recognized',
              activation: currentActivation,
              listening: currentListening,
              tts,
              audioDetected: true
            });
            break;
          }

          const diagnostic = await dumpXml(serial, artifactDir, `home-acoustic-voice-diagnostic-${attempt}`);
          attempts.push({
            attempt,
            status: 'no-semantic-result',
            activation: currentActivation,
            listening: currentListening,
            tts,
            ...acousticDiagnosticFromXml(diagnostic.xml, diagnostic.outputPath)
          });
          if (attempt < 3) await delay(900);
        }

        const detectedStates = attempts.map((attempt) => attempt.audioDetected).filter((value) => value !== null);
        report.acousticVoice = {
          attempts,
          maxAttempts: 3,
          nativeRecognizerReady: attempts.some((attempt) => attempt.listening?.matched === true),
          audioDetected: detectedStates.includes(true) ? true : detectedStates.length ? false : null,
          semanticResultCreated: Boolean(runtime?.matched),
          enginesAttempted: [...new Set(attempts.map((attempt) => attempt.recognitionEngine).filter(Boolean))],
          rawVoiceTranscriptStoredInReport: false
        };
        if (!runtime?.matched) {
          if (!report.acousticVoice.nativeRecognizerReady) {
            throw new Error('mobile native voice recognizer did not enter ready state on any available engine');
          }
          if (report.acousticVoice.audioDetected === false) {
            throw new Error('acoustic voice audio did not reach the phone microphone');
          }
          if (report.acousticVoice.audioDetected === true) {
            throw new Error('acoustic voice audio was detected but produced no semantic result');
          }
          throw new Error('acoustic voice final transcript did not create a task');
        }

        const taskEvidence = acousticVoiceTaskEvidence(runtime.value);
        report.acousticVoice = {
          ...report.acousticVoice,
          audioDetected: true,
          semanticResultCreated: true,
          recognizedTranscriptSha256: taskEvidence.recognizedTranscriptSha256,
          rawVoiceTranscriptStoredInReport: false
        };
        const approvalScreen = await waitForXml(serial, artifactDir, 'home-approval-after-acoustic-voice', (xml) => (
          xml.includes('home-approve-button')
          && xml.includes('home-reject-button')
          && xml.includes('이렇게 진행할까요?')
        ), { timeoutMs: 60_000, intervalMs: 800 });
        if (!approvalScreen.matched) throw new Error('acoustic voice task did not reach the approval screen');
        return {
          permissionGranted,
          startActivation,
          listening: attempts.at(-1)?.listening ?? listening,
          tts: attempts.at(-1)?.tts ?? null,
          acousticAttempts: attempts.length,
          ...taskEvidence,
          approvalScreen,
          transcriptTaskCreated: true,
          rawVoiceTranscriptStored: false
        };
      }

      const stoppedVoiceInput = await setHomeVoiceInputState(serial, packageName, artifactDir, {
        listening: false,
        label: 'home-mic-stop',
        maxScrolls: 0,
        activityName
      });
      const stopActivation = stoppedVoiceInput.activation;
      const stopped = stoppedVoiceInput.state;
      if (!stopped.matched) throw new Error('mobile voice input did not return to idle state');

      return {
        permissionGranted,
        startActivation,
        stopActivation,
        listening,
        stopped,
        rawVoiceTranscriptStored: false
      };
    });

    await runStep(report, 'ui.task-create', async () => {
      if (acousticVoice || fileVoice) {
        const voiceStep = report.steps.find((step) => step.id === 'ui.voice-input-start-stop');
        const task = voiceStep?.taskId ? bridgeRuntime.coreFacade.tasks.get(voiceStep.taskId) : null;
        if (!task) throw new Error('voice task identity was not preserved');
        if (task.status !== 'WAITING_APPROVAL') {
          throw new Error(`voice task was not waiting for approval:${task.status}`);
        }
        return {
          activation: voiceStep.startActivation,
          commandInput: null,
          taskId: task.taskId,
          taskCount: bridgeRuntime.stateCache.snapshot().tasks.length,
          source: acousticVoice ? 'physical-acoustic-voice' : 'synthetic-file-audio-source',
          inputMode: task.request.source.inputMode,
          actionType: task.intent.actionType,
          screen: voiceStep.approvalScreen
        };
      }
      const initialTaskIds = new Set(
        bridgeRuntime.stateCache.snapshot().tasks.map((task) => task.taskId)
      );
      await scrollToTop(serial, artifactDir, { packageName, activityName });
      const commandInput = await enterHomeCommand(serial, packageName, artifactDir, 'list files', activityName);
      const findCreatedTask = () => (
        bridgeRuntime.stateCache.snapshot().tasks.find((task) => !initialTaskIds.has(task.taskId)) ?? null
      );
      let activation = null;
      let runtime = null;
      if (commandInput.entered) {
        const touchActivation = await tapNode(serial, artifactDir, {
          resourceId: 'home-submit-button',
          label: 'home-submit',
          maxScrolls: 2,
          packageName,
          activityName
        });
        runtime = await waitForRuntime('task cached after touch', findCreatedTask, {
          timeoutMs: packageName === androidPackageName ? 5000 : 60_000
        });
        activation = {
          ...touchActivation,
          activationTransport: 'adb-shell-touch',
          physicalTapAccepted: runtime.matched,
          isolatedFallbackUsed: false
        };
      }
      if (!runtime?.matched && packageName === androidPackageName) {
        const deepLinkActivation = await openDeepLink(
          serial,
          packageName,
          `jarvis://e2e-command/create?text=${encodeURIComponent('list files')}`
        );
        activation = {
          ...(activation ?? commandInput.activation),
          activationTransport: 'isolated-e2e-deep-link',
          physicalInputAccepted: commandInput.entered,
          physicalTapAccepted: false,
          isolatedFallbackUsed: true,
          deepLinkActivation
        };
        runtime = await waitForRuntime('task cached after isolated trigger', findCreatedTask, { timeoutMs: 60_000 });
      }
      if (!runtime.matched) throw new Error('task was not created through D Bridge');
      const screen = await waitForXml(serial, artifactDir, 'home-approval-after-task', (xml) => (
        xml.includes('home-approve-button')
        && xml.includes('home-reject-button')
        && xml.includes('이렇게 진행할까요?')
      ), { timeoutMs: 60_000, intervalMs: 800 });
      if (!screen.matched) throw new Error('home approval card was not visible after task creation');
      return {
        activation,
        commandInput,
        taskId: runtime.value.taskId,
        taskCount: bridgeRuntime.stateCache.snapshot().tasks.length,
        screen
      };
    });

    await runStep(report, 'ui.approval-decision', async () => {
      const createdTaskId = report.steps.find((step) => step.id === 'ui.task-create')?.taskId;
      if (!createdTaskId) throw new Error('created task identity was not preserved for approval verification');
      const findApprovedTask = () => {
        const task = bridgeRuntime.coreFacade.tasks.get(createdTaskId);
        if (!task || !['APPROVED', 'EXECUTING', 'COMPLETED'].includes(task.status)) return null;
        return { taskId: task.taskId, status: task.status, approvalId: task.approvalCard.approvalId };
      };
      const touchActivation = await tapNode(serial, artifactDir, {
        resourceId: 'home-approve-button',
        label: 'home-approve',
        maxScrolls: 4,
        packageName,
        activityName
      });
      let runtime = await waitForRuntime('task approved after touch', findApprovedTask, {
        timeoutMs: packageName === androidPackageName ? 5000 : 30_000
      });
      let activation = {
        ...touchActivation,
        activationTransport: 'adb-shell-touch',
        physicalTapAccepted: runtime.matched,
        isolatedFallbackUsed: false
      };
      if (!runtime.matched && packageName === androidPackageName) {
        const deepLinkActivation = await openDeepLink(serial, packageName, 'jarvis://e2e-approval/approve');
        activation = {
          ...activation,
          activationTransport: 'isolated-e2e-deep-link',
          physicalTapAccepted: false,
          isolatedFallbackUsed: true,
          deepLinkActivation
        };
        runtime = await waitForRuntime('task approved after isolated trigger', findApprovedTask, { timeoutMs: 30_000 });
      }
      if (!runtime.matched) throw new Error('ApprovalDecision did not approve a live task');
      const screen = await waitForXml(serial, artifactDir, 'home-result-after-approval', (xml) => (
        xml.includes('home-new-command-button')
        && (xml.includes('완료했어요') || xml.includes('결과:'))
      ), { timeoutMs: 60_000, intervalMs: 900 });
      if (!screen.matched) throw new Error('home result was not visible after approval decision');
      return { activation, runtime: runtime.value, screen };
    });

    if (pcVoiceHandoff) {
      await runStep(report, 'ui.pc-voice-high-risk-handoff', async () => {
        const pcPairing = bridgeRuntime.pairing.start();
        pcConsoleDeviceId = `pc_console_e2e_${runId}`;
        const pcPaired = bridgeRuntime.pairing.confirm({
          deviceId: pcConsoleDeviceId,
          deviceName: 'Local PC Voice Console E2E',
          pairingId: pcPairing.pairingId,
          pairingCode: pcPairing.pairingCode
        });
        if (pcPaired.success === false) {
          throw new Error(pcPaired.error?.code ?? 'PC console E2E pairing failed');
        }
        pcConsoleDeviceToken = pcPaired.deviceToken;

        try {
          const voice = await runIsolatedVoiceTaskFixture({
            serial,
            packageName,
            artifactDir,
            bridgeRuntime,
            commandText: pcVoiceHandoffFixture,
            expectedActionType: 'SEND_EMAIL',
            labelPrefix: 'home-pc-voice-handoff'
          });
          const task = bridgeRuntime.coreFacade.tasks.get(voice.taskId);
          if (!task || task.status !== 'WAITING_APPROVAL') {
            throw new Error(`PC voice handoff task was not waiting for approval:${task?.status ?? 'missing'}`);
          }
          if (Number(task.approvalCard?.riskTier ?? 5) > 3) {
            throw new Error(`PC voice handoff task was not high risk:${task.approvalCard?.riskTier ?? 'unknown'}`);
          }

          const findVoiceHandoff = () => (
            [...bridgeRuntime.pcConfirmationHandoffs.values()].find((item) => (
              item.taskId === voice.taskId && item.status === 'awaiting_pc_confirmation'
            )) ?? null
          );
          const approvalTouchActivation = await tapNode(serial, artifactDir, {
            resourceId: 'home-approve-button',
            label: 'home-pc-voice-approve',
            maxScrolls: 4,
            packageName,
            activityName
          });
          let handoffWait = await waitForRuntime('PC voice handoff requested by touch', findVoiceHandoff, {
            timeoutMs: packageName === androidPackageName ? 5000 : 30_000,
            intervalMs: 300
          });
          let approvalActivation = {
            ...approvalTouchActivation,
            activationTransport: 'adb-shell-touch',
            physicalTapAccepted: handoffWait.matched,
            isolatedFallbackUsed: false
          };
          if (!handoffWait.matched && packageName === androidPackageName) {
            const deepLinkActivation = await openDeepLink(serial, packageName, 'jarvis://e2e-approval/approve');
            approvalActivation = {
              ...approvalActivation,
              activationTransport: 'isolated-e2e-deep-link',
              physicalTapAccepted: false,
              isolatedFallbackUsed: true,
              deepLinkActivation
            };
            handoffWait = await waitForRuntime('PC voice handoff requested by isolated trigger', findVoiceHandoff, {
              timeoutMs: 30_000,
              intervalMs: 300
            });
          }
          if (!handoffWait.matched) throw new Error('mobile did not request a PC voice confirmation handoff');
          const handoff = handoffWait.value;
          const challengeScreen = await waitForXml(serial, artifactDir, 'home-pc-voice-confirmation', (xml) => (
            xml.includes('home-pc-voice-confirmation')
            && xml.includes('PC 음성 확인 대기')
            && xml.includes(handoff.voiceChallenge.phrase)
          ), { timeoutMs: 20_000, intervalMs: 500 });
          if (!challengeScreen.matched) throw new Error('mobile did not render the PC voice challenge');

          const voiceProof = {
            mode: 'pc-voice-challenge',
            challengeId: handoff.voiceChallenge.challengeId,
            challengeResponse: handoff.voiceChallenge.phrase,
            spokenDecision: 'approve',
            confidence: 0.96,
            confirmationCount: 1,
            engine: 'deterministic-pc-voice-proof-simulator',
            transcriptStored: false,
            rawAudioStored: false
          };
          const accepted = bridgeRuntime.decidePcConfirmationHandoff({
            handoffId: handoff.handoffId,
            token: pcConsoleDeviceToken,
            decision: 'approve',
            operatorId: 'physical-pc-voice-e2e',
            voiceProof,
            requestContext: { remoteAddress: '127.0.0.1' }
          });
          if (accepted.success === false) {
            throw new Error(accepted.error?.code ?? 'PC voice handoff decision failed');
          }
          if (!['review-only', 'awaiting-confirmation'].includes(accepted.executionDisposition)) {
            throw new Error(`external transfer did not stop before execution:${accepted.executionDisposition ?? 'unknown'}`);
          }
          if (accepted.executionDisposition === 'awaiting-confirmation' && !accepted.executionHandoffId) {
            throw new Error('external transfer execution handoff identity was missing');
          }
          if (accepted.executionDisposition === 'review-only' && accepted.executionHandoffId) {
            throw new Error('review-only external transfer unexpectedly created an execution handoff');
          }
          const replay = bridgeRuntime.decidePcConfirmationHandoff({
            handoffId: handoff.handoffId,
            token: pcConsoleDeviceToken,
            decision: 'approve',
            operatorId: 'physical-pc-voice-e2e',
            voiceProof,
            requestContext: { remoteAddress: '127.0.0.1' }
          });
          if (replay.error?.code !== 'D_PC_HANDOFF_ALREADY_DECIDED') {
            throw new Error(`PC voice challenge was not single-use:${replay.error?.code ?? 'no-error'}`);
          }

          const resultScreen = await waitForXml(serial, artifactDir, 'home-result-after-pc-voice', (xml) => (
            xml.includes('home-new-command-button')
            && xml.includes('APPROVED')
            && xml.includes('검토 전용')
          ), { timeoutMs: 35_000, intervalMs: 700 });
          if (!resultScreen.matched) throw new Error('mobile did not return from PC voice confirmation with an honest review-only result');
          const finalTask = bridgeRuntime.coreFacade.tasks.get(voice.taskId);
          if (finalTask?.status !== 'APPROVED') {
            throw new Error(`review-only PC voice task ended unexpectedly:${finalTask?.status ?? 'missing'}`);
          }

          return {
            taskId: voice.taskId,
            taskStatus: finalTask.status,
            inputMode: voice.inputMode,
            actionType: voice.actionType,
            riskTier: task.approvalCard.riskTier,
            recognizedTranscriptSha256: voice.recognizedTranscriptSha256,
            voiceTransport: voice.voiceTransport,
            recognition: voice.recognition,
            fixture: voice.fixture,
            confirmationFixture: voice.confirmationFixture,
            fixtureTelemetry: voice.fixtureTelemetry,
            attempts: voice.attempts,
            approvalActivation,
            challengeScreen,
            resultScreen,
            handoffId: handoff.handoffId,
            challengeIdHash: createHash('sha256').update(handoff.voiceChallenge.challengeId).digest('hex'),
            challengePhraseHash: createHash('sha256').update(handoff.voiceChallenge.phrase).digest('hex'),
            challengeSingleUseVerified: true,
            executionDisposition: accepted.executionDisposition,
            executionHandoffCreated: Boolean(accepted.executionHandoffId),
            executionConfirmationWithheld: true,
            externalTransferExecuted: false,
            pcVoiceProofSynthetic: true,
            transcriptStored: false,
            rawAudioStored: false,
            rawCommandStoredInReport: false,
            rawChallengeStoredInReport: false,
            rawDeviceTokenStoredInReport: false
          };
        } finally {
          if (pcConsoleDeviceId) {
            bridgeRuntime.registry.revoke(pcConsoleDeviceId, { reason: 'pc_voice_e2e_complete' });
          }
          pcConsoleDeviceToken = null;
        }
      });
    }

    await runStep(report, 'secure-store.restore-after-relaunch', async () => {
      const launch = await launchApp(serial, packageName, { clearData: false, activityName });
      if (!launch.success) throw new Error(`relaunch failed: ${launch.output}`);
      await scrollToTop(serial, artifactDir, { packageName, activityName });
      const screen = await waitForXml(serial, artifactDir, 'secure-store-restored', isPairedHomeScreen, { timeoutMs: 20_000 });
      if (!screen.matched) throw new Error('SecureStore token restore was not visible after relaunch');
      return { launch, screen };
    });

    await runStep(report, 'ui.device-revoke-disconnect', async () => {
      await scrollToTop(serial, artifactDir, { packageName, activityName });
      const disconnectTap = await openDeepLink(serial, packageName, 'jarvis://device/disconnect');
      const revoked = await waitForRuntime('device revoked', () => bridgeRuntime.registry.list().every((device) => device.status !== 'active'));
      if (!revoked.matched) throw new Error('device was not revoked in D Bridge runtime');
      const pairingScreen = await waitForXml(serial, artifactDir, 'home-after-disconnect', isUnpairedHomeScreen, { timeoutMs: 20_000 });
      if (!pairingScreen.matched) throw new Error('production home did not show unpaired state after disconnect');
      return { disconnectTap, pairingScreen, activeDeviceCount: bridgeRuntime.registry.list().filter((device) => device.status === 'active').length };
    });

    await runStep(report, 'secure-store.cleanup-after-relaunch', async () => {
      const launch = await launchApp(serial, packageName, { clearData: false, activityName });
      if (!launch.success) throw new Error(`cleanup relaunch failed: ${launch.output}`);
      await scrollToTop(serial, artifactDir, { packageName, activityName });
      const screen = await waitForXml(serial, artifactDir, 'secure-store-cleaned', isUnpairedHomeScreen, { timeoutMs: 20_000 });
      if (!screen.matched) throw new Error('SecureStore token cleanup was not visible after relaunch');
      return { launch, screen };
    });

    const serialSafe = sanitizeSerial(serial);
    const screenshot = await captureScreenshot(serial, join(artifactDir, `${serialSafe}-final.png`)).catch((error) => ({
      outputPath: join(artifactDir, `${serialSafe}-final.png`),
      bytes: 0,
      hasPngHeader: false,
      error: error.code ?? error.message
    }));
    report.runtime = runtimeSnapshot(bridgeRuntime);
    report.artifacts.finalScreenshot = screenshot;
    report.actualDeviceVerified = report.steps.some((step) => step.id === 'app.launch-clean' && step.status === 'passed')
      && report.steps.some((step) => step.id === 'adb.reverse-bridge' && step.status === 'passed');
    report.liveBridgeVerified = report.steps.some((step) => step.id === 'ui.pairing-confirm' && step.status === 'passed')
      && report.steps.some((step) => step.id === 'ui.task-create' && step.status === 'passed')
      && report.steps.some((step) => step.id === 'ui.approval-decision' && step.status === 'passed');
    report.voiceInputVerified = report.steps.some((step) => step.id === 'ui.voice-input-start-stop' && step.status === 'passed');
    report.voiceTranscriptVerified = report.steps.some((step) => (
      step.id === 'ui.voice-input-start-stop'
      && step.status === 'passed'
      && step.transcriptTaskCreated === true
      && step.inputMode === 'voice'
      && step.actionType === 'LIST_FILES'
    ));
    report.voiceAudioSourceVerified = report.steps.some((step) => (
      step.id === 'ui.voice-input-start-stop'
      && step.status === 'passed'
      && step.voiceTransport === 'synthetic-file-audio-source'
      && step.transcriptTaskCreated === true
    ));
    report.pcVoiceHandoffVerified = report.steps.some((step) => (
      step.id === 'ui.pc-voice-high-risk-handoff'
      && step.status === 'passed'
      && step.inputMode === 'voice'
      && step.actionType === 'SEND_EMAIL'
      && step.riskTier <= 3
      && step.challengeSingleUseVerified === true
      && ['review-only', 'awaiting-confirmation'].includes(step.executionDisposition)
      && step.executionConfirmationWithheld === true
      && step.externalTransferExecuted === false
      && step.transcriptStored === false
      && step.rawAudioStored === false
    ));
    report.secureStoreRestoreVerified = report.steps.some((step) => step.id === 'secure-store.restore-after-relaunch' && step.status === 'passed');
    report.deviceRevokeVerified = report.steps.some((step) => step.id === 'ui.device-revoke-disconnect' && step.status === 'passed')
      && report.runtime.health.pairedDevices === 0;
    report.secureStoreCleanupVerified = report.steps.some((step) => step.id === 'secure-store.cleanup-after-relaunch' && step.status === 'passed');
    report.status = report.liveBridgeVerified
      && report.voiceInputVerified
      && (!(report.acousticVoiceRequested || report.fileVoiceRequested) || report.voiceTranscriptVerified)
      && (!report.pcVoiceHandoffRequested || report.pcVoiceHandoffVerified)
      && report.secureStoreRestoreVerified
      && report.deviceRevokeVerified
      && report.secureStoreCleanupVerified
      ? 'passed'
      : 'product-readiness-blocked';
    report.reason = report.status === 'passed' ? null : 'live-bridge-securestore-or-revoke-contract-not-verified';
    return report;
  } catch (error) {
    const deviceReady = report.steps.some((step) => step.id === 'adb.ready-device' && step.status === 'passed');
    const failure = classifyMobileLiveBridgeE2EFailure(error, { deviceReady });
    report.status = failure.status;
    report.reason = failure.reason;
    report.runtime = runtimeSnapshot(bridgeRuntime);
    return report;
  } finally {
    const cleanup = {
      bridgeDevicesRevoked: 0,
      isolatedAppDataCleared: false,
      isolatedAppDataClearVerified: false
    };
    for (const device of bridgeRuntime.registry.list().filter((item) => item.status === 'active')) {
      const revoked = bridgeRuntime.registry.revoke(device.deviceId, { reason: 'mobile_live_e2e_finally' });
      if (revoked?.success !== false) cleanup.bridgeDevicesRevoked += 1;
    }
    if (serial && packageName === androidPackageName) {
      await shell(serial, `am force-stop ${packageName}`, { timeout: 10000 }).catch(() => '');
      const clearOutput = await shell(serial, `pm clear ${packageName}`, { timeout: 30000 }).catch(() => '');
      cleanup.isolatedAppDataCleared = true;
      cleanup.isolatedAppDataClearVerified = /^Success$/im.test(clearOutput);
    }
    if (serial && previousStayOnSetting !== null) {
      await restoreInteractiveDevice(serial, previousStayOnSetting);
      report.device = {
        ...(report.device ?? { serial }),
        interactiveSettingRestored: true
      };
    }
    if (serial && reversePort) {
      await adb(['-s', serial, 'reverse', '--remove', `tcp:${reversePort}`], { timeout: 10000 }).catch(() => null);
      report.bridge.adbReverse = { ...(report.bridge.adbReverse ?? {}), active: false, removed: true };
    }
    await close(server);
    report.cleanup = cleanup;
  }
}

export function renderMobileLiveBridgeE2EMarkdown(report) {
  const lines = [
    '# JARVIS Mobile Live Bridge E2E',
    '',
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    `Reason: ${report.reason ?? 'none'}`,
    `Device: ${report.device?.serial ?? 'none'}`,
    `Bridge: ${report.bridge.localUrl} / device ${report.bridge.deviceUrl}`,
    `Live bridge verified: ${report.liveBridgeVerified}`,
    `Acoustic voice requested: ${report.acousticVoiceRequested}`,
    `Acoustic audio detected: ${report.acousticVoice?.audioDetected ?? 'not-measured'}`,
    `File voice requested: ${report.fileVoiceRequested}`,
    `Voice input verified: ${report.voiceInputVerified}`,
    `Voice transcript verified: ${report.voiceTranscriptVerified}`,
    `Voice audio source verified: ${report.voiceAudioSourceVerified}`,
    `PC voice handoff requested: ${report.pcVoiceHandoffRequested}`,
    `PC voice handoff verified: ${report.pcVoiceHandoffVerified}`,
    `SecureStore restore verified: ${report.secureStoreRestoreVerified}`,
    `Device revoke verified: ${report.deviceRevokeVerified}`,
    `SecureStore cleanup verified: ${report.secureStoreCleanupVerified}`,
    '',
    '## Steps'
  ];
  for (const step of report.steps) {
    lines.push(`- ${step.id}: ${step.status} (${step.durationMs}ms)`);
  }
  lines.push('', '## Runtime');
  lines.push(`- pairedDevices: ${report.runtime?.health?.pairedDevices ?? 0}`);
  lines.push(`- cachedTasks: ${report.runtime?.cache?.taskCount ?? 0}`);
  lines.push(`- approvedTasks: ${(report.runtime?.tasks ?? []).filter((task) => task.status === 'APPROVED').length}`);
  lines.push(`- eventCount: ${report.runtime?.events?.eventCount ?? 0}`);
  lines.push(`- isolatedPackage: ${report.privacy?.isolatedPackage === true}`);
  lines.push(`- rawCommandStoredInReport: ${report.privacy?.rawCommandStoredInReport === true}`);
  return `${lines.join('\n')}\n`;
}

export async function writeMobileLiveBridgeE2EArtifacts(report, {
  jsonPath = 'dist/mobile-live-bridge-e2e-report.json',
  markdownPath = 'dist/mobile-live-bridge-e2e-report.md'
} = {}) {
  const runJsonPath = report.artifacts?.directory
    ? join(report.artifacts.directory, 'report.json')
    : null;
  const runMarkdownPath = report.artifacts?.directory
    ? join(report.artifacts.directory, 'report.md')
    : null;
  if (runJsonPath && runMarkdownPath) {
    report.artifacts.runReportJsonPath = runJsonPath;
    report.artifacts.runReportMarkdownPath = runMarkdownPath;
    await mkdir(dirname(runJsonPath), { recursive: true });
  }
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  const json = JSON.stringify(report, null, 2);
  const markdown = renderMobileLiveBridgeE2EMarkdown(report);
  await writeFile(jsonPath, json, 'utf8');
  await writeFile(markdownPath, markdown, 'utf8');
  if (runJsonPath && runMarkdownPath) {
    await writeFile(runJsonPath, json, 'utf8');
    await writeFile(runMarkdownPath, markdown, 'utf8');
  }
  return { jsonPath, markdownPath, runJsonPath, runMarkdownPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const serialIndex = process.argv.indexOf('--serial');
  const requestedSerial = serialIndex >= 0
    ? process.argv[serialIndex + 1]
    : process.env.JARVIS_MOBILE_DEVICE_SERIAL;
  const acousticVoice = process.argv.includes('--acoustic-voice');
  const fileVoice = process.argv.includes('--file-voice');
  const pcVoiceHandoff = process.argv.includes('--pc-voice-handoff');
  const report = await runMobileLiveBridgeE2E({ requestedSerial, acousticVoice, fileVoice, pcVoiceHandoff });
  const artifacts = await writeMobileLiveBridgeE2EArtifacts(report);
  console.log('# JARVIS Mobile Live Bridge E2E');
  console.log(`Status: ${report.status}`);
  console.log(`Reason: ${report.reason ?? 'none'}`);
  console.log(`Live bridge verified: ${report.liveBridgeVerified}`);
  console.log(`Acoustic voice requested: ${report.acousticVoiceRequested}`);
  console.log(`File voice requested: ${report.fileVoiceRequested}`);
  console.log(`Voice input verified: ${report.voiceInputVerified}`);
  console.log(`Voice transcript verified: ${report.voiceTranscriptVerified}`);
  console.log(`Voice audio source verified: ${report.voiceAudioSourceVerified}`);
  console.log(`PC voice handoff requested: ${report.pcVoiceHandoffRequested}`);
  console.log(`PC voice handoff verified: ${report.pcVoiceHandoffVerified}`);
  console.log(`SecureStore restore verified: ${report.secureStoreRestoreVerified}`);
  console.log(`Device revoke verified: ${report.deviceRevokeVerified}`);
  console.log(`SecureStore cleanup verified: ${report.secureStoreCleanupVerified}`);
  console.log(`Reports: ${artifacts.jsonPath}, ${artifacts.markdownPath}`);
  if (!['passed', 'external-blocked'].includes(report.status)) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
