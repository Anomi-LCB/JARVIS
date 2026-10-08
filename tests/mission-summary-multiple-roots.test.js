import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
import {generateLocalSourceSummary} from '../packages/core/src/mission/local-source-summary.js';

test('find, read, derive source facts, save and rediscover across separate registered roots',{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-multiroot-summary-'));let runtime;
 try{
  const roots=['decoy','source','results'].map(name=>join(root,name));
  await Promise.all(roots.map(path=>mkdir(path,{recursive:true})));
  const input=join(roots[1],'notes.txt'),output=join(roots[2],'summary.txt');
  const source='현재 재고는 12개이다. 현재 재고 정정: 12개 → 9개.\n업체 주장: 처리 속도 개선율은 30%이다.';
  await writeFile(input,source);
  const expected=JSON.stringify({inventory:'9',claim:'30'});
  const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
  let generated;
  const planner={async planNextWave(context){
   const count=context.observations.filter(o=>o.outcome==='success').length;
   let tool,args;
   if(count===0){tool='filesystem.searchFiles';args={query:'notes.txt',scope:'workspace',directory:roots[1],maxResults:20};}
   else if(count===1){tool='filesystem.readText';args={path:input,offset:0,maxChars:12000};}
   else if(count===2){
    const read=context.observations.find(o=>o.toolName==='filesystem.readText');
    assert.equal(read.verification.status,'passed');
    generated=await generateLocalSourceSummary({source:read.data.textRead.content,
     questions:{inventory:'정정 후 재고',claim:'업체가 주장한 개선율'},valueFormats:{inventory:'digits',claim:'digits'},
     sourceFields:{inventory:{label:'현재 재고',kind:'corrected-integer',unit:'개'},claim:{label:'처리 속도 개선율',kind:'attributed-integer',actor:'업체',unit:'%'}}},{});
    tool='filesystem.createTextFile';args={path:output,content:JSON.stringify(generated.output.facts)};
   }else if(count===3){tool='filesystem.searchFiles';args={query:'summary.txt',scope:'workspace',directory:roots[2],maxResults:20};}
   else if(count===4){tool='filesystem.readText';args={path:output,offset:0,maxChars:12000};}
   else return {decision:'complete',actions:[],criteriaAssessment:[]};
   return {decision:'continue',actions:[{id:'step-'+count,command:tool==='filesystem.createTextFile'?'summary.txt 텍스트 파일을 만들어줘':tool==='filesystem.searchFiles'?'작업공간에서 파일을 찾아줘':'파일 내용을 읽어줘',expectedToolName:tool,arguments:args,dependencies:[]}]};
  }};
  runtime=createAgRuntime({allowedRoots:roots,auditRoot:join(root,'audit'),cwd:()=>roots[0],env,taskEnv:env,missionPlanner:planner,workerDaemonEnabled:false});
  const owner=runtime.personalOwnerSession.activate({requestedBy:'isolated-multiroot-test',durationMinutes:5});
  const objective=`'${input}' 파일을 찾아 내용을 읽고 핵심 사실을 요약해 '${output}'로 저장한 다음, 저장된 요약 파일을 다시 찾아 읽고 확인해`;
  const mission=runtime.missionRuntime.createMission({objective,
   successCriteria:[{criterionId:'facts',statement:'독립 정답과 일치',verificationSpec:{version:1,kind:'text.equals',path:output,equals:expected}}],
   authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE,MissionGrant.HIGH_IMPACT]}});
  const result=await runtime.missionRuntime.runMission(mission.missionId,{maxWaves:6});
  assert.equal(await readFile(output,'utf8'),expected);
  assert.equal(generated.fieldProvenance.claim.independentlyVerified,false);
  if(result.status!=='COMPLETED')console.log(JSON.stringify({searches:result.observations.filter(o=>o.toolName==='filesystem.searchFiles'),actions:result.waves.flatMap(w=>w.actions).map(a=>({tool:a.actualToolName,dispatch:a.operation?.dispatch}))}));
  assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,coverage:result.goalCompletionCoverage,reason:result.stopReason}));
  assert.equal(result.metrics.executedActions,5);
  assert.equal(await readFile(input,'utf8'),source);
  console.log(JSON.stringify({actualLocalMission:true,actions:5,sourceRoot:1,resultRoot:2,modelCalls:0,independentSemanticQuality:false}));
 }finally{runtime?.coreFacade.cognition.close();await rm(root,{recursive:true,force:true});}
});
