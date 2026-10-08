import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {evaluateSemanticCorpus} from '../scripts/semantic-requirement-evaluation.mjs';
const item={id:'synthetic-oracle-check',domain:'test',command:"'a.txt'를 읽어; 'b.txt'는 삭제하지 마",requirements:[
 {text:"'a.txt'를 읽어",action:'read',target:'a.txt',polarity:'required',sourceSpan:{start:0,end:12}},
 {text:"'b.txt'는 삭제하지 마",action:'delete',target:'b.txt',polarity:'prohibited',sourceSpan:{start:14,end:30}}]};
function corpus(){const c=structuredClone(item);let offset=0;for(const r of c.requirements){const start=c.command.indexOf(r.text,offset);r.sourceSpan={start,end:start+r.text.length};offset=r.sourceSpan.end;}return {cases:[c]};}

function modelCorpus(){return {...corpus(),version:'separate-model-semantic-holdout-26-v1'};}
function review(c){return {version:'semantic-gold-review-v1',corpusDigest:createHash('sha256').update(JSON.stringify(c)).digest('hex'),
 status:'approved',reviewer:'synthetic-reviewer',method:'separate-model-review',observedAt:'2026-10-07T00:00:00Z',
 cases:c.cases.map(row=>({id:row.id,status:'approved',rationale:'Synthetic test fixture, not actual gold qualification.'}))};}
test('model-authored gold cannot reach the engine merely by valid annotations or a frozen corpus',()=>{
 let calls=0;const engine=()=>{calls++;throw Error('must not execute');};
 const c=modelCorpus();
 assert.throws(()=>evaluateSemanticCorpus(c,{engine}),/GOLD_REVIEW_REQUIRED/);
 assert.throws(()=>evaluateSemanticCorpus({...corpus(),authoring:{kind:'model'}},{engine}),/GOLD_REVIEW_REQUIRED/);
 assert.equal(calls,0);
});
test('review binds exact corpus and every case; stale partial duplicate rejected reviews cannot authorize scoring',()=>{
 const c=modelCorpus(),valid=review(c);
 for(const change of [r=>r.corpusDigest='0'.repeat(64),r=>r.status='rejected',r=>r.cases=[],
  r=>r.cases[0].status='rejected',r=>r.cases[0].id='unknown',r=>r.cases[0].rationale='',
  r=>r.method='self-praise',r=>r.observedAt='invalid',r=>r.reviewer='']){
  const invalid=structuredClone(valid);change(invalid);
  let calls=0;assert.throws(()=>evaluateSemanticCorpus(c,{goldReview:invalid,engine:()=>{calls++;}}),/GOLD_REVIEW_REQUIRED/);
  assert.equal(calls,0);
 }
 const changed=structuredClone(c);changed.cases[0].requirements[0].action='delete';
 assert.throws(()=>evaluateSemanticCorpus(changed,{goldReview:valid}),/GOLD_REVIEW_REQUIRED/);
 const multiple=modelCorpus();multiple.cases.push({...structuredClone(multiple.cases[0]),id:'another'});
 const duplicate=review(multiple);duplicate.cases[1].id=duplicate.cases[0].id;
 assert.throws(()=>evaluateSemanticCorpus(multiple,{goldReview:duplicate}),/GOLD_REVIEW_REQUIRED/);
});
test('explicit review allows evaluation but never claims expert qualification or complete semantic acceptance',()=>{
 const c=modelCorpus(),report=evaluateSemanticCorpus(c,{goldReview:review(c)});
 assert.equal(report.preservationRate,1);assert.equal(report.fullSemanticCriteriaMet,false);
 assert.equal(report.productExecuted,false);
});
test('independent annotation scorer checks actual action target polarity rather than retained text',()=>{
 const c=corpus(),positive=evaluateSemanticCorpus(c);assert.equal(positive.preservationRate,1);
 const engine=()=>({requirements:c.cases[0].requirements.map(r=>({text:r.text,interpretation:{status:'recognized',action:r.action,target:r.target,polarity:r.polarity}}))});
 for(const field of ['action','target','polarity']){
  const report=evaluateSemanticCorpus(c,{engine:()=>{const value=engine();value.requirements[0].interpretation[field]='wrong';return value;}});assert.equal(report.preserved,1);
 }
 assert.equal(evaluateSemanticCorpus(c,{engine:()=>({requirements:[{text:c.cases[0].command,interpretation:{status:'unresolved'}}]})}).preserved,0);
});
test('unresolved interpretations with guessed correct fields cannot receive preservation credit',()=>{
 const c=corpus();
 const report=evaluateSemanticCorpus(c,{engine:()=>({requirements:c.cases[0].requirements.map(r=>({text:r.text,interpretation:{status:'unresolved',action:r.action,target:r.target,polarity:r.polarity}}))})});
 assert.equal(report.preserved,0);
 assert.equal(report.preservationRate,0);
});
test('invented requirements lower precision and prevent a complete preservation claim',()=>{
 const c=corpus();
 const report=evaluateSemanticCorpus(c,{engine:()=>({requirements:[...c.cases[0].requirements.map(r=>({text:r.text,interpretation:{status:'recognized',action:r.action,target:r.target,polarity:r.polarity}})),{text:'허락 없이 메일을 발송해',interpretation:{status:'recognized',action:'send',target:'other@example.invalid',polarity:'required'}}]})});
 assert.equal(report.preservationRate,1);
 assert.equal(report.extraRequirements,1);
 assert.equal(report.requirementPrecision,2/3);
 assert.equal(report.strictCasePassRate,0);
 assert.equal(report.fullSemanticCriteriaMet,false);
});
test('malformed gold annotations and duplicate IDs are refused, not removed from denominator',()=>{
 const c=corpus();c.cases[0].requirements[0].sourceSpan.end--;assert.throws(()=>evaluateSemanticCorpus(c),/ANNOTATION_INVALID/);
 const duplicate=corpus();duplicate.cases.push(structuredClone(duplicate.cases[0]));assert.throws(()=>evaluateSemanticCorpus(duplicate),/CASE_INVALID/);
});
test('engine never receives gold and failures remain scored with explicit unmeasured costs',()=>{
 const c=corpus(),report=evaluateSemanticCorpus(c,{engine:input=>{assert.deepEqual(Object.keys(input).sort(),['objective','referenceTime','timeZone']);throw new Error('failed');}});
 assert.equal(report.requirements,2);assert.equal(report.preserved,0);assert.equal(report.parseFailures,1);assert.equal(report.actualCost,null);assert.equal(report.productExecuted,false);
});

