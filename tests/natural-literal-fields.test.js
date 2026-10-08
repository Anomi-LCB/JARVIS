import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileNaturalWorkflowObjective} from '../packages/core/src/mission/natural-workflow-compiler.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';

const objective="'source.txt' 텍스트를 '자료'로 읽어; '자료'에서 '실제 지출액'을 '원' 단위 숫자로 추출해 '지출'로 만들어; '자료'에서 '승인 여부'의 승인 상태를 추출해 '승인'으로 만들어; '자료'에서 '확정일'의 미정 여부를 확인해 '납품'으로 만들어; '지출'을 'paid.json' JSON으로 저장해; '승인'을 'approval.json' JSON으로 저장해; '납품'을 'delivery.json' JSON으로 저장해";
const source='장비 도입 기록: 견적 금액은 450000원이고 결제는 하지 않았다. 승인 여부: 미승인. 실제 지출액은 0원이다. 공급 업체는 다음 주 납품이 가능할 것으로 예상하지만 확정일은 제시하지 않았다.';
test('natural request binds exact quoted labels and units with no expected answers in the spec',()=>{
 const result=compileNaturalWorkflowObjective(objective,{workspaceRoot:tmpdir()});assert.equal(result.status,'compiled',JSON.stringify(result));
 const nodes=result.spec.nodes.filter(n=>n.op==='text.extractFields');assert.equal(nodes.length,3);
 assert.equal(nodes[0].args.sourceFields.value.label,'실제 지출액');assert.equal(nodes[0].args.sourceFields.value.unit,'원');
 assert.equal(Object.hasOwn(nodes[0].args.sourceFields.value,'expected'),false);assert.equal(result.goalContract.requirements.length,7);
 for(const suffix of ['; 은행에서 송금해','; 결과를 저장하지 마'])assert.notEqual(compileNaturalWorkflowObjective(objective+suffix,{workspaceRoot:tmpdir()}).status,'compiled');
});
for(const mode of ['normal','conflict','negation','wrong-unit','revoked','quoted','conditional','invalid-utf8'])test('actual default planner literal-field workflow '+mode,async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-natural-fields-'));let runtime;
 try{
  const body=mode==='conflict'?source+' 실제 지출액은 300원이다.':mode==='negation'?source.replace('실제 지출액은 0원이다.','실제 지출액은 0원이 아니다.'):mode==='wrong-unit'?source.replace('실제 지출액은 0원이다.','실제 지출액은 0만원이다.'):source;
  const finalBody=mode==='quoted'?body.replace('실제 지출액은 0원이다.',"' 실제 지출액은 0원이다. '"):mode==='conditional'?body.replace('실제 지출액은 0원이다.','만약 실제 지출액은 0원이다.'):body;
  const bytes=mode==='invalid-utf8'?Buffer.concat([Buffer.from([0xff]),Buffer.from(finalBody)]):Buffer.from(finalBody);
  await writeFile(join(root,'source.txt'),bytes);
  const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
  runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,missionRunner:async()=>{throw new Error('LLM must not run');}});
  const owner=runtime.personalOwnerSession.activate({requestedBy:'natural-fields-test',durationMinutes:5});
  const expected={'paid.json':'0','approval.json':'미승인','delivery.json':'미정'};
  const mission=runtime.missionRuntime.createMission({objective,successCriteria:Object.entries(expected).map(([path,equals])=>({criterionId:path,statement:'원문 요구 값 확인',verificationSpec:{version:1,kind:'json.value',path,pointer:'/facts/value',equals}})),
    constraints:['외부 전송은 하지 않는다.'],authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE,MissionGrant.HIGH_IMPACT]}});
  if(mode==='revoked')runtime.personalOwnerSession.revoke({reason:'test revoke'});
  const started=performance.now(),result=await runtime.missionRuntime.runMission(mission.missionId,{maxWaves:3});
  if(mode==='normal'){
   assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,reason:result.stopReason,observations:result.observations}));
   for(const [file,value] of Object.entries(expected)){const output=JSON.parse(await readFile(join(root,file),'utf8'));assert.equal(output.facts.value,value);assert.ok(finalBody.includes(output.evidence.value));}
   assert.equal(result.observations.find(o=>o.toolName==='workflow.execute').verification.status,'passed');
  }else{assert.notEqual(result.status,'COMPLETED');for(const file of Object.keys(expected))await assert.rejects(readFile(join(root,file)),{code:'ENOENT'});}
  assert.deepEqual(await readFile(join(root,'source.txt')),bytes);
  console.log(JSON.stringify({naturalLiteralEvidence:{mode,status:result.status,reason:result.stopReason,totalMs:performance.now()-started,modelCalls:0}}));
 }finally{runtime?.coreFacade.cognition.close();await rm(root,{recursive:true,force:true});}
});
