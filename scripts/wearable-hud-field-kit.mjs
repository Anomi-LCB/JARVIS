import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultOutputDir = 'dist/wearable-hud-field-kit';
const scriptRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function workspacePath(workspaceRoot, path) {
  return resolve(workspaceRoot, path);
}

export async function writeWearableHudFieldKit({
  workspaceRoot = process.cwd(),
  outputDir = workspacePath(workspaceRoot, defaultOutputDir),
  bridgeUrl = 'http://127.0.0.1:17777'
} = {}) {
  const clientSource = await readFirstText([
    workspacePath(workspaceRoot, 'apps/wearable-hud/src/browser-client.js'),
    workspacePath(scriptRepoRoot, 'apps/wearable-hud/src/browser-client.js')
  ]);
  const voiceSessionSource = await readFirstText([
    workspacePath(workspaceRoot, 'apps/wearable-hud/src/voice-session.js'),
    workspacePath(scriptRepoRoot, 'apps/wearable-hud/src/voice-session.js')
  ]);
  const fieldLabSource = (await readFirstText([
    workspacePath(workspaceRoot, 'apps/wearable-hud/src/field-lab.js'),
    workspacePath(scriptRepoRoot, 'apps/wearable-hud/src/field-lab.js')
  ])).replace("'./browser-client.js'", "'./wearable-hud-client.js'");
  const fieldServerSource = await readFirstText([
    workspacePath(workspaceRoot, 'apps/wearable-hud/src/field-server.mjs'),
    workspacePath(scriptRepoRoot, 'apps/wearable-hud/src/field-server.mjs')
  ]);
  const sharedHttpSource = await readFirstText([
    workspacePath(workspaceRoot, 'packages/shared/src/http.js'),
    workspacePath(scriptRepoRoot, 'packages/shared/src/http.js')
  ]);
  const runnerApk = await readFirstBufferOptional([
    workspacePath(workspaceRoot, 'apps/wearable-field-runner/app/build/outputs/apk/debug/app-debug.apk'),
    workspacePath(scriptRepoRoot, 'apps/wearable-field-runner/app/build/outputs/apk/debug/app-debug.apk')
  ]);
  const html = renderFieldKitHtml({ bridgeUrl });
  const fieldLabHtml = renderFieldLabHtml({ bridgeUrl });
  const readme = renderReadme({ bridgeUrl });
  const checklist = renderChecklist();
  const adbHarness = renderAdbHarness();
  const server = fieldServerSource.replace(
    "from '../../../packages/shared/src/http.js';",
    "from './jarvis-http.mjs';"
  );
  const productGate = createWearableHudFieldKitProductGate({
    html,
    clientSource,
    voiceSessionSource,
    fieldLabSource,
    fieldLabHtml,
    serverSource: server,
    sharedHttpSource,
    adbHarnessSource: adbHarness
  });
  const manifest = {
    manifestVersion: 'c-d-wearable-hud-field-kit-manifest-v1',
    generatedAt: new Date().toISOString(),
    status: productGate.status,
    bridgeUrl,
    outputDir: resolve(outputDir),
    files: [
      'index.html',
      'wearable-hud-client.js',
      'voice-session.js',
      'wearable-field-lab.js',
      'field-calibration.html',
      'field-server.mjs',
      'jarvis-http.mjs',
      ...(runnerApk ? ['wearable-field-runner.apk'] : []),
      'connect-wearable-adb.ps1',
      'README.md',
      'field-smoke-checklist.md',
      'field-kit-manifest.json'
    ],
    privacy: {
      tokenStorage: 'memory-only',
      rawTranscriptStored: false,
      rawBridgeTokenStored: false
    },
    runnerArtifact: runnerApk ? {
      included: true,
      bytes: runnerApk.length,
      sha256: createHash('sha256').update(runnerApk).digest('hex'),
      packageName: 'local.eureka.jarvis.wearablefield'
    } : {
      included: false,
      buildRequired: true,
      packageName: 'local.eureka.jarvis.wearablefield'
    },
    productGate
  };

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDir, 'index.html'), html, 'utf8'),
    writeFile(resolve(outputDir, 'wearable-hud-client.js'), clientSource, 'utf8'),
    writeFile(resolve(outputDir, 'voice-session.js'), voiceSessionSource, 'utf8'),
    writeFile(resolve(outputDir, 'wearable-field-lab.js'), fieldLabSource, 'utf8'),
    writeFile(resolve(outputDir, 'field-calibration.html'), fieldLabHtml, 'utf8'),
    writeFile(resolve(outputDir, 'field-server.mjs'), server, 'utf8'),
    writeFile(resolve(outputDir, 'jarvis-http.mjs'), sharedHttpSource, 'utf8'),
    writeFile(resolve(outputDir, 'connect-wearable-adb.ps1'), adbHarness, 'utf8'),
    writeFile(resolve(outputDir, 'README.md'), readme, 'utf8'),
    writeFile(resolve(outputDir, 'field-smoke-checklist.md'), checklist, 'utf8'),
    ...(runnerApk ? [writeFile(resolve(outputDir, 'wearable-field-runner.apk'), runnerApk)] : [])
  ]);
  await writeFile(resolve(outputDir, 'field-kit-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function readFirstText(paths) {
  let lastError = null;
  for (const path of paths) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function readFirstBufferOptional(paths) {
  for (const path of paths) {
    try {
      return await readFile(path);
    } catch {
      // The source tree remains usable before the optional Android build.
    }
  }
  return null;
}

export function createWearableHudFieldKitProductGate({
  html = '',
  clientSource = '',
  voiceSessionSource = '',
  fieldLabSource = '',
  fieldLabHtml = '',
  serverSource = '',
  sharedHttpSource = '',
  adbHarnessSource = ''
} = {}) {
  const checks = [
    {
      checkId: 'field_kit_green_hud_shell',
      passed: html.includes('jarvis-wearable-hud-root')
        && html.includes('hud-cockpit')
        && html.includes('hud-orbit')
        && html.includes('hud-action-deck')
        && html.includes('#00ff66')
        && html.includes('wearable-hud-client.js')
        && html.includes('JARVIS 웨어러블 HUD')
    },
    {
      checkId: 'field_kit_browser_live_client',
      passed: clientSource.includes('wearableHudBrowserClientVersion')
        && clientSource.includes('createWearableHudBrowserSnapshot')
        && clientSource.includes('createWearableQuickCommandPlan')
        && clientSource.includes('createWearableHudActionPlan')
        && clientSource.includes('pairWearableHudBrowser')
        && clientSource.includes('WearableVoiceSession')
        && clientSource.includes('voiceSessionVersion')
        && clientSource.includes('웨어러블 관제')
        && clientSource.includes('operatorFirst')
        && clientSource.includes('data-action-deck')
        && clientSource.includes('data-restore-controls')
        && clientSource.includes('bridgeInput?.value || config.bridgeUrl')
        && clientSource.includes('PC 확인 필요')
        && clientSource.includes('stage_task')
        && clientSource.includes('/pairing/start')
        && clientSource.includes('/pairing/confirm')
        && clientSource.includes('/approvals/')
        && clientSource.includes('/tasks')
        && clientSource.includes('/events?eventType=task.status.changed')
    },
    {
      checkId: 'field_kit_voice_v2_ready',
      passed: voiceSessionSource.includes('c-d-wearable-voice-session-v2')
        && voiceSessionSource.includes('interimResults')
        && voiceSessionSource.includes('recognition-restart-scheduled')
        && voiceSessionSource.includes('bargeInCount')
        && voiceSessionSource.includes('createHttpAudioFallbackTranscriber')
        && voiceSessionSource.includes('preferLocalStt')
        && voiceSessionSource.includes('rawTranscriptStored: false')
        && voiceSessionSource.includes('rawAudioStored: false')
    },
    {
      checkId: 'field_kit_physical_lab_ready',
      passed: fieldLabHtml.includes('jarvis-wearable-field-lab')
        && fieldLabHtml.includes('물리 안경 검증')
        && fieldLabSource.includes('c-d-wearable-physical-field-report-v1')
        && fieldLabSource.includes('measureWearableMicrophone')
        && fieldLabSource.includes('measureWearableBridgeLatency')
        && fieldLabSource.includes('showMeasurement')
        && fieldLabSource.includes('speechLevelDbfs')
        && fieldLabSource.includes("fieldCheck('secure_context_ready'")
        && fieldLabSource.includes("fetch('/field-evidence'")
    },
    {
      checkId: 'field_kit_adb_secure_context_harness',
      passed: adbHarnessSource.includes('adb-reverse-verification-v1')
        && adbHarnessSource.includes('reverse "tcp:$HudPort" "tcp:$HudPort"')
        && adbHarnessSource.includes('reverse "tcp:$BridgePort" "tcp:$BridgePort"')
        && adbHarnessSource.includes('wearable-field-runner.apk')
        && adbHarnessSource.includes('install -r $RunnerApkPath')
        && adbHarnessSource.includes("$launchMode = 'dedicated-runner'")
        && adbHarnessSource.includes('rawDeviceSerialStored = $false')
        && adbHarnessSource.includes('http://127.0.0.1:$HudPort/field-calibration.html')
    },
    {
      checkId: 'field_kit_memory_only_token',
      passed: clientSource.includes('memoryOnlyToken')
        && !clientSource.includes('localStorage')
        && !clientSource.includes('sessionStorage')
        && !html.includes('Bearer ')
    },
    {
      checkId: 'field_kit_high_risk_pc_handoff',
      passed: clientSource.includes('request_pc_confirmation')
        && clientSource.includes('wearable_high_risk_pc_confirmation')
        && clientSource.includes('pc-confirmation-required')
    },
    {
      checkId: 'field_kit_static_server_ready',
      passed: serverSource.includes('createServer')
        && serverSource.includes('0.0.0.0')
        && serverSource.includes('wearable-hud-field-server')
        && serverSource.includes('/field-evidence')
        && serverSource.includes('/voice/transcribe')
        && serverSource.includes('JARVIS_WEARABLE_STT_COMMAND')
        && serverSource.includes("from './jarvis-http.mjs'")
        && sharedHttpSource.includes('listenOnFetchSafePort')
    }
  ];
  return {
    productGateVersion: 'c-d-wearable-hud-field-kit-product-gate-v1',
    status: checks.every((item) => item.passed) ? 'passed' : 'blocked',
    checks
  };
}

function renderFieldKitHtml({ bridgeUrl }) {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>JARVIS 웨어러블 HUD</title>
  <link rel="icon" href="data:," />
  <style>
    :root {
      color-scheme: dark;
      --hud-green: #00ff66;
      --hud-dim: #37a86b;
      --hud-bg: #000400;
      --hud-warn: #b7ff5a;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      min-height: 100%;
      background: var(--hud-bg);
      color: var(--hud-green);
      font-family: Consolas, "SFMono-Regular", "Roboto Mono", monospace;
      letter-spacing: 0;
    }
    body {
      min-height: 100vh;
      overflow: hidden;
    }
    #jarvis-wearable-hud-root {
      position: relative;
      width: 100%;
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      gap: 10px;
      padding: clamp(18px, 4vh, 44px) clamp(18px, 6vw, 96px);
      background:
        linear-gradient(rgba(0, 255, 102, 0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 255, 102, 0.025) 1px, transparent 1px),
        #000400;
      background-size: 100% 8px, 44px 100%;
      text-shadow: 0 0 8px rgba(0, 255, 102, 0.32);
      overflow: hidden;
    }
    .hud-status-bar {
      display: grid;
      grid-template-columns: 170px 1fr auto;
      gap: 14px;
      align-items: center;
      min-height: 42px;
      border: 1px solid rgba(55, 168, 107, 0.34);
      background: rgba(0, 14, 6, 0.72);
      padding: 8px 10px;
    }
    .hud-brand {
      display: grid;
      gap: 1px;
    }
    .hud-brand strong {
      font-size: 16px;
      line-height: 1;
    }
    .hud-brand span,
    .hud-status-cluster span,
    .hud-action-chip,
    .hud-metric span,
    .hud-metric small,
    .hud-panel-kicker,
    .hud-panel-row span,
    .hud-primary span,
    .hud-primary small,
    .hud-orbit-core span,
    .hud-orbit-core small {
      color: var(--hud-dim);
      font-size: 10px;
      text-transform: uppercase;
    }
    .hud-action-deck {
      min-width: 0;
      display: grid;
      grid-template-columns: repeat(4, minmax(72px, 1fr));
      gap: 8px;
    }
    .hud-action-chip,
    .hud-status-cluster span {
      min-height: 20px;
      display: grid;
      place-items: center;
      border: 1px solid rgba(55, 168, 107, 0.24);
      background: rgba(0, 8, 4, 0.72);
      border-radius: 3px;
    }
    .hud-action-chip {
      width: 100%;
      padding: 0 8px;
      color: var(--hud-green);
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
    }
    .hud-action-chip:hover,
    .hud-action-chip:focus {
      border-color: rgba(0, 255, 102, 0.56);
      background: rgba(0, 255, 102, 0.05);
    }
    .hud-status-cluster {
      display: grid;
      grid-auto-flow: column;
      gap: 8px;
    }
    .hud-metric-rail {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .hud-metric,
    .hud-panel,
    .hud-focus,
    .hud-control-dock {
      border: 1px solid rgba(55, 168, 107, 0.28);
      background: rgba(0, 10, 5, 0.74);
      box-shadow: inset 0 0 0 1px rgba(0, 255, 102, 0.035);
    }
    .hud-metric {
      min-height: 52px;
      display: grid;
      align-content: center;
      gap: 2px;
      padding: 8px 10px;
    }
    .hud-metric strong {
      font-size: 16px;
      line-height: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: clip;
    }
    .hud-cockpit {
      display: grid;
      grid-template-columns: minmax(190px, 0.8fr) minmax(280px, 1.5fr) minmax(190px, 0.8fr);
      gap: 10px;
      min-height: 0;
    }
    .hud-panel {
      display: grid;
      align-content: start;
      gap: 9px;
      padding: 10px;
      min-width: 0;
      overflow: hidden;
    }
    .hud-panel-kicker {
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(55, 168, 107, 0.22);
    }
    .hud-panel-row {
      display: grid;
      gap: 3px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(55, 168, 107, 0.14);
    }
    .hud-quick-command {
      width: 100%;
      min-height: 0;
      text-align: left;
      background: transparent;
      border: 0;
      border-bottom: 1px solid rgba(55, 168, 107, 0.14);
      color: var(--hud-green);
      cursor: pointer;
    }
    .hud-quick-command:hover,
    .hud-quick-command:focus {
      border-bottom-color: rgba(0, 255, 102, 0.48);
      background: rgba(0, 255, 102, 0.045);
    }
    .hud-panel-row strong {
      font-size: 15px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: clip;
    }
    .hud-focus {
      display: grid;
      grid-template-columns: minmax(150px, 0.7fr) minmax(260px, 1.3fr);
      grid-template-rows: auto 1fr;
      gap: 12px;
      align-content: center;
      padding: clamp(14px, 3vh, 28px);
      min-width: 0;
      overflow: hidden;
    }
    .hud-orbit {
      grid-row: 1 / span 2;
      width: min(26vmin, 190px);
      aspect-ratio: 1;
      position: relative;
      justify-self: center;
      align-self: center;
      display: grid;
      place-items: center;
      border-radius: 999px;
      background:
        radial-gradient(circle at center, #000400 0 55%, transparent 56%),
        conic-gradient(var(--hud-green) var(--hud-progress-deg, 0deg), rgba(55, 168, 107, 0.18) 0);
      filter: drop-shadow(0 0 18px rgba(0, 255, 102, 0.12));
    }
    .hud-orbit::before {
      content: "";
      width: 76%;
      aspect-ratio: 1;
      border-radius: 999px;
      border: 1px solid rgba(55, 168, 107, 0.24);
      position: absolute;
    }
    .hud-orbit-core {
      position: relative;
      z-index: 1;
      display: grid;
      place-items: center;
      gap: 6px;
    }
    .hud-orbit-core strong {
      font-size: 46px;
      line-height: 0.9;
    }
    .hud-primary {
      align-self: end;
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .hud-primary strong {
      font-size: 28px;
      line-height: 1.08;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .hud-lines {
      display: grid;
      align-content: start;
      gap: 6px;
      min-height: 0;
    }
    .hud-line {
      min-height: 22px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 16px;
      line-height: 1.15;
      color: rgba(0, 255, 102, 0.86);
      border-top: 1px solid rgba(55, 168, 107, 0.13);
      padding-top: 5px;
    }
    .hud-approval-risk {
      color: var(--hud-warn);
    }
    .hud-footer {
      color: var(--hud-dim);
    }
    .hud-control-dock {
      display: grid;
      grid-template-columns: minmax(150px, 1fr) minmax(90px, 0.6fr) repeat(4, auto);
      gap: 8px;
      align-items: center;
      opacity: 0.92;
      padding: 8px;
    }
    #jarvis-wearable-hud-root[data-controls="hidden"] .hud-control-dock {
      opacity: 0;
      pointer-events: none;
    }
    .hud-controls-restore {
      display: none;
      position: absolute;
      right: 8px;
      bottom: 8px;
      z-index: 3;
      min-height: 28px;
      padding: 0 8px;
      border: 1px solid var(--hud-dim);
      background: #001006;
      color: var(--hud-green);
    }
    #jarvis-wearable-hud-root[data-controls="hidden"] .hud-controls-restore { display: block; }
    input, button {
      min-height: 34px;
      border: 1px solid var(--hud-dim);
      background: #001006;
      color: var(--hud-green);
      font: inherit;
      font-size: 14px;
      border-radius: 0;
      outline: none;
    }
    input { width: 100%; padding: 0 8px; }
    button { padding: 0 10px; cursor: pointer; }
    button:focus, input:focus { border-color: var(--hud-green); }
    @media (max-width: 900px), (max-height: 520px) {
      #jarvis-wearable-hud-root {
        grid-template-rows: auto auto minmax(0, 1fr) auto;
        gap: 5px;
        padding: 5px;
      }
      .hud-status-bar {
        grid-template-columns: 112px minmax(0, 1fr) auto;
        min-height: 36px;
        gap: 5px;
        padding: 5px 6px;
      }
      .hud-brand strong { font-size: 14px; }
      .hud-brand span { font-size: 8px; }
      .hud-action-deck { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
      .hud-action-chip { min-width: 0; min-height: 20px; padding: 0 3px; font-size: 9px; }
      .hud-status-cluster { gap: 3px; }
      .hud-status-cluster span { min-width: 0; min-height: 18px; padding: 0 4px; font-size: 8px; }
      .hud-metric-rail { gap: 4px; }
      .hud-metric { min-height: 44px; padding: 5px 6px; }
      .hud-metric strong { font-size: 14px; }
      .hud-cockpit {
        grid-template-columns: minmax(148px, 0.72fr) minmax(250px, 1.25fr) minmax(148px, 0.72fr);
        gap: 5px;
      }
      .hud-panel { gap: 3px; padding: 6px; }
      .hud-panel-kicker { padding-bottom: 4px; font-size: 8px; }
      .hud-panel-row { gap: 2px; padding: 4px 0; }
      .hud-panel-row span { font-size: 8px; }
      .hud-panel-row strong { font-size: 12px; }
      .hud-focus {
        grid-template-columns: 96px minmax(0, 1fr);
        gap: 6px;
        padding: 7px;
      }
      .hud-orbit { width: 92px; }
      .hud-orbit-core { gap: 3px; }
      .hud-orbit-core strong { font-size: 30px; }
      .hud-primary { gap: 3px; }
      .hud-primary strong { font-size: 18px; }
      .hud-primary span, .hud-primary small { font-size: 8px; }
      .hud-lines { gap: 3px; }
      .hud-line { min-height: 17px; padding-top: 3px; font-size: 11px; }
      .hud-control-dock {
        grid-template-columns: minmax(115px, 1fr) minmax(64px, 0.45fr) repeat(4, auto);
        gap: 3px;
        padding: 4px;
      }
      input, button { min-height: 27px; padding: 0 5px; font-size: 9px; }
    }
    @media (max-width: 560px) {
      #jarvis-wearable-hud-root {
        grid-template-rows: auto 1fr auto;
        gap: 6px;
        padding: 10px;
      }
      .hud-status-bar {
        grid-template-columns: minmax(0, 1fr) auto;
        min-height: 32px;
        gap: 8px;
        padding: 6px 8px;
      }
      .hud-brand span,
      .hud-panel-left {
        display: none;
      }
      .hud-action-deck {
        grid-template-columns: repeat(2, minmax(58px, 1fr));
        gap: 4px;
      }
      .hud-metric-rail {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .hud-status-cluster { gap: 5px; }
      .hud-status-cluster span {
        min-height: 18px;
        padding: 0 6px;
      }
      .hud-cockpit {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(0, 1fr) auto;
        gap: 6px;
        min-height: 0;
      }
      .hud-focus {
        grid-template-columns: minmax(82px, 0.35fr) minmax(0, 1fr);
        grid-template-rows: auto auto;
        gap: 8px;
        padding: 10px;
      }
      .hud-orbit {
        grid-row: 1 / span 2;
        width: min(28vmin, 112px);
      }
      .hud-orbit-core { gap: 3px; }
      .hud-orbit-core strong { font-size: 30px; }
      .hud-primary {
        align-self: center;
        gap: 3px;
      }
      .hud-primary strong { font-size: 19px; }
      .hud-lines { gap: 3px; }
      .hud-line {
        min-height: 18px;
        font-size: 12px;
        padding-top: 3px;
      }
      .hud-panel {
        gap: 4px;
        padding: 8px;
      }
      .hud-panel-kicker { padding-bottom: 5px; }
      .hud-panel-row {
        min-height: 36px;
        padding: 5px 0;
      }
      .hud-panel-row strong { font-size: 13px; }
      .hud-control-dock {
        grid-template-columns: minmax(0, 1fr) minmax(60px, 0.5fr) repeat(4, auto);
        gap: 4px;
        padding: 5px;
      }
      input, button {
        min-height: 28px;
        padding: 0 6px;
        font-size: 11px;
      }
    }
    @media (max-width: 560px), (max-height: 300px) {
      #jarvis-wearable-hud-root {
        grid-template-rows: auto minmax(0, 1fr) auto;
        gap: 4px;
        padding: 4px;
      }
      .hud-status-bar {
        grid-template-columns: 62px minmax(0, 1fr);
        min-height: 32px;
        gap: 4px;
        padding: 4px 5px;
      }
      .hud-brand span, .hud-status-cluster, .hud-metric-rail, .hud-panel-left, .hud-panel-right { display: none; }
      .hud-action-deck { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 3px; }
      .hud-action-chip { min-height: 22px; padding: 0 2px; font-size: 8px; }
      .hud-cockpit { display: block; min-height: 0; }
      .hud-focus {
        height: 100%;
        grid-template-columns: 76px minmax(0, 1fr);
        grid-template-rows: auto minmax(0, 1fr);
        gap: 4px 7px;
        padding: 6px;
      }
      .hud-orbit { grid-row: 1 / span 2; width: 70px; }
      .hud-orbit-core strong { font-size: 24px; }
      .hud-orbit-core span, .hud-orbit-core small { font-size: 7px; }
      .hud-primary { align-self: end; }
      .hud-primary strong { font-size: 16px; }
      .hud-primary span, .hud-primary small { font-size: 7px; }
      .hud-lines { align-self: start; }
      .hud-line { min-height: 15px; font-size: 9px; }
      .hud-control-dock { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 3px; padding: 3px; }
      .hud-control-dock input { display: none; }
      .hud-control-dock button { min-width: 0; min-height: 25px; padding: 0 3px; font-size: 9px; }
    }
  </style>
</head>
<body>
  <main id="jarvis-wearable-hud-root" data-bridge-url="${escapeHtml(bridgeUrl)}"></main>
  <script type="module" src="./wearable-hud-client.js"></script>
</body>
</html>
`;
}

function renderFieldLabHtml({ bridgeUrl }) {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>JARVIS 물리 안경 검증</title>
  <link rel="icon" href="data:," />
  <style>
    :root {
      color-scheme: dark;
      --green: #00ff66;
      --dim: #37a86b;
      --line: rgba(0, 255, 102, 0.24);
      --panel: rgba(0, 18, 8, 0.78);
      --bg: #000400;
      font-family: "Noto Sans KR", "Malgun Gothic", sans-serif;
      letter-spacing: 0;
    }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: var(--bg); color: var(--green); }
    body {
      background-image: linear-gradient(rgba(0, 255, 102, 0.025) 1px, transparent 1px);
      background-size: 100% 5px;
    }
    button, input { font: inherit; letter-spacing: 0; }
    button { color: var(--green); background: transparent; border: 1px solid var(--line); cursor: pointer; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
    #jarvis-wearable-field-lab {
      width: min(100%, 1600px);
      height: 100dvh;
      min-height: 320px;
      margin: 0 auto;
      padding: max(8px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left));
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto auto;
      gap: 8px;
    }
    .field-header, .field-identity, .field-footer { border-block: 1px solid var(--line); background: var(--panel); }
    .field-header {
      min-height: 44px;
      padding: 7px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .field-header div { display: flex; align-items: baseline; gap: 10px; }
    .field-header strong { font-size: 16px; }
    .field-header span, .field-header output { color: var(--dim); font-size: 12px; }
    .field-identity {
      padding: 7px 10px;
      display: grid;
      grid-template-columns: minmax(140px, 0.7fr) minmax(220px, 1.3fr) auto;
      gap: 8px;
      align-items: end;
    }
    .field-identity label { display: grid; gap: 3px; color: var(--dim); font-size: 10px; }
    .field-identity input:not([type="checkbox"]) {
      width: 100%; min-height: 30px; padding: 0 8px; color: var(--green); background: rgba(0, 7, 3, 0.9); border: 1px solid var(--line);
    }
    .field-identity .field-check { min-height: 30px; display: flex; flex-direction: row; align-items: center; gap: 7px; color: var(--green); font-size: 11px; }
    .field-tests {
      min-height: 0;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 7px;
    }
    .field-tests button {
      min-width: 0;
      padding: 12px;
      display: grid;
      align-content: center;
      justify-items: start;
      gap: 7px;
      text-align: left;
      background: rgba(0, 12, 5, 0.62);
    }
    .field-tests button:hover { border-color: var(--green); background: rgba(0, 26, 11, 0.8); }
    .field-tests button[data-passed="true"] { border-color: var(--green); }
    .field-tests button[data-passed="false"] { border-color: #ffbf47; }
    .field-tests button[data-passed="false"] small { color: #ffbf47; }
    .field-tests button:disabled { cursor: not-allowed; opacity: 0.38; border-color: var(--line); }
    .field-tests button span { color: var(--dim); font-size: 10px; }
    .field-tests button strong { font-size: 22px; }
    .field-tests button small { max-width: 100%; color: var(--dim); font-size: 11px; overflow-wrap: anywhere; }
    .field-scenarios { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 5px; }
    .field-scenarios label {
      min-height: 32px;
      padding: 0 7px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 1px solid var(--line);
      color: var(--dim);
      font-size: 10px;
    }
    input[type="checkbox"] { accent-color: var(--green); }
    .field-footer {
      min-height: 42px;
      padding: 6px 8px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }
    .field-footer output { min-width: 0; color: var(--dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .field-footer output[data-passed="true"] { color: var(--green); }
    .field-footer output[data-passed="false"] { color: #ffbf47; }
    .field-footer button { min-height: 30px; padding: 0 14px; background: rgba(0, 255, 102, 0.06); }
    @media (max-width: 760px), (max-height: 460px) {
      #jarvis-wearable-field-lab { gap: 5px; padding: 5px; }
      .field-header { min-height: 34px; padding: 4px 7px; }
      .field-identity { grid-template-columns: minmax(105px, 0.7fr) minmax(130px, 1.3fr) auto; padding: 4px 7px; gap: 4px; }
      .field-identity input:not([type="checkbox"]) { min-height: 26px; font-size: 10px; }
      .field-tests { gap: 4px; }
      .field-tests button { padding: 7px; gap: 3px; }
      .field-tests button strong { font-size: 16px; }
      .field-tests button small { font-size: 9px; }
      .field-scenarios { gap: 3px; }
      .field-scenarios label { min-height: 26px; padding: 0 3px; font-size: 9px; }
      .field-footer { min-height: 34px; padding: 3px 5px; }
      .field-footer button { min-height: 27px; }
    }
    @media (max-width: 520px) {
      html, body { overflow: auto; }
      #jarvis-wearable-field-lab { height: auto; min-height: 100dvh; grid-template-rows: auto auto auto auto auto; }
      .field-identity { grid-template-columns: 1fr; }
      .field-tests { grid-template-columns: repeat(2, minmax(0, 1fr)); min-height: 260px; }
      .field-scenarios { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 520px) and (max-height: 300px) {
      #jarvis-wearable-field-lab { padding: 3px; gap: 3px; }
      .field-header { min-height: 28px; padding: 2px 5px; }
      .field-header div { gap: 6px; }
      .field-header strong { font-size: 13px; }
      .field-header span { display: none; }
      .field-header output { font-size: 9px; }
      .field-identity { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 3px 5px; gap: 3px; }
      .field-identity label { font-size: 8px; }
      .field-identity input:not([type="checkbox"]) { min-height: 22px; padding-inline: 5px; font-size: 9px; }
      .field-identity .field-check { grid-column: 1 / -1; min-height: 20px; font-size: 9px; }
      .field-tests { min-height: 176px; gap: 3px; }
      .field-tests button { min-height: 86px; padding: 5px; }
      .field-tests button strong { font-size: 14px; }
      .field-tests button span, .field-tests button small { font-size: 8px; }
      .field-scenarios label { min-height: 24px; font-size: 8px; }
      .field-footer output { font-size: 9px; }
    }
  </style>
</head>
<body>
  <main id="jarvis-wearable-field-lab" data-bridge-url="${escapeHtml(bridgeUrl)}"></main>
  <script type="module">
    const { installWearableFieldLab } = await import(
      new URL('./wearable-field-lab.js', window.location.href)
    );
    installWearableFieldLab({ initialBridgeUrl: ${JSON.stringify(bridgeUrl)} });
  </script>
</body>
</html>
`;
}

function renderReadme({ bridgeUrl }) {
  return `# JARVIS 웨어러블 HUD 필드 키트

이 폴더는 AI 스마트 안경과 초록 단색 HUD 표시 장치를 위한 브라우저 실행 키트입니다.

실행:

\`\`\`powershell
node field-server.mjs --host 0.0.0.0 --port 4176
\`\`\`

출력된 URL을 안경 브라우저나 미러링 화면에서 여세요. 기본 브릿지 주소: \`${bridgeUrl}\`. 브라우저가 없는 Android 안경은 키트에 포함된 전용 Field Runner APK를 ADB 하네스가 자동 설치합니다.

- 실행 HUD: \`http://<PC-IP>:4176/\`
- 물리 안경 검증: \`http://<PC-IP>:4176/field-calibration.html\`

마이크 검증은 보안 컨텍스트가 필수입니다. Android/ADB 호환 안경은 아래 하네스를 우선 사용합니다. HUD와 브릿지를 안경의 localhost로 역방향 연결하고 검증 화면을 엽니다.

\`\`\`powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\connect-wearable-adb.ps1
\`\`\`

하네스는 \`wearable-field-runner.apk\`가 있으면 전용 보안 WebView를 우선 사용하고, APK가 없을 때만 브라우저 URL Activity를 시도합니다. LAN HTTP 주소는 화면과 연결 확인용입니다. ADB를 지원하지 않는 기기는 신뢰된 HTTPS 프록시 또는 제조사 WebView의 보안 배포 채널을 사용해야 합니다.

브라우저 음성 인식을 지원하지 않는 안경에서 로컬 STT 폴백을 쓰려면 서버 실행 전에 환경변수로 실행 파일과 구조화된 인자를 설정합니다. 명령은 셸을 거치지 않고 직접 실행되며 오디오 임시 파일은 처리 직후 제거됩니다.

\`\`\`powershell
$env:JARVIS_WEARABLE_STT_COMMAND = "C:\\path\\to\\stt.exe"
$env:JARVIS_WEARABLE_STT_ARGS_JSON = '["--input","{inputPath}","--language","{language}"]'
\`\`\`

보안 기준:

- 기기 토큰은 브라우저 메모리에만 유지합니다.
- 음성 원문은 HUD에 저장하지 않습니다.
- 마이크 원음과 STT 임시 파일은 검증 증거에 저장하지 않습니다.
- 고위험 승인은 안경에서 직접 승인하지 않고 PC 확인을 요청합니다.
- 화면에는 짧게 비식별 처리된 HUD 라인만 표시합니다.
`;
}

function renderChecklist() {
  return `# 웨어러블 HUD 현장 점검표

- 안경 네트워크에서 브릿지에 접근됩니다.
- 마이크 측정 전 화면 상태가 보안 연결로 표시되며, Android 계열은 \`connect-wearable-adb.ps1\`로 localhost 연결을 검증합니다.
- HUD가 검정 배경과 #00ff66 초록 텍스트로 전체 화면에 열립니다.
- 브릿지 주소와 토큰이 맞으면 상태가 저하/오프라인에서 동기화로 바뀝니다.
- 음성 버튼이 "자비스 상태"를 인식하고 프레임을 갱신합니다.
- 음성 듣기를 중지했다가 다시 시작할 수 있고 일시적 오류 후 자동 복구됩니다.
- \`field-calibration.html\`에서 화면, 마이크 SNR/클리핑, 음성 명령, 브리지 p95를 측정합니다.
- 실제 안경 확인과 실내/실외/이동/연결복구/발열·배터리를 모두 확인해야 물리 필드 게이트가 통과합니다.
- Tier 3 승인은 "PC 확인 필요"로 표시됩니다.
- Tier 3에서 "자비스 승인"이라고 말하면 직접 승인 대신 PC 확인을 요청합니다.
- 스크린샷이나 생성 리포트에 원문 토큰, Windows 경로, 음성 원문이 노출되지 않습니다.
`;
}

function renderAdbHarness() {
  return `#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Serial = '',
  [ValidateRange(1, 65535)][int]$HudPort = 4176,
  [ValidateRange(1, 65535)][int]$BridgePort = 17777,
  [string]$ReportPath = '',
  [string]$RunnerApkPath = '',
  [string]$RunnerComponent = 'local.eureka.jarvis.wearablefield/.FieldLabActivity',
  [switch]$SkipLaunch
)

$ErrorActionPreference = 'Stop'
if (-not $ReportPath) { $ReportPath = Join-Path $PSScriptRoot 'adb-reverse-verification.json' }
if (-not $RunnerApkPath) { $RunnerApkPath = Join-Path $PSScriptRoot 'wearable-field-runner.apk' }
$adbCommand = Get-Command adb -ErrorAction Stop
$adb = $adbCommand.Source
$deviceRows = @(& $adb devices) | Select-Object -Skip 1 | Where-Object { $_ -match '^\\S+\\s+device$' }
$deviceSerials = @($deviceRows | ForEach-Object { ($_ -split '\\s+')[0] })

if ($Serial) {
  if ($deviceSerials -notcontains $Serial) { throw 'The requested ADB device is not connected and authorized.' }
  $deviceSerial = $Serial
} elseif ($deviceSerials.Count -eq 1) {
  $deviceSerial = $deviceSerials[0]
} elseif ($deviceSerials.Count -eq 0) {
  throw 'No authorized ADB wearable is connected.'
} else {
  throw 'Multiple ADB devices are connected. Run again with -Serial.'
}

& $adb -s $deviceSerial reverse "tcp:$HudPort" "tcp:$HudPort" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to reverse the wearable HUD port.' }
& $adb -s $deviceSerial reverse "tcp:$BridgePort" "tcp:$BridgePort" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to reverse the JARVIS Bridge port.' }

$reverseList = @(& $adb -s $deviceSerial reverse --list)
$hudReady = [bool]($reverseList | Where-Object { $_ -match [regex]::Escape("tcp:$HudPort tcp:$HudPort") })
$bridgeReady = [bool]($reverseList | Where-Object { $_ -match [regex]::Escape("tcp:$BridgePort tcp:$BridgePort") })
if (-not $hudReady -or -not $bridgeReady) { throw 'ADB reverse verification failed.' }

$url = "http://127.0.0.1:$HudPort/field-calibration.html"
$launchMode = 'skipped'
$runnerInstalled = $false
if (-not $SkipLaunch) {
  if (Test-Path -LiteralPath $RunnerApkPath) {
    $installOutput = @(& $adb -s $deviceSerial install -r $RunnerApkPath)
    if ($LASTEXITCODE -ne 0 -or -not ($installOutput -match 'Success')) {
      throw 'The dedicated wearable Field Runner could not be installed.'
    }
    $runnerInstalled = $true
    & $adb -s $deviceSerial shell pm grant local.eureka.jarvis.wearablefield android.permission.RECORD_AUDIO 2>$null | Out-Null
    $launchOutput = @(& $adb -s $deviceSerial shell am start -W -n $RunnerComponent --es url $url)
    $focusOutput = @(& $adb -s $deviceSerial shell dumpsys window)
    if ($LASTEXITCODE -ne 0 -or -not ($launchOutput -match 'Status: ok') -or -not ($focusOutput -match 'local.eureka.jarvis.wearablefield')) {
      throw 'The dedicated wearable Field Runner did not reach the foreground.'
    }
    $launchMode = 'dedicated-runner'
  } else {
    $launchOutput = @(& $adb -s $deviceSerial shell am start -a android.intent.action.VIEW -d $url)
    if ($LASTEXITCODE -ne 0 -or $launchOutput -match 'Error|No Activity found|unable to resolve') {
      throw 'No wearable browser is available and wearable-field-runner.apk is missing.'
    }
    $launchMode = 'browser'
  }
}

$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $deviceHashBytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($deviceSerial))
} finally {
  $sha256.Dispose()
}
$deviceHash = -join ($deviceHashBytes | ForEach-Object { $_.ToString('x2') })
$report = [ordered]@{
  reportVersion = 'adb-reverse-verification-v1'
  generatedAt = [DateTime]::UtcNow.ToString('o')
  status = 'passed'
  deviceHash = $deviceHash.Substring(0, 12)
  rawDeviceSerialStored = $false
  secureContextUrl = $url
  hudPort = $HudPort
  bridgePort = $BridgePort
  hudReverseVerified = $hudReady
  bridgeReverseVerified = $bridgeReady
  launched = -not $SkipLaunch
  launchMode = $launchMode
  runnerInstalled = $runnerInstalled
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
Write-Host "Wearable secure-context tunnel ready: $url"
Write-Host "Wrote $ReportPath"
`;
}

function renderStaticServer() {
  return `import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = parseArgs(process.argv.slice(2));
const host = args.host ?? '0.0.0.0';
const port = Number(args.port ?? 4176);
const root = resolve(args.root ?? fileURLToPath(new URL('.', import.meta.url)));
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = resolve(join(root, normalize(pathname).replace(/^([/\\\\])+/, '')));
  if (!filePath.startsWith(root + sep) && filePath !== root) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-jarvis-server': 'wearable-hud-field-server'
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, host, () => {
  console.log('# wearable-hud-field-server');
  console.log(\`Local:   http://127.0.0.1:\${port}/\`);
  console.log(\`Network: http://<this-pc-ip>:\${port}/\`);
});

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host') parsed.host = argv[++index];
    else if (arg === '--port') parsed.port = argv[++index];
    else if (arg === '--root') parsed.root = argv[++index];
  }
  return parsed;
}
`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace-root') args.workspaceRoot = argv[++index];
    else if (arg === '--output-dir' || arg === '--output') args.outputDir = argv[++index];
    else if (arg === '--bridge-url') args.bridgeUrl = argv[++index];
  }
  if (args.outputDir && args.workspaceRoot) args.outputDir = workspacePath(args.workspaceRoot, args.outputDir);
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = await writeWearableHudFieldKit(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS 웨어러블 HUD 필드 키트');
  console.log(`Status: ${manifest.status}`);
  console.log(`Output: ${manifest.outputDir}`);
  console.log('Run: node dist/wearable-hud-field-kit/field-server.mjs --host 0.0.0.0 --port 4176');
  if (manifest.status === 'blocked') process.exitCode = 1;
}
