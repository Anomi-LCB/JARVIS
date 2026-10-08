import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
const root=mkdtempSync(resolve('artifacts/csv-decimal-office-20261007-'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const source='region,status,amount\n서울,paid,0.1\n서울,paid,0.2\n서울,paid,-0.05\n부산,paid,2\n부산,void,999\n';
writeFileSync(join(root,'source.csv'),source,{flag:'wx'});
const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
let runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'csv-audit'),env,taskEnv:env,workerDaemonEnabled:false});
const results=[];
try{
 const owner=runtime.personalOwnerSession.activate({durationMinutes:60,requestedBy:'csv-decimal-office-pilot'});
 for(const item of [{id:'decimal',input:'source.csv',output:'summary.csv',total:0.25},
  {id:'unrepresentable',input:'overflow.csv',output:'must-not-exist.csv',total:0}]){
  if(item.id==='unrepresentable')writeFileSync(join(root,item.input),'region,status,amount\n서울,paid,0.1234567890123456789\n',{flag:'wx'});
  const before=hash(readFileSync(join(root,item.input))),started=performance.now();
  const created=runtime.missionRuntime.createMission({objective:`'${item.input}' CSV를 '원본'으로 읽고; '원본'에서 'status'가 'paid'인 행만 '지급'으로 걸러내고; '지급'을 'region'별로 'amount' 합계 'total'을 계산해 '요약'으로 만들고; '요약'을 '${item.output}' CSV로 저장해.`,
   authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','local_reversible']},budgets:{maxWaves:3,maxPlannerCalls:3,maxConsecutiveFailures:1},
   successCriteria:[{criterionId:'totals',statement:'원본의 지역별 정확한 합계',verificationSpec:{version:1,kind:'csv.rows',path:item.output,
    equals:item.id==='decimal'?[{region:'서울',total:0.25},{region:'부산',total:2}]:[{region:'서울',total:0}],numericColumns:['total'],order:'unordered'}}]});
  const result=await runtime.missionRuntime.runMission(created.missionId),internal=runtime.missionRuntime.missions.get(created.missionId);
  const present=existsSync(join(root,item.output)),preserved=before===hash(readFileSync(join(root,item.input)));
  results.push({id:item.id,status:result.status,stopReason:result.stopReason,durationMs:performance.now()-started,outputPresent:present,sourcePreserved:preserved,observations:internal.observations});
  assert.equal(preserved,true);if(item.id==='decimal')assert.equal(result.status,'COMPLETED');
  else{assert.notEqual(result.status,'COMPLETED');assert.equal(present,false);}
 }
}finally{runtime.coreFacade.cognition.close();}
const rows=readFileSync(join(root,'summary.csv'),'utf8').trim().split(/\r?\n/).slice(1).map(line=>{const [region,total]=line.split(',');return [region,Number(total)];});
const tables=[[['region','total'],...rows.map(([region,total])=>[region,String(total)])]];
let missionId;
const runner=async()=>{
 const mission=runtime.missionRuntime.missions.get(missionId);
 const response=(decision,actions=[],extra={})=>JSON.stringify({decision,summary:'실제 CSV 집계를 표와 차트로 저장',actions,sourceNotes:[],criteriaAssessment:[],question:null,blockedReason:null,...extra});
 if(!mission.observations.length)return response('continue',[
  {id:'excel',title:'Excel 집계와 차트',command:'report.xlsx 엑셀 파일 만들어줘',expectedToolName:'excel.createWorkbook',arguments:{outputPath:join(root,'report.xlsx'),sheetName:'집계',columns:['region','total'],rows,charts:[{type:'bar',title:'지역별 합계',range:'A1:B3'}]},dependencies:[],successSignal:'current cells and chart'},
  {id:'word',title:'Word 실제 집계표',command:'report.docx 워드 파일 만들어줘',expectedToolName:'word.create',arguments:{path:join(root,'report.docx'),title:'CSV 소수 집계 검증',blocks:[{type:'table',columns:tables[0][0],rows:tables[0].slice(1)}]},dependencies:[],successSignal:'saved table coordinates'}]);
 if(mission.observations.some(o=>o.outcome!=='success'||o.verification?.status!=='passed'))return response('blocked',[],{blockedReason:'office-current-check-failed'});
 return response('complete',[],{criteriaAssessment:mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:mission.observations.map(o=>o.actionId)}))});
};
const officeEnv={...env,JARVIS_MISSION_EXECUTIVE:'1'};
runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'office-audit'),missionRunner:runner,workerDaemonEnabled:false,env:officeEnv,taskEnv:officeEnv});
try{
 const started=performance.now();
 const created=runtime.missionRuntime.createMission({objective:'report.xlsx 엑셀 파일 만들어줘. report.docx 워드 파일 만들어줘.',authorization:{grants:['read_only','local_reversible']},budgets:{maxWaves:3,maxPlannerCalls:3},successCriteria:[
  {criterionId:'cells',statement:'집계 셀 값',verificationSpec:{version:1,kind:'xlsx.cells',path:'report.xlsx',sheetName:'집계',equals:{A1:'region',B1:'total',A2:'서울',B2:0.25,A3:'부산',B3:2}}},
  {criterionId:'charts',statement:'차트의 실제 참조와 숫자',verificationSpec:{version:1,kind:'xlsx.charts',path:'report.xlsx',sheetName:'집계',equals:[{type:'bar',title:'지역별 합계',series:[{name:'total',categoryFormula:"'집계'!$A$2:$A$3",valueFormula:"'집계'!$B$2:$B$3",categories:['서울','부산'],values:[0.25,2]}]}]}},
  {criterionId:'tables',statement:'Word 저장본의 모든 표 좌표',verificationSpec:{version:1,kind:'document.tables',path:'report.docx',equals:tables}}
 ]});
 missionId=created.missionId;const result=await runtime.missionRuntime.runMission(missionId),internal=runtime.missionRuntime.missions.get(missionId);
 const ids=internal.observations.map(o=>o.actionId);
 const checks=internal.successCriteria.map(c=>({id:c.criterionId,proof:runtime.missionRuntime.verifyCriterionEvidence(internal,c,ids)}));
 const wrong=structuredClone(internal.successCriteria.find(c=>c.criterionId==='charts'));wrong.verificationSpec.equals[0].series[0].values[0]=999;
 const wrongChart=runtime.missionRuntime.verifyCriterionEvidence(internal,wrong,ids);
 const wrongCellSpec=structuredClone(internal.successCriteria.find(c=>c.criterionId==='cells'));wrongCellSpec.verificationSpec.equals.B2=999;
 const wrongCells=runtime.missionRuntime.verifyCriterionEvidence(internal,wrongCellSpec,ids);
 const wrongTableSpec=structuredClone(internal.successCriteria.find(c=>c.criterionId==='tables'));wrongTableSpec.verificationSpec.equals[0][1][1]='999';
 const wrongTables=runtime.missionRuntime.verifyCriterionEvidence(internal,wrongTableSpec,ids);
 results.push({id:'office',status:result.status,durationMs:performance.now()-started,checks,wrongChart,wrongCells,wrongTables,observations:internal.observations,syntheticPlanner:true});
 assert.equal(result.status,'COMPLETED');assert.ok(checks.every(c=>c.proof.passed));for(const proof of [wrongChart,wrongCells,wrongTables])assert.equal(proof.passed,false);
}finally{
 runtime.coreFacade.cognition.close();
 writeFileSync(join(root,'result.json'),JSON.stringify({observedAt:new Date().toISOString(),root,results,sourcePreserved:hash(readFileSync(join(root,'source.csv')))===hash(source),externalModelCalls:0,cost:'미측정',scope:'strict natural CSV grammar; fixed Office planner; literal values, not arbitrary semantics'},null,2),{flag:'wx'});
 console.log(JSON.stringify({root,results:results.map(({id,status,durationMs})=>({id,status,durationMs}))}));
}
