import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { verifySafetySimulationResult } from '../packages/core/src/mission/mission-safety-simulation-result.js';
if (!process.argv[2]) throw Error('New evidence output path required');
const root = await mkdtemp(join(tmpdir(), 'jarvis-hazard-core-audit-')); let runtime;
try {
  const objective = "긴급전화·차량·도어락·전열기 안전 절차를 격리 모의 시험하고 'safety.json'에 저장한 뒤 다시 읽어 검증해줘";
  const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0',
    JARVIS_LLM_CONTENT: '0', JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' };
  const options = { allowedRoots: [root], auditRoot: join(root, 'audit'), missionStorePath: join(root, 'missions.json'), env, taskEnv: env,
    workerDaemonEnabled: false, missionRunner: async () => { throw Error('External model disabled'); } };
  runtime = createAgRuntime(options);
  const owner = runtime.personalOwnerSession.activate({ requestedBy: 'synthetic-hazard-audit', durationMinutes: 5 });
  const statement = `${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`;
  const mission = runtime.missionRuntime.createMission({ objective, successCriteria: [{ criterionId: 'safety', statement }],
    authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId, grants: ['read_only', 'local_reversible', 'high_impact'] } });
  const start = performance.now(), result = await runtime.missionRuntime.runMission(mission.missionId, { maxWaves: 3 });
  const elapsedMs = performance.now() - start;
  const output = JSON.parse(await readFile(join(root, 'safety.json'), 'utf8'));
  runtime.coreFacade.cognition.close(); runtime = createAgRuntime(options);
  const restored = runtime.missionRuntime.getMission(mission.missionId);
  const verification = verifySafetySimulationResult({ objective, statement, observations: restored.observations, allowedRoots: [root] });
  if (result.status !== 'COMPLETED' || restored.status !== 'COMPLETED' || verification.passed !== true || result.gates.length) throw Error('audit-incomplete');
  await writeFile(process.argv[2], JSON.stringify({ observedAt: new Date().toISOString(), evidenceLevel: 'isolated-simulation',
    coreMissionExecuted: true, physicalActionVerified: false, runtimeRecreatedInSameProcess: true, actualCost: null,
    elapsedMs, objective, result, restoredVerification: verification, output }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, gates: result.gates.length, checks: verification.checks.length, elapsedMs, physicalActionVerified: false }));
} finally { runtime?.coreFacade.cognition.close(); await rm(root, { recursive: true, force: true }); }
