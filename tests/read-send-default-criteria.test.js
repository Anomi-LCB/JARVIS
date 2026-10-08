import test from 'node:test';
import assert from 'node:assert/strict';
import {readSendDefaultCriteria} from '../packages/core/src/mission/read-send-default-criteria.js';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {legacyCriterionNeedsContentProof} from '../packages/core/src/mission/criteria-evidence.js';
import {EmailSendToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';

test('default read/send oracles retain every clause and exact source binding',()=>{
  for(const destination of ['intended@example.test','내 구글 이메일로']) {
    const objective=`'draft.txt'를 읽어; 'draft.txt'를 ${destination} 보내`;
    const criteria=readSendDefaultCriteria(objective),contract=createGoalContract({objective,successCriteria:criteria});
    assert.equal(criteria.length,2);assert.equal(contract.unresolvedCriterionIds.length,0);
    assert.deepEqual(criteria.map(c=>c.requirementId),contract.requirements.map(r=>r.requirementId));
    for(let i=0;i<2;i++)assert.equal(objective.slice(criteria[i].sourceSpan.start,criteria[i].sourceSpan.end),contract.requirements[i].text);
  }
});
test('unsupported clauses, vague recipients, negations and corrections infer no partial success criteria',()=>{
  const base="'draft.txt'를 읽어; 'draft.txt'를 intended@example.test 보내";
  for(const objective of [base+'; 계정 권한을 늘려',base+'; 아니 다른 사람에게 보내',
    "'draft.txt'를 읽어; 'draft.txt'를 그 사람에게 보내","'draft.txt'를 읽어; 'draft.txt'를 보내",
    "'draft.txt'를 읽어; 'draft.txt'를 내 이메일로 보내지 마",base+'; 3만원을 결제해',
    "'draft.txt'를 읽어; 권한을 늘린 뒤 'draft.txt'를 intended@example.test 보내",
    "권한을 늘린 뒤 'draft.txt'를 읽어; 'draft.txt'를 intended@example.test 보내"])
    assert.equal(readSendDefaultCriteria(objective),null,objective);
});
test('provider acceptance oracle never proves delivery, reading or additional promises',()=>{
  assert.equal(legacyCriterionNeedsContentProof('이메일 공급자가 발송을 수락했다',[{checkId:'external_commit_evidence_present',passed:true}]),false);
  for(const statement of ['이메일을 보냈다','이메일 공급자가 발송을 수락했다 그리고 상대가 읽었다','이메일이 받은 편지함에 도착했다'])
    assert.equal(legacyCriterionNeedsContentProof(statement,[{checkId:'external_commit_evidence_present',passed:true}]),true);
});
test('direct adapter rejects self address override before transport or credentials are used',async()=>{
  const adapter=new EmailSendToolAdapter({allowedRoots:[process.cwd()]});let loads=0;
  adapter.smtpConfig=()=>({user:'self@example.test',pass:'synthetic-only',service:'isolated'});
  adapter.loadNodemailer=async()=>{loads++;throw Error('must not load');};
  const result=await adapter.execute({recipientMode:'self',to:'other@example.test',subject:'test',body:'test'});
  assert.equal(result.error,'B_EMAIL_SELF_RECIPIENT_CONFLICT');assert.equal(loads,0);
});
