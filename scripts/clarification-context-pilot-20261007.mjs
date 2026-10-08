import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
const root=mkdtempSync(resolve('artifacts/clarification-context-pilot-20261007-')),rows=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
const knownQuestions=['결과 파일의 이름은 무엇인가요?','원본 파일의 이름은 무엇인가요?'];
const answerQuestions=['포함할 항목은 무엇인가요?','제목은 무엇인가요?'];
for(const mode of ['known-source','typed-answer-restart']){
 const directory=join(root,mode);mkdirSync(directory);const content='합성 원본: 확인된 항목 3건\n',expectedOutput=mode==='known-source'?content:`확인된 항목\n${content}`;writeFileSync(join(directory,'source.txt'),content,{flag:'wx'});
 let runtime,first,restored,missionId,plannerCalls=0,readCalls=0,writeCalls=0,interventions=0;
 const started=performance.now();
 const planner={async planNextWave(context){plannerCalls++;
  const reads=context.observations.filter(o=>o.toolName==='filesystem.readText'&&o.outcome==='success');
  const resolved=context.observations.filter(o=>o.category==='clarification_context'&&o.outcome==='success');
  const reqs=runtime.missionRuntime.missions.get(missionId).goalContract.requirements;
  const readAction={id:'read',title:'원본 읽기',command:'source.txt 내용을 읽어줘',expectedToolName:'filesystem.readText',arguments:{path:join(directory,'source.txt'),maxChars:1024},dependencies:[],clarificationIndependent:true,...(mode==='known-source'?{requirementIds:[reqs[0].requirementId]}:{})};
  if(mode==='known-source'&&!reads.length)return {decision:'ask_user',questions:knownQuestions,actions:[readAction]};
  if(mode==='typed-answer-restart'&&!context.observations.some(o=>o.category==='user_clarification'))return {decision:'ask_user',questions:answerQuestions,actions:reads.length?[]:[readAction]};
  // Intentionally repeat the answered batch once. Runtime must replan without
  // presenting another gate or guessing a new answer.
  if(mode==='typed-answer-restart'&&!resolved.length)return {decision:'ask_user',questions:answerQuestions,actions:[]};
  const actualSource=reads[0]?.data?.textRead?.content;
  assert.equal(typeof actualSource,'string','writer must consume the independently observed read, not a fixture constant');
  const answers=runtime.missionRuntime.missions.get(missionId).gates.find(g=>g.status==='approved'&&g.type==='clarification')?.answers;
  if(mode==='typed-answer-restart')assert.deepEqual(answers,['항목 전체','확인된 항목']);
  const outputContent=mode==='known-source'?actualSource:`${answers[1]}\n${actualSource}`;
  if(!context.observations.some(o=>o.toolName==='filesystem.createTextFile'&&o.outcome==='success'))return {decision:'continue',actions:[{
   id:'write',title:'확인된 결과 저장',command:'result.txt를 저장해',expectedToolName:'filesystem.createTextFile',
   arguments:{path:join(directory,'result.txt'),content:outputContent,allowOverwrite:false},dependencies:[],...(mode==='known-source'?{requirementIds:[reqs[1].requirementId]}:{})}],criteriaAssessment:[]};
  return {decision:'complete',actions:[],criteriaAssessment:context.mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:context.observations.filter(o=>o.outcome==='success'&&o.actionId).map(o=>o.actionId)}))};
 }};
 const options={allowedRoots:[directory],auditRoot:join(directory,'audit'),cwd:()=>directory,env,taskEnv:env,missionPlanner:planner,workerDaemonEnabled:false};
 const instrument=r=>{for(const [tool,increment] of [['filesystem.readText',()=>readCalls++],['filesystem.createTextFile',()=>writeCalls++]]){
  const adapter=r.pcAgent.registry.get(tool),execute=adapter.execute.bind(adapter);adapter.execute=async(...args)=>{increment();return execute(...args);};}};
 try{
  first=runtime=createAgRuntime(options);instrument(runtime);
  const objective=mode==='known-source'?"'source.txt'를 읽어; 'result.txt'를 저장해":'선택한 자료를 확인한 뒤 답변 조건에 맞는 문서를 저장해';
  const created=runtime.missionRuntime.createMission({objective,successCriteria:[{statement:'결과 파일 내용이 정확하다',verificationSpec:{version:1,kind:'text.equals',path:'result.txt',equals:expectedOutput}}],authorization:{grants:['read_only','local_reversible']},budgets:{maxPlannerCalls:6,maxWaves:4}});
  missionId=created.missionId;let result=await runtime.missionRuntime.runMission(created.missionId);
  if(mode==='typed-answer-restart'){
   assert.equal(result.status,'WAITING_APPROVAL');assert.equal(readCalls,1);assert.equal(writeCalls,0);assert.equal(result.pendingGates.length,1);
   assert.equal(runtime.missionRuntime.decideGate(created.missionId,result.pendingGates[0].gateId,{decision:'approve',answers:['항목 전체']}).error.code,'A_MISSION_CLARIFICATION_ANSWERS_INVALID');
   runtime.missionRuntime.decideGate(created.missionId,result.pendingGates[0].gateId,{decision:'approve',answers:['항목 전체','확인된 항목']});interventions++;
   restored=runtime=createAgRuntime(options);instrument(runtime);result=await runtime.missionRuntime.runMission(created.missionId);
  }
  const internal=runtime.missionRuntime.missions.get(created.missionId),actual=readFileSync(join(directory,'result.txt'),'utf8');
  assert.equal(result.status,'COMPLETED',JSON.stringify({mode,status:result.status,reason:result.stopReason,error:result.lastError}));
  assert.equal(result.pendingGates.length,0);assert.equal(actual,expectedOutput);assert.equal(readCalls,1);assert.equal(writeCalls,1);
  assert.equal(hash(readFileSync(join(directory,'source.txt'))),hash(content));
  rows.push({mode,objective,status:result.status,interventions,plannerCalls,readCalls,writeCalls,durationMs:performance.now()-started,
   sourceSha256:hash(content),outputSha256:hash(actual),outputIndependentMatch:true,
   gates:internal.gates,resolved:internal.observations.filter(o=>o.category==='clarification_context').map(o=>o.data),observations:internal.observations});
 }finally{first?.coreFacade.cognition.close();restored?.coreFacade.cognition.close();}
}
writeFileSync(join(root,'result.json'),JSON.stringify({observedAt:new Date().toISOString(),scope:'actual local Core/E/B/G and persisted restart; injected deterministic planner; synthetic text; no external account/model call or general semantic evaluator',rows,cost:'미측정',externalModelCalls:0},null,2),{flag:'wx'});
console.log(JSON.stringify({root,rows:rows.map(({mode,status,interventions,readCalls,writeCalls})=>({mode,status,interventions,readCalls,writeCalls}))}));
