import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileNaturalWorkflowObjective} from '../packages/core/src/mission/natural-workflow-compiler.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
const objective="'source.txt' 텍스트를 '자료'로 읽어; '자료'에서 항목 '실제 지출액'의 '원' 단위 숫자, '승인 여부'의 승인 상태, '확정일'의 미정 여부를 함께 추출해 '요약'으로 만들어; '요약'을 'result.json' JSON으로 저장해; 그 파일을 '확인'으로 다시 읽어";
const source='장비 도입 기록: 견적 금액은 450000원이고 결제는 하지 않았다. 공급 업체는 다음 주 납품이 가능할 것으로 예상하지만 확정일은 제시하지 않았다. 승인 여부: 미승인. 실제 지출액은 0원이다.';
const singleObjective="'source.txt' 파일에서 항목 '실제 지출액'의 '원' 단위 숫자, '승인 여부'의 승인 상태, '확정일'의 미정 여부를 정리해 'result.json'에 JSON으로 저장하고 다시 읽어 확인해줘";
const discoveredObjective="'.' 폴더에서 "+singleObjective.replace(' 파일에서 항목',' 파일을 찾아 항목');
test('discovery compiles unique match assertion before dynamic read and preserves original request',()=>{
 const result=compileNaturalWorkflowObjective(discoveredObjective,{workspaceRoot:tmpdir()});assert.equal(result.status,'compiled',JSON.stringify(result));
 assert.deepEqual(result.spec.nodes.map(n=>n.op),['fs.inventory','data.filter','assert.count','text.read','text.extractFields','write.json','data.readJson']);
 assert.ok(result.spec.nodes[3].dependsOn.includes(result.spec.nodes[2].id));
 assert.equal(result.clauses[0].sourceText,discoveredObjective);
 assert.notEqual(compileNaturalWorkflowObjective(discoveredObjective.replace("'source.txt'","'../source.txt'"),{workspaceRoot:tmpdir()}).status,'compiled');
});
test('one sentence preserves full original requirement and every dependency without synthetic aliases',()=>{
 const result=compileNaturalWorkflowObjective(singleObjective,{workspaceRoot:tmpdir()});
 assert.equal(result.status,'compiled',JSON.stringify(result));
 assert.equal(result.clauseCount,1);assert.equal(result.nodeCount,4);
 assert.deepEqual(result.spec.nodes.map(n=>n.op),['text.read','text.extractFields','write.json','data.readJson']);
 assert.equal(result.goalContract.requirements[0].nodeIds.length,4);
 assert.equal(result.clauses[0].sourceText,singleObjective);
 for(const request of [singleObjective+' 그리고 송금해',singleObjective.replace("'result.json'","'source.txt'"),singleObjective.replace("'result.json'","'../result.json'")])assert.notEqual(compileNaturalWorkflowObjective(request,{workspaceRoot:tmpdir()}).status,'compiled');
});
test('multi-field natural binding is one typed operation with no embedded answers',()=>{
  const compiled=compileNaturalWorkflowObjective(objective,{workspaceRoot:tmpdir()});
  assert.equal(compiled.status,'compiled',JSON.stringify(compiled));
  const fields=compiled.spec.nodes.filter(n=>n.op==='text.extractFields');assert.equal(fields.length,1);
  assert.deepEqual(Object.keys(fields[0].args.sourceFields),['field1','field2','field3']);
  assert.equal(JSON.stringify(fields[0].args).includes('450000'),false);
  for(const bad of [objective.replace("'승인 여부'의 승인 상태","'실제 지출액'의 승인 상태"),objective.replace("'확정일'의 미정 여부","'확정일'의 예상 날짜"),objective+'; 결과를 이메일로 보내']){
    assert.notEqual(compileNaturalWorkflowObjective(bad,{workspaceRoot:tmpdir()}).status,'compiled');
  }
});
for(const mode of ['original','discovered','duplicate-file','missing-file','single-sentence','single-conflict','single-forbidden-suffix','different-labels','conflict','missing','quoted','conditional','wrong-unit'])test('default Core/E/B/G multi-field source contract '+mode,async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-multi-source-'));let runtime;
 try{
  let body=source,request=objective,expected={field1:'0',field2:'미승인',field3:'미정'};
  if(mode==='single-sentence')request=singleObjective;
  if(mode==='single-conflict'){request=singleObjective;body+=' 실제 지출액은 300원이다.';}
  if(mode==='single-forbidden-suffix')request=singleObjective+' 그리고 결과는 저장하지 마';
  if(['discovered','duplicate-file','missing-file'].includes(mode))request=discoveredObjective;
  if(mode==='missing-file')request=discoveredObjective.replace("'source.txt'","'absent.txt'");
  if(mode==='different-labels'){body='실제 주문수는 7개이다. 확인 상태: 승인. 수령일은 미정이다.';request=objective.replaceAll('실제 지출액','실제 주문수').replaceAll("'원'","'개'").replaceAll('승인 여부','확인 상태').replaceAll('확정일','수령일');expected={field1:'7',field2:'승인',field3:'미정'};}
  if(mode==='conflict')body+=' 실제 지출액은 300원이다.';
  if(mode==='missing')body=body.replace('승인 여부: 미승인.','');
  if(mode==='quoted')body=body.replace('실제 지출액은 0원이다.',"'실제 지출액은 0원이다.'");
  if(mode==='conditional')body=body.replace('실제 지출액은 0원이다.','만약 실제 지출액은 0원이다.');
  if(mode==='wrong-unit')body=body.replace('실제 지출액은 0원이다.','실제 지출액은 0만원이다.');
  let sourcePath=join(root,'source.txt');
  if(mode==='discovered'){await mkdir(join(root,'nested'));sourcePath=join(root,'nested','source.txt');}
  await writeFile(sourcePath,body);
  if(mode==='duplicate-file'){await mkdir(join(root,'nested'));await writeFile(join(root,'nested','source.txt'),body);}
  const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
  runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,missionRunner:async()=>{throw new Error('Model must not run');}});
  const owner=runtime.personalOwnerSession.activate({requestedBy:'multi-field-isolated-test',durationMinutes:5});
  const mission=runtime.missionRuntime.createMission({objective:request,successCriteria:Object.entries(expected).map(([field,equals])=>({criterionId:field,statement:'고정 원문 사실 오라클',verificationSpec:{version:1,kind:'json.value',path:'result.json',pointer:'/facts/'+field,equals}})),authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE,MissionGrant.HIGH_IMPACT]}});
  const start=performance.now(),result=await runtime.missionRuntime.runMission(mission.missionId,{maxWaves:3});
  if(mode==='original'||mode==='discovered'||mode==='single-sentence'||mode==='different-labels'){
    assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,reason:result.stopReason,observations:result.observations}));
    const output=JSON.parse(await readFile(join(root,'result.json'),'utf8'));assert.deepEqual(output.facts,expected);
    assert.ok(Object.values(output.evidence).every(quote=>body.includes(quote)));
    assert.equal(result.observations.find(o=>o.toolName==='workflow.execute').verification.status,'passed');
  }else{assert.notEqual(result.status,'COMPLETED');await assert.rejects(readFile(join(root,'result.json')),{code:'ENOENT'});}
  assert.equal(await readFile(sourcePath,'utf8'),body);
  console.log(JSON.stringify({multiFieldEvidence:{mode,status:result.status,totalMs:performance.now()-start,modelCalls:0}}));
 }finally{runtime?.coreFacade.cognition.close();await rm(root,{recursive:true,force:true});}
});
