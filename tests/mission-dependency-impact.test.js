import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';
import {PersonalOperationsMissionLink} from '../packages/core/src/personal-operations/mission-link.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {MissionBudgetGate} from '../packages/core/src/personal-operations/mission-budget-gate.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';

const binding={capabilityId:'workflow.execute',providerId:'isolated-fixture',accountRef:'test-account',deviceRef:'test-device',scopes:['fixture.read']};
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-impact-'));
 let now=Date.parse('2026-10-06T00:00:00Z');const clock=()=>new Date(now);
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock});
 const inbox=new PersonalSourceInbox(store),budget=new PersonalMandateBudget(store),quota=new MissionBudgetGate({store,budget});
 const make=()=>createAgRuntime({env:{},allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,clock,workerDaemonEnabled:false,missionStorePath:join(root,'missions.json')});
 const r=make(),runtime=r.missionRuntime;runtime.executionBudget=quota;
 const link=new PersonalOperationsMissionLink({store,missionRuntime:runtime});
 const observe=(changes={})=>r.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:r.capabilityPackageRegistry.availabilityFor(binding).codeVersion,
   permissionRevision:'grant-1',accountStatus:'connected',observedAccountRef:binding.accountRef,deviceStatus:'online',observedDeviceRef:binding.deviceRef,
   grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'isolated-observation',observedAt:clock().toISOString(),...changes});
 const create=extra=>runtime.createMission({objective:'작업 폴더 파일 목록 확인',successCriteria:['파일 목록을 검증한다'],authorization:{mode:'supervised',grants:['read_only']},...extra});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 return {root,r,runtime,store,inbox,budget,quota,link,make,observe,create,advance:ms=>now+=ms};
}
function planned(f){
 const m=f.create();const live=f.runtime.missions.get(m.missionId);
 const wave=f.runtime.createWave(live,{summary:'명시적 계획',actions:[
   {id:'a',title:'기기 읽기',command:'작업 폴더 파일 목록 보여줘',expectedToolName:'workflow.execute',capabilityBinding:binding,dependencies:[]},
   {id:'b',title:'후속 읽기',command:'작업 폴더 파일 목록 보여줘',expectedToolName:'filesystem.listFiles',dependencies:['a']},
   {id:'c',title:'독립 읽기',command:'작업 폴더 파일 목록 보여줘',expectedToolName:'filesystem.listFiles',dependencies:[]}]});
 return {m,live,wave};
}

test('all-Mission projection carries shared quota change without mutating or hiding independent work',t=>{
 const f=fixture(t),q=f.quota.createQuota({validFrom:'2026-01-01T00:00:00Z',expiresAt:'2027-01-01T00:00:00Z',maxCalls:1});
 const a=f.create({executionMandateId:q.mandate.id}),b=f.create({executionMandateId:q.mandate.id}),independent=f.create();
 const before=JSON.stringify([...f.runtime.missions.values()]);
 const page=f.runtime.dependencyImpacts({limit:1});assert.equal(page.total,3);assert.equal(page.items.length,1);assert.ok(page.nextCursor);
 f.advance(1);const second=f.runtime.dependencyImpacts({limit:2,cursor:page.nextCursor});assert.equal(second.error,undefined);assert.equal(second.items.length,2);
 assert.equal(new Set([...page.items,...second.items].map(i=>i.missionId)).size,3);assert.equal(second.nextCursor,null);
 const held=f.budget.reserve({mandateId:q.mandate.id,requestId:'mission:'+a.missionId,request:f.quota.request()});
 assert.equal(f.runtime.dependencyImpacts({cursor:page.nextCursor}).error.code,'A_MISSION_IMPACT_SNAPSHOT_CHANGED');
 const changed=f.runtime.dependencyImpacts();
 assert.ok(changed.items.find(i=>i.missionId===b.missionId).reasons.includes('call-budget-exhausted'));
 assert.equal(changed.items.find(i=>i.missionId===a.missionId).budget.quota.status,'current');
 assert.equal(changed.items.find(i=>i.missionId===independent.missionId).budget.quota.status,'not-required');
 assert.equal(changed.counts['requires-review'],1);assert.equal(changed.executionAuthority,false);
 assert.equal(JSON.stringify([...f.runtime.missions.values()]),before);assert.equal(f.budget.get(held.id).state,'reserved');
});

