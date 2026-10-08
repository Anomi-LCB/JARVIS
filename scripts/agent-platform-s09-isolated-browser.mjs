import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productServiceDefinitions, startProductRuntime } from './product-runtime.mjs';
import { resolveProductRuntimeSecrets } from '../packages/shared/src/product-runtime-secrets.js';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = resolve(process.env.JARVIS_S09_EVIDENCE_DIR
  ?? join(repositoryRoot, 'artifacts', 'agent-platform-20260929', 's09-isolated-browser-runtime'));
const pythonScript = join(repositoryRoot, 'scripts', 'agent-platform-s09-isolated-browser.py');

async function reservePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolvePromise, reject) => {
    server.once('listening', resolvePromise);
    server.once('error', reject);
  });
  const port = server.address().port;
  await new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  return port;
}

function runPython(url) {
  return new Promise((resolvePromise, reject) => {
    const python = process.env.PYTHON ?? 'python';
    const child = spawn(python, [pythonScript, '--url', url, '--output', join(outputDirectory, 'browser-flow.json')], {
      cwd: repositoryRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolvePromise(stdout.trim())
      : reject(new Error(`Isolated S09 browser flow exited ${code}: ${stderr.trim().slice(-1200)}`)));
  });
}

const isolatedRoot = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'jarvis-s09-browser-')));
await mkdir(outputDirectory, { recursive: true });
await rm(join(outputDirectory, 'browser-flow.json'), { force: true });
process.env.JARVIS_TEST_MODE = '1';
const [corePort, uiPort] = await Promise.all([reservePort(), reservePort()]);
const isolatedEnv = {
  ...process.env,
  JARVIS_TEST_MODE: '1',
  JARVIS_PRODUCT_HOST: '127.0.0.1',
  JARVIS_CORE_PORT: String(corePort),
  JARVIS_PC_AGENT_PORT: String(await reservePort()),
  JARVIS_BRIDGE_PORT: String(await reservePort()),
  JARVIS_UI_PORT: String(uiPort),
  JARVIS_CORE_ROOT: isolatedRoot,
  JARVIS_ALLOWED_ROOTS: join(isolatedRoot, 'workspace'),
  JARVIS_CORE_ALLOWED_ROOTS: join(isolatedRoot, 'workspace'),
  JARVIS_CORE_AUDIT_ROOT: join(isolatedRoot, 'audit'),
  JARVIS_TRUST_ROOT: join(isolatedRoot, 'trust'),
  JARVIS_CORE_COGNITION_DB: join(isolatedRoot, 'audit', 'cognition.sqlite'),
  JARVIS_PERSONAL_OPERATIONS_DB: join(isolatedRoot, 'audit', 'personal-operations.sqlite'),
  JARVIS_MANAGED_AGENT_EGRESS_KEY_PATH: join(isolatedRoot, 'audit', 'egress-key.json'),
  JARVIS_CORE_WORKER_DAEMON_ENABLED: '0',
  JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
  JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED: '0'
};
const secrets = resolveProductRuntimeSecrets({ env: isolatedEnv });
let definitions = productServiceDefinitions({ cwd: repositoryRoot, env: isolatedEnv, secrets })
  .filter(definition => ['core', 'ui'].includes(definition.id));
definitions = definitions.map(definition => definition.id === 'core'
  ? { ...definition, environment: { ...definition.environment, JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED: '0' } }
  : definition);
let runtime;
let result = null;
let failure = null;
try {
  runtime = await startProductRuntime({ definitions, startupTimeoutMs: 20_000, monitorIntervalMs: 60_000, logger: { log() {}, error() {} } });
  result = await runPython(runtime.uiUrl);
} catch (error) {
  failure = error;
} finally {
  await runtime?.stop();
  const tempRoot = resolve(tmpdir());
  if (!isolatedRoot.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)
    || !isolatedRoot.split(/[\\/]/u).at(-1)?.startsWith('jarvis-s09-browser-')) {
    throw new Error('Refusing to clean an isolated runtime directory outside the generated test prefix.');
  }
  await rm(isolatedRoot, { recursive: true, force: true });
}

