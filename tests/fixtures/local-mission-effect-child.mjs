import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAgRuntime } from '../../apps/runtime-compose/src/create-runtime.js';
import { PersonalOperationsStore } from '../../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../../packages/core/src/mission/sqlite-mission-store.js';
import { MissionGrant } from '../../packages/core/src/mission/mission-runtime.js';
import { SqliteMemoryStore } from '../../apps/growth-memory/src/db/sqlite-store.js';
import { PersonalMandateBudget } from '../../packages/core/src/personal-operations/mandate-budget.js';
import { MissionBudgetGate } from '../../packages/core/src/personal-operations/mission-budget-gate.js';
import { CapabilityAvailabilityRegistry } from '../../packages/core/src/capabilities/capability-availability.js';
import { MissionExecutionAuthority } from '../../packages/core/src/mission/mission-execution-authority.js';

const [root, mode = 'normal', time = '2026-09-27T00:00:00Z'] = process.argv.slice(2);
const clock = () => new Date(), workspace = join(root, 'workspace');
const targetName = mode === 'case-alias-first' ? 'Result.txt' : 'result.txt';
const graphMode = mode.endsWith('-graph');
let leaseOffsetMs = mode === 'resume' ? 120_000 : 0;
mkdirSync(workspace, { recursive: true });
const operations = new PersonalOperationsStore({ dbPath: join(root, 'operations.sqlite'),
  clock: () => new Date(Date.now() + leaseOffsetMs) });
const store = new SqliteMissionStore({ operationsStore: operations });
const coreAuthority = mode.startsWith('core-authority-') ? new MissionExecutionAuthority({store,ownerId:'isolated-core',ttlMs:30_000}) : null;
coreAuthority?.activate({expectedToken:0,heartbeat:false});
const memoryStore = new SqliteMemoryStore({ dbPath: join(root, 'growth.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups'), clock });
const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
const connectionBinding = { capabilityId: 'filesystem.createTextFile', providerId: 'isolated-effect-provider',
  accountRef: 'isolated-effect-account', deviceRef: null, scopes: ['fixture.write'] };
const runtime = createAgRuntime({ allowedRoots: [workspace], auditRoot: join(root, 'audit'), cwd: () => workspace,
  ...(mode.startsWith('revoke-connection-') ? { capabilityBindingResolver: () => ({ required: true, binding: connectionBinding }) } : {}),
  memoryStore,
  ...(mode.startsWith('cognition-')?{cognitionStorePath:join(root,'cognition.sqlite')}:{}),
  missionExecutionAuthority: coreAuthority,
  trustSigningSecret: 'synthetic-cross-process-mission-effect-trust-key-not-a-credential',
  clock, env, taskEnv: env, ...(mode === 'implicit-path-file' ? {} : { missionStore: store }), workerDaemonEnabled: false,
  missionPlanner: { async planNextWave(context) {
    if (context.observations.filter(item => item.outcome === 'success').length >= (graphMode ? 2 : 1)) return { decision: 'complete', actions: [],
      criteriaAssessment: context.mission.successCriteria.map(criterion => ({ criterionId: criterion.criterionId,
        status: 'satisfied', evidenceActionIds: context.observations.filter(item => item.outcome === 'success').map(item => item.actionId) })) };
    if (graphMode) return {decision:'continue',actions:['first','second'].map((name,index)=>({id:`write_${name}`,command:`${name} 텍스트 파일을 만들어줘`,expectedToolName:'filesystem.createTextFile',arguments:{path:join(workspace,`${name}.txt`),content:`durable graph ${name}`},dependencies:index?['write_first']:[],requirementIds:[context.mission.goalContract.requirements[index]?.requirementId??context.mission.goalContract.requirements[0].requirementId]}))};
    return { decision: 'continue', actions: [{ id: 'write', command: 'result 텍스트 파일을 만들어줘', expectedToolName: 'filesystem.createTextFile',
      arguments: { ...(mode.startsWith('implicit-path') ? {} : { path: join(workspace, targetName) }), content: 'actual durable local effect' }, dependencies: [],
      requirementIds: [context.mission.goalContract.requirements[0].requirementId] }] };
  } } });