test('current all-Mission pagination rejects membership, device and permission changes while retaining history',t=>{
 const f=fixture(t),p=planned(f);f.create();f.observe();
 const first=f.runtime.dependencyImpacts({limit:1});
 f.advance(1);f.observe({deviceStatus:'offline'});assert.equal(f.runtime.dependencyImpacts({cursor:first.nextCursor}).error.code,'A_MISSION_IMPACT_SNAPSHOT_CHANGED');
 const changed=f.runtime.dependencyImpacts();const row=changed.items.find(i=>i.missionId===p.m.missionId);
 assert.equal(row.affectedActionIds.length,2);
 const permissionCursor=f.runtime.dependencyImpacts({limit:1}).nextCursor;
 f.advance(1);f.observe({grantedScopes:[],permissionRevision:'grant-2'});
 assert.equal(f.runtime.dependencyImpacts({cursor:permissionCursor}).error.code,'A_MISSION_IMPACT_SNAPSHOT_CHANGED');
 const cursor=f.runtime.dependencyImpacts({limit:1}).nextCursor;f.create();
 assert.equal(f.runtime.dependencyImpacts({cursor}).error.code,'A_MISSION_IMPACT_SNAPSHOT_CHANGED');
 p.live.status='COMPLETED';p.live.waves[0].actions[0].status='succeeded';
 assert.equal(f.runtime.dependencyImpacts().items.find(i=>i.missionId===p.m.missionId).status,'historical');
 for(const options of [{limit:0},{limit:101},{limit:1.5},{cursor:''},{cursor:'bad'},{cursor:Buffer.from('{}').toString('base64url')}])assert.ok(f.runtime.dependencyImpacts(options).error);
});

test('actual ADMIN HTTP all-Mission impact API enforces authorization and snapshot consistency',async t=>{
 const f=fixture(t);f.create();f.create();
 const server=createCoreServer(f.r.coreFacade,{missionRuntime:f.runtime,adminToken:'synthetic-impact-batch-admin'});
 await listenOnFetchSafePort(server);t.after(()=>new Promise(done=>server.close(done)));
 const url=`http://127.0.0.1:${server.address().port}/missions/dependency-impacts`,headers={authorization:'Bearer synthetic-impact-batch-admin'};
 assert.equal((await fetch(url)).status,401);
 const first=await (await fetch(url+'?limit=1',{headers})).json();assert.equal(first.total,2);assert.equal(first.executionAuthority,false);
 f.create();const stale=await fetch(url+'?cursor='+encodeURIComponent(first.nextCursor),{headers});assert.equal(stale.status,409);
 for(const query of ['?limit=0','?limit=101','?limit=1&limit=2','?cursor=x&cursor=y','?account=other','?limit=1e2'])assert.equal((await fetch(url+query,{headers})).status,400);
 assert.equal((await fetch(url,{method:'POST',headers})).status,405);
 const api=await (await fetch(`http://127.0.0.1:${server.address().port}/openapi.json`)).json();assert.ok(api.paths['/missions/dependency-impacts']);
 assert.equal(f.runtime.listMissions().items.length,3);
});

test('device and permission changes map to exact actions and downstream dependencies without execution or mutation',t=>{
 const f=fixture(t),p=planned(f);f.observe();
 const original=JSON.stringify(p.live),actions=p.wave.actions;
 f.advance(1);f.observe({deviceStatus:'offline'});
 const result=f.runtime.dependencyImpact(p.m.missionId);
 assert.equal(result.actions[0].availability.deviceStatus,'offline');assert.ok(result.actions[0].directReasons.includes('device-offline'));
 assert.deepEqual(result.actions[1].affectedBy,[actions[0].actionId]);assert.deepEqual(result.actions[2].affectedBy,[]);
 assert.deepEqual(result.affectedActionIds,[actions[0].actionId,actions[1].actionId]);assert.equal(result.executionAuthority,false);
 assert.equal(JSON.stringify(p.live),original);
 f.advance(1);f.observe({grantedScopes:[],permissionRevision:'grant-2'});
 const next=f.runtime.dependencyImpact(p.m.missionId);assert.ok(next.actions[0].directReasons.includes('scope-not-granted'));
 assert.equal(next.actions[0].availability.permissionRevision,'grant-2');
});

test('a completed parent is preserved as history and does not invalidate an independent finished result',t=>{
 const f=fixture(t),p=planned(f);p.wave.actions[0].status='succeeded';p.live.metrics.successfulActions=1;
 f.observe({deviceStatus:'offline'});const result=f.runtime.dependencyImpact(p.m.missionId);
 assert.equal(result.actions[0].status,'historical');assert.equal(result.completedActionCount,1);
 assert.deepEqual(result.actions[1].affectedBy,[]);assert.deepEqual(result.affectedActionIds,[]);
});

