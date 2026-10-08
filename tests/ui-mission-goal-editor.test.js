import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoalRevisionDraft, goalRevisionRequest } from '../src/ui/mission-goal-editor.js';

test('lost response retries keep a key and original CAS revision even after a background refresh', () => {
  const mission = { missionId: 'm1', objective: '원래 목표', goalContract: { revision: 3 }, successCriteria: [{ statement: '원본 보존', verificationSpec: { type: 'typed' } }] };
  const draft = createGoalRevisionDraft(mission);
  draft.objective = '새 목표';
  const first = goalRevisionRequest(draft, () => 'first');
  mission.goalContract.revision = 4;
  assert.deepEqual(goalRevisionRequest(draft, () => 'must-not-change'), first);
  assert.equal(first.expectedRevision, 3);
  assert.equal(Object.hasOwn(first, 'successCriteria'), false);
  draft.objective = '또 다른 목표';
  assert.equal(goalRevisionRequest(draft, () => 'second').idempotencyKey, 'second');
});

test('criteria and constraints are replaced only by explicit user selection', () => {
  const draft = createGoalRevisionDraft({ missionId: 'm2', objective: '목표', constraints: [{ statement: '원본 보존' }] });
  draft.criteria = '출력 내용 검증\n\n원본 보존';
  draft.replaceCriteria = true;
  draft.replaceConstraints = true;
  draft.constraints = '';
  const request = goalRevisionRequest(draft, () => 'key');
  assert.deepEqual(request.successCriteria, ['출력 내용 검증', '원본 보존']);
  assert.deepEqual(request.constraints, []);
  draft.criteria = ' ';
  assert.throws(() => goalRevisionRequest(draft), /최소 한 가지/);
});

test('explicit current criteria review preserves the original independent verifier contract',()=>{
 const criteria=[{criterionId:'c1',statement:'내용 일치',verificationSpec:{version:1,kind:'text.equals',path:'result.txt',equals:'exact bytes'}}];
 const draft=createGoalRevisionDraft({missionId:'m',objective:'목표',goalContract:{revision:1},successCriteria:criteria});
 criteria[0].verificationSpec.equals='changed elsewhere';
 assert.equal(Object.hasOwn(goalRevisionRequest(draft,()=> 'old'),'successCriteria'),false);
 draft.confirmExistingCriteria=true;
 const reviewed=goalRevisionRequest(draft,()=> 'reviewed');assert.equal(reviewed.idempotencyKey,'reviewed');
 assert.equal(reviewed.successCriteria[0].verificationSpec.equals,'exact bytes');
 reviewed.successCriteria[0].verificationSpec.equals='mutated payload';
 assert.equal(goalRevisionRequest(draft).successCriteria[0].verificationSpec.equals,'exact bytes');
 draft.confirmExistingCriteria=false;assert.equal(Object.hasOwn(goalRevisionRequest(draft,()=> 'new'),'successCriteria'),false);
});
test('review cannot silently turn an empty criterion set into unchecked completion',()=>{
 const draft=createGoalRevisionDraft({missionId:'m',objective:'목표',successCriteria:[]});draft.confirmExistingCriteria=true;
 assert.throws(()=>goalRevisionRequest(draft),/최소 한 가지/);
});


test('explicit role changes retain typed verifier, identity and retry contract without granting permissions',()=>{
 const criteria=[{criterionId:'c1',statement:'원본 확인',verificationSpec:{version:1,kind:'text.equals',path:'source.txt',equals:'exact bytes'}}];
 const draft=createGoalRevisionDraft({missionId:'m',objective:'읽어',successCriteria:criteria});
 draft.criterionRoles[0]='input';
 const request=goalRevisionRequest(draft,()=> 'input-key');
 assert.deepEqual(request.successCriteria,[{...criteria[0],artifactRole:'input'}]);
 assert.equal(Object.hasOwn(request,'authorization'),false);
 assert.equal(Object.hasOwn(criteria[0],'artifactRole'),false);
 assert.deepEqual(goalRevisionRequest(draft,()=> 'unused'),request);
 draft.criterionRoles[0]='output';assert.equal(Object.hasOwn(goalRevisionRequest(draft,()=> 'reset'),'successCriteria'),false);
 draft.criterionRoles[0]='read-write';assert.throws(()=>goalRevisionRequest(draft),/資料|자료 종류/);
 draft.criterionRoles=[];assert.throws(()=>goalRevisionRequest(draft),/자료 종류/);
});
