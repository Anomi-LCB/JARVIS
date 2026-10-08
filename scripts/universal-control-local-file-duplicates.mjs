import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant, MissionStatus } from '../packages/core/src/mission/mission-runtime.js';
import { classifyCommandLane } from '../packages/shared/src/command-lane.js';
import { generateCorpus } from './universal-control-extreme-corpus.mjs';
import { createEvidenceRun, writeEvidence, EVIDENCE_ROOT } from './lib/universal-control-evidence.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const OUTPUT=EVIDENCE_ROOT;
const sha256=value=>createHash('sha256').update(value).digest('hex');
const writeJson=writeEvidence;

export async function runLocalDuplicateFileControl({outputBase=OUTPUT,quiet=false}={}) {
  const corpus=await generateCorpus();
  const testCase=corpus.cases.find(item=>item.id==='D01-02');
  const command="'inputs' 폴더의 파일을 재귀 해시 목록으로 조사해 '인벤토리'로 만들고; 'inputs' 폴더의 내용 중복을 찾아 '중복'으로 만들고; '중복'을 'outputs/duplicates.json' JSON으로 저장하고; '중복'의 개수가 1인지 검증해.";
  const root=await createEvidenceRun(outputBase,'local-duplicates');
  const started=performance.now();
  await mkdir(path.join(root,'inputs','nested'),{recursive:true});
  const duplicateBytes=Buffer.from('격리된 중복 파일 감지 시험\n내용은 읽기 전용입니다.\n','utf8');
  const uniqueBytes=Buffer.from('서로 다른 합성 파일\n','utf8');
  await writeFile(path.join(root,'inputs','a.txt'),duplicateBytes);
  await writeFile(path.join(root,'inputs','nested','copy.txt'),duplicateBytes);
  await writeFile(path.join(root,'inputs','unique.txt'),uniqueBytes);
  const before={
    'a.txt':sha256(duplicateBytes),
    'nested/copy.txt':sha256(duplicateBytes),
    'unique.txt':sha256(uniqueBytes)
  };
  const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
  let runtime=null,created=null,mission=null,error=null;
  try {
    runtime=createAgRuntime({allowedRoots:[root],auditRoot:path.join(root,'audit'),cwd:()=>root,env,taskEnv:env,workerDaemonEnabled:false,bridgeRealExecution:true,workerDefaultTimeoutMs:45000,missionMaxActionsPerWave:4});
    const owner=runtime.personalOwnerSession.activate({durationMinutes:15,requestedBy:'universal-control-local-duplicates'});
    created=runtime.missionRuntime.createMission({
      objective:command,
      successCriteria:[{criterionId:'duplicate_exists',statement:'outputs/duplicates.json 파일이 실제 생성된다.',verificationSpec:{version:1,kind:'file.exists',path:'outputs/duplicates.json'}},{criterionId:'duplicate_count',statement:'중복 그룹의 파일 수는 정확히 두 개다.',verificationSpec:{version:1,kind:'json.value',path:'outputs/duplicates.json',pointer:'/0/count',equals:2}},{criterionId:'duplicate_hash',statement:'중복 그룹 해시가 원본 내용과 일치한다.',verificationSpec:{version:1,kind:'json.value',path:'outputs/duplicates.json',pointer:'/0/sha256',equals:sha256(duplicateBytes)}}],
      constraints:[`허용 루트는 ${root} 하나이다.`,'외부 네트워크·계정·전송을 사용하지 않는다.','모든 입력은 읽기 전용이며 원본 파일을 이동·삭제·수정하지 않는다.'],
      budgets:{maxWaves:3,maxActions:8,maxPlannerCalls:4,maxConsecutiveFailures:2,maxActiveRuntimeMs:60000},
      authorization:{mode:'trusted_session',grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE],ownerSessionId:owner.session.sessionId},
      metadata:{auditCaseId:testCase.id,corpusSha256:corpus.sha256,externalNetworkAllowed:false},
      idempotencyKey:`universal-duplicates:${testCase.id}:${corpus.sha256.slice(0,16)}`
    });
    mission=await runtime.missionRuntime.runMission(created.missionId);
  } catch(caught) { error={code:caught.code??'PRODUCT_EXCEPTION',message:caught.message}; }
  const outputPath=path.join(root,'outputs','duplicates.json');
  let output=null,outputError=null;
  try { output=JSON.parse(await readFile(outputPath,'utf8')); } catch(caught) { outputError={code:caught.code??'OUTPUT_READ_FAILED',message:caught.message}; }
  const inputHashesAfter={};
  for(const relativePath of Object.keys(before)) inputHashesAfter[relativePath]=sha256(await readFile(path.join(root,'inputs',relativePath)));
  const expectedFiles=['a.txt','nested/copy.txt'].sort();
  const groups=Array.isArray(output)?output:output?.groups??[];
  const group=groups[0];
  const actualFiles=(group?.files??[]).map(item=>item.relativePath).sort();
  const outputMatches=groups.length===1&&group?.count===2&&group?.sha256===sha256(duplicateBytes)&&JSON.stringify(actualFiles)===JSON.stringify(expectedFiles);
  const actionList=mission?.waves?.flatMap(wave=>wave.actions??[])??[];
  const executed=actionList.filter(action=>action.taskId);
  const observation=mission?.observations?.find(item=>item.actionId===executed[0]?.actionId);
  const receiptPassed=executed.length===1&&executed[0]?.actualToolName==='workflow.execute'&&observation?.outcome==='success'&&observation?.verification?.status==='passed'&&Boolean(observation?.evidenceId);
  const inputUnchanged=Object.keys(before).every(relativePath=>before[relativePath]===inputHashesAfter[relativePath]);
  const success=mission?.status===MissionStatus.COMPLETED&&mission?.completion?.status==='verified'&&mission?.verificationStatus==='passed'&&receiptPassed&&outputMatches&&inputUnchanged&&!error;
  const result={schemaVersion:'2.0.0',caseId:'D01-02.local-exact-duplicates',parentCaseId:testCase.id,controlKind:'positive',coverage:{partialCoverage:true,originalCaseComplete:false,covered:['exact-content duplicates in three synthetic text files','original bytes unchanged'],notCovered:['large project directory','old-file classification','quarantine candidate list','recovery commands']},elapsedMs:Number((performance.now()-started).toFixed(3)),cost:'미측정',command,corpusSha256:corpus.sha256,observedAt:new Date().toISOString(),executionMode:'local-product-mission; LLM disabled; only local workflow operations requested',root,externalNetworkAllowed:false,externalEffectMeasurement:'local workflow receipts only; not host-wide network monitoring',missionStatus:mission?.status??null,completionStatus:mission?.completion?.status??null,verificationStatus:mission?.verificationStatus??null,successCriteria:mission?.successCriteria??[],criteriaVerification:mission?.completion?.criteria??[],productPass:Boolean(success),error,outputError,commandLane:classifyCommandLane(command),executedToolNames:executed.map(action=>action.actualToolName??null),workflowReceipt:{passed:receiptPassed,taskIds:executed.map(action=>action.taskId),observation:observation??null},output:{path:'outputs/duplicates.json',groupCount:groups.length,duplicateFileCount:group?.files?.length??0,groupSha256:group?.sha256??null,files:actualFiles,passed:outputMatches,sha256:output?sha256(JSON.stringify(output)):null},inputHashesBefore:before,inputHashesAfter,inputUnchanged,externalEffects:{network:0,email:0,calendar:0,booking:0,purchase:0,payment:0,physicalDevice:0},limitations:['합성된 세 개의 텍스트 파일과 지정된 임시 폴더에서 exact-content 중복 검색만 확인했다.','파일 자동 분류, 의미상 유사도 탐지, 실제 사용자 문서, 대용량 성능 또는 다른 파일 형식은 시험하지 않았다.']};
  await writeJson(path.join(root,'mission-created.json'),created);
  await writeJson(path.join(root,'mission-result.json'),mission);
  await writeJson(path.join(root,'result.json'),result);
  if(runtime?.close) await runtime.close();
  if(!quiet) console.log(JSON.stringify(result,null,2));
  
  return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) runLocalDuplicateFileControl().then(result=>{if(!result.productPass)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});