test('unknown/stale availability never inherits cached readiness and registry errors are redacted',t=>{
 const f=fixture(t),p=planned(f);assert.equal(f.runtime.dependencyImpact(p.m.missionId).actions[0].availability.status,'unknown');
 f.observe();f.advance(60001);assert.ok(f.runtime.dependencyImpact(p.m.missionId).actions[0].directReasons.includes('observation-stale'));
 f.runtime.capabilityAvailabilityGuard.registry={availabilityFor(){throw new Error('private-token');}};
 const result=f.runtime.dependencyImpact(p.m.missionId);assert.equal(result.actions[0].availability,null);
 assert.ok(result.actions[0].unknownReasons.includes('capability-read-unavailable'));assert.equal(JSON.stringify(result).includes('private-token'),false);
});

test('changed contract binding is flagged and dynamic resolution is explicitly unmeasured without invoking it',t=>{
 const f=fixture(t),p=planned(f);f.observe();let resolverCalls=0;
 f.runtime.capabilityAvailabilityGuard.resolver=()=>{resolverCalls++;throw new Error('must-not-call');};
 const contractFor=f.runtime.pcAgent.registry.contractFor.bind(f.runtime.pcAgent.registry);
 f.runtime.pcAgent.registry.contractFor=name=>name==='workflow.execute'?{...contractFor(name),availabilityBinding:{...binding,deviceRef:'different-device'}}:contractFor(name);
 const result=f.runtime.dependencyImpact(p.m.missionId);
 assert.ok(result.actions[0].directReasons.includes('contract-binding-changed'));
 assert.ok(result.actions[0].unknownReasons.includes('dynamic-binding-not-rechecked'));assert.equal(resolverCalls,0);
});

test('shared count quota exhaustion affects another mission without reserving or releasing capacity',t=>{
 const f=fixture(t),q=f.quota.createQuota({validFrom:'2026-01-01T00:00:00Z',expiresAt:'2027-01-01T00:00:00Z',maxCalls:1});
 const a=f.create({executionMandateId:q.mandate.id}),b=f.create({executionMandateId:q.mandate.id});
 assert.equal(f.runtime.dependencyImpact(a.missionId).budget.quota.remainingCalls,1);
 const held=f.budget.reserve({mandateId:q.mandate.id,requestId:'mission:'+a.missionId,request:f.quota.request()});
 assert.ok(f.runtime.dependencyImpact(b.missionId).reasons.includes('call-budget-exhausted'));
 assert.equal(f.runtime.dependencyImpact(a.missionId).budget.quota.status,'current');
 f.budget.begin(held.id);f.budget.uncertain(held.id);
 assert.ok(f.runtime.dependencyImpact(a.missionId).reasons.includes('reservation-reconciliation-required'));
 f.store.revokeMandate(q.mandate.id);assert.ok(f.runtime.dependencyImpact(b.missionId).reasons.includes('revoked'));
 assert.equal(f.budget.summary(q.mandate.id).usedOrHeldCalls,1);
});

test('budget reader failure stays unknown and unrelated missions do not inherit a quota',t=>{
 const f=fixture(t),m=f.create(),before=JSON.stringify(f.store.summary());
 assert.equal(f.runtime.dependencyImpact(m.missionId).budget.quota.status,'not-required');
 f.runtime.missions.get(m.missionId).executionMandateId='missing';f.runtime.executionBudget=null;
 const result=f.runtime.dependencyImpact(m.missionId);assert.equal(result.budget.quota.status,'unknown');
 assert.ok(result.unknownReasons.includes('budget-read-unavailable'));assert.equal(JSON.stringify(f.store.summary()),before);
});

test('actual prepared action reflects permission change and local budget reductions without running it',async t=>{
 const f=fixture(t);f.runtime.planner={async planNextWave(){return {decision:'continue',summary:'파일 생성 준비',criteriaAssessment:[],actions:[{id:'write',title:'파일 생성',command:'impact-check 메모 파일을 만들어줘. 내용은 검사',expectedToolName:'filesystem.createTextFile',dependencies:[],successSignal:'파일 생성'}]};}};
 const m=f.create(),result=await f.runtime.runMission(m.missionId);assert.equal(result.status,'WAITING_APPROVAL');
 const before=JSON.stringify(f.runtime.missions.get(m.missionId));
 assert.ok(f.runtime.dependencyImpact(m.missionId).actions[0].directReasons.includes('action-authorization-required'));
 assert.equal(JSON.stringify(f.runtime.missions.get(m.missionId)),before);
 const profile=f.runtime.missions.get(m.missionId).waves[0].actions[0].capabilityProfile;
 f.runtime.updateMission(m.missionId,{authorization:{grants:['read_only',profile.executionClass]}});
 assert.equal(f.runtime.dependencyImpact(m.missionId).actions[0].authorization,'current');
 f.runtime.updateMission(m.missionId,{authorization:{grants:['read_only']},budgets:{maxActions:1}});
 const live=f.runtime.missions.get(m.missionId);live.metrics.executedActions=1;
 assert.ok(f.runtime.dependencyImpact(m.missionId).reasons.includes('mission-action-budget-exhausted'));
 assert.equal(live.metrics.successfulActions,0);
});

