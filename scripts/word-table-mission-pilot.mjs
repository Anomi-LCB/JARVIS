import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
const root=mkdtempSync(resolve('artifacts/word-table-mission-live-20261007-'));
const expected=[[['항목','금액'],['수입','10000'],['지출','2500'],['잔액','7500']]];
const file='생활예산.docx';let runtime,missionId;
const runner=async()=>{
 const mission=runtime.missionRuntime.missions.get(missionId);
 const response=(decision,actions=[],extra={})=>JSON.stringify({decision,summary:'표 좌표별 실제 값 검증',actions,sourceNotes:[],criteriaAssessment:[],question:null,blockedReason:null,...extra});
 if(!mission.observations.length)return response('continue',[{id:'author',title:'Word 예산 표 제작',command:`${file} 파일 만들어줘`,expectedToolName:'word.create',arguments:{path:join(root,file),title:'생활 예산 값 검증',blocks:[{type:'paragraph',text:'시험 자료의 수입과 지출을 비교하고 잔액을 확인합니다.'},{type:'table',columns:expected[0][0],rows:expected[0].slice(1)}]},dependencies:[],successSignal:'saved table coordinates'}]);
 const observed=mission.observations[0];if(observed.outcome!=='success'||observed.verification?.status!=='passed')return response('blocked',[],{blockedReason:'word-current-table-check-not-passed'});
 return response('complete',[],{criteriaAssessment:[{criterionId:'table',status:'satisfied',evidenceActionIds:[observed.actionId]}]});
};
const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),missionRunner:runner,workerDaemonEnabled:false,env,taskEnv:env});
try{
 const created=runtime.missionRuntime.createMission({objective:`${file} 파일 만들어줘`,authorization:{grants:['read_only','local_reversible']},budgets:{maxWaves:3,maxPlannerCalls:3},successCriteria:[{criterionId:'table',statement:'모든 표 셀 값이 요구한 행과 열에서 검증된다.',verificationSpec:{version:1,kind:'document.tables',path:file,equals:expected}}]});
 missionId=created.missionId;const result=await runtime.missionRuntime.runMission(missionId);const internal=runtime.missionRuntime.missions.get(missionId);
 const ids=internal.observations.filter(o=>o.outcome==='success').map(o=>o.actionId);
 const current=runtime.missionRuntime.verifyCriterionEvidence(internal,internal.successCriteria[0],ids);
 const wrong=structuredClone(internal.successCriteria[0]);wrong.verificationSpec.equals[0][1][1]='99999';const wrongRequirements=runtime.missionRuntime.verifyCriterionEvidence(internal,wrong,ids);
 let originalSha256=null;if(result.status==='COMPLETED'){const bytes=readFileSync(join(root,file));writeFileSync(join(root,'original-output.docx'),bytes,{flag:'wx'});originalSha256=createHash('sha256').update(bytes).digest('hex');writeFileSync(join(root,file),'tampered after G');}
 const changed=runtime.missionRuntime.verifyCriterionEvidence(internal,internal.successCriteria[0],ids);
 writeFileSync(join(root,'result.json'),JSON.stringify({observedAt:new Date().toISOString(),root,missionId,status:result.status,stopReason:result.stopReason,current,wrongRequirements,changed,originalSha256,observations:internal.observations,externalModelCalls:0,syntheticPlanner:true,scope:'Core/E/B/G actual Word and typed table criteria; arbitrary language/summary not assessed',cost:'unmeasured'},null,2),{flag:'wx'});
 console.log(JSON.stringify({root,status:result.status,current:current.passed,wrong:wrongRequirements.passed,changed:changed.passed}));if(result.status!=='COMPLETED'||!current.passed||wrongRequirements.passed||changed.passed)process.exitCode=1;
}finally{runtime.coreFacade.cognition.close();}
