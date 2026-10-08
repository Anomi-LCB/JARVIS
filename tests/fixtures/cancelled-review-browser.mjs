import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createAgRuntime } from '../../apps/runtime-compose/src/create-runtime.js';
import { createCoreServer } from '../../packages/core/src/main.mjs';
import { MissionGrant } from '../../packages/core/src/mission/mission-runtime.js';
import { PersonalOperationsStore } from '../../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../../packages/core/src/mission/sqlite-mission-store.js';
import { SqliteMemoryStore } from '../../apps/growth-memory/src/db/sqlite-store.js';

const root = await mkdtemp(join(tmpdir(), 'jarvis-cancelled-review-browser-'));
const store = new PersonalOperationsStore({ dbPath: join(root, 'ops.sqlite') });
const memory = new SqliteMemoryStore({ dbPath: join(root, 'growth.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
const runtime = createAgRuntime({ memoryStore: memory, allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env,
  workerDaemonEnabled: false, missionStore: new SqliteMissionStore({ operationsStore: store }) });
await writeFile(join(root, 'input.json'), '[{"total":42}]');
const owner = runtime.personalOwnerSession.activate({ durationMinutes: 5, requestedBy: 'synthetic-browser' });
const mission = runtime.missionRuntime.createMission({ objective: "'input.json' JSON을 '원본'으로 읽고; '원본'을 'output.json' JSON으로 저장해",
  authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId, grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] },
  successCriteria: [{ statement: '합계', verificationSpec: { version: 1, kind: 'json.value', path: 'output.json', pointer: '/0/total', equals: 42 } }] });
const record = runtime.pcAgent.packetJournal.recordResult.bind(runtime.pcAgent.packetJournal);
runtime.pcAgent.packetJournal.recordResult = (...args) => {
  const result = record(...args);
  if (!args[2]?.dryRun && args[1].executionResult?.status === 'success') runtime.missionRuntime.cancelMission(mission.missionId);
  return result;
};
const stopped = await runtime.missionRuntime.runMission(mission.missionId);
if (stopped.status !== 'CANCELLED') throw Error('Fixture cancellation failed: ' + JSON.stringify({ status: stopped.status, stopReason: stopped.stopReason, lastError: stopped.lastError }));
const originalOutput = await readFile(join(root, 'output.json'));
const core = createCoreServer(runtime.coreFacade, { adminToken: 'synthetic-browser-admin', missionRuntime: runtime.missionRuntime });
await new Promise(r => core.listen(0, '127.0.0.1', r));
const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port; await new Promise(r => reservation.close(r));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC)$/iu.test(key)));
const ui = spawn(process.execPath, ['scripts/dev-server.mjs'], { cwd: process.cwd(), windowsHide: true,
  env: { ...baseEnv, PORT: String(port), JARVIS_CORE_API_URL: `http://127.0.0.1:${core.address().port}`, JARVIS_CORE_ADMIN_TOKEN: 'synthetic-browser-admin' }, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((resolve, reject) => { ui.stdout.on('data', () => resolve()); ui.once('exit', code => reject(Error(`UI exit ${code}`))); });
console.log(JSON.stringify({ status: 'ready', url: `http://127.0.0.1:${port}`, missionId: mission.missionId }));
let closing = false;
async function stop() {
  if (closing) return; closing = true; ui.kill();
  await new Promise(r => core.close(r)); runtime.pcAgent.remoteOperationStore?.close(); runtime.coreFacade.cognition?.close(); store.close(); memory.close();
  await rm(root, { recursive: true, force: true }); process.exit(0);
}
process.stdin.on('data', async data => {
  const action = String(data).trim();
  if (['mutate', 'reset'].includes(action)) {
    await writeFile(join(root, 'output.json'), action === 'mutate' ? '[{"total":99}]' : originalOutput);
    console.log(JSON.stringify({ status: action }));
  } else await stop();
});
process.stdin.once('end', stop);