if(mode.startsWith('cognition-failure-')){
 const boundary=mode.endsWith('-outcome')?'BEFORE INSERT ON cognitive_decision_outcomes':mode.endsWith('-goal')?"BEFORE UPDATE ON cognitive_goals WHEN NEW.status='COMPLETED'":'BEFORE INSERT ON cognitive_episodes';
 runtime.coreFacade.cognition.db.exec(`CREATE TRIGGER cognition_failure ${boundary} ${mode.includes('-second-')?'WHEN (SELECT count(*) FROM cognitive_episodes)>=1':''} BEGIN SELECT RAISE(ABORT,'injected-cognition-failure'); END`);
}
if(mode.startsWith('cognition-resume')&&mode!=='cognition-resume-still-failing')runtime.coreFacade.cognition.db.exec('DROP TRIGGER IF EXISTS cognition_failure');
if(mode==='cognition-failure-observe-kill'){
 const cognition=runtime.coreFacade.cognition,observe=cognition.observeRun.bind(cognition);
 cognition.observeRun=(...args)=>{const result=observe(...args);if(!result&&cognition.lastError){
  process.send?.({type:'boundary',boundary:'cognition-write-failed'});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); // Fixture-only crash boundary, killed by parent.
 }return result;};
}
let cognitiveProofChecks=null;
if(mode==='cognition-resume-retracted'){
 const cognition=runtime.coreFacade.cognition,goal=cognition.db.prepare('SELECT * FROM cognitive_goals LIMIT 1').get();
 if(goal)cognition._retract({scopeRef:goal.scope,taskRef:goal.task_id});
}
if(mode==='cognition-resume-plan-mismatch'){
 const db=runtime.coreFacade.cognition.db,row=db.prepare('SELECT id,payload FROM cognitive_decisions ORDER BY rowid DESC LIMIT 1').get();
 const payload=JSON.parse(row.payload);payload.planRef='changed-plan-reference';db.prepare('UPDATE cognitive_decisions SET payload=? WHERE id=?').run(JSON.stringify(payload),row.id);
}
if(mode==='cognition-resume-proofs'){
 const cognition=runtime.coreFacade.cognition,observe=cognition.observeRecovered.bind(cognition);
 cognition.observeRecovered=recovered=>{
  const clone=observe(structuredClone(recovered));
  const status=recovered.verification.status;recovered.verification.status='failed';const mutated=observe(recovered);recovered.verification.status=status;
  if(clone?.reason!=='live-durable-recovery-required'||mutated?.reason!=='live-durable-recovery-required')throw new Error('Cognition proof guards failed');
  cognitiveProofChecks={cloneRejected:true,mutationRejected:true};return observe(recovered);
 };
}
let executionMandateId = null, ownerSessionId = null, revocationBoundary = null;
const isolatedAvailability = new CapabilityAvailabilityRegistry({ clock });
if (mode.startsWith('revoke-connection-')) {
  const isolatedRegistry = {
    availabilityFor: (binding, options) => isolatedAvailability.evaluate(binding, { ...options, codeVersion: 'isolated-file-v1' }),
    recordAvailability: observation => isolatedAvailability.recordObservation(observation)
  };
  runtime.missionRuntime.capabilityAvailabilityGuard.registry = isolatedRegistry;
  runtime.orchestrationWorker.capabilityAvailabilityGuard.registry = isolatedRegistry;
}
const observeConnection = accountStatus => isolatedAvailability.recordObservation({ ...connectionBinding,
  codeVersion: 'isolated-file-v1',
  permissionRevision: 'isolated-grant-1', observedAt: clock().toISOString(), accountStatus,
  observedAccountRef: connectionBinding.accountRef, grantedScopes: connectionBinding.scopes,
  verificationLevel: 'live-probe', evidenceRef: 'isolated-effect-contract-only' });
