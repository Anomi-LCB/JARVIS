import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createResearchSourceTrace,renderResearchTraceReport} from '../packages/core/src/mission/research-source-trace.js';
const root=mkdtempSync(resolve('artifacts/research-source-trace-live-20261007-'));
const sourceUrl=process.argv[2]??'https://nodejs.org/en/blog/release/v24.8.0';
let runtime,missionId,trace,runnerCalls=0;
const runner=async()=>{
 runnerCalls++;
 const mission=runtime.missionRuntime.missions.get(missionId),observations=mission.observations??[],actions=(mission.waves??[]).flatMap(w=>w.actions??[]);
 const response=(decision,actions=[],extra={})=>JSON.stringify({decision,summary:'실제 공식 원문과 출처 기록 연결',actions,sourceNotes:[],criteriaAssessment:[],question:null,blockedReason:null,...extra});
 if(!observations.length)return response('continue',[{id:'read-source',title:'공식 공지 원문 읽기',command:`이 기사 링크 읽어줘 ${sourceUrl}`,
  expectedToolName:'news.fetchArticle',arguments:{url:sourceUrl},dependencies:[],successSignal:'실제 HTTPS 원문 추출과 G 확인'}]);
 const read=observations.find(o=>o.toolName==='news.fetchArticle');
 if(read?.outcome!=='success'||read.verification?.status!=='passed')return response('blocked',[],{blockedReason:'live-official-source-unavailable'});
 if(!observations.some(o=>o.toolName==='filesystem.createTextFile')){
  const quote='Node.js now supports inspection of HTTP/2 network calls';
  if(!read.data.article.text.includes(quote))return response('blocked',[],{blockedReason:'predeclared-source-quote-not-found'});
  trace=createResearchSourceTrace({observations,actions,citations:[{observationActionId:read.actionId,
   claim:'이 공식 릴리스 공지는 Node.js의 HTTP/2 네트워크 검사 지원을 설명합니다.',quote}]});
  return response('continue',[
   {id:'write-trace',title:'출처 연결 기록 저장',command:'source-trace.json 텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',
    arguments:{path:join(root,'source-trace.json'),content:JSON.stringify(trace,null,2)+'\n',allowOverwrite:false},dependencies:[],successSignal:'출처 기록 파일 G 검증'},
   {id:'write-report',title:'원문 인용 연구 보고서 저장',command:'web-research.md 텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',
    arguments:{path:join(root,'web-research.md'),content:renderResearchTraceReport(trace),allowOverwrite:false},dependencies:[],successSignal:'연구 보고서 G 검증'}]);
 }
 return response('complete',[],{criteriaAssessment:[{criterionId:'source-trace',status:'satisfied',evidenceActionIds:observations.map(o=>o.actionId),reason:'실제 읽기와 두 파일의 결정형 대조 요청'}]});
};
const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),missionRunner:runner,workerDaemonEnabled:false,env,taskEnv:env});
try{
 const created=runtime.missionRuntime.createMission({objective:`공식 기술 공지 ${sourceUrl} 원문을 읽고 web-research.md 연구 보고서와 source-trace.json 출처 연결 기록에 조회 시각·원문 해시·인용 근거를 저장해. 주장의 의미적 타당성은 이번에 검증하지 마.`,
  authorization:{grants:['read_only','local_reversible']},budgets:{maxWaves:6,maxPlannerCalls:6},
  successCriteria:[{criterionId:'source-trace',statement:'실제 원문 관측·조회 시각·해시·인용이 현재 보고서와 출처 기록에 연결된다.',
   verificationSpec:{version:1,kind:'research.sourceTrace',path:'source-trace.json',reportPath:'web-research.md',minimumSources:1}}]});
 missionId=created.missionId;
 const result=await runtime.missionRuntime.runMission(missionId);
 const summary={observedAt:new Date().toISOString(),root,missionId,status:result.status,stopReason:result.stopReason,verification:result.verificationSummary,
  actualPublicHttpsReads:result.observations.filter(o=>o.toolName==='news.fetchArticle').map(o=>({outcome:o.outcome,verificationStatus:o.verification?.status,
   requestedUrl:o.data?.article?.requestedUrl,finalUrl:o.data?.article?.finalUrl,fetchedAt:o.data?.article?.fetchedAt,httpStatus:o.data?.article?.httpStatus,
   textSha256:o.data?.article?.textSha256,textCharacters:o.data?.article?.textCharacters,live:o.data?.article?.live,error:o.error})),
  diagnosticPlans:result.planHistory,
  diagnosticObservations:result.observations.map(o=>({toolName:o.toolName,category:o.category,outcome:o.outcome,error:o.error,summary:o.summary})),
  externalModelCalls:0,syntheticPlanner:runnerCalls>0,runnerCalls,semanticEntailment:'not-evaluated',externalUserEffects:0,cost:'unmeasured'};
 writeFileSync(join(root,'result.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
 if(result.status==='COMPLETED'){
  trace??=JSON.parse(readFileSync(join(root,'source-trace.json'),'utf8'));
  if(readFileSync(join(root,'web-research.md'),'utf8')!==renderResearchTraceReport(trace))throw Error('REPORT_REREAD_MISMATCH');
 }else process.exitCode=1;
 console.log(JSON.stringify(summary));
}finally{runtime.coreFacade.cognition.close();}
