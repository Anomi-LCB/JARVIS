import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {importOfxBankStatement} from '../packages/shared/src/ofx-bank-statement-import.js';import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const xml='<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>KRW</CURDEF><BANKACCTFROM><BANKID>test</BANKID><ACCTID>A</ACCTID></BANKACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261001</DTPOSTED><TRNAMT>-700</TRNAMT><FITID>one</FITID></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
for(const mode of ['natural','invalid','prepared'])test('actual natural OFX Core E B G file '+mode,async()=>{
 const valid=mode!=='invalid';
 const root=await mkdtemp(join(tmpdir(),'jarvis-ofx-mission-'));let runtime;
 try{const imported=importOfxBankStatement(xml,{currencyExponents:{KRW:0}});const source=JSON.stringify({xml,currencyExponents:{KRW:0},classifications:valid?[{transactionId:imported.records[0].id,sourceSha256:imported.sourceSha256,kind:'charge',category:'자료',paymentRef:'p'}]:[],receipts:[],budgets:[{id:'b',category:'자료',currency:'KRW',limitMinor:600}]});await writeFile(join(root,'records.json'),source);
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
 runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),missionStorePath:join(root,'missions.json'),env,taskEnv:env,workerDaemonEnabled:false,missionRunner:async()=>{throw Error('No model');}});const owner=runtime.personalOwnerSession.activate({requestedBy:'synthetic-ofx',durationMinutes:5});const objective="'records.json' OFX 금융자료를 대사해 'report.md'에 저장하고 다시 읽어 확인해줘";
 const authorization={mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE,MissionGrant.HIGH_IMPACT]};
 let mission;
 if(mode==='prepared'){
  const server=createCoreServer(runtime.coreFacade,{missionRuntime:runtime.missionRuntime,ownerSessionManager:runtime.personalOwnerSession,adminToken:'admin',adminTokens:[{token:'reader',scopes:['read_diagnostics']}]});await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
  try{
   const url=`http://127.0.0.1:${server.address().port}/financial-records/ofx/save-mission`;
   const payload={input:JSON.parse(source),authorization,idempotencyKey:'ofx_save_synthetic'};
   const post=(body,token='admin')=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
   assert.equal((await post(payload,null)).status,401);assert.equal((await post(payload,'reader')).status,403);
   assert.equal((await post({...payload,authorization:{}})).status,409);
   assert.equal((await post({...payload,outputPath:'../forbidden'})).status,400);
   const created=await post(payload);assert.equal(created.status,201);assert.equal(created.headers.get('cache-control'),'no-store');mission=await created.json();
   assert.equal((await(await post(payload)).json()).missionId,mission.missionId);
   assert.equal((await post({...payload,input:{...payload.input,budgets:[]}})).status,409);
  }finally{await new Promise(r=>server.close(r));}
 }else mission=runtime.missionRuntime.createMission({objective,successCriteria:[{criterionId:'default',statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`}],authorization});
 const result=await runtime.missionRuntime.runMission(mission.missionId,{maxWaves:3});
 if(valid){assert.equal(result.status,'COMPLETED',JSON.stringify(result));const reportPath=mode==='prepared'?runtime.missionRuntime.missions.get(mission.missionId).ofxSave.operationId:null;const output=join(root,reportPath?`financial-report-${reportPath}.md`:'report.md');const report=await readFile(output,'utf8');assert.match(report,/\| 자료 \| KRW \| 700 \| 0 \| 700 \| 600 \| 예 \|/);assert.match(report,/총 가져온 거래 1건 · 대사 대상 1건 · 기타 0건/);assert.equal((await runtime.missionRuntime.getVerifiedFinancialReport(mission.missionId)).reportMarkdown,report);
  if(mode==='prepared'){
   runtime.coreFacade.cognition.close();runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),missionStorePath:join(root,'missions.json'),env,taskEnv:env,workerDaemonEnabled:false,missionRunner:async()=>{throw Error('No model');}});
   assert.equal((await runtime.missionRuntime.getVerifiedFinancialReport(mission.missionId)).reportMarkdown,report);
   await writeFile(output,'PRIVATE_TAMPER');assert.equal((await runtime.missionRuntime.getVerifiedFinancialReport(mission.missionId)).reportMarkdown,undefined);
  }
 }
 else{assert.notEqual(result.status,'COMPLETED');await assert.rejects(readFile(join(root,'report.md')),{code:'ENOENT'});}assert.equal(await readFile(join(root,'records.json'),'utf8'),source);
 }finally{runtime?.coreFacade.cognition.close();await rm(root,{recursive:true,force:true});}
});
