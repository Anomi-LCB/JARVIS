import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSemanticAssertions,evaluateSemanticAssertions} from '../scripts/semantic-contract-oracle.mjs';
import {evaluateSemanticCorpus} from '../scripts/semantic-requirement-evaluation.mjs';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';

const annotation=(command,id,dimension,path,expected)=>({id,dimension,path,operator:'equals',expected,sourceSpan:{start:0,end:command.length}});
test('independently specified currency minor units, date and quantity are checked against the actual contract',()=>{
 const command="예산 12.34 USD 이하; 내일; 최대 3개";
 const item={command,semanticAssertions:[
  annotation(command,'usd','amount','/amounts/0/minorUnits',1234),
  annotation(command,'currency','amount','/amounts/0/currency','USD'),
  annotation(command,'limit','amount','/amounts/0/comparator','lte'),
  annotation(command,'tomorrow','time','/times/0/date','2026-10-08'),
  annotation(command,'zone','time','/times/0/timeZone','Asia/Seoul'),
  annotation(command,'count','quantity','/quantities/0/baseUnits',3),
  annotation(command,'quantity-limit','quantity','/quantities/0/comparator','lte')
 ]};
 validateSemanticAssertions(item);
 const contract=createGoalContract({objective:command,referenceTime:'2026-10-07T00:00:00Z',timeZone:'Asia/Seoul'});
 const actual=evaluateSemanticAssertions(item,contract);
 assert.ok(actual.every(a=>a.passed),JSON.stringify(actual));
 for(const [field,value] of [['minorUnits',1235],['currency','KRW'],['comparator','lt']]){
  const changed=structuredClone(contract);changed.amounts[0][field]=value;
  assert.equal(evaluateSemanticAssertions(item,changed).filter(a=>!a.passed).length,1);
 }
 const wrongDate=structuredClone(contract);wrongDate.times[0].date='2026-10-09';
 assert.equal(evaluateSemanticAssertions(item,wrongDate).find(a=>a.id==='tomorrow').passed,false);
});
test('condition, dependency, authority and outcome annotations detect deletion or fabrication',()=>{
 const command="내가 승인하면 'source.txt'를 읽어";
 const item={command,semanticAssertions:[
  annotation(command,'predicate','condition','/requirements/0/interpretation/unresolvedConditions/0/text','승인하면'),
  annotation(command,'dependency','dependency','/requirements/0/dependsOn',[]),
  annotation(command,'authority','authority','/executionAuthorized',false),
  annotation(command,'outcome','outcome','/successCriteria',[])
 ]};
 validateSemanticAssertions(item);
 const contract=createGoalContract({objective:command});
 assert.ok(evaluateSemanticAssertions(item,contract).every(a=>a.passed));
 for(const mutate of [c=>delete c.requirements[0].interpretation.unresolvedConditions,
  c=>c.requirements[0].dependsOn.push('invented'),c=>c.executionAuthorized=true,c=>c.successCriteria.push({statement:'invented'})]){
  const altered=structuredClone(contract);mutate(altered);
  assert.equal(evaluateSemanticAssertions(item,altered).filter(a=>!a.passed).length,1);
 }
});
test('missing and explicit null are distinct; failed engine does not earn absent-field credit',()=>{
 const command='시험 명령',a=annotation(command,'null','time','/times/0/date',null);
 const item={command,semanticAssertions:[a]};
 assert.equal(evaluateSemanticAssertions(item,{times:[{date:null}]} )[0].passed,true);
 assert.equal(evaluateSemanticAssertions(item,{times:[{}]} )[0].passed,false);
 item.semanticAssertions=[{id:'absent',dimension:'condition',path:'/requirements/0/interpretation/unresolvedConditions',operator:'absent',sourceSpan:{start:0,end:command.length}}];
 validateSemanticAssertions(item);
 assert.equal(evaluateSemanticAssertions(item,{requirements:[{interpretation:{}}]})[0].passed,true);
 assert.equal(evaluateSemanticAssertions(item,undefined,{engineFailed:true})[0].passed,false);
 assert.equal(evaluateSemanticAssertions(item,{requirements:[{interpretation:Object.create({unresolvedConditions:[]})}]})[0].passed,true);
});
test('dimension cannot be relabeled, invalid source and duplicate assertion identities are refused',()=>{
 const command='시험 명령',valid=annotation(command,'one','amount','/amounts',[]);
 for(const change of [a=>a.dimension='authority',a=>a.dimension='__proto__',a=>a.path='/constructor/prototype',
  a=>a.sourceSpan.end=100,a=>a.sourceSpan.start=-1,a=>delete a.expected,a=>a.expected=Infinity,a=>a.operator='contains']){
  const a=structuredClone(valid);change(a);
  assert.throws(()=>validateSemanticAssertions({command,semanticAssertions:[a]}),/SEMANTIC_ANNOTATION_INVALID/);
 }
 assert.throws(()=>validateSemanticAssertions({command,semanticAssertions:[valid,structuredClone(valid)]}),/SEMANTIC_ANNOTATION_INVALID/);
});
test('atomic score stays separate and a failed additional fact prevents strict success',()=>{
 const command="'source.txt'를 읽어";
 const gold={id:'dev-additional-fact',command,requirements:[{text:command,sourceSpan:{start:0,end:command.length},action:'read',target:'source.txt',polarity:'required'}],
  semanticAssertions:[annotation(command,'no-money','amount','/amounts',[]),annotation(command,'no-authority','authority','/executionAuthorized',false)]};
 const positive=evaluateSemanticCorpus({cases:[gold]});
 assert.equal(positive.strictCasePassRate,1);assert.equal(positive.semanticAssertionsPassed,2);
 assert.equal(positive.fullSemanticCriteriaMet,false);
 assert.equal(positive.additionalSemantics.find(d=>d.dimension==='time').unmeasuredCases,1);
 const negative=evaluateSemanticCorpus({cases:[gold]},{engine:input=>({...createGoalContract(input),executionAuthorized:true})});
 assert.equal(negative.preservationRate,1);assert.equal(negative.strictCasePassRate,0);
 assert.equal(negative.semanticAssertionsPassed,1);assert.equal(negative.fullSemanticCriteriaMet,false);
});
test('old corpora remain explicitly unmeasured across all seven additional dimensions',()=>{
 const command="'source.txt'를 읽어";
 const report=evaluateSemanticCorpus({cases:[{id:'legacy',command,requirements:[{text:command,sourceSpan:{start:0,end:command.length},action:'read',target:'source.txt',polarity:'required'}]}]});
 assert.equal(report.semanticAssertionCount,0);assert.equal(report.unevaluatedDimensions.length,7);
 assert.ok(report.additionalSemantics.every(d=>d.assertions===0&&d.unmeasuredCases===1));
 assert.equal(report.fullSemanticCriteriaMet,false);
});
