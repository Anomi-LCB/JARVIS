import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'jarvis-personal-ops-'));
  const path=join(dir,'ops.sqlite'), stores=[];
  const open=()=>{const s=new PersonalOperationsStore({dbPath:path,clock:()=>new Date('2026-09-13T00:00:00Z')});stores.push(s);return s;};
  t.after(()=>{for(const s of stores)try{s.close();}catch{}rmSync(dir,{recursive:true,force:true});});
  return {open};
}
test('personal ops durable deadline processing is idempotent across independent connections',t=>{
  const f=fixture(t),s=f.open(),goal=s.createGoal({title:'출장 준비'});
  const due=s.createCommitment({goalId:goal.id,title:'예약 조건 확인',dueAt:'2026-09-13T10:00:00+09:00',sourceRef:'user:test'});
  s.createCommitment({title:'다음 달',dueAt:'2026-10-13T00:00:00Z',sourceRef:'user:test'});
  assert.equal(s.tick().created,1);s.close();const other=f.open();
  assert.equal(other.tick().created,0);assert.equal(other.summary().goals[0].title,'출장 준비');
  other.resolveCommitment(due.id,'cancelled');assert.equal(other.summary().followUps[0].state,'dismissed');
});
test('followup resolution does not falsely complete original commitment or regenerate it',t=>{
  const s=fixture(t).open();s.createCommitment({title:'조건 조사',dueAt:'2026-09-12T00:00:00Z',sourceRef:'user:test'});
  const row=s.tick().followUps[0];s.resolveFollowUp(row.id,'done','조사를 마쳤으며 예약은 미진행');
  assert.equal(s.tick().created,0);assert.equal(s.summary().commitments[0].state,'open');
  assert.throws(()=>s.resolveFollowUp(row.id,'done','중복'));
});
test('mandate matching respects scope amount expiry revocation and never grants execution',t=>{
  const s=fixture(t).open();const m=s.createMandate({action:'travel.quote',target:'provider:test',currency:'KRW',maxAmountMinor:100000,validFrom:'2026-09-12T00:00:00Z',expiresAt:'2026-09-14T00:00:00Z'});
  const q={action:'travel.quote',target:'provider:test',currency:'KRW',amountMinor:100000};
  assert.deepEqual(s.evaluateMandate(m.id,q),{matches:true,reasons:[],executionAuthority:false,budgetReserved:false,requiresExistingPolicyEvaluation:true});
  for(const patch of [{amountMinor:100001},{currency:'USD'},{target:'attacker'},{action:'travel.purchase'}])assert.equal(s.evaluateMandate(m.id,{...q,...patch}).matches,false);
  s.revokeMandate(m.id);assert.equal(s.evaluateMandate(m.id,q).matches,false);
  const expired=s.createMandate({action:q.action,target:q.target,currency:q.currency,maxAmountMinor:1,validFrom:'2026-09-12T00:00:00Z',expiresAt:'2026-09-13T00:00:00Z'});
  assert.ok(s.evaluateMandate(expired.id,{...q,amountMinor:0}).reasons.includes('outside-validity'));
});
test('invalid dates, unknown goals, malformed text and unbounded money fail closed',t=>{
  const s=fixture(t).open();const c={title:'약속',sourceRef:'user:test',dueAt:'2026-09-13T00:00:00Z'};
  for(const dueAt of ['tomorrow','2026-02-30T00:00:00Z','2026-09-13T00:00:00'])assert.throws(()=>s.createCommitment({...c,dueAt}));
  assert.throws(()=>s.createCommitment({...c,goalId:'missing'}));assert.throws(()=>s.createCommitment({...c,autoApprove:true}));
  assert.throws(()=>s.createGoal({title:'\u0000'}));assert.throws(()=>s.tick({horizonHours:-1}));
  for(const amountMinor of [-1,0.1,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>s.evaluateMandate('missing',{action:'a',target:'b',currency:'KRW',amountMinor}));
  assert.equal(s.summary().commitments.length,0);
});

test('deadline changes fence old deliveries, survive restart and preserve dismissed reminders',t=>{
  const f=fixture(t),s=f.open();const c=s.createCommitment({title:'기한 변경',dueAt:'2026-09-13T01:00:00Z',sourceRef:'fixture'});
  s.tick();const claim=s.claimPendingReminders({ownerId:'worker'})[0];
  const change={dueAt:'2026-09-20T01:00:00Z',expectedRevision:1,changeId:'change-one'};
  assert.equal(s.changeDeadline(c.id,change).revision,2);
  assert.equal(s.acknowledgeReminder(claim.eventId,'worker',claim.attempts).acknowledged,false);
  assert.equal(s.tick().pendingReminders.length,0);
  assert.equal(s.changeDeadline(c.id,change).repeated,true);
  assert.throws(()=>s.changeDeadline(c.id,{...change,changeId:'stale'}),/REVISION_CONFLICT/);
  assert.throws(()=>s.changeDeadline(c.id,{...change,dueAt:'2026-09-21T01:00:00Z'}),/changeId conflict/);
  s.changeDeadline(c.id,{dueAt:'2026-09-13T02:00:00Z',expectedRevision:2,changeId:'change-two'});
  const newEvent=s.tick().pendingReminders[0];assert.notEqual(newEvent.eventId,claim.eventId);
  s.resolveFollowUp(newEvent.followUpId,'dismissed','user choice');
  s.changeDeadline(c.id,{dueAt:'2026-09-13T03:00:00Z',expectedRevision:3,changeId:'change-three'});
  assert.equal(f.open().tick().pendingReminders.length,0);
  assert.equal(s.summary().commitments[0].state,'open');
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM personal_reminder_archive').get().n,2);
  assert.equal(f.open().changeDeadline(c.id,change).repeated,true);
});
