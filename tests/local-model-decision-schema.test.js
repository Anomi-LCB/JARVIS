import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelProvider} from '../packages/core/src/mission/model-provider.js';
import {GoalExecutivePlanner} from '../packages/core/src/mission/mission-planner.js';

test('local grammar binds each decision to its permitted action cardinality and preserves the complete contract',async()=>{
 let schema;
 const adapter=createModelProvider({provider:'ollama-local',model:'fixture',fetchImpl:async(url,init)=>{
  if(url.endsWith('/api/tags'))return Response.json({models:[{name:'fixture',size:1000}]});
  schema=JSON.parse(init.body).format;
  return Response.json({model:'fixture',done:true,done_reason:'stop',response:JSON.stringify({decision:'blocked',summary:'fixture',question:null,blockedReason:'fixture',actions:[],criteriaAssessment:[]})});
 }});
 await adapter.generate({prompt:'fixture'});
 assert.equal(schema.anyOf.length,4);
 for(const decision of ['continue','complete','ask_user','blocked']){
  const branch=schema.anyOf.find(b=>b.properties.decision.enum[0]===decision);
  assert.equal(branch.type,'object');assert.equal(branch.additionalProperties,false);
  assert.deepEqual(branch.required,['decision','summary','question','blockedReason','actions','criteriaAssessment']);
  assert.equal(branch.properties.actions.minItems,decision==='continue'?1:0);
  assert.equal(branch.properties.actions.maxItems,['complete','blocked'].includes(decision)?0:8);
  assert.equal(branch.properties.actions.items.properties.arguments.additionalProperties,true);
  assert.equal(branch.properties.actions.items.properties.clarificationIndependent.type,'boolean');
  if(decision!=='ask_user'){
   assert.deepEqual(branch.properties.question,{type:'null'});
   assert.equal(Object.hasOwn(branch.properties,'questions'),false);
  }
  if(decision!=='blocked')assert.deepEqual(branch.properties.blockedReason,{type:'null'});
 }
});
test('grammar is not execution authority: conflicting terminal plans remain rejected',()=>{
 const context={mission:{objective:'파일 읽기',successCriteria:[],constraints:[]},capabilities:[{toolName:'filesystem.readText'}],observations:[]};
 const action={id:'read',command:'source.txt 파일을 읽어',expectedToolName:'filesystem.readText',arguments:{path:'source.txt'},dependencies:[]};
 for(const decision of ['complete','blocked']){
  const diagnostic={};
  assert.equal(new GoalExecutivePlanner().sanitizePlan({decision,actions:[action]},context,diagnostic),null);
  assert.equal(diagnostic.reason,'terminal-decision-has-actions');
 }
 const diagnostic={};
 assert.equal(new GoalExecutivePlanner().sanitizePlan({decision:'continue',actions:[]},context,diagnostic),null);
 assert.equal(diagnostic.reason,'continue-without-actions');
});
