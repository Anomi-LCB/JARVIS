import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {assessMissionRequirementCoverage,assessMissionGoalCompletionCoverage} from '../packages/core/src/mission/mission-requirement-coverage.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
const root=resolve('artifacts/creation-binding-fixture');
const profile={mutatesSystem:true,readOnly:false,externalTransfer:false,externalNetwork:false};
function fixture(objective='a.xlsx 엑셀 파일 만들어줘. b.docx 워드 파일 만들어줘.') {
 const mission={objective,workspaceRoot:root,goalContract:createGoalContract({objective}),constraints:[],successCriteria:[],observations:[],waves:[]};
 const actions=[{actionId:'excel',expectedToolName:'excel.createWorkbook',arguments:{outputPath:join(root,'a.xlsx')}},
  {actionId:'word',expectedToolName:'word.create',arguments:{path:join(root,'b.docx')}}];
 const wave={actions};mission.waves.push(wave);
 return {mission,actions,wave};
}
function dispatch(graph,index=0){return assessMissionRequirementCoverage({...graph,action:graph.actions[index],profile,allowedRoots:[root]});}

test('explicit creation contracts preserve quote spans, filenames, type and negation',()=>{
 for(const [text,target] of [['a.xlsx 엑셀 파일 만들어줘','a.xlsx'],['b.docx 워드 파일 생성해주세요','b.docx'],['"공백 문서.docx" 파일 만들어주세요','공백 문서.docx'],['먼저 a.pptx 파워포인트 파일을 만들어줘','a.pptx']]){
  const contract=createGoalContract({objective:text}),item=contract.requirements[0];
  assert.equal(text.slice(item.sourceSpan.start,item.sourceSpan.end),text);
  assert.equal(item.interpretation.status,'recognized');assert.equal(item.interpretation.target,target);assert.equal(item.interpretation.action,'save');
 }
 for(const text of ['a.xlsx 파일 만들지 마','a.xlsx 파일 안 만들어줘','a.xlsx 파일 생성하지 마']){
  const item=createGoalContract({objective:text}).requirements[0].interpretation;
  assert.equal(item.status,'recognized');assert.equal(item.polarity,'prohibited');assert.equal(item.hasProhibition,true);
 }
 for(const text of ['a.docx 엑셀 파일 만들어줘','a.xlsx 파일 만들어줘 그리고 계정 권한을 늘려','그 파일 만들어줘','a.xlsx 파일 만들어줘 대신 b.xlsx']){
  assert.ok(createGoalContract({objective:text}).requirements.some(item=>item.interpretation.status==='unresolved'));
 }
});

test('the whole creation plan must cover every requested path exactly once before either write',()=>{
 const valid=fixture();assert.equal(dispatch(valid).allowed,true);assert.equal(dispatch(valid,1).allowed,true);
 for(const alter of [g=>g.actions.pop(),g=>g.actions.push({...g.actions[0],actionId:'extra',arguments:{outputPath:join(root,'extra.xlsx')}}),
  g=>g.actions[1].arguments.path=join(root,'other.docx'),g=>g.actions[0].arguments.renderPdf=true,
  g=>g.actions[0].arguments.pdfOutputPath=join(root,'extra.pdf'),g=>g.actions[1].expectedToolName='email.send',
  g=>g.actions[1].arguments.path=resolve(root,'..','outside.docx')]){
  const graph=fixture();alter(graph);assert.equal(dispatch(graph).allowed,false);
 }
 // A merely ignored pdfOutputPath without renderPdf is rejected by the tool
 // argument contract; the binding guard must never treat it as an output proof.
 const changed=fixture();changed.actions[0].arguments={outputPath:join(root,'other.xlsx')};
 assert.equal(assessMissionRequirementCoverage({...changed,action:changed.actions[0],profile,allowedRoots:[root],
  dispatchToolName:'excel.createWorkbook',dispatchArguments:{outputPath:join(root,'a.xlsx')}}).allowed,true);
 const rev=fixture();rev.mission.goalContract.revisionChange={invalidatedCriterionIds:['old']};assert.equal(dispatch(rev).allowed,false);
});