test('legacy acceptance without a source baseline remains unknown and expiry survives quota reopening',t=>{
 const f=fixture(t),page={provider:'google-calendar',account:'test',scope:'primary',observedAt:'2026-10-01T00:00:00Z',items:[{id:'event',title:'시험 일정'}]};
 f.inbox.ingest(page);f.inbox.accept({id:f.inbox.list()[0].id,dueAt:'2026-10-05T00:00:00Z'});
 f.store.db.exec('UPDATE personal_source_items SET accepted_source_hash=NULL');
 const id=f.store.tick().followUps[0].id,m=f.link.dispatch(id,{objective:'파일 목록 확인',successCriteria:['목록 확인']});
 assert.equal(f.runtime.dependencyImpact(m.missionId).schedule.status,'unknown');assert.throws(()=>f.link.assertCurrentMission(m),/DEPENDENCY_CHANGED/);
 const q=f.quota.createQuota({validFrom:'2026-10-05T00:00:00Z',expiresAt:'2026-10-06T00:01:00Z',maxCalls:1}),bound=f.create({executionMandateId:q.mandate.id});
 f.advance(60001);const r=f.make();r.missionRuntime.executionBudget=f.quota;
 assert.ok(r.missionRuntime.dependencyImpact(bound.missionId).reasons.includes('outside-validity'));
});

test('accepted calendar change/withdrawal is tied to the real stored commitment; empty/repeated pages are not cancellation',t=>{
 const f=fixture(t),page={provider:'google-calendar',account:'test',scope:'primary',observedAt:'2026-10-01T00:00:00Z',items:[{id:'event-a',title:'시험 일정',start:'2026-10-05T00:00:00Z'}]};
 f.inbox.ingest(page);const source=f.inbox.list()[0],c=f.inbox.accept({id:source.id,dueAt:'2026-10-05T00:00:00Z'});
 const id=f.store.tick().followUps[0].id,m=f.link.dispatch(id,{objective:'작업 폴더 파일 목록 확인',successCriteria:['목록 확인']});
 const initial=f.runtime.dependencyImpact(m.missionId);assert.equal(initial.schedule.status,'current');
 const baseline=initial.schedule.acceptedSourceHash;f.inbox.ingest({...page,observedAt:'2026-10-02T00:00:00Z',items:[]});
 assert.equal(f.runtime.dependencyImpact(m.missionId).schedule.status,'current');
 const changed={...page,observedAt:'2026-10-03T00:00:00Z',items:[{...page.items[0],start:'2026-10-07T00:00:00Z'}]};
 f.inbox.ingest(changed);f.inbox.accept({id:source.id,dueAt:'2026-10-07T00:00:00Z'});
 assert.equal(f.runtime.dependencyImpact(m.missionId).schedule.status,'changed');
 assert.equal(f.runtime.dependencyImpact(m.missionId).schedule.acceptedSourceHash,baseline);
 assert.equal(f.store.summary().commitments.find(row=>row.id===c.id).due_at,'2026-10-05T00:00:00.000Z');
 f.inbox.ingest({...changed,observedAt:'2026-10-04T00:00:00Z',items:[{...changed.items[0],withdrawn:true}]});
 assert.equal(f.runtime.dependencyImpact(m.missionId).schedule.status,'withdrawn');
 const r=f.make();r.missionRuntime.executionBudget=f.quota;new PersonalOperationsMissionLink({store:f.store,missionRuntime:r.missionRuntime});
 assert.equal(r.missionRuntime.dependencyImpact(m.missionId).schedule.status,'withdrawn');
});

