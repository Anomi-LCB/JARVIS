import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';
import { generateCorpus } from './universal-control-extreme-corpus.mjs';
import { createEvidenceRun, writeEvidence, EVIDENCE_ROOT } from './lib/universal-control-evidence.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const OUTPUT=EVIDENCE_ROOT;
const writeJson=writeEvidence;

export async function runMissingInputControl({outputBase=OUTPUT,quiet=false}={}) {
  const corpus=await generateCorpus();
  const testCase=corpus.cases.find(item=>item.id==='D01-09');
  const root=await createEvidenceRun(outputBase,'missing-input');
  const started=performance.now();
  await mkdir(path.join(root,'inputs'),{recursive:true});
  await writeFile(path.join(root,'inputs','a.csv'),'id,region,status,amount\n1,north,paid,10\n','utf8');
  const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
  let runtime=null,created=null,mission=null,error=null;
  try {
    runtime=createAgRuntime({allowedRoots:[root],auditRoot:path.join(root,'audit'),cwd:()=>root,env,taskEnv:env,workerDaemonEnabled:false,bridgeRealExecution:true,workerDefaultTimeoutMs:45000,missionMaxActionsPerWave:4});
    const owner=runtime.personalOwnerSession.activate({durationMinutes:15,requestedBy:'universal-control-local-missing-input'});
    created=runtime.missionRuntime.createMission({
      objective:testCase.command,
      successCriteria:['outputs/summary.csv가 실제 생성된다.'],
      constraints:[`허용 루트는 ${root} 하나이다.`,'외부 네트워크·계정·전송을 사용하지 않는다.','존재하지 않는 입력을 대신 만들거나 임의 경로에서 찾지 않는다.'],
      budgets:{maxWaves:2,maxActions:4,maxPlannerCalls:2,maxConsecutiveFailures:1,maxActiveRuntimeMs:30000},
      authorization:{mode:'trusted_session',grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE],ownerSessionId:owner.session.sessionId},
      metadata:{auditCaseId:testCase.id,faultVariant:'missing-prerequisite',corpusSha256:corpus.sha256,externalNetworkAllowed:false},
      idempotencyKey:`universal-missing:${testCase.id}:${corpus.sha256.slice(0,16)}`
    });
    mission=await runtime.missionRuntime.runMission(created.missionId);
  } catch(caught) { error={code:caught.code??'PRODUCT_EXCEPTION',message:caught.message}; }
  const outputPath=path.join(root,'outputs','summary.csv');
  let outputExists=true,outputContents=null;
  try { outputContents=await readFile(outputPath,'utf8'); } catch(caught) { outputExists=caught.code!=='ENOENT'; }
  const observations=mission?.observations??[];
  const actions=mission?.waves?.flatMap(wave=>wave.actions??[])??[];
  const success=Boolean(mission?.status==='BLOCKED'&&!error&&!outputExists&&actions.every(action=>action.status!=='succeeded')&&!observations.some(item=>item.category==='completion_guard'&&item.outcome==='success'));
  const result={schemaVersion:'2.0.0',caseId:'D01-09.local-csv-missing-input',parentCaseId:testCase.id,controlKind:'fault',coverage:{partialCoverage:true,originalCaseComplete:false,covered:['missing CSV fails closed'],notCovered:['complete corpus requirements','provider authentication failures']},elapsedMs:Number((performance.now()-started).toFixed(3)),cost:'미측정',faultVariant:'missing-prerequisite',expectedStatus:'사전 조건 차단',observedAt:new Date().toISOString(),root,missingInput:'inputs/b.csv',missionStatus:mission?.status??null,stopReason:mission?.stopReason??null,productPass:success,error,outputExists,outputContents,executedToolNames:actions.filter(action=>action.taskId).map(action=>action.actualToolName).filter(Boolean),executedActions:actions.map(({actualToolName,status})=>({actualToolName,status})),observations:observations.map(({category,outcome,summary,error:observationError})=>({category,outcome,summary,error:observationError})),externalEffects:{network:0,email:0,purchase:0,payment:0,physicalDevice:0},interpretation:'누락 입력이 있을 때 산출물을 꾸며 완료로 보고하지 않고 멈추는지 검사함. 사용자에게 친절한 다음 조치 안내의 품질은 별도 평가하지 않음.'};
  await writeJson(path.join(root,'mission-created.json'),created);
  await writeJson(path.join(root,'mission-result.json'),mission);
  await writeJson(path.join(root,'result.json'),result);
  if(runtime?.close) await runtime.close();
  if(!quiet) console.log(JSON.stringify(result,null,2));
  
  return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) runMissingInputControl().then(result=>{if(!result.productPass)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});
