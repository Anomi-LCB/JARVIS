import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {verifiedResearchSources,createResearchSourceTrace,renderResearchTraceReport} from './research-source-trace.js';

// Whole-request grammar: unknown clauses and extra actions are not discarded.
export function parseResearchSourceRequest(mission,roots=[]){
 const pattern=/^(?:공식\s*(?:기술\s*공지|자료)|웹\s*페이지|뉴스\s*기사)\s+(https:\/\/\S+)\s+(?:원문|본문)을\s*읽고\s+([\p{L}\p{N}_.-]+\.md)\s*(?:연구\s*)?보고서와\s+([\p{L}\p{N}_.-]+\.json)\s*출처\s*연결\s*기록에\s*조회\s*시각\s*[·,]\s*원문\s*해시\s*[·,]\s*인용\s*근거를\s*저장(?:해|해주세요|해줘)[.]?\s*주장의\s*의미적\s*타당성은\s*(?:이번에\s*)?검증하지\s*마(?:세요)?[.]?$/u;
 const match=pattern.exec(mission?.objective?.trim()??'');
 if(!match||roots.length!==1||mission.constraints?.length||mission.goalContract?.objective!==mission.objective
  ||mission.goalContract?.contradictions?.length||mission.goalContract?.revisionChange)return null;
 let url;try{url=new URL(match[1]);if(url.protocol!=='https:'||url.username||url.password||url.port)return null;}catch{return null;}
 const criteria=mission.successCriteria??[],spec=criteria.length===1?criteria[0].verificationSpec:null;
 if(spec?.kind!=='research.sourceTrace'||spec.minimumSources!==1)return null;
 const root=resolve(roots[0]),reportPath=resolve(root,match[2]),tracePath=resolve(root,match[3]);
 if(resolve(root,spec.path)!==tracePath||resolve(root,spec.reportPath)!==reportPath)return null;
 if([tracePath,reportPath].some(path=>isAbsolute(relative(root,path))||relative(root,path).startsWith('..')))return null;
 return {url:url.href,reportPath,tracePath,criterionId:criteria[0].criterionId};
}
const allActions=mission=>(mission.waves??[]).flatMap(w=>w.actions??[]);
export function researchSourceOutputs(mission,request){
 const sources=verifiedResearchSources({observations:mission.observations,actions:allActions(mission)})
  .filter(source=>source.requestedUrl===request.url);
 if(sources.length!==1)return null;
 const source=sources[0];
 // An excerpt is not a fabricated summary. No extra facts or instructions.
 // Preserve exact whitespace from the observed body instead of normalizing it.
 const end=source.body.trimStart().match(/^(?:\S+\s+){0,9}\S+/u)?.[0];
 if(!end||!source.body.includes(end))return null;
 const trace=createResearchSourceTrace({observations:mission.observations,actions:allActions(mission),citations:[{
  observationActionId:source.observationActionId,claim:'조회한 원문의 발췌입니다. 별도 요약이나 의미적 사실 검증은 수행하지 않았습니다.',quote:end}]});
 return {sourceActionId:source.observationActionId,files:[{path:request.tracePath,content:JSON.stringify(trace,null,2)+'\n'},
  {path:request.reportPath,content:renderResearchTraceReport(trace)}]};
}
export function planResearchSourceWorkflow({mission,roots=[]}){
 const request=parseResearchSourceRequest(mission,roots);if(!request)return null;
 const actions=allActions(mission),observations=mission.observations??[];
 const output=researchSourceOutputs(mission,request);
 const plan=(decision,actions=[],extra={})=>({decision,actions,summary:'원문 조회와 출처 연결 기록을 처리합니다. 의미적 사실 검증은 제외합니다.',
  criteriaAssessment:[],planning:{provider:'local-research-source-compiler',externalService:'none',modelRoundTrips:0,reason:'whole-request-source-trace'},...extra});
 if(!actions.length)return plan('continue',[{id:'research_read',command:`이 기사 링크 읽어줘 ${request.url}`,expectedToolName:'news.fetchArticle',
  arguments:{url:request.url},dependencies:[],successSignal:'공개 원문 실제 조회와 G 검증'}]);
 if(!output)return plan('blocked',[],{blockedReason:'research-source-read-unverified'});
 if(actions.length===1)return plan('continue',output.files.map((file,index)=>({id:`research_write_${index}`,
  command:`${index?'보고서':'출처 기록'} 텍스트 파일을 만들어줘`,expectedToolName:'filesystem.createTextFile',
  arguments:{...file,allowOverwrite:false},dependencies:[],successSignal:'현재 원문과 산출물 내용 대조'})));
 if(actions.length!==3||observations.some(o=>o.category==='execution'&&o.outcome!=='success'))return plan('blocked',[],{blockedReason:'research-artifact-result-unresolved'});
 return plan('complete',[],{criteriaAssessment:[{criterionId:request.criterionId,status:'satisfied',
  evidenceActionIds:observations.filter(o=>o.category==='execution').map(o=>o.actionId),reason:'현재 산출물을 원문·시각·인용과 독립 대조해야 합니다.'}]});
}

// Used at both write admission and completion, independently of planner labels.
export function researchSourceCoverage({mission,roots,action,dispatchArguments,phase='completion'}){
 const request=parseResearchSourceRequest(mission,roots);if(!request)return null;
 if(action&&(action.actualToolName??action.expectedToolName)!=='filesystem.createTextFile')return null;
 const output=researchSourceOutputs(mission,request),actions=allActions(mission);
 const fail=()=>({allowed:false,reasons:[{code:'research-source-whole-request-binding-unverified'}],coveredRequirementIds:[]});
 if(!output||actions.length!==3)return fail();
 const reads=actions.filter(a=>(a.actualToolName??a.expectedToolName)==='news.fetchArticle');
 if(reads.length!==1||reads[0].actionId!==output.sourceActionId)return fail();
 const writes=actions.filter(a=>(a.actualToolName??a.expectedToolName)==='filesystem.createTextFile');
 const selected=new Set();
 for(const write of writes){
  const args=write===action?(dispatchArguments??write.arguments):write.operation?.dispatch?.arguments??write.arguments;
  if(!args||Object.keys(args).some(key=>!['path','content','allowOverwrite','rawText'].includes(key))
   ||args.rawText!=null&&args.rawText!==write.command)return fail();
  const file=output.files.find(f=>resolve(args?.path??'')===f.path&&args?.content===f.content&&args?.allowOverwrite===false);
  if(!file||selected.has(file.path))return fail();selected.add(file.path);
  if(phase==='completion'){
   const o=(mission.observations??[]).find(o=>o.actionId===write.actionId);
   if(write.status!=='succeeded'||o?.outcome!=='success'||o.verification?.status!=='passed'
    ||write.operation?.dispatch?.taskId!==write.taskId||write.operation.dispatch.toolName!==write.actualToolName
    ||o.actionId!==write.actionId||o.taskId!==write.taskId)return fail();
   const digest=createHash('sha256').update(file.content).digest('hex');
   if(!o.artifacts?.some(a=>a.outsideAllowedRoots===false&&a.contentSha256===digest))return fail();
  }
 }
 if(selected.size!==2||action&&!writes.includes(action))return fail();
 return {allowed:true,sourceBindingVerified:true,semanticAccuracyVerified:false,executionAuthority:false,
  reasons:[],coveredRequirementIds:mission.goalContract.requirements.map(r=>r.requirementId),
  resultCriteriaVerificationRequired:true,status:'whole-request-research-source-binding'};
}
