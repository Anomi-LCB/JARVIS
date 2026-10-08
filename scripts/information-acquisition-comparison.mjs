import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,dirname,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {assertComparisonOutputPath} from './recovery-comparison.mjs';
import {acquireInformation,acquisitionPlanner,acquisitionModes} from './lib/information-acquisition-adapter.mjs';
const suitePath=resolve('tests/fixtures/information-acquisition-v1.json');
const frozenHash='5b6f5f5f453f5c10be46b18eb636ef0b1cfbadb9c1417383da0d27075d56ee93';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const sourcePaths=[suitePath,fileURLToPath(import.meta.url),resolve('scripts/lib/information-acquisition-adapter.mjs'),resolve('packages/core/src/mission/mission-runtime.js'),resolve('apps/pc-agent/src/pc-agent-runtime.js'),resolve('apps/verification/src/verification-runtime.js'),resolve('apps/runtime-compose/src/create-runtime.js')];
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]??null;
export async function runInformationComparison({repeat=3}={}){
 if(!Number.isInteger(repeat)||repeat<1||repeat>5)throw new Error('Invalid repetitions');
 if(hash(suitePath)!==frozenHash)throw new Error('Frozen corpus changed');
 const suite=JSON.parse(readFileSync(suitePath)),before=Object.fromEntries(sourcePaths.map(p=>[p,hash(p)]));
 const runs=[],startedAt=new Date().toISOString();
 for(let repetition=0;repetition<repeat;repetition++)for(const item of suite.cases){
  const order=acquisitionModes.map((_,i)=>acquisitionModes[(i+repetition)%acquisitionModes.length]);
  for(const mode of order){
   const root=mkdtempSync(join(tmpdir(),'jarvis-information-comparison-'));let runtime,toolCalls=0;
   const start=performance.now();
   try{
    if(!item.stimulus.missingHint)writeFileSync(join(root,'hint.json'),JSON.stringify(item.stimulus.hint));
    writeFileSync(join(root,'candidates.json'),typeof item.stimulus.candidateData==='string'?item.stimulus.candidateData:JSON.stringify(item.stimulus.candidateData));
    const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
    runtime=createAgRuntime({allowedRoots:[root],cwd:()=>root,auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,missionPlanner:acquisitionPlanner(mode,root)});
    const original=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
    runtime.orchestrationWorker.runTask=(...args)=>{toolCalls++;return original(...args);};
    const acquiredAt=performance.now();
    const request=Object.fromEntries(['target','candidateIds','cachedChoice','userAnswer'].map(k=>[k,item.stimulus[k]]));
    const result=await acquireInformation({runtime,root,mode,request});
    const ended=performance.now(),correct=result.selected===item.oracle.choice;
    runs.push({id:item.id,split:item.split,repetition,mode,...result,expected:item.oracle.choice,correct,
     incorrectSelection:result.selected!==null&&!correct,unresolvedExpectedChoice:result.selected===null&&item.oracle.choice!==null,
     setupMs:acquiredAt-start,acquisitionMs:ended-acquiredAt,totalMs:ended-start,toolCalls,approvals:result.gates?.filter(g=>g.type!=='clarification'&&g.decision==='approve').length??0,cost:null,costStatus:'미측정'});
   }finally{runtime?.coreFacade.cognition?.close();if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('jarvis-information-comparison-'))throw new Error('Cleanup target rejected');rmSync(root,{recursive:true,force:true});}
  }
 }
 const summary=acquisitionModes.map(mode=>{const rows=runs.filter(r=>r.mode===mode);return {mode,total:rows.length,correct:rows.filter(r=>r.correct).length,incorrectSelection:rows.filter(r=>r.incorrectSelection).length,unresolvedExpectedChoice:rows.filter(r=>r.unresolvedExpectedChoice).length,
  statuses:Object.fromEntries([...new Set(rows.map(r=>r.status))].map(status=>[status,rows.filter(r=>r.status===status).length])),
  failedActions:rows.reduce((s,r)=>s+(r.metrics.failedActions??0),0),plannerCalls:rows.reduce((s,r)=>s+(r.metrics.plannerCalls??0),0),
  questions:rows.reduce((s,r)=>s+r.questions,0),answers:rows.reduce((s,r)=>s+r.answers,0),toolCalls:rows.reduce((s,r)=>s+r.toolCalls,0),artifactReads:rows.reduce((s,r)=>s+r.artifactReads,0),
  acquisitionP50Ms:percentile(rows.map(r=>r.acquisitionMs),.5),acquisitionP95Ms:percentile(rows.map(r=>r.acquisitionMs),.95),totalP95Ms:percentile(rows.map(r=>r.totalMs),.95),cost:null};});
 return {version:suite.version,startedAt,finishedAt:new Date().toISOString(),suiteSha256:frozenHash,sources:before,sourceUnchanged:sourcePaths.every(p=>hash(p)===before[p]),environment:{node:process.version,platform:process.platform},summary,runs,
  limitations:['고정 한국어 자료 선언 일치 시험; 독립 전문가 의미 평가 아님','질문 응답은 합성 입력; 실제 사람의 응답 지연 제외','execute는 격리 JSON 복사·재조회; 외부 행동 권한 또는 일반 지능 실증 아님','조회·질문 계획은 scripted; 실행은 기존 결정형 workflow 계획기','질문 완료 뒤 BLOCKED는 업무 종료 표시이며 답변의 정확성을 보장하지 않음','holdout은 작성자에게 알려진 표현 반례; 블라인드 평가 아님','금액 비용 미측정; 로컬 파일 정확성만으로 현실 자료의 진실성 검증 불가']};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),options={repeat:3};let output;
 for(let i=0;i<args.length;i+=2){if(!args[i+1]||!['--output','--repeat'].includes(args[i]))throw new Error('Invalid arguments');if(args[i]==='--output')output=args[i+1];else options.repeat=Number(args[i+1]);}
 if(!output)throw new Error('--output required');assertComparisonOutputPath(output,{suitePath,sourcePaths,root:process.cwd()});
 const result=await runInformationComparison(options);mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(resolve(output),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,sourceUnchanged:result.sourceUnchanged,summary:result.summary}));
}
