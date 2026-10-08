import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { productServiceDefinitions, startProductRuntime, probeProductServices, createServiceEnvironment } from './product-runtime.mjs';
import { resolveProductRuntimeSecrets } from '../packages/shared/src/product-runtime-secrets.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { runIsolatedNaturalWorkflowPilot } from './lib/isolated-natural-workflow-pilot.mjs';

const tempRoot = await mkdtemp(join(tmpdir(), 'jarvis-isolated-stack-'));
const workflowMode = process.argv.includes('--workflow');
const output = resolve(`artifacts/agent-platform-20260930/${workflowMode ? 'isolated-natural-workflow' : 'isolated-product-browser'}`);
await mkdir(output, { recursive: true });
const ports = [], reservations = [];
let runtime, status, failure;
// No inherited account credentials or application settings. OS process variables only.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMSPEC)$/iu.test(key)));
Object.assign(env, {
  JARVIS_TEST_MODE: '1', JARVIS_PRODUCT_HOST: '127.0.0.1',
  JARVIS_CORE_ROOT: tempRoot, JARVIS_CORE_AUDIT_ROOT: join(tempRoot, 'core'),
  JARVIS_AUDIT_ROOT: join(tempRoot, 'pc'), JARVIS_TEST_AUDIT_ROOT: join(tempRoot, 'test'),
  JARVIS_ALLOWED_ROOTS: join(tempRoot, 'workspace'), JARVIS_CORE_ALLOWED_ROOTS: join(tempRoot, 'workspace'),
  JARVIS_TRUST_ROOT: join(tempRoot, 'trust'), JARVIS_BRIDGE_STATE_DIR: join(tempRoot, 'bridge'),
  JARVIS_UNDO_JOURNAL: join(tempRoot, 'pc', 'undo.jsonl'), JARVIS_ROLLBACK_TRANSACTIONS: join(tempRoot, 'pc', 'rollback.jsonl'),
  JARVIS_PACKET_JOURNAL: join(tempRoot, 'pc', 'packets.jsonl'), JARVIS_PACKET_QUEUE: join(tempRoot, 'pc', 'queue.jsonl'),
  JARVIS_TOKEN_VAULT: join(tempRoot, 'pc', 'vault.jsonl'),
  JARVIS_CORE_INTEGRATION_VAULT: join(tempRoot, 'integrations.dpapi.json'),
  JARVIS_PERSONAL_OPERATIONS_DB: join(tempRoot, 'personal.sqlite'),
  JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0',
  JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
  JARVIS_QUEUE_DRAIN_ENABLED: '0', JARVIS_BRIDGE_REAL_EXECUTION: '0', JARVIS_BRIDGE_OPEN_OUTPUTS: '0',
  JARVIS_BROWSER_DRIVER: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0'
});
if (workflowMode) Object.assign(env, { JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED: '1', JARVIS_CORE_MISSION_STORE_BACKEND: 'sqlite' });
try {
  await mkdir(join(tempRoot, 'workspace'), { recursive: true });
  for (let i = 0; i < 4; i++) {
    const server = createServer(); reservations.push(server);
    const address = await listenOnFetchSafePort(server, { host: '127.0.0.1', port: 0 }); ports.push(address.port);
  }
  await Promise.all(reservations.map(server => new Promise(resolvePromise => server.close(resolvePromise))));
  [env.JARVIS_CORE_PORT, env.JARVIS_PC_AGENT_PORT, env.JARVIS_BRIDGE_PORT, env.JARVIS_UI_PORT] = ports.map(String);
  const secrets = resolveProductRuntimeSecrets({ env });
  // Test-mode path keys are process-local unless the supported shared test seed is supplied.
  // Production DPAPI key lifecycle is deliberately not replaced by this fixture seed.
  const trustSeed = randomBytes(32).toString('base64url');
  const definitions = productServiceDefinitions({ env, secrets }).map(definition => ({ ...definition,
    environment: { ...definition.environment, JARVIS_TEST_TRUST_SECRET: trustSeed }
  }));
  // Explicitly supply the sanitized base environment to each child.
  const start = () => startProductRuntime({ definitions, spawnImpl: (command, args, options) => {
    const definition = definitions.find(item => item.command === command && JSON.stringify(item.args) === JSON.stringify(args));
    if (!definition) throw new Error('ISOLATED_CHILD_DEFINITION_REQUIRED');
    return spawn(command, args, { ...options, env: createServiceEnvironment(definition, env) });
  } });
  runtime = await start();
  status = await probeProductServices({ definitions });
  if (!status.services.every(service => service.identityVerified && service.healthy)) throw new Error('ISOLATED_STACK_IDENTITY_NOT_READY');
  if (!status.operational || !status.mutatingExecutionAllowed) throw new Error('ISOLATED_STACK_TRUST_RESTRICTED');
  if (workflowMode) {
    const workflow = await runIsolatedNaturalWorkflowPilot({ definitions, secrets, tempRoot, restart: async () => {
      await runtime.stop(); runtime = await start();
      const restored = await probeProductServices({ definitions });
      if (!restored.operational) throw new Error('ISOLATED_RESTART_TRUST_RESTRICTED');
      return restored;
    } });
    await writeFile(join(output, 'workflow-report.json'), JSON.stringify(workflow, null, 2) + '\n');
  } else {
  const code = await new Promise((resolvePromise, reject) => {
    const child = spawn('python', ['-X', 'utf8', 'scripts/selected-conversation-browser-qa.py', '--url', runtime.uiUrl, '--output', output, '--full-page'], {
      windowsHide: true, stdio: 'inherit', env: { ...env, JARVIS_QA_RAW_TOKEN: secrets.coreToken }
    });
    child.once('error', reject); child.once('exit', resolvePromise);
  });
  if (code !== 0) throw new Error('ISOLATED_FULL_PAGE_BROWSER_FAILED');
  }
} catch (error) { failure = { code: error?.code ?? 'ISOLATED_STACK_PILOT_FAILED', message: String(error?.message ?? error).slice(0, 300) }; process.exitCode = 1; }
finally {
  await runtime?.stop();
  for (const server of reservations) if (server.listening) await new Promise(resolvePromise => server.close(resolvePromise));
  if (!resolve(tempRoot).startsWith(resolve(tmpdir()) + sep) || !tempRoot.split(/[\\/]/u).at(-1).startsWith('jarvis-isolated-stack-')) throw new Error('UNSAFE_TEMP_CLEANUP');
  await rm(tempRoot, { recursive: true, force: true });
}
await writeFile(join(output, 'stack-report.json'), JSON.stringify({ observedAt: new Date().toISOString(), status: failure ? 'failed' : 'passed',
  productStatus: status, failure, isolated: true, productionServicesTouched: false,
  limitations: 'Ephemeral test keys; isolated synthetic data. Automatic imports, Google sync, bridge execution and models disabled. Only explicitly submitted local workflows run in workflow mode. Evidence does not prove general task execution, production recovery or live accounts.' }, null, 2) + '\n');
console.log(JSON.stringify({ status: failure ? 'failed' : 'passed', report: join(output, 'stack-report.json'), failure }));
