import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {resolveClarificationContext} from '../packages/core/src/mission/clarification-context.js';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
const questions=['결과 파일의 이름은 무엇인가요?','어느 자료를 최종 결과에 포함할까요?'];
const mission=objective=>({objective,goalContract:createGoalContract({objective}),gates:[]});
const objectiveHash=m=>createHash('sha256').update(m.objective).digest('hex');
test('only bounded exact source fields resolve known questions; unknown preferences remain questions',()=>{
 const m=mission("'source.txt'를 읽어; 'report.txt' 파일을 만들어줘");
 const result=resolveClarificationContext(m,{questions});
 assert.deepEqual(result.questions,[questions[1]]);assert.equal(result.resolved[0].answer,'report.txt');
 assert.equal(result.resolved[0].source,'exact-original-request');
 assert.deepEqual(resolveClarificationContext(m,{questions:['어떤 색상으로 만들까요?']}).resolved,[]);
 for(const objective of ["'a.txt' 파일을 만들어줘; 'b.txt' 파일을 만들어줘",'결과 파일을 만들어줘'])
  assert.deepEqual(resolveClarificationContext(mission(objective),{questions:[questions[0]]}).resolved,[]);
});
test('typed answers are reused by question and same goal revision, not by array position or unrelated gates',()=>{
 const m=mission('자료를 확인하고 결과를 작성해');
 m.gates=[{type:'clarification',status:'approved',goalRevision:1,goalObjectiveSha256:objectiveHash(m),gateId:'g1',questions,answers:['result.txt','source.txt만 포함']}];
 const result=resolveClarificationContext(m,{questions:[questions[1],questions[0],'새 자료도 추가할까요?']});
 assert.deepEqual(result.resolved.map(r=>r.answer),['source.txt만 포함','result.txt']);assert.deepEqual(result.questions,['새 자료도 추가할까요?']);
 m.goalContract.revision=2;assert.equal(resolveClarificationContext(m,{questions}).resolved.length,0);
 m.goalContract.revision=1;m.gates[0].status='rejected';assert.equal(resolveClarificationContext(m,{questions}).resolved.length,0);
 m.gates[0].status='approved';m.gates[0].type='action_approval';assert.equal(resolveClarificationContext(m,{questions}).resolved.length,0);
});
test('free-text batch without mapped answers is not guessed or treated as semantically complete',()=>{
 const m=mission('자료를 확인해');m.gates=[{type:'clarification',status:'approved',goalRevision:1,goalObjectiveSha256:objectiveHash(m),questions,answers:null,responseText:'파일은 둘 중 하나'}];
 assert.equal(resolveClarificationContext(m,{questions}).resolved.length,0);
});
test('different case-sensitive targets in questions never share a cached answer',()=>{
 const m=mission('선택한 자료를 확인해');m.gates=[{type:'clarification',status:'approved',goalRevision:1,goalObjectiveSha256:objectiveHash(m),gateId:'g',
  questions:["'Case.txt'를 포함할까요?"],answers:['예']}];
 assert.equal(resolveClarificationContext(m,{questions:["'case.txt'를 포함할까요?"]}).resolved.length,0);
 m.gates[0].questions=["'a b.txt'를 포함할까요?"];
 assert.equal(resolveClarificationContext(m,{questions:["'a  b.txt'를 포함할까요?"]}).resolved.length,0);
});

test('restored approved records with invalid question or answer batches cannot suppress current questions',()=>{
 for(const change of [g=>g.answers=[''],g=>g.answers=['   '],g=>g.answers=[42],g=>g.answers=['x'.repeat(501)],
  g=>g.questions=[42],g=>g.questions=['어느 자료를 포함할까요?','어느 자료를 포함할까요?'],
  g=>{g.questions=['어느 자료를 포함할까요?','두 번째?'];g.answers=['ok'];}]){
  const m=mission('자료를 확인해'),question='어느 자료를 포함할까요?';
  const gate={type:'clarification',status:'approved',goalRevision:1,goalObjectiveSha256:objectiveHash(m),gateId:'restored',questions:[question],answers:['ok']};
  change(gate);m.gates=[gate];
  assert.deepEqual(resolveClarificationContext(m,{questions:[question]}).resolved,[]);
  assert.deepEqual(resolveClarificationContext(m,{questions:[question]}).questions,[question]);
 }
});
