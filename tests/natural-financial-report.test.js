import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {verifyFinancialReportResult} from '../packages/core/src/mission/mission-financial-report-result.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {compileNaturalWorkflowObjective} from '../packages/core/src/mission/natural-workflow-compiler.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
const objective="'records.json' 금융자료를 대사해 'report.md'에 저장하고 다시 읽어 확인해줘";
const input={transactions:[{id:'one',accountRef:'test',paymentRef:'p1',kind:'charge',amountMinor:700,currency:'KRW',category:'자료',source:'synthetic'}],receipts:[],budgets:[{id:'b',category:'자료',currency:'KRW',limitMinor:600}]};
const expected=['# 제공된 금융자료 대사','','자료 기준: 사용자가 제공한 기록','은행·영수증 진위는 검증하지 않았습니다. 거래 실행 권한이 없으며 금융·세무 조언이 아닙니다.','금액은 입력의 최소 화폐 단위이며 통화 간 환산·합산은 하지 않습니다.','','거래 1건 · 영수증 0건 · 일치 0건','확인 필요: 예','','## 범주별 금액','| 범주 | 통화 | 지출 | 환불 | 순지출 | 예산 | 초과 |','| --- | --- | --- | --- | --- | --- | --- |','| 자료 | KRW | 700 | 0 | 700 | 600 | 예 |','','## 대사 결과','| 거래 ID | 상태 | 영수증 ID |','| --- | --- | --- |','| one | receipt-missing | 없음 |','','연결되지 않은 영수증: 없음','제거한 동일 중복: 거래 0 · 영수증 0 · 예산 0',`입력 SHA-256: ${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`,''].join('\n')+'\n';
test('financial grammar retains all steps and rejects overwrite traversal and unsupported suffix',()=>{
 const c=compileNaturalWorkflowObjective(objective,{workspaceRoot:tmpdir()});assert.equal(c.status,'compiled');assert.deepEqual(c.spec.nodes.map(n=>n.op),['data.readJson','financial.report','write.text','text.read']);assert.equal(c.goalContract.requirements[0].nodeIds.length,4);
 for(const x of [objective+' 그리고 송금해',objective.replace('report.md','records.json'),objective.replace('report.md','../report.md')])assert.notEqual(compileNaturalWorkflowObjective(x,{workspaceRoot:tmpdir()}).status,'compiled');
});
for(const mode of ['exact','default','invalid'])test('actual Core E B G financial file '+mode,async()=>{
 const valid=mode!=='invalid';
 const root=await mkdtemp(join(tmpdir(),'jarvis-financial-'));let runtime;
 try{
 const data=structuredClone(input);if(!valid)data.transactions[0].amountMinor=-1;const source=JSON.stringify(data);await writeFile(join(root,'records.json'),source);
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
 const options={allowedRoots:[root],auditRoot:join(root,'audit'),missionStorePath:join(root,'missions.json'),env,taskEnv:env,workerDaemonEnabled:false,missionRunner:async()=>{throw Error('No model');}};runtime=createAgRuntime(options);
 const owner=runtime.personalOwnerSession.activate({requestedBy:'synthetic-finance',durationMinutes:5});
 const mission=runtime.missionRuntime.createMission({objective,successCriteria:[mode==='default'?{criterionId:'default',statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`}:{criterionId:'exact',statement:'독립 고정 보고서 값',verificationSpec:{version:1,kind:'text.equals',path:'report.md',equals:expected}}],authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE,MissionGrant.HIGH_IMPACT]}});
 const result=await runtime.missionRuntime.runMission(mission.missionId,{maxWaves:3});
 if(valid){assert.equal(result.status,'COMPLETED',JSON.stringify(result));assert.equal(await readFile(join(root,'report.md'),'utf8'),expected);assert.equal(result.observations.find(o=>o.toolName==='workflow.execute').verification.status,'passed');
 if(mode==='default'){
  const proof={objective,statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`,observations:result.observations,allowedRoots:[root]};
  assert.equal(verifyFinancialReportResult(proof).passed,true);
  assert.equal((await runtime.missionRuntime.getVerifiedFinancialReport(mission.missionId)).reportMarkdown,expected);
  const server=createCoreServer(runtime.coreFacade,{missionRuntime:runtime.missionRuntime,adminToken:'synthetic-admin',adminTokens:[{token:'reader',scopes:['read_diagnostics']}]});
  await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
  try{
   const base=`http://127.0.0.1:${server.address().port}`;const path=`/missions/${mission.missionId}/verified-financial-report`;
   assert.equal((await fetch(base+path)).status,401);
   assert.equal((await fetch(base+path,{headers:{authorization:'Bearer reader'}})).status,403);
   const response=await fetch(base+path,{headers:{authorization:'Bearer synthetic-admin'}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).reportMarkdown,expected);
   const missing=await fetch(base+'/missions/missing/verified-financial-report',{headers:{authorization:'Bearer synthetic-admin'}});assert.equal(missing.status,404);
   const spec=await(await fetch(base+'/openapi.json')).json();assert.equal(spec.paths['/missions/{missionId}/verified-financial-report'].get.operationId,'getVerifiedMissionFinancialReport');
   await writeFile(join(root,'report.md'),'PRIVATE_INVALID_REPORT');const changed=await fetch(base+path,{headers:{authorization:'Bearer synthetic-admin'}});const value=await changed.json();assert.equal(value.status,'changed-or-unavailable');assert.equal(value.reportMarkdown,undefined);assert.equal(JSON.stringify(value).includes('PRIVATE_INVALID_REPORT'),false);await writeFile(join(root,'report.md'),expected);
  }finally{await new Promise(r=>server.close(r));}
  const journal=await readFile(join(root,'missions.json'),'utf8');runtime.coreFacade.cognition.close();runtime=createAgRuntime(options);
  assert.equal((await runtime.missionRuntime.getVerifiedFinancialReport(mission.missionId)).reportMarkdown,expected);
  assert.equal(await readFile(join(root,'missions.json'),'utf8'),journal);

  const broken=structuredClone(proof);broken.observations.find(o=>o.toolName==='workflow.execute').data.workflow.receipts.pop();assert.equal(verifyFinancialReportResult(broken).passed,false);
  await writeFile(join(root,'report.md'),expected.replace('700','999'));assert.equal(verifyFinancialReportResult(proof).passed,false);assert.equal((await runtime.missionRuntime.getVerifiedFinancialReport(mission.missionId)).reportMarkdown,undefined);
  await writeFile(join(root,'report.md'),expected);await writeFile(join(root,'records.json'),source+' ');assert.equal(verifyFinancialReportResult(proof).passed,false);await writeFile(join(root,'records.json'),source);
 }
 }
 else{assert.notEqual(result.status,'COMPLETED');await assert.rejects(readFile(join(root,'report.md')),{code:'ENOENT'});}
 assert.equal(await readFile(join(root,'records.json'),'utf8'),source);
 }finally{runtime?.coreFacade.cognition.close();await rm(root,{recursive:true,force:true});}
});
