import {join} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {chooseDeclaredMemory} from '../new-session-memory-comparison.mjs';
export async function executeRememberedArtifact({root,store,clock,request,enabled}){
 let runtime,prepared=null,chosen=null,toolCalls=0,memoryRecallCalls=0;
 const planner={async planNextWave(context){
  if(context.observations.some(o=>o.actionId))return {decision:'blocked',blockedReason:'artifact-action-did-not-verify',actions:[]};
  prepared=runtime.coreFacade.createTask(request.subject+' 선택을 참고해서 작업 폴더 파일 목록 보여줘',{userId:'synthetic-owner',metadata:{longTermMemory:enabled,conversationId:null}});
  chosen=chooseDeclaredMemory(request,prepared.memoryContext);
  if(chosen===null)return {decision:'blocked',blockedReason:'current-choice-unresolved',actions:[]};
  return {decision:'continue',actions:[{id:'save',title:'기억을 사용한 선택 기록 저장',command:'selection.json 텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:join(root,'selection.json'),content:JSON.stringify({schema:'remembered-selection-v1',selected:chosen}),allowOverwrite:false},dependencies:[]}],criteriaAssessment:[]};
 }};
 try{
  const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
  runtime=createAgRuntime({memoryStore:store,allowedRoots:[root],cwd:()=>root,auditRoot:join(root,'execution'),clock,env,taskEnv:env,workerDaemonEnabled:false,missionPlanner:planner});
  const recall=runtime.growthRuntime.query.bind(runtime.growthRuntime);runtime.growthRuntime.query=(...args)=>{memoryRecallCalls++;return recall(...args);};
  const original=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);runtime.orchestrationWorker.runTask=(...args)=>{toolCalls++;return original(...args);};
  const owner=runtime.personalOwnerSession.activate({requestedBy:'isolated-memory-artifact-comparison',durationMinutes:5});
  const mission=runtime.missionRuntime.createMission({objective:request.subject+'의 기억과 현재 지시를 참고해 선택을 selection.json에 기록해',metadata:{userId:'synthetic-owner',longTermMemory:enabled},
   authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','local_reversible']},
   successCriteria:[{statement:'선택 기록 형식이 실제 파일에 저장된다',verificationSpec:{version:1,kind:'json.value',path:'selection.json',pointer:'/schema',equals:'remembered-selection-v1'}}]});
  const result=await runtime.missionRuntime.runMission(mission.missionId),fileExists=existsSync(join(root,'selection.json'));
  let selected=null;if(fileExists){const artifact=JSON.parse(readFileSync(join(root,'selection.json'),'utf8'));if(artifact.schema==='remembered-selection-v1'&&['a','b'].includes(artifact.selected))selected=artifact.selected;}
  return {selected,missionStatus:result.status,toolCalls,memoryRecallCalls,fileExists,artifactReads:fileExists?1:0,metrics:result.metrics,
   verifiedActions:result.observations.filter(o=>o.outcome==='success'&&o.verification?.status==='passed').length,
   semanticTruthVerified:false,contextSourceIds:prepared?.memoryContext.flatMap(r=>r.provenance?.sourceEventIds??[])??[]};
 }finally{runtime?.coreFacade.cognition?.close();}
}