test('ADMIN HTTP impact is read-only and denies anonymous/diagnostic scopes and mutating methods',async t=>{
 const f=fixture(t),m=f.create(),server=createCoreServer(f.r.coreFacade,{adminToken:'impact-test',adminTokens:[{token:'impact-reader',scopes:['read_diagnostics']}],missionRuntime:f.runtime});
 await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/missions/${m.missionId}/dependency-impact`,headers={authorization:'Bearer impact-test'};
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{authorization:'Bearer impact-reader'}})).status,403);
 const response=await fetch(url,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const result=await response.json();assert.equal(result.status,'unknown');assert.equal(result.executionAuthority,false);
 assert.equal((await fetch(url,{method:'POST',headers})).status,405);
 assert.equal((await fetch(url.replace(m.missionId,'missing'),{headers})).status,404);
 assert.equal(f.runtime.getMission(m.missionId).status,'CREATED');
});

test('calendar mutation stops actual local execution; reviewed hash replans once and stale hash is rejected',async t=>{
 const f=fixture(t),page={provider:'google-calendar',account:'test',scope:'primary',observedAt:'2026-10-01T00:00:00Z',items:[{id:'event-a',title:'시험 일정',start:'2026-10-05T00:00:00Z'}]};
 f.inbox.ingest(page);f.inbox.accept({id:f.inbox.list()[0].id,dueAt:'2026-10-05T00:00:00Z'});
 const id=f.store.tick().followUps[0].id,request={objective:'작업 폴더 파일 목록 확인',successCriteria:['파일 목록을 검증한다']};
 const old=f.link.dispatch(id,request);const before=f.link.describeFollowup(id).sourceDependency;
 f.inbox.ingest({...page,observedAt:'2026-10-02T00:00:00Z',items:[{...page.items[0],start:'2026-10-08T00:00:00Z'}]});
 const blocked=await f.runtime.runMission(old.missionId);assert.equal(blocked.error.code,'A_PERSONAL_LINK_DEPENDENCY_CHANGED');
 assert.equal(f.runtime.missions.get(old.missionId).observations.length,0);f.link.cancel(id);
 assert.throws(()=>f.link.replan(id,{request,expectedRevision:1,expectedSourceHash:before.currentSourceHash}),/SOURCE_REVISION_CONFLICT/);
 const latest=f.link.describeFollowup(id).sourceDependency;
 const next=f.link.replan(id,{request,expectedRevision:1,expectedSourceHash:latest.currentSourceHash});
 assert.notEqual(next.missionId,old.missionId);assert.equal(f.link.replan(id,{request,expectedRevision:1,expectedSourceHash:latest.currentSourceHash}).missionId,next.missionId);
 assert.equal(f.runtime.dependencyImpact(next.missionId).schedule.status,'current');
 assert.throws(()=>f.link.assertCurrentMission({missionId:old.missionId}),/DEPENDENCY_CHANGED/);
 const result=await f.link.run(id);assert.equal(result.verified,true,JSON.stringify(result));
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM personal_mission_link_history').get().n,1);
});

test('schedule withdrawal during actual effect staging prevents worker handoff and cannot be acknowledged as ready',async t=>{
 const f=fixture(t),page={provider:'google-calendar',account:'test',scope:'primary',observedAt:'2026-10-01T00:00:00Z',items:[{id:'event',title:'시험 일정',start:'2026-10-05T00:00:00Z'}]};
 f.inbox.ingest(page);f.inbox.accept({id:f.inbox.list()[0].id,dueAt:'2026-10-05T00:00:00Z'});
 const id=f.store.tick().followUps[0].id,request={objective:'작업 폴더 파일 목록 확인',successCriteria:['파일 목록을 검증한다']};
 f.link.dispatch(id,request);let calls=0;
 const run=f.runtime.orchestrationWorker.runTask.bind(f.runtime.orchestrationWorker);f.runtime.orchestrationWorker.runTask=(...args)=>{calls++;return run(...args);};
 const coordinator=f.runtime.effectCoordinator,stage=coordinator.stage.bind(coordinator);
 coordinator.stage=async(...args)=>{const result=await stage(...args);f.inbox.ingest({...page,observedAt:'2026-10-02T00:00:00Z',items:[{...page.items[0],withdrawn:true}]});return result;};
 const result=await f.link.run(id);assert.equal(result.mission.status,'PAUSED');assert.equal(result.verified,false);assert.equal(calls,0);
 f.link.cancel(id);const hash=f.link.describeFollowup(id).sourceDependency.currentSourceHash;
 assert.throws(()=>f.link.replan(id,{request,expectedRevision:1,expectedSourceHash:hash}),/SOURCE_NOT_AVAILABLE/);
});
