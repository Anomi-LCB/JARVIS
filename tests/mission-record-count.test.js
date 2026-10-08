import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';

for(const [mode,quantity,content,expected] of [
 ['exact','정확히 3건','a\nb\nc\n',true],['too-few','정확히 3건','a\nb',false],
 ['too-many','최대 3건','a\nb\nc\nd',false],['range','2~4건','a\r\nb\r\nc',true],
 ['strict-boundary','3건 미만','a\nb\nc',false],['blank-record','정확히 3건','a\n\nc',false],
 ['zero','정확히 0건','',true],['wrong-path','정확히 3건','a\nb\nc',false],
 ['tampered','정확히 3건','a\nb\nc',false],['source-mismatch','정확히 3건','a\nb\nc',false],
 ['blank-zero','정확히 0건','\n',false],['double-terminal','정확히 3건','a\nb\nc\n\n',false],
 ['control-text','정확히 3건','a\tb\nc\nd',false],['fractional','정확히 0.5건','a',false],
 ['metadata-forged','정확히 3건','a\nb',false],['objective-changed','정확히 3건','a\nb\nc',false],
 ['read-permission-revoked','정확히 3건','a\nb\nc',false],['typed-content','정확히 3건','a\nb\nc',true],
 ['typed-wrong-count','정확히 3건','a\nb',false]
])test('actual source-bound saved record count '+mode,async()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-record-count-')),workspace=join(root,'workspace');mkdirSync(workspace);
 let runtime,operations,memory;
 try{
  operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite')});
  memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
  const objective=`'result.txt'에 ${quantity}의 기록을 줄바꿈으로 저장해`;
  runtime=createAgRuntime({allowedRoots:[workspace],auditRoot:join(root,'audit'),missionStore:new SqliteMissionStore({operationsStore:operations}),memoryStore:memory,workerDaemonEnabled:false,
   env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'},
   missionPlanner:{async planNextWave({mission,observations}){
    const successes=observations.filter(o=>o.outcome==='success');
    if(successes.length){
     return {decision:'complete',actions:[],criteriaAssessment:[{criterionId:'records',status:'satisfied',evidenceActionIds:successes.map(o=>o.actionId)}]};
    }
    return {decision:'continue',actions:[{id:'save',command:'텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:join(workspace,mode==='wrong-path'?'other.txt':'result.txt'),content},dependencies:[],requirementIds:[mission.goalContract.requirements[0].requirementId]}]};
   }}});
  const created=runtime.missionRuntime.createMission({objective,successCriteria:[{criterionId:'records',statement:objective,...(mode.startsWith('typed-')?{verificationSpec:{version:1,kind:'text.equals',path:'result.txt',equals:content}}:{})}],authorization:{grants:['read_only','local_reversible']}});
  if(mode==='metadata-forged')runtime.missionRuntime.missions.get(created.missionId).goalContract.quantities[0].baseUnits=2;
  const complete=runtime.missionRuntime.completeMission.bind(runtime.missionRuntime);
  runtime.missionRuntime.completeMission=(mission,completion)=>{
   if(mode==='tampered')writeFileSync(join(workspace,'result.txt'),'changed');
   if(mode==='source-mismatch')mission.goalContract.objective="'result.txt'에 정확히 30건의 기록을 줄바꿈으로 저장해";
   if(mode==='objective-changed')mission.objective="'result.txt' 파일을 만들어줘";
   if(mode==='read-permission-revoked')runtime.missionRuntime.resultReadGuard=()=>()=>{throw Error('READ_PERMISSION_REVOKED');};
   return complete(mission,completion);
  };
  const result=await runtime.missionRuntime.runMission(created.missionId),mission=runtime.missionRuntime.missions.get(created.missionId);
  assert.equal(result.status==='COMPLETED',expected,JSON.stringify({status:result.status,criteria:mission.criteriaStatus}));
  assert.equal(readFileSync(join(workspace,mode==='wrong-path'?'other.txt':'result.txt'),'utf8'),mode==='tampered'?'changed':content);
  const persisted=new SqliteMissionStore({operationsStore:operations}).load().find(m=>m.missionId===created.missionId);
  assert.equal(persisted.status,mission.status);
  if(expected){assert.match(JSON.stringify(mission.completion),/source_quantity_record_count/);assert.match(JSON.stringify(mission.completion),/measurementProvenanceVerified/);}
  console.log(JSON.stringify({actualCoreEBG:true,actualSQL:true,mode,status:mission.status,expectedComplete:expected}));
 }finally{
  await runtime?.missionRuntime.requestShutdown({reason:'isolated-record-count-cleanup'});runtime?.coreFacade.cognition.close();memory?.close();operations?.close();
  assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-record-count-'));rmSync(root,{recursive:true,force:true});
 }
});
