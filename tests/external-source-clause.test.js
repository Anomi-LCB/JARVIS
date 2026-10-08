import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {externalSourceClauseBound} from '../packages/core/src/mission/external-source-clause.js';
const check=text=>{const goalContract=createGoalContract({objective:text});return goalContract.requirements.every(r=>externalSourceClauseBound({objective:text,goalContract},r));};
test('one file receipt consumes the exact bounded source clause, never unsupported preceding demands',()=>{
  for(const text of ["'draft.txt'를 읽어","'draft.txt'를 저장해","먼저 'a b.txt'를 읽어줘",'source.txt 내용을 읽어줘',
    "'draft.txt'를 intended@example.test 보내","'draft.txt'를 내 이메일로 보내줘","'draft.txt' 파일을 만들어줘"])
    assert.equal(check(text),true,text);
  for(const text of ["권한을 늘린 뒤 'draft.txt'를 읽어","비밀번호를 알아낸 뒤 'draft.txt'를 저장해",
    "원본을 검사한 뒤 'draft.txt'를 읽어","'draft.txt'를 읽고 요약해","'draft.txt'와 'other.txt'를 읽어",
    "'draft.txt'를 그 사람에게 보내","'draft.txt'를 intended@example.test 보내; 계정 권한을 늘려"])
    assert.equal(check(text),false,text);
});
test('stored action, target, source span or clause text cannot replace the original request',()=>{
  const objective="'draft.txt'를 읽어",goalContract=createGoalContract({objective}),mission={objective,goalContract};
  const original=goalContract.requirements[0];
  for(const mutate of [r=>r.interpretation.target='other.txt',r=>r.interpretation.action='save',
    r=>r.sourceSpan.start=1,r=>r.sourceSpan.end=99999,r=>r.text="'other.txt'를 읽어"]){
    const requirement=structuredClone(original);mutate(requirement);
    assert.equal(externalSourceClauseBound(mission,requirement),false);
  }
});