test('extra clauses, exclusions, corrections, prohibited effects and duplicate targets cannot disappear',()=>{
 for(const objective of ['a.xlsx 파일 만들어줘. b.docx 파일 만들어줘. 계정 권한을 늘려',
  'a.xlsx 파일 만들어줘. b.docx 파일 만들지 마','a.xlsx 파일 만들어줘. 아니 b.docx 파일 만들어줘',
  'a.xlsx 파일 만들어줘. b.docx 파일 만들어줘. 원본은 제외해','a.xlsx 파일 만들어줘. a.xlsx 파일 만들어줘',
  'a.xlsx 파일 만들어줘 그리고 계정 권한을 늘려']){
  assert.equal(dispatch(fixture(objective)).allowed,false,objective);
 }
 if(process.platform==='win32')assert.equal(dispatch(fixture('a.xlsx 파일 만들어줘. A.xlsx 파일 만들어줘.')).allowed,false);
});

test('completion needs independently verified observations and bound dispatch, not planner claims',()=>{
 const graph=fixture();
 const completion=()=>assessMissionGoalCompletionCoverage({mission:graph.mission,allowedRoots:[root]});
 assert.equal(completion().allowed,false);
 for(const action of graph.actions){
  action.status='succeeded';action.actualToolName=action.expectedToolName;action.taskId=`task-${action.actionId}`;
  action.observationId=`obs-${action.actionId}`;action.operation={dispatch:{taskId:action.taskId,toolName:action.actualToolName,arguments:action.arguments}};
  graph.mission.observations.push({observationId:action.observationId,actionId:action.actionId,taskId:action.taskId,toolName:action.actualToolName,
   outcome:'success',verification:{status:'passed',verificationId:'G-proof',failedCheckIds:[]},evidenceId:'G-evidence',
   artifacts:[{rootIndex:0,relativePath:action.actionId==='excel'?'a.xlsx':'b.docx',outsideAllowedRoots:false,contentSha256:'a'.repeat(64)}]});
 }
 assert.equal(completion().allowed,true);
 graph.actions[1].operation.dispatch.taskId='other-task';assert.equal(completion().allowed,false);
});

test('actual Core/E/B/G file batch completes, while omitted or added actions produce no files',async t=>{
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
 for(const mode of ['valid','omitted','added','unknown-clause','inline-unknown']){
  const directory=await mkdtemp(join(tmpdir(),'jarvis-creation-binding-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  let runtime,id;
  const runner=async()=>{
   const mission=runtime.missionRuntime.missions.get(id);
   const response=(decision,actions=[],extra={})=>JSON.stringify({decision,summary:'원문 파일 지시 검증',actions,sourceNotes:[],criteriaAssessment:[],question:null,blockedReason:null,...extra});
   if(!mission.observations.length){
    const files=mode==='omitted'?['a.txt']:mode==='added'?['a.txt','b.txt','extra.txt']:['a.txt','b.txt'];
    return response('continue',files.map((name,index)=>({id:`file-${index}`,title:name,command:`${name} 텍스트 파일 만들어줘`,expectedToolName:'filesystem.createTextFile',
     arguments:{path:join(directory,name),content:name==='a.txt'?'첫째':'둘째'},dependencies:[],successSignal:'current content'})));
   }
   return response('complete',[],{criteriaAssessment:mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:mission.observations.filter(o=>o.outcome==='success').map(o=>o.actionId)}))});
  };
  runtime=createAgRuntime({allowedRoots:[directory],auditRoot:join(directory,'audit'),missionRunner:runner,env,taskEnv:env,workerDaemonEnabled:false});
  try{
   const objective=mode==='inline-unknown'?'a.txt 파일 만들어줘 그리고 권한을 늘려':'a.txt 파일 만들어줘. b.txt 파일 만들어줘.'+(mode==='unknown-clause'?' 계정 권한을 늘려.':'');
   const created=runtime.missionRuntime.createMission({objective,authorization:{grants:['read_only','local_reversible']},budgets:{maxWaves:2,maxPlannerCalls:2,maxConsecutiveFailures:1},
    successCriteria:[{criterionId:'a',statement:'첫째 본문',verificationSpec:{version:1,kind:'text.equals',path:'a.txt',equals:'첫째'}},
     {criterionId:'b',statement:'둘째 본문',verificationSpec:{version:1,kind:'text.equals',path:'b.txt',equals:'둘째'}}]});
   id=created.missionId;const result=await runtime.missionRuntime.runMission(id);
   if(mode==='valid'){assert.equal(result.status,'COMPLETED',JSON.stringify(runtime.missionRuntime.missions.get(id).observations));assert.equal(await readFile(join(directory,'a.txt'),'utf8'),'첫째');}
   else{assert.notEqual(result.status,'COMPLETED');for(const file of ['a.txt','b.txt','extra.txt'])await assert.rejects(readFile(join(directory,file)),{code:'ENOENT'});}
  }finally{runtime.coreFacade.cognition.close();}
 }
});
