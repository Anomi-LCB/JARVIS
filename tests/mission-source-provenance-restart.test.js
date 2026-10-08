import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {FileMissionStore} from '../packages/core/src/mission/mission-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
import {buildMissionPlanningPrompt} from '../packages/core/src/mission/mission-planner.js';
import {taskView} from '../src/ui/workspace/model.js';
for(const backend of ['file','sqlite'])test('actual extraction provenance survives runtime restart and source change '+backend,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-provenance-restart-'));let runtime,operations,memoryStore;
 t.after(async()=>{runtime?.coreFacade.cognition.close();operations?.close();memoryStore?.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
 const make=()=>{
  let missionStore;if(backend==='file')missionStore=new FileMissionStore({filePath:join(root,'missions.json')});
  else{operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite')});missionStore=new SqliteMissionStore({operationsStore:operations});}
  memoryStore=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
  return createAgRuntime({memoryStore,allowedRoots:[root],auditRoot:join(root,'audit'),missionStore,env,taskEnv:env,workerDaemonEnabled:false,missionRunner:async()=>{throw new Error('unexpected LLM');}});
 };
 const original='업체 주장: 개선율은 30%이다.';await writeFile(join(root,'source.txt'),original);
 runtime=make();const owner=runtime.personalOwnerSession.activate({requestedBy:'provenance-restart',durationMinutes:5});
 const mission=runtime.missionRuntime.createMission({objective:"'source.txt' 텍스트를 '자료'로 읽어; '자료'에서 '업체'의 '개선율' 주장을 '%' 단위 숫자로 추출해 '주장'으로 만들어; '주장'을 'claim.json' JSON으로 저장해",
  successCriteria:[{criterionId:'claim',statement:'원문의 주장 추출',verificationSpec:{version:1,kind:'json.value',path:'claim.json',pointer:'/facts/value',equals:'30'}}],constraints:['외부 전송 금지'],
  authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE,MissionGrant.HIGH_IMPACT]}});
 const result=await runtime.missionRuntime.runMission(mission.missionId,{maxWaves:3});assert.equal(result.status,'COMPLETED');
 const outputBefore=await readFile(join(root,'claim.json'),'utf8');assert.equal(JSON.parse(outputBefore).fieldProvenance.value.independentlyVerified,false);
 runtime.coreFacade.cognition.close();runtime=null;operations?.close();operations=null;memoryStore.close();memoryStore=null;
 await writeFile(join(root,'source.txt'),'업체 주장: 개선율은 40%이다.');runtime=make();
 const restored=runtime.missionRuntime.getMission(mission.missionId);assert.equal(restored.status,'COMPLETED');
 assert.deepEqual(taskView(restored).sourceClaims,[{claimedBy:'업체',sourceLabel:'개선율'}]);
 const prompt=buildMissionPlanningPrompt({mission:restored,capabilities:[],observations:restored.observations});
 const observations=JSON.parse(prompt.split('\n').find(l=>l.startsWith('실행 관찰: ')).slice('실행 관찰: '.length));
 const field=observations.find(o=>o.toolName==='workflow.execute').evidenceFacts.sourceExtractions.fields[0];
 assert.equal(field.sourceSha256,createHash('sha256').update(original).digest('hex'));
 assert.notEqual(field.sourceSha256,createHash('sha256').update(await readFile(join(root,'source.txt'))).digest('hex'));
 assert.equal(field.currentSourceVerified,false);assert.equal(field.independentlyVerified,false);assert.equal(field.executionAuthority,false);
 assert.equal(await readFile(join(root,'claim.json'),'utf8'),outputBefore);
 console.log(JSON.stringify({provenanceRestartEvidence:{backend,status:restored.status,sourceChanged:true,historicalProvenancePreserved:true,currentSourceVerified:false,independentlyVerified:false,modelCalls:0,cost:'unmeasured'}}));
});
