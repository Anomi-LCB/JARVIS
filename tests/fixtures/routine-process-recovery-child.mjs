import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAgRuntime } from '../../apps/runtime-compose/src/create-runtime.js';
import { PersonalOperationsStore } from '../../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../../packages/core/src/mission/sqlite-mission-store.js';
import { SqliteMemoryStore } from '../../apps/growth-memory/src/db/sqlite-store.js';
import { SqliteDurableRoutineStore } from '../../packages/core/src/runtime/durable-routine-store.js';
import { DurableRoutineScheduler } from '../../packages/core/src/runtime/durable-routine-scheduler.js';

const [root, mode, originalBoundary, configuration] = process.argv.slice(2), workspace = join(root, 'workspace');
const temporal=configuration?JSON.parse(configuration):null;
let controlledTime=temporal?(mode==='resume'?temporal.resumeAt:temporal.createdAt):null;
mkdirSync(workspace, { recursive: true });
const clock = () => new Date(controlledTime??Date.now());
const leaseTimeOffsetMs = mode === 'resume' && ['b-receipt', 'file-effect'].includes(originalBoundary) ? 120000 : 0;
const operations = new PersonalOperationsStore({ dbPath: join(root, 'operations.sqlite'), clock: () => new Date(clock().getTime() + leaseTimeOffsetMs) });
const store = new SqliteMissionStore({ operationsStore: operations });
const memoryStore = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups'), clock });
const content = '실제 프로세스 종료 후 예약 결과';
const env = { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
const runtime = createAgRuntime({ allowedRoots: [workspace], auditRoot: join(root, 'audit'), cwd: () => workspace, clock, env, taskEnv: env,
  memoryStore, missionStore: store, workerDaemonEnabled: false, trustSigningSecret: 'synthetic-routine-process-key-not-production',
  missionPlanner: { async planNextWave(context) {
    const successes = context.observations.filter(o => o.outcome === 'success');
    if (successes.length) return { decision: 'complete', actions: [], criteriaAssessment: context.mission.successCriteria.map(c => ({ criterionId: c.criterionId, status: 'satisfied', evidenceActionIds: successes.map(o => o.actionId) })) };
    return { decision: 'continue', actions: [{ id: 'write', command: 'result 텍스트 파일을 만들어줘', expectedToolName: 'filesystem.createTextFile', arguments: { path: join(workspace, 'result.txt'), content }, dependencies: [], requirementIds: [context.mission.goalContract.requirements[0].requirementId] }] };
  } } });
const pause = async boundary => { process.send({ type: 'boundary', boundary, pid: process.pid }); await new Promise(() => {}); };
const adapter = runtime.pcAgent.registry.get('filesystem.createTextFile'), execute = adapter.execute.bind(adapter);
adapter.execute = async (...args) => {
  const result = await execute(...args);
  appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ operationId: args[1]?.idempotencyKey, taskId: args[1]?.taskId, status: result.status }) + '\n');
  if (mode === 'file-effect') await pause('file-effect');
  return result;
};
if (mode === 'b-receipt') {
  const receive = runtime.pcAgent.receiveExecutionPacket.bind(runtime.pcAgent);
  runtime.pcAgent.receiveExecutionPacket = async (...args) => { const result = await receive(...args); await pause('b-receipt'); return result; };
}
runtime.missionRuntime.effectCoordinator.onBoundary = async boundary => { if (mode === 'prepared' && boundary === 'prepared') await pause('prepared'); };
const run = runtime.missionRuntime.runMission.bind(runtime.missionRuntime);
const notices = [];
const routines = new SqliteDurableRoutineStore({ operationsStore: operations });
const scheduler = new DurableRoutineScheduler({ store: routines, ownerId: `process-${process.pid}`, clock, onNotification: n => notices.push(n),
  missionRuntime: mode === 'completed-before-ack' && !temporal ? { createMission: request => runtime.missionRuntime.createMission(request), async runMission(id) {
    const result = await run(id); if (result.status !== 'COMPLETED') throw new Error(`unexpected ${result.status}`);
    await pause('completed-before-ack'); return result;
  } } : runtime.missionRuntime });
if(temporal&&mode==='completed-before-ack')runtime.missionRuntime.runMission=async id=>{
  const result=await run(id);if(result.status!=='COMPLETED')throw new Error(`unexpected ${result.status}`);
  await pause('completed-before-ack');return result;
};
process.send({ type: 'ready', pid: process.pid });
process.once('message', async () => {
  try {
    if (!routines.get('process-routine')) scheduler.schedule({ routineId: 'process-routine', ...(temporal?.deadline?{scheduledAt:temporal.dispatchAt}:temporal?{scheduleText:'오늘 오전 9시 1분'}:{scheduledAt:clock().toISOString()}), missionRequest: {
      objective: (temporal?.deadline==='duration'?'지금부터 1분 0초 이내 ':temporal?.deadline?(temporal.deadline==='tomorrow'?'내일':'오늘')+' 오전 9시 2분까지 ':temporal?'오늘 오전 9시 1분에 ':'')+'result.txt를 저장해', successCriteria: [{ criterionId: 'text', statement: '실제 파일 내용이 일치한다.', verificationSpec: { version: 1, kind: 'text.equals', path: 'result.txt', equals: content } }], authorization: { mode: 'supervised', grants: ['read_only', 'local_reversible'] }
    } });
    if(temporal&&mode!=='resume')controlledTime=temporal.dispatchAt;
    const recovered = mode === 'resume' ? await scheduler.startupReconcile() : null;
    await scheduler.tick();
    const routine = routines.get('process-routine'), listed = runtime.missionRuntime.listMissions().items[0];
    const mission = listed ? runtime.missionRuntime.getMission(listed.missionId) : null;
    const action = mission?.waves[0]?.actions[0];
    process.send({ type: 'result', pid: process.pid, leaseTimeOffsetMs, recovered, routine, missionStatus: mission?.status, missionId: mission?.missionId,
      effect: action?.effect ? store.getEffect(action.effect.effectId) : null, pendingFollowups: store.pendingFollowups().length,
      growthEvents: runtime.growthRuntime.ingestor.store.allEvents().filter(e => e.taskId === action?.taskId && e.eventType === 'execution.completed').length,
      workEntries: runtime.coreFacade.workMemory.load().filter(e => e.taskId === action?.taskId).length,
      notices, completion:mission?.completion??null, scheduleTemporalVerification:action?.scheduleTemporalVerification??null,
      deadlineTemporalVerification:action?.deadlineTemporalVerification??null, stopReason:mission?.stopReason??null,
      lastError:mission?.lastError??null,
      actualText:existsSync(join(workspace,'result.txt'))?readFileSync(join(workspace, 'result.txt'), 'utf8'):null });
    await runtime.missionRuntime.requestShutdown({ reason: 'fixture-complete' });
    operations.close(); memoryStore.close(); process.disconnect();
  } catch (error) {
    process.send({ type: 'error', code: error.code, message: error.message, stack: error.stack });
    try { operations.close(); memoryStore.close(); } catch {} process.disconnect(); process.exitCode = 1;
  }
});
