import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {MissionExecutionAuthority} from '../packages/core/src/mission/mission-execution-authority.js';
import {MissionBudgetGate} from '../packages/core/src/personal-operations/mission-budget-gate.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {PersonalOperationsMissionLink} from '../packages/core/src/personal-operations/mission-link.js';
import {dependencyImpactDigest} from '../packages/core/src/mission/dependency-impact-digest.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-impact-clock-'));let now=Date.parse('2026-10-08T00:00:00Z');
 const operations=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock:()=>new Date(now)}),store=new SqliteMissionStore({operationsStore:operations});
 const authority=new MissionExecutionAuthority({store,ttlMs:60000});authority.activate({expectedToken:store.coreAuthorityStatus().token,heartbeat:false});
 const runtime=createAgRuntime({missionStore:store,missionExecutionAuthority:authority,allowedRoots:[root],auditRoot:join(root,'audit'),clock:()=>new Date(now),workerDaemonEnabled:false,env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'}});
 const budget=new PersonalMandateBudget(operations),quota=new MissionBudgetGate({store:operations,budget});runtime.missionRuntime.executionBudget=quota;
 t.after(()=>{authority.stopHeartbeat();runtime.coreFacade.cognition.close();operations.close();rmSync(root,{recursive:true,force:true});});
 return {r:runtime.missionRuntime,operations,store,quota,advance:ms=>now+=ms,create:extra=>runtime.missionRuntime.createMission({objective:'작업 폴더 파일 목록 확인',successCriteria:['목록 확인'],...extra})};
}
test('unchanged dependencies retain pagination across a later observation time',t=>{
 const f=fixture(t);for(let i=0;i<3;i++)f.create();
 const first=f.r.dependencyImpacts({limit:1});assert.ok(first.nextCursor);f.advance(5);
 const next=f.r.dependencyImpacts({limit:2,cursor:first.nextCursor});assert.equal(next.error,undefined);assert.equal(next.items.length,2);assert.equal(next.snapshotSha256,first.snapshotSha256);assert.notEqual(next.observedAt,first.observedAt);
});
test('durable impact history preserves explicit deadline changes instead of identical review summaries',t=>{
 const f=fixture(t),link=new PersonalOperationsMissionLink({store:f.operations,missionRuntime:f.r});
 const commitment=f.operations.createCommitment({title:'기한 변경 검증',dueAt:'2026-10-08T00:00:00Z',sourceRef:'user:test'});
 const followup=f.operations.tick().followUps[0];link.dispatch(followup.id,{objective:'작업 폴더 파일 목록 확인',successCriteria:['목록 확인']});
 f.r.reconcileDependencyImpacts();
 for(const [revision,day] of [[1,'09'],[2,'10']]){
  f.operations.changeDeadline(commitment.id,{dueAt:`2026-10-${day}T00:00:00Z`,expectedRevision:revision,changeId:`deadline-${revision}`});
  const result=f.r.reconcileDependencyImpacts();assert.equal(result.changed,1);
 }
 const events=f.r.dependencyImpactEvents().items;assert.equal(events.length,2);
 assert.equal(events[0].previous.deadline.currentDueAt,'2026-10-08T00:00:00.000Z');
 assert.equal(events[0].current.deadline.currentDueAt,'2026-10-09T00:00:00.000Z');
 assert.equal(events[1].previous.deadline.currentRevision,2);
 assert.equal(events[1].current.deadline.currentDueAt,'2026-10-10T00:00:00.000Z');
 assert.equal(events[1].current.deadline.shiftMilliseconds,172800000);
 assert.equal(events[1].executionAuthority,false);
 f.advance(10);assert.equal(f.r.reconcileDependencyImpacts().changed,0);
});
test('clock-only polling neither appends durable events nor increments head revision',t=>{
 const f=fixture(t);f.create();assert.equal(f.r.reconcileDependencyImpacts().baselines,1);
 const before=f.store.db.prepare('SELECT * FROM mission_dependency_impact_heads').get();
 for(const ms of [1,3,100]){f.advance(ms);assert.equal(f.r.reconcileDependencyImpacts().changed,0);}
 assert.equal(f.r.dependencyImpactEvents().items.length,0);assert.deepEqual(f.store.db.prepare('SELECT * FROM mission_dependency_impact_heads').get(),before);
});
test('stored event tampering cannot hide inside fields excluded from change detection',t=>{
 const f=fixture(t),q=f.quota.createQuota({validFrom:'2026-10-08T00:00:00Z',expiresAt:'2026-10-08T00:00:01Z',maxCalls:2});
 f.create({executionMandateId:q.mandate.id});f.r.reconcileDependencyImpacts();f.advance(1001);f.r.reconcileDependencyImpacts();
 const row=f.store.db.prepare('SELECT sequence,body FROM mission_dependency_impact_events').get(),body=JSON.parse(row.body);
 body.current.observedAt='2099-01-01T00:00:00Z';
 f.store.db.prepare('UPDATE mission_dependency_impact_events SET body=? WHERE sequence=?').run(JSON.stringify(body),row.sequence);
 assert.throws(()=>f.r.dependencyImpactEvents(),/A_MISSION_IMPACT_HISTORY_CORRUPTED/);
});
test('legacy semantic digests remain readable without claiming byte integrity or fabricating deadline details',t=>{
 const f=fixture(t),q=f.quota.createQuota({validFrom:'2026-10-08T00:00:00Z',expiresAt:'2026-10-08T00:00:01Z',maxCalls:2});
 f.create({executionMandateId:q.mandate.id});f.r.reconcileDependencyImpacts();f.advance(1001);f.r.reconcileDependencyImpacts();
 const row=f.store.db.prepare('SELECT sequence,body FROM mission_dependency_impact_events').get(),body=JSON.parse(row.body);
 delete body.createdAt;delete body.previous.deadline;delete body.current.deadline;
 f.store.db.prepare('UPDATE mission_dependency_impact_events SET body=?,body_digest=? WHERE sequence=?').run(JSON.stringify(body),dependencyImpactDigest(body),row.sequence);
 const event=f.r.dependencyImpactEvents().items[0];assert.equal(event.integrityFormat,'legacy-semantic-v1');assert.equal(event.previous.deadline,undefined);
});
test('new head summaries reject excluded-field modification before no-change fast path',t=>{
 const f=fixture(t);f.create();f.r.reconcileDependencyImpacts();
 const head=f.store.db.prepare('SELECT mission_id,summary FROM mission_dependency_impact_heads').get(),body=JSON.parse(head.summary);body.checkedAt='2099-01-01T00:00:00Z';
 f.store.db.prepare('UPDATE mission_dependency_impact_heads SET summary=? WHERE mission_id=?').run(JSON.stringify(body),head.mission_id);
 assert.throws(()=>f.r.reconcileDependencyImpacts(),/A_MISSION_IMPACT_HISTORY_CORRUPTED/);
 assert.equal(f.r.dependencyImpactEvents().items.length,0);
});
test('new event creation time must match its persisted timestamp',t=>{
 const f=fixture(t),q=f.quota.createQuota({validFrom:'2026-10-08T00:00:00Z',expiresAt:'2026-10-08T00:00:01Z',maxCalls:2});
 f.create({executionMandateId:q.mandate.id});f.r.reconcileDependencyImpacts();f.advance(1001);f.r.reconcileDependencyImpacts();
 f.store.db.prepare("UPDATE mission_dependency_impact_events SET created_at='2099-01-01T00:00:00Z'").run();
 assert.throws(()=>f.r.dependencyImpactEvents(),/A_MISSION_IMPACT_HISTORY_CORRUPTED/);
});
test('legacy heads transition to byte-checked new records without rewriting prior evidence',t=>{
 const f=fixture(t),q=f.quota.createQuota({validFrom:'2026-10-08T00:00:00Z',expiresAt:'2026-10-08T00:00:01Z',maxCalls:2});
 f.create({executionMandateId:q.mandate.id});f.r.reconcileDependencyImpacts();
 const head=f.store.db.prepare('SELECT * FROM mission_dependency_impact_heads').get(),body=JSON.parse(head.summary);delete body.deadline;
 const legacy=JSON.stringify(body);f.store.db.prepare('UPDATE mission_dependency_impact_heads SET summary=?,summary_digest=?').run(legacy,dependencyImpactDigest(body));
 assert.equal(f.r.reconcileDependencyImpacts().changed,0);assert.equal(f.store.db.prepare('SELECT summary FROM mission_dependency_impact_heads').get().summary,legacy);
 f.advance(1001);f.r.reconcileDependencyImpacts();
 const event=f.r.dependencyImpactEvents().items[0];assert.equal(event.previousIntegrityFormat,'legacy-semantic-v1');assert.equal(event.integrityFormat,'json-bytes-v2');assert.equal(event.previous.deadline,undefined);
 assert.match(f.store.db.prepare('SELECT summary_digest FROM mission_dependency_impact_heads').get().summary_digest,/^json-bytes-v2:/u);
});
test('time crossing an actual mandate expiry invalidates pagination and records exactly one transition',t=>{
 const f=fixture(t),q=f.quota.createQuota({validFrom:'2026-10-08T00:00:00Z',expiresAt:'2026-10-08T00:00:01Z',maxCalls:2});
 const a=f.create({executionMandateId:q.mandate.id});f.create();f.r.reconcileDependencyImpacts();const page=f.r.dependencyImpacts({limit:1});
 f.advance(1001);const change=f.r.reconcileDependencyImpacts();assert.equal(change.changed,1);assert.equal(change.events[0].missionId,a.missionId);assert.equal(change.events[0].current.budget.quota.status,'requires-review');
 assert.equal(f.r.dependencyImpacts({limit:1,cursor:page.nextCursor}).error.code,'A_MISSION_IMPACT_SNAPSHOT_CHANGED');
 f.advance(5);assert.equal(f.r.reconcileDependencyImpacts().changed,0);assert.equal(f.r.dependencyImpactEvents().items.length,1);
 assert.equal(f.operations.db.prepare('SELECT COUNT(*) AS n FROM personal_budget_reservations').get().n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM mission_effects').get().n,0);
});
