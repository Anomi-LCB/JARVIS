import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
const root=mkdtempSync(resolve('artifacts/artifact-layout-mission-live-20261007-'));
const mode=process.argv[2]??'presentation',presentation=mode==='presentation';let runtime,missionId,runnerCalls=0;
const expected=presentation?[
 {title:'전체 요구사항 보존',bullets:['자료 출처와 확인 시각','본문과 해석을 구분','계정 권한과 예산 한도'],notes:'발표자 메모도 실제 저장 파일에서 확인한다.'},
 {title:'검증 결과와 다음 행동',bullets:['완료한 일과 남은 일을 구분','재시작 후 결과를 다시 확인'],notes:'추론과 사실을 혼동하지 않는다.'}]:
 {title:'필수 요구사항 전체 검증',label:'JARVIS BRIEF',subtitle:'',body:['자료 출처 확인','예산 한도 검토','일정 충돌 검사','개인 정보 보호','보고서 내용 검토','계정 권한 확인','작업 결과 기록','최종 승인 상태'],footer:'검증 출처',accent:'#4471ff'};
const file=presentation?'presentation.pptx':'complete.png',tool=presentation?'powerpoint.create':'visual.createCards';
const runner=async()=>{
 runnerCalls++;const mission=runtime.missionRuntime.missions.get(missionId);
 const response=(decision,actions=[],extra={})=>JSON.stringify({decision,summary:'명시된 제작 요구 실행과 현재 내용·배치 대조',actions,sourceNotes:[],criteriaAssessment:[],question:null,blockedReason:null,...extra});
 if(!mission.observations.length)return response('continue',[{id:'author',title:'명시적 요구로 산출물 제작',command:`${file} 파일 만들어줘`,expectedToolName:tool,
  arguments:presentation?{path:join(root,file),slides:expected}:{outputDirectory:root,width:1200,height:675,cards:[{...expected,fileName:file}]},dependencies:[],successSignal:'실제 산출물과 G 독립 내용·배치 검증'}]);
 const observation=mission.observations[0];
 if(observation.outcome!=='success'||observation.verification?.status!=='passed')return response('blocked',[],{blockedReason:'current-content-layout-not-verified'});
 return response('complete',[],{criteriaAssessment:[{criterionId:'layout',status:'satisfied',evidenceActionIds:[observation.actionId],reason:'명시적 내용·배치 typed criterion 대조 요청'}]});
};
const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),missionRunner:runner,workerDaemonEnabled:false,env,taskEnv:env});
try{
 const created=runtime.missionRuntime.createMission({objective:`${file} 파일 만들어줘`,authorization:{grants:['read_only','local_reversible']},budgets:{maxWaves:3,maxPlannerCalls:3},
  successCriteria:[{criterionId:'layout',statement:'명시한 모든 문구와 배치가 현재 산출물에서 검증된다.',verificationSpec:{version:1,kind:presentation?'presentation.contentLayout':'image.cardLayout',path:file,equals:expected,...(!presentation?{width:1200,height:675}:{})}}]});
 missionId=created.missionId;const result=await runtime.missionRuntime.runMission(missionId);
 const internal=runtime.missionRuntime.missions.get(missionId),ids=internal.observations.filter(o=>o.outcome==='success').map(o=>o.actionId);
 const current=runtime.missionRuntime.verifyCriterionEvidence(internal,internal.successCriteria[0],ids);
 const wrongCriterion=structuredClone(internal.successCriteria[0]);if(presentation)wrongCriterion.verificationSpec.equals[0].bullets[0]='요청과 다른 본문';else wrongCriterion.verificationSpec.equals.body[0]='요청과 다른 본문';
 const wrongRequirements=runtime.missionRuntime.verifyCriterionEvidence(internal,wrongCriterion,ids);
 const output=internal.observations[0]?.artifacts?.find(a=>a.name===file);
 // Change an actual file after a successful G observation. Completion must
 // reject the stale proof without revising any fixed expected requirement.
 if(result.status==='COMPLETED'){
  writeFileSync(join(root,`original-output.${presentation?'pptx':'png'}`),readFileSync(join(root,file)),{flag:'wx'});
  writeFileSync(join(root,file),'tampered after G');
 }
 const changed=runtime.missionRuntime.verifyCriterionEvidence(internal,internal.successCriteria[0],ids);
 const summary={observedAt:new Date().toISOString(),root,mode,missionId,status:result.status,stopReason:result.stopReason,verification:result.verificationSummary,
  currentBeforeTamper:current,wrongRequirements,changedAfterG:changed,originalOutputArtifact:output,observations:internal.observations,plans:result.planHistory,
  externalModelCalls:0,syntheticPlanner:true,runnerCalls,semanticMeaning:'not-evaluated',externalUserEffects:0,cost:'unmeasured'};
 writeFileSync(join(root,'result.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
 if(result.status!=='COMPLETED'||!current.passed||wrongRequirements.passed||changed.passed)process.exitCode=1;
 console.log(JSON.stringify({root,status:result.status,stopReason:result.stopReason,currentPassed:current.passed,wrongRequirementsPassed:wrongRequirements.passed,changedAfterGPassed:changed.passed}));
}finally{runtime.coreFacade.cognition.close();}
