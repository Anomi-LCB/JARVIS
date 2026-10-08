import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
const root=await mkdtemp(join(tmpdir(),'jarvis-paragraph-mission-')),output=join(root,'report.docx');
const multiline=process.argv.includes('--multiline');
const requested=['문단 순서 검증',multiline?'첫 문단\t10000원\n같은 입력의 다음 줄입니다.':'첫 문단의 금액은 10000원입니다.','둘째 문단의 금액은 2500원입니다.'];
const expected=requested.flatMap(value=>value.split('\n'));
const ops=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite')}),memory=new SqliteMemoryStore({dbPath:join(root,'growth.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
let runtime,missionId,plannerCalls=0;const started=performance.now();
const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
runtime=createAgRuntime({missionStore:new SqliteMissionStore({operationsStore:ops}),memoryStore:memory,allowedRoots:[root],cwd:()=>root,auditRoot:join(root,'audit'),cognitionStorePath:join(root,'cognition.sqlite'),workerDaemonEnabled:false,env,taskEnv:env,missionRunner:async()=>{
 plannerCalls++;const mission=runtime.missionRuntime.missions.get(missionId),o=mission.observations;
 return JSON.stringify(o.length?{decision:'complete',actions:[],criteriaAssessment:[{criterionId:'paragraphs',status:'satisfied',evidenceActionIds:o.map(x=>x.actionId)}]}:
 {decision:'continue',actions:[{id:'word',command:'report.docx 워드 문서를 만들어줘',expectedToolName:'word.create',arguments:{path:output,title:requested[0],blocks:requested.slice(1).map(text=>({type:'paragraph',text}))},dependencies:[]}]});
}});
try{
 const m=runtime.missionRuntime.createMission({objective:'report.docx 워드 문서를 만들어줘',authorization:{grants:['read_only','local_reversible']},budgets:{maxWaves:3,maxPlannerCalls:3},successCriteria:[{criterionId:'paragraphs',statement:'요청한 문단이 정확한 순서와 값으로 저장된다.',verificationSpec:{version:1,kind:'document.paragraphs',path:'report.docx',equals:expected}}]});
 missionId=m.missionId;const result=await runtime.missionRuntime.runMission(missionId),internal=runtime.missionRuntime.missions.get(missionId),ids=internal.observations.map(o=>o.actionId);
 const criterion=internal.successCriteria[0],current=runtime.missionRuntime.verifyCriterionEvidence(internal,criterion,ids);
 const swapped=structuredClone(criterion);[swapped.verificationSpec.equals[1],swapped.verificationSpec.equals[2]]=[swapped.verificationSpec.equals[2],swapped.verificationSpec.equals[1]];
 const wrong=runtime.missionRuntime.verifyCriterionEvidence(internal,swapped,ids);
 const original=await readFile(output);await writeFile(output,'changed after successful G');
 const changed=runtime.missionRuntime.verifyCriterionEvidence(internal,criterion,ids);
 const assertions={missionCompleted:result.status==='COMPLETED',orderedParagraphsVerified:current.passed===true,wrongOrderRejected:wrong.passed===false,currentFileChangeRejected:changed.passed===false,
  bothProofsPreserved:internal.observations.some(o=>['document.tables','document.paragraphs'].every(kind=>o.data?.artifactLayoutProofs?.some(p=>p.kind===kind))),actualNativeWord:internal.observations.some(o=>o.toolName==='word.create'&&o.verification?.status==='passed')};
 const report={observedAt:new Date().toISOString(),status:Object.values(assertions).every(Boolean)?'passed':'failed',assertions,missionStatus:result.status,stopReason:result.stopReason,current,wrong,changed,observations:internal.observations,plannerCalls,durationMs:performance.now()-started,originalBytes:original.length,externalModelCalls:0,scriptedPlanner:true,cost:null,scope:'Actual Word through Core/E/B/G and typed ordered paragraph criterion; arbitrary language, mixed block documents, installation and semantic accuracy not assessed.'};
 await writeFile('artifacts/document-paragraph-20261008-native'+(multiline?'-multiline':'')+'.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,assertions,missionStatus:result.status}));if(report.status!=='passed')process.exitCode=1;
}finally{runtime.coreFacade.cognition.close();memory.close();ops.close();await rm(root,{recursive:true,force:true});}
