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
  const html = renderFieldKitHtml({ bridgeUrl });
  const readme = renderReadme({ bridgeUrl });
  const checklist = renderChecklist();
  const server = renderStaticServer();
  const productGate = createWearableHudFieldKitProductGate({
    html,
    clientSource,
    serverSource: server
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
      'field-server.mjs',
      'README.md',
      'field-smoke-checklist.md',
      'field-kit-manifest.json'
    ],
    privacy: {
      tokenStorage: 'memory-only',
      rawTranscriptStored: false,
      rawBridgeTokenStored: false
    },
    productGate
  };

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDir, 'index.html'), html, 'utf8'),
    writeFile(resolve(outputDir, 'wearable-hud-client.js'), clientSource, 'utf8'),
    writeFile(resolve(outputDir, 'field-server.mjs'), server, 'utf8'),
    writeFile(resolve(outputDir, 'README.md'), readme, 'utf8'),
    writeFile(resolve(outputDir, 'field-smoke-checklist.md'), checklist, 'utf8')
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

export function createWearableHudFieldKitProductGate({
  html = '',
  clientSource = '',
  serverSource = ''
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
        && clientSource.includes('SpeechRecognition')
        && clientSource.includes('웨어러블 관제')
        && clientSource.includes('operatorFirst')
        && clientSource.includes('data-action-deck')
        && clientSource.includes('PC 확인 필요')
        && clientSource.includes('stage_task')
        && clientSource.includes('/pairing/start')
        && clientSource.includes('/pairing/confirm')
        && clientSource.includes('/approvals/')
        && clientSource.includes('/tasks')
        && clientSource.includes('/events?eventType=task.status.changed')
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
      font-size: clamp(34px, 8vmin, 68px);
      line-height: 0.9;
    }
    .hud-primary {
      align-self: end;
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .hud-primary strong {
      font-size: clamp(20px, 4vmin, 36px);
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
      font-size: clamp(13px, 2.4vmin, 20px);
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
      .hud-orbit-core strong { font-size: clamp(24px, 8vmin, 36px); }
      .hud-primary {
        align-self: center;
        gap: 3px;
      }
      .hud-primary strong { font-size: clamp(18px, 5vmin, 24px); }
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
  </style>
</head>
<body>
  <main id="jarvis-wearable-hud-root" data-bridge-url="${escapeHtml(bridgeUrl)}"></main>
  <script type="module" src="./wearable-hud-client.js"></script>
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

출력된 URL을 안경 브라우저나 미러링 화면에서 여세요. 기본 브릿지 주소: \`${bridgeUrl}\`.

보안 기준:

- 기기 토큰은 브라우저 메모리에만 유지합니다.
- 음성 원문은 HUD에 저장하지 않습니다.
- 고위험 승인은 안경에서 직접 승인하지 않고 PC 확인을 요청합니다.
- 화면에는 짧게 비식별 처리된 HUD 라인만 표시합니다.
`;
}

function renderChecklist() {
  return `# 웨어러블 HUD 현장 점검표

- 안경 네트워크에서 브릿지에 접근됩니다.
- HUD가 검정 배경과 #00ff66 초록 텍스트로 전체 화면에 열립니다.
- 브릿지 주소와 토큰이 맞으면 상태가 저하/오프라인에서 동기화로 바뀝니다.
- 음성 버튼이 "자비스 상태"를 인식하고 프레임을 갱신합니다.
- Tier 3 승인은 "PC 확인 필요"로 표시됩니다.
- Tier 3에서 "자비스 승인"이라고 말하면 직접 승인 대신 PC 확인을 요청합니다.
- 스크린샷이나 생성 리포트에 원문 토큰, Windows 경로, 음성 원문이 노출되지 않습니다.
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
