import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
const root=resolve(process.argv[2]??'artifacts/workbook-native-pdf-20261003-mission');
await mkdir(root,{recursive:false});
const xlsx=join(root,'report.xlsx'),pdf=join(root,'report.pdf');
const namedWrites=process.argv.includes('--named-writes');
const planner={async planNextWave(context){
 if(context.observations?.length || context.mission?.observations?.length) {
   const observations=context.observations??context.mission.observations;
   return {decision:'complete',summary:'실제 관측을 검증하여 완료 판정 요청',actions:[],criteriaAssessment:['cells','pdf'].map(criterionId=>({criterionId,status:'satisfied',evidenceActionIds:observations.map(o=>o.actionId)}))};
 }
 return {decision:'continue',summary:'고정 합성 표와 실제 PDF 생성',criteriaAssessment:[],actions:[{
 id:'workbook-pdf',title:'보고서와 PDF',command:'report.xlsx 엑셀 파일과 report.pdf PDF를 함께 저장해.',expectedToolName:'excel.createWorkbook',
 arguments:{outputPath:xlsx,pdfOutputPath:pdf,renderPdf:true,sheetName:'보고서',columns:['월','매출'],rows:[['1월',10],['2월',20]],charts:[{type:'bar',title:'실적',range:'A1:B3'}]},
 requirementIds:context.mission.goalContract?.requirements?.map(r=>r.requirementId)??[],
 dependencies:[],successSignal:'표와 실제 PDF가 저장되고 원본과 파일 해시를 재확인한다.'}]};}};
const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_MISSION_EXECUTIVE:'0'};
const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env,taskEnv:env,missionPlanner:planner,workerDaemonEnabled:false});
const owner=runtime.personalOwnerSession.activate({requestedBy:'native-pdf-recheck',durationMinutes:5});
const request=runtime.missionRuntime.createMission({objective:namedWrites?"'report.xlsx' 파일을 저장해; 'report.pdf' 파일을 저장해.":'report.xlsx 엑셀 표와 동일한 report.pdf PDF를 실제로 저장하고 다시 읽어 확인해.',successCriteria:[
 {criterionId:'cells',statement:'엑셀 값이 실제로 보존된다.',verificationSpec:{version:1,kind:'xlsx.cells',path:'report.xlsx',sheetName:'보고서',equals:{A2:'1월',B2:10,A3:'2월',B3:20}}},
 {criterionId:'pdf',statement:'요청한 PDF가 native export로 저장된다.',verificationSpec:{version:1,kind:'file.exists',path:'report.pdf'}}],
 budgets:{maxPlannerCalls:2,maxWaves:2,maxActions:2},authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]}});
if(!request.success) throw Error(JSON.stringify(request));
const started=performance.now(),result=await runtime.missionRuntime.runMission(request.missionId);
const report={observedAt:new Date().toISOString(),status:result.status,wholeMissionMs:Math.round(performance.now()-started),fixedPlanner:true,externalModelCalls:0,cost:'미측정',result};
await writeFile(join(root,'mission-report.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({status:report.status,wholeMissionMs:report.wholeMissionMs,observationStatuses:result.observations.map(o=>o.verification?.status),report:join(root,'mission-report.json')}));
if(result.status!=='COMPLETED') process.exitCode=1;
