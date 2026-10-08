import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfiguredCoreServiceRuntime } from './core-service-runtime.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { IntegrationCredentialVault } from '../packages/core/src/personal-operations/integration-security.js';
import { resolveProductRuntimeSecrets } from '../packages/shared/src/product-runtime-secrets.js';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = resolve(root, 'artifacts/agent-platform-20260930/provider-readiness-browser');
const pythonScript = join(root, 'scripts/provider-readiness-browser-qa.py');
const tempRoot = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'jarvis-provider-readiness-')));
const uiPortServer = await import('node:http').then(({ createServer }) => createServer());
uiPortServer.listen(0, '127.0.0.1');
await new Promise((resolvePromise, reject) => { uiPortServer.once('listening', resolvePromise); uiPortServer.once('error', reject); });
const uiPort = uiPortServer.address().port;
await new Promise((resolvePromise, reject) => uiPortServer.close(error => error ? reject(error) : resolvePromise()));
const secrets = resolveProductRuntimeSecrets({ env: { ...process.env, JARVIS_TEST_MODE: '1' } });
const adminToken = secrets.coreToken;
const corePort = 0;
const vaultPath = join(tempRoot, 'integrations', 'credentials.dpapi.json');
const vault = new IntegrationCredentialVault({ path: vaultPath, platform: 'win32' });
const checkedAt = new Date().toISOString();
const seeded = [
  { provider: 'xai', connectorId: 'jarvis-model-xai', scope: 'model.plan', status: 'authentication-rejected', errorCode: 'A_MODEL_PROVIDER_AUTH_REJECTED' },
  { provider: 'meta', connectorId: 'jarvis-model-meta', scope: 'model.plan', status: 'authorization-rejected', errorCode: 'A_MODEL_PROVIDER_POLICY_OR_SCOPE_REJECTED' },
  { provider: 'gemini', connectorId: 'jarvis-model-gemini', scope: 'model.plan', status: 'verified', errorCode: null },
  { provider: 'openai-agents', connectorId: 'jarvis-openai-agents', scope: 'agents.provider.verify', status: null, errorCode: null }
];
for (const item of seeded) {
  const connection = vault.save({
    connectorId: item.connectorId,
    providerAccountId: `synthetic-${item.provider}-account`,
    label: `${item.provider} browser QA fixture`,
    authMethod: 'api-key',
    scopes: [item.scope],
    grants: [],
    credentials: { apiKey: `synthetic-${item.provider}-key-never-transmitted` }
  });
  if (item.status) vault.recordProviderVerification(connection.connectionId, {
    status: item.status,
    providerVerified: item.status === 'verified',
    checkedAt,
    modelCount: item.status === 'verified' ? 4 : 0,
    errorCode: item.errorCode ?? undefined
  });
}