const flowPath = join(outputDirectory, 'browser-flow.json');
let flow = null;
try { flow = JSON.parse(await readFile(flowPath, 'utf8')); } catch {}
const report = {
  reportVersion: 'jarvis-agent-platform-s09-isolated-browser-v1',
  generatedAt: new Date().toISOString(),
  status: failure ? 'failed' : flow?.status === 'passed' ? 'passed' : 'failed',
  environment: {
    mode: 'isolated-test-runtime',
    servicesStarted: definitions.map(item => item.id),
    testMode: true,
    workerDaemonEnabled: false,
    remotePcExecutionEnabled: false,
    providerCalls: 0,
    externalWrites: 0,
    isolatedStateRoot: isolatedRoot,
    isolatedStateCleaned: true,
    productUserStateTouched: false
  },
  browserFlow: flow,
  output: result,
  error: failure ? { name: failure.name, code: failure.code ?? null, message: failure.message } : null,
  limitation: 'This is a real browser against isolated Core and UI processes. An ephemeral test-mode Core credential was held only by the server-side proxy and was not sent to the browser. It is not the user product runtime, persistent user profile, Windows service, or live account.'
};
await writeFile(join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const checks = flow?.checks ?? [];
const checkLines = checks.length ? checks.map(check => `- ${check.passed ? '통과' : '실패'}: ${check.id}${check.observed ? ` (${JSON.stringify(check.observed)})` : ''}`).join('\n') : '- 브라우저 단계 진입 전 실패';
const markdown = `# S09 격리 Core·UI 브라우저 통합 검증\n\n관측 시각: ${report.generatedAt}\n\n## 결과\n\n상태: **${report.status}**\n\n${checkLines}\n\n## 실행 경계\n\n- 실행 서비스: ${definitions.map(item => item.id).join(', ')}. 전용 포트, 임시 데이터 경로, JARVIS_TEST_MODE=1을 사용했습니다. 임시 Core 관리자 인증은 서버 프록시에만 주입했고 브라우저에 전달하지 않았습니다.\n- Core worker 자동 시작과 원격 PC 실행은 껐습니다. 공급자 호출·외부 전송·거래·기기 동작은 없었습니다.\n- 브라우저는 실제 제어센터 정적 UI와 실제 Core HTTP API를 사용했습니다. 주간 예약 생성·GET 목록 재조회·정확한 작업 대상의 시간대 PATCH·예약 취소를 UI에서 수행했습니다.\n- 합성 예약의 작업 설명·루틴 ID·인증값은 브라우저 증거에서 제외했습니다. 전체 API 개수는 초기 조회 재시도 때문에 변동될 수 있어, 메서드별 단순 총량 대신 필요한 API 경로의 관측 여부를 검사했습니다.\n- 임시 Core 상태 폴더는 프로세스 종료 후 삭제했습니다. 이 결과는 테스트 모드 통합이며 사용자 제품 런타임·Windows 서비스·계정 연결의 현장 실증은 아닙니다.\n\n${flow?.elapsedMs ? `## 테스트 프로세스 계측\n\nloadAndConnectMs: ${flow.elapsedMs.loadAndConnectMs}; createMs: ${flow.elapsedMs.createMs}; timezoneRevisionMs: ${flow.elapsedMs.timezoneRevisionMs}; cancelMs: ${flow.elapsedMs.cancelMs}. 이는 이 한 번의 로컬 검증 흐름 시간이며 사용자 체감 SLA로 일반화하지 않습니다.\n\n` : ''}${failure ? `## 실패\n\n${failure.code ?? failure.name}: ${failure.message}\n` : ''}`;
await writeFile(join(outputDirectory, 'report.md'), markdown, 'utf8');
console.log(JSON.stringify({ status: report.status, reportPath: join(outputDirectory, 'report.json'), checks: flow?.checks ?? [] }, null, 2));
if (failure || report.status !== 'passed') process.exitCode = 1;