test('invalid engine output fails its case without aborting later cases or shrinking the denominator',()=>{
 const c=corpus();c.cases.push({...structuredClone(c.cases[0]),id:'next-valid-case'});
 for(const invalid of [null,{}, {requirements:null}, {requirements:[null]},
  {requirements:[{text:123,interpretation:{}}]},
  {requirements:[{text:'x',interpretation:null}]}]){
  let calls=0;
  const report=evaluateSemanticCorpus(c,{engine:()=>++calls===1?invalid:{requirements:c.cases[1].requirements.map(r=>({text:r.text,interpretation:{status:'recognized',action:r.action,target:r.target,polarity:r.polarity}}))}});
  assert.equal(calls,2);assert.equal(report.cases,2);assert.equal(report.requirements,4);
  assert.equal(report.preserved,2);assert.equal(report.parseFailures,1);
  assert.equal(report.rows[0].error,'EVALUATION_ENGINE_CONTRACT_INVALID');
  assert.equal(report.rows[0].extraRequirements.length,0);
  assert.equal(report.rows[1].error,null);
 }
});

test('empty engine output is an omission failure and never a strict case success',()=>{
 const report=evaluateSemanticCorpus(corpus(),{engine:()=>({requirements:[]})});
 assert.equal(report.preserved,0);assert.equal(report.strictCasePassRate,0);
 assert.equal(report.requirements,2);assert.equal(report.parseFailures,0);
});