if (mode.startsWith('revoke-connection-')) observeConnection('connected');
if (mode.startsWith('revoke-quota-')) {
  const gate = new MissionBudgetGate({ store: operations, budget: new PersonalMandateBudget(operations) });
  runtime.missionRuntime.executionBudget = gate;
  executionMandateId = gate.createQuota({ validFrom: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(), maxCalls: 1 }).mandate.id;
}
if (mode.startsWith('revoke-owner-')) {
  ownerSessionId = runtime.personalOwnerSession.activate({ requestedBy: 'isolated-effect-test', durationMinutes: 5 }).session.sessionId;
}
const revokeExecutionAuthority = boundary => {
  revocationBoundary = boundary;
  if (coreAuthority) leaseOffsetMs += 120_000;
  if (mode.startsWith('revoke-connection-')) observeConnection('revoked');
  if (executionMandateId) operations.revokeMandate(executionMandateId);
  if (ownerSessionId) runtime.personalOwnerSession.revoke({ reason: 'isolated-effect-test', revokedBy: 'test-owner' });
};
if (mode.includes('f-store-failure')) {
  const store = runtime.growthRuntime.ingestor.store, save = store.saveEvent.bind(store);
  let failed = false;
  store.saveEvent = event => { if (!failed && event.eventType === 'execution.completed' && (!mode.includes('-second-') || store.allEvents().some(e=>e.eventType==='execution.completed'))) { failed = true; throw Object.assign(new Error('synthetic F append failure'), { code: 'TEST_F_APPEND_FAILED' }); } return save(event); };
}
if (mode.includes('work-memory-')) {
  const memory = runtime.coreFacade.workMemory, record = memory.record.bind(memory); let failed = false;
  memory.record = value => {
    if (!failed) { failed = true; if (mode.endsWith('false') || mode.includes('work-memory-false-')) return null; throw Object.assign(new Error('synthetic work-memory append failure'), { code: 'TEST_WORK_MEMORY_APPEND_FAILED' }); }
    return record(value);
  };
}
const stop = async boundary => {
  process.send?.({ type: 'boundary', boundary });
  await new Promise(resolveResume => process.once('message', resolveResume));
};
const adapter = runtime.pcAgent.registry.get('filesystem.createTextFile'), execute = adapter.execute.bind(adapter);
if (coreAuthority) runtime.missionRuntime.effectCoordinator.leaseTtlMs = 300_000;
if (mode === 'expire-inside-adapter' || mode.endsWith('-inside-adapter')) {
  const shadow = adapter.shadow.bind(adapter); let shadowCalls = 0;
  adapter.shadow = async (...args) => { const result = await shadow(...args); if (++shadowCalls === 2) {
    if (mode === 'expire-inside-adapter') leaseOffsetMs += 120_000;
    else revokeExecutionAuthority('adapter-shadow');
  } return result; };
}
adapter.execute = async (...args) => {
  if (mode === 'transaction-observation') {
    if (operations.db.isTransaction) throw new Error('Actual B adapter entered inside Core transaction');
    const observer = new PersonalOperationsStore({ dbPath: join(root, 'operations.sqlite') });
    try { observer.db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS fixture_io_probe(value INTEGER); INSERT INTO fixture_io_probe VALUES(1); COMMIT;'); }
    finally { observer.close(); }
    appendFileSync(join(root, 'transaction-observation.jsonl'), JSON.stringify({ phase:'before-actual-B',transactionOpen:false,independentWriterCommitted:true })+'\n');
  }
  const result = await execute(...args);
  if (mode === 'transaction-observation') {
    if (operations.db.isTransaction) throw new Error('Actual B adapter returned inside Core transaction');
    appendFileSync(join(root, 'transaction-observation.jsonl'), JSON.stringify({ phase:'after-actual-B',transactionOpen:false })+'\n');
  }
  appendFileSync(join(root, 'adapter-calls.jsonl'), JSON.stringify({ taskId: args[1]?.taskId,
    idempotencyKey: args[1]?.idempotencyKey, status: result.status }) + '\n');
  if (mode === 'file-effect') await stop(mode);
  return result;
};
runtime.missionRuntime.effectCoordinator.onBoundary = async boundary => {
  if (mode.endsWith('-claimed') && boundary === 'claimed') revokeExecutionAuthority('claimed');
  if (mode === 'expire-before-effect' && boundary === 'claimed') leaseOffsetMs += 120_000;
  if (boundary === mode || (mode === 'case-alias-first' && boundary === 'claimed')) await stop(boundary);
};
if (mode === 'b-receipt') {
  const receive = runtime.pcAgent.receiveExecutionPacket.bind(runtime.pcAgent);
  runtime.pcAgent.receiveExecutionPacket = async (...args) => { const result = await receive(...args); await stop(mode); return result; };
}
const verify = runtime.orchestrationWorker.verifyExecution.bind(runtime.orchestrationWorker);
runtime.orchestrationWorker.verifyExecution = async (...args) => {
  const result = await verify(...args);
  appendFileSync(join(root, 'g-verifications.jsonl'), JSON.stringify({ taskId: args[0]?.taskId, status: result.status }) + '\n');
  if (mode === 'after-G') await stop(mode);
  return result;
};
process.send?.({ type: 'ready' });
process.once('message', async () => {
  try {
    const existing = mode === 'case-alias-second' ? null : runtime.missionRuntime.listMissions().items[0];
    const created = existing ?? runtime.missionRuntime.createMission({ objective: graphMode ? "'first.txt'를 저장하고 'second.txt'도 저장해" : `'${targetName}'를 저장해`,
      successCriteria: graphMode ? ['first','second'].map(name=>({criterionId:name,statement:`${name} 실제 내용이 일치한다.`,verificationSpec:{version:1,kind:'text.equals',path:`${name}.txt`,equals:`durable graph ${name}`}})) : [{ criterionId: 'text', statement: '저장한 파일의 실제 내용이 일치한다.',
        verificationSpec: { version: 1, kind: 'text.equals', path: targetName, equals: 'actual durable local effect' } }],
      ...(executionMandateId ? { executionMandateId } : {}),
      authorization: { ...(ownerSessionId ? { mode: 'trusted_session', ownerSessionId } : {}),
        grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
    const result = await runtime.missionRuntime.runMission(created.missionId);
    const action = result.waves[0]?.actions[0];
    if(mode.startsWith('cognition-failure-kill') || (graphMode && (mode.includes('f-store-failure') || mode.includes('work-memory-'))))await stop(mode);
    process.send?.({ type: 'result', result, revocationBoundary, effect: action?.effect ? store.getEffect(action.effect.effectId) : null,
      cognitiveProofChecks,
      cognitionEpisodes:runtime.coreFacade.cognition.db.prepare('SELECT COUNT(*) AS n FROM cognitive_episodes').get().n,
      pendingFollowups: store.pendingFollowups().length, enabled: runtime.missionRuntime.effectCoordinator.enabled,
      workMemoryCount: runtime.coreFacade.workMemory.load().filter(entry => entry.taskId === action?.taskId).length,
      growthMemoryCount: runtime.growthRuntime.ingestor.store.allEvents().filter(entry => entry.taskId === action?.taskId && entry.eventType === 'execution.completed').length,
      fixtureTrust: { syntheticStableCrossProcessKey: true, productionTrustKeyRead: false } });
    operations.close(); memoryStore.close(); process.disconnect?.();
  } catch (error) {
    process.send?.({ type: 'error', message: error.message, stack: error.stack });
    try { operations.close(); memoryStore.close(); } catch {} process.disconnect?.(); process.exitCode = 1;
  }
});
