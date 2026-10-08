import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve,dirname,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {CoreFacade} from '../packages/core/src/core-facade.js';
import {assertComparisonOutputPath} from './recovery-comparison.mjs';
const suitePath=resolve('tests/fixtures/new-session-memory-v1.json'),frozenHash='721a96dfc69cae010a577746376e021879055c6774d930cc6d4b30916763fdab';
const sourcePaths=[suitePath,fileURLToPath(import.meta.url),resolve('apps/growth-memory/src/growth-runtime.js'),resolve('apps/growth-memory/src/personal-knowledge-projection.js'),resolve('packages/core/src/core-facade.js'),resolve('packages/core/src/context/memory-context-projection.js')];
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const modes=['off','on','stale','wrong'];
export function chooseDeclaredMemory({subject,explicitChoice},context){
 if(explicitChoice!==undefined)return ['a','b'].includes(explicitChoice)?explicitChoice:null;
 if(context.some(r=>r.subject===subject&&r.predicate==='선택'&&r.requiresUserResolution))return null;
 const values=[...new Set(context.filter(r=>r.memoryType==='personal_knowledge'&&r.subject===subject&&r.predicate==='선택'&&r.status==='active').map(r=>r.value))];
 return values.length===1&&['a','b'].includes(values[0])?values[0]:null;
}
export async function runNewSessionMemoryComparison({repeat=3,executeArtifact=null}={}){
 if(!Number.isInteger(repeat)||repeat<1||repeat>5)throw new Error('Invalid repetitions');
 if(hash(suitePath)!==frozenHash)throw new Error('Frozen corpus changed');
 const suite=JSON.parse(readFileSync(suitePath)),before=Object.fromEntries(sourcePaths.map(p=>[p,hash(p)])),rows=[],startedAt=new Date().toISOString();
 for(let repetition=0;repetition<repeat;repetition++)for(const item of suite.cases)for(let position=0;position<modes.length;position++){
  const mode=modes[(position+repetition)%modes.length],root=mkdtempSync(join(tmpdir(),'jarvis-new-session-memory-'));
  const options={dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups'),clock:()=>new Date(suite.now)};
  let store,core;const started=performance.now();
  try{
   store=new SqliteMemoryStore(options);let growth=new GrowthRuntime({memoryStore:store,auditRoot:root,clock:options.clock});
   const scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:null};
   const seed=(id,value,patch={})=>{
    const result=growth.ingest({eventId:id,taskId:id,eventType:'task.created',createdAt:patch.at??'2026-10-01T00:00:00.000Z',source:{module:'CORE',memoryScope:{...scope,userId:patch.otherOwner?'other-synthetic-owner':scope.userId}},
     payload:{rawText:'합성 자료 선택',knowledge:{kind:'fact',subject:item.subject,predicate:'선택',value,...(patch.expired?{validUntil:'2026-10-02T00:00:00.000Z'}:{}),...(patch.supersedes?{supersedesEventId:patch.supersedes}:{})}},
     learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true,externalContent:false,systemGenerated:false}},patch.supersedes?{expectedKnowledgeSource:{eventId:patch.supersedes,observedAt:'2026-10-01T00:00:00.000Z'}}:{});
    if(!result.success)throw new Error('Synthetic seed rejected');
   };
   if(mode==='wrong')seed('wrong',item.memoryValue==='a'?'b':'a');
   else if(mode==='stale')seed('expired',item.memoryValue,{expired:true});
   else{
    if(item.correction){seed('old','a');seed('current',item.memoryValue,{at:'2026-10-03T00:00:00.000Z',supersedes:'old'});}
    else seed('current',item.memoryValue,{otherOwner:item.otherOwner});
    if(item.conflict)seed('conflicting','b',{at:'2026-10-03T00:00:00.000Z'});
   }
   // A genuinely reopened SQLite connection and new F/Core objects; no old in-memory ingestor survives.
   store.close();growth=null;store=new SqliteMemoryStore(options);growth=new GrowthRuntime({memoryStore:store,auditRoot:root,clock:options.clock});
   core=new CoreFacade({memoryStore:growth,clock:options.clock,workspaceRoot:root,cwd:()=>root});
   let recallCalls=0;const original=growth.query.bind(growth);growth.query=(...args)=>{recallCalls++;return original(...args);};
   const acquisitionStarted=performance.now();
   const task=core.createTask(item.subject+' 선택을 참고해서 작업 폴더 파일 목록 보여줘',{userId:scope.userId,metadata:{longTermMemory:mode!=='off',conversationId:null}});
   let selected=chooseDeclaredMemory({subject:item.subject,explicitChoice:item.explicitChoice},task.memoryContext),execution=null;
   if(executeArtifact){execution=await executeArtifact({root,store,clock:options.clock,request:{subject:item.subject,explicitChoice:item.explicitChoice},enabled:mode!=='off'});selected=execution.selected;}
   const ended=performance.now();
   rows.push({caseId:item.id,repetition,mode,selected,gold:item.gold,correct:selected===item.gold,incorrectSelection:selected!==null&&selected!==item.gold,unresolvedExpectedChoice:selected===null&&item.gold!==null,
    contextSourceIds:task.memoryContext.flatMap(r=>r.provenance?.sourceEventIds??[]),memoryTypes:task.memoryContext.map(r=>r.memoryType),recallCalls,
    userPreferences:task.contextSnapshot.userPreferences.length,memoryEvidence:task.contextSnapshot.memoryEvidence.length,
    authorityGrantedByMemory:task.contextSnapshot.memoryEvidence.some(r=>r.executionAuthority!==false),
    totalMs:ended-started,prepareAndRecallMs:ended-acquisitionStarted,execution,toolCalls:execution?.toolCalls??0,externalModelCalls:0,cost:null,userQuestions:null,approvals:null,status:execution?'measured-local-artifact':'measured-local-context-only'});
  }finally{core?.cognition?.close();store?.close();if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw new Error('Cleanup rejected');rmSync(root,{recursive:true,force:true});}
 }
 const pct=(v,p)=>[...v].sort((a,b)=>a-b)[Math.ceil(v.length*p)-1];
 const summary=modes.map(mode=>{const selected=rows.filter(r=>r.mode===mode);return {mode,total:selected.length,correct:selected.filter(r=>r.correct).length,incorrectSelection:selected.filter(r=>r.incorrectSelection).length,unresolvedExpectedChoice:selected.filter(r=>r.unresolvedExpectedChoice).length,recallCalls:selected.reduce((s,r)=>s+r.recallCalls,0),p50Ms:pct(selected.map(r=>r.prepareAndRecallMs),.5),p95Ms:pct(selected.map(r=>r.prepareAndRecallMs),.95),fullP95Ms:pct(selected.map(r=>r.totalMs),.95),cost:null};});
 return {version:suite.version,startedAt,observedAt:new Date().toISOString(),corpusSha256:frozenHash,sourceHashes:before,sourceUnchanged:sourcePaths.every(p=>hash(p)===before[p]),summary,rows,
  limitations:['고정 합성 선택 과제와 결정형 소비자; LLM 품질·실제 업무 완료 또는 독립 전문가 평가가 아님','on/off는 실제 Core longTermMemory 설정과 재개방 F/SQLite 질의. 새 객체 세션이며 별도 OS 프로세스 시험 아님','오래된 기억은 선언된 validUntil 만료; 유효기간 없는 현실 정보의 낡음을 검출하지 못함','wrong은 아직 정정되지 않은 사용자 진술; 현재 출처 또는 실제 업무 검증 없이 진실성을 판별할 수 없음','실제 사람 질문/승인 및 비용 미측정; 도구·외부모델 호출은 실제로 없음','성공보다 실패를 유지하고 기본 모델·권한·운영 설정을 변경하지 않음']};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),opts={};let output;const seen=new Set();
 for(let i=0;i<args.length;i+=2){if(!['--output','--repeat'].includes(args[i])||seen.has(args[i])||!args[i+1])throw new Error('Invalid arguments');seen.add(args[i]);if(args[i]==='--output')output=args[i+1];else opts.repeat=Number(args[i+1]);}
 if(!output)throw new Error('--output required');assertComparisonOutputPath(output,{suitePath,sourcePaths,root:process.cwd()});
 const report=await runNewSessionMemoryComparison(opts);mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,sourceUnchanged:report.sourceUnchanged,summary:report.summary}));
}
