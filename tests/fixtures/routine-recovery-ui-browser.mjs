import { createServer, request as upstreamRequest } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import { createAgRuntime } from '../../apps/runtime-compose/src/create-runtime.js';
import { PersonalOperationsStore } from '../../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../../packages/core/src/mission/sqlite-mission-store.js';
import { SqliteMemoryStore } from '../../apps/growth-memory/src/db/sqlite-store.js';
import { SqliteDurableRoutineStore } from '../../packages/core/src/runtime/durable-routine-store.js';
import { DurableRoutineScheduler } from '../../packages/core/src/runtime/durable-routine-scheduler.js';
import { createCoreServer } from '../../packages/core/src/main.mjs';

const root = mkdtempSync(join(tmpdir(), 'jarvis-routine-ui-')), children = new Set();
const message = child => new Promise((done, reject) => {
  const clean = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); };
  const onMessage = m => { clean(); m.type === 'error' ? reject(new Error(JSON.stringify(m))) : done(m); };
  const onExit = code => { clean(); reject(new Error(`child exited ${code}`)); };
  const timer = setTimeout(() => { clean(); reject(new Error('child timed out')); }, 15000);
  child.once('message', onMessage); child.once('exit', onExit);
});
const launch = async mode => {
  const child = fork(new URL('./routine-process-recovery-child.mjs', import.meta.url), [root, mode, 'file-effect'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.add(child); await message(child); return child;
};
try {
  const first = await launch('file-effect'), boundary = message(first); first.send('run');
  if ((await boundary).boundary !== 'file-effect') throw new Error('wrong boundary');
  const killed = once(first, 'exit'); first.kill('SIGKILL'); await killed; children.delete(first);
  const resumed = await launch('resume'), recovery = message(resumed); resumed.send('run');
  const result = await recovery;
  if (result.routine.status !== 'blocked' || result.effect.state !== 'uncertain') throw new Error('unknown result required');
  await once(resumed, 'exit'); children.delete(resumed);
} catch (error) {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const killed = once(child, 'exit'); child.kill('SIGKILL'); await killed; }
  rmSync(root, { recursive: true, force: true }); throw error;
}
const clock = () => new Date(), workspace = join(root, 'workspace');
const operations = new PersonalOperationsStore({ dbPath: join(root, 'operations.sqlite'), clock: () => new Date(Date.now() + 120000) });
const missionStore = new SqliteMissionStore({ operationsStore: operations });
const memoryStore = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups'), clock });
const runtime = createAgRuntime({ allowedRoots: [workspace], auditRoot: join(root, 'audit'), cwd: () => workspace, clock, memoryStore, missionStore,
  workerDaemonEnabled: false, trustSigningSecret: 'synthetic-routine-process-key-not-production',
  env: { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' },
  missionPlanner: { async planNextWave() { throw new Error('Browser fixture must not execute a Mission'); } } });
const routines = new SqliteDurableRoutineStore({ operationsStore: operations });
const scheduler = new DurableRoutineScheduler({ store: routines, missionRuntime: runtime.missionRuntime });
const core = createCoreServer(runtime.coreFacade, { adminToken: 'synthetic-browser-only', missionRuntime: runtime.missionRuntime,
  routineScheduler: scheduler, trustKernel: runtime.trustKernel, ownerSessionManager: runtime.personalOwnerSession });
await new Promise(r => core.listen(0, '127.0.0.1', r));
const repo = resolve('.'), requests = [];
const outer = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/fixture/check') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ requests, adapterCalls: readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').length,
      routineStatus: routines.get('process-routine').status, missionId: routines.get('process-routine').missionId,
      observedAt: new Date().toISOString(), isolated: true, source: 'actual-local-PC-effect-without-receipt-after-process-kill' }));
  }
  if (url.pathname === '/api/local/capabilities') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ credentialsExposed: false, coreAdminProxyConfigured: true })); }
  if (url.pathname.startsWith('/api/core')) {
    requests.push({ method: req.method, path: url.pathname.slice('/api/core'.length) + url.search });
    const headers = { ...req.headers, authorization: 'Bearer synthetic-browser-only', host: `127.0.0.1:${core.address().port}` };
    for (const name of ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cookie']) delete headers[name];
    const proxy = upstreamRequest({ host: '127.0.0.1', port: core.address().port, path: url.pathname.slice('/api/core'.length) + url.search, method: req.method, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    proxy.on('error', () => { res.statusCode = 503; res.end(); }); req.pipe(proxy); return;
  }
  const file = resolve(repo, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(repo + sep)) { res.statusCode = 403; return res.end(); }
  try { res.setHeader('content-type', ({ '.html': 'text/html;charset=utf-8', '.css': 'text/css;charset=utf-8', '.js': 'text/javascript;charset=utf-8' })[extname(file)] ?? 'application/octet-stream'); res.end(readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => outer.listen(0, '127.0.0.1', r));
console.log(JSON.stringify({ url: `http://127.0.0.1:${outer.address().port}/#routines`, isolated: true }));
process.stdin.once('data', async () => {
  outer.closeAllConnections(); core.closeAllConnections();
  await Promise.all([new Promise(r => outer.close(r)), new Promise(r => core.close(r))]);
  await runtime.missionRuntime.requestShutdown({ reason: 'browser-fixture-cleanup' });
  runtime.coreFacade.cognition?.close(); operations.close(); memoryStore.close();
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Cleanup root invalid');
  rmSync(root, { recursive: true, force: true }); process.exit(0);
});