const isolatedEnv = {
  ...process.env,
  JARVIS_TEST_MODE: '1',
  JARVIS_CORE_HOST: '127.0.0.1',
  JARVIS_CORE_PORT: '0',
  JARVIS_CORE_ROOT: join(tempRoot, 'core'),
  JARVIS_CORE_AUDIT_ROOT: join(tempRoot, 'audit'),
  JARVIS_CORE_ALLOWED_ROOTS: join(tempRoot, 'workspace'),
  JARVIS_CORE_INTEGRATION_VAULT: vaultPath,
  JARVIS_CORE_ADMIN_TOKEN_SHA256: createHash('sha256').update(adminToken).digest('hex'),
  JARVIS_ALLOWED_ROOTS: join(tempRoot, 'workspace'),
  JARVIS_PERSONAL_IMPORT_ENABLED: '0',
  JARVIS_GOOGLE_SYNC_ENABLED: '0',
  JARVIS_CORE_WORKER_DAEMON_ENABLED: '0',
  JARVIS_CORE_WORKER_DAEMON_AUTOSTART: 'false',
  JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED: '0'
};
let core;
let ui;
let status = 'failed';
let flow = null;
let error = null;
let browserDiagnostics = null;
try {
  core = await createConfiguredCoreServiceRuntime({
    env: isolatedEnv,
    integrationVault: vault,
    modelProviderFetch: async () => { throw new Error('Provider calls are disabled in browser QA.'); }
  });
  const address = await listenOnFetchSafePort(core.server, { host: '127.0.0.1', port: corePort });
  const uiEnv = {
    ...isolatedEnv,
    PORT: String(uiPort),
    HOST: '127.0.0.1',
    JARVIS_CORE_API_URL: `http://127.0.0.1:${address.port}`,
    JARVIS_PC_AGENT_API_URL: 'http://127.0.0.1:1',
    JARVIS_BRIDGE_API_URL: 'http://127.0.0.1:1',
    JARVIS_CORE_ADMIN_TOKEN: adminToken,
    JARVIS_PC_AGENT_API_TOKEN: 'synthetic-pc-token-fixture-only'
  };
  ui = spawn(process.execPath, ['scripts/dev-server.mjs'], { cwd: root, env: uiEnv, windowsHide: true, stdio: 'ignore' });
  const uiUrl = `http://127.0.0.1:${uiPort}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${uiUrl}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) break;
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  const health = await fetch(`${uiUrl}/health`, { signal: AbortSignal.timeout(2_000) });
  if (!health.ok) throw new Error('Isolated UI did not become healthy.');
  await mkdir(output, { recursive: true });
  const child = spawn(process.env.PYTHON ?? 'python', [pythonScript, '--url', uiUrl, '--output', join(output, 'browser-flow.json')], {
    cwd: root, env: { ...process.env, JARVIS_QA_RAW_TOKEN: adminToken }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', resolvePromise);
  });
  browserDiagnostics = { exitCode: code, stdout: stdout.slice(-1800), stderr: stderr.slice(-1800) };
  if (code !== 0) throw new Error(`Browser QA exited ${code}: ${stderr.slice(-1200) || stdout.slice(-1200)}`);
  flow = JSON.parse(await readFile(join(output, 'browser-flow.json'), 'utf8'));
  if (flow.status !== 'passed') throw new Error('Browser QA returned a non-passing report.');
  status = 'passed';
} catch (cause) {
  error = { name: cause?.name ?? 'Error', message: String(cause?.message ?? cause).slice(0, 1200) };
} finally {
  if (ui && ui.exitCode === null) {
    ui.kill();
    await new Promise(resolvePromise => { const timeout = setTimeout(resolvePromise, 2_000); ui.once('exit', () => { clearTimeout(timeout); resolvePromise(); }); });
  }
  await core?.close();
  const resolvedTemp = resolve(tmpdir());
  if (!resolve(tempRoot).startsWith(`${resolvedTemp}${process.platform === 'win32' ? '\\' : '/'}`)
    || !resolve(tempRoot).split(/[\\/]/u).at(-1)?.startsWith('jarvis-provider-readiness-')) {
    throw new Error('Refusing to clean an isolated provider-readiness directory outside the generated temporary prefix.');
  }
  await rm(tempRoot, { recursive: true, force: true });
}

const report = {
  reportVersion: 'jarvis-provider-readiness-browser-qa-v1',
  observedAt: new Date().toISOString(),
  status,
  checks: flow?.checks ?? [],
  browser: flow ? { url: 'loopback-only', consoleErrors: flow.consoleErrors, pageErrors: flow.pageErrors, failedApiRequests: flow.failedApiRequests } : null,
  providerCalls: 0,
  externalNetworkRequests: 0,
  externalWrites: 0,
  costUsd: null,
  userProductStateTouched: false,
  browserDiagnostics,
  limitation: 'Synthetic credentials and verification records were seeded in a temporary Windows CurrentUser DPAPI vault. This proves the isolated Core→local UI display path only; no real account, provider request, user product service, or provider key was used.',
  error
};
await mkdir(output, { recursive: true });
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const lines = report.checks.map(item => `- ${item.passed ? '통과' : '실패'}: ${item.id}`).join('\n') || '- 브라우저 단계에 도달하지 못했습니다.';
await writeFile(join(output, 'report.md'), `# 모델 제공자 연결 준비도 브라우저 검증\n\n관측 시각: ${report.observedAt}\n\n상태: **${status}**\n\n${lines}\n\n외부 provider 호출·네트워크·쓰기: 0. 비용은 미측정. 합성 DPAPI vault를 사용했으며 실계정·제품 서비스 검증은 아닙니다.\n\n${error ? `실패: ${error.name}: ${error.message}\n` : ''}`, 'utf8');
console.log(JSON.stringify({ status, reportPath: join(output, 'report.json'), checks: report.checks, error }, null, 2));
if (status !== 'passed') process.exitCode = 1;
