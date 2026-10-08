import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersistentEvaluationBudget} from '../packages/core/src/capabilities/persistent-evaluation-budget.js';
import {cases as workflowCases} from './fixtures/evaluation-recovery-workflow-cases.mjs';
import {CapabilityPackagePromotionManager} from '../packages/core/src/capabilities/capability-package-promotion.js';
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
const cases=[{id:'one',method:'execute',args:{},packet:{},expected:42,requirementIds:['R1']}],suiteSha256=createHash('sha256').update(canonical(cases)).digest('hex');
function fixture(t,outcome='passed'){
 const root=mkdtempSync(join(tmpdir(),'jarvis-stage-recovery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=new PersonalOperationsStore({dbPath:join(root,'state.sqlite')});
 const mandate=PersistentEvaluationBudget.createCountQuota({store,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:outcome==='real-comparison'?6:1});store.close();
 const selectedSuiteSha256=outcome.startsWith('real')?createHash('sha256').update(canonical(workflowCases)).digest('hex'):suiteSha256;
 const invoke=mode=>JSON.parse(execFileSync(process.execPath,[join(import.meta.dirname,'fixtures/evaluation-stage-recovery-process.mjs'),mode,root,mandate.id,selectedSuiteSha256,outcome],{encoding:'utf8',timeout:60000,windowsHide:true}));
 return{root,invoke};
}
test('legacy completion without evaluation-start evidence is not assumed to exclude a later interrupted rerun',()=>{
 const manager=new CapabilityPackagePromotionManager({registry:{},targets:{},journal:{status:()=>({pendingTransitions:[]}),stageHistory:()=>[
  {sequence:1,eventType:'stage_created',payload:{}},{sequence:2,eventType:'evaluation_passed',payload:{}}]},
  restoreEvaluation:()=>{throw Error('legacy recovery must stop before receipt read');}});
 assert.throws(()=>manager.restoreStage('legacy-stage',{}),{code:'A_CAPABILITY_PACKAGE_RECOVERY_INCOMPLETE'});
});

test('automatic preparation and real workflow comparison consume exactly six reservations and reject an equal-quality candidate',t=>{
 const {invoke}=fixture(t,'real-comparison'),first=invoke('write');
 assert.equal(first.item.state,'evaluating');assert.equal(first.evaluationCalls,6);assert.equal(first.budget.remainingCalls,0);
 assert.equal(first.factories,1);assert.equal(first.fetches,1);assert.equal(first.oracles,6);
 assert.equal(first.comparison.repeats,3);assert.equal(first.comparison.baseline.runs,3);assert.equal(first.comparison.candidate.runs,3);
 assert.equal(first.comparison.improved,false);assert.equal(first.activePackageId,'jarvis.local-workflow');
 assert.equal(first.preparations.length,1);assert.equal(first.preparations[0].preparation_id,first.item.id);
 assert.equal(first.preparations[0].bound_stage_id,`${first.item.stageId}-c0`);
 const next=invoke('read');assert.notEqual(first.pid,next.pid);assert.equal(next.errorCode,null);
 assert.equal(next.restore.evaluation.receipt.comparison.improved,false);assert.equal(next.restore.evaluation.status,'failed');
 assert.equal(next.restore.review,null);assert.equal(next.promoteCode,'A_CAPABILITY_PACKAGE_REVIEW_REQUIRED');
 assert.equal(next.evaluationCalls,0);assert.equal(next.factories,0);assert.equal(next.fetches,0);assert.equal(next.oracles,0);assert.equal(next.item.state,'failed');
 t.diagnostic(JSON.stringify({writerPid:first.pid,readerPid:next.pid,actualDocker:6,preparationReservations:1,remainingCalls:0,
  improved:false,aggregateRecovery:'restored without replay',scope:'Actual bundled workflow and fixed host oracle; no candidate activation or general quality claim'}));
});
for(const outcome of ['passed','failed'])test(`actual OS restart re-admits and restores ${outcome} Docker evidence without oracle, quota or review replay`,t=>{
 const {invoke}=fixture(t,outcome),first=invoke('write');assert.equal(first.item.state,'evaluating');assert.equal(first.evaluationCalls,1);assert.equal(first.budget.remainingCalls,0);
 const next=invoke('read');assert.notEqual(first.pid,next.pid);assert.equal(next.errorCode,null);
 assert.equal(next.restore.stageId,first.item.stageId);assert.equal(next.restore.evaluation.status,outcome);assert.equal(next.restore.review,null);assert.equal(next.restore.reviewRestored,false);
 assert.equal(next.restore.evaluation.evaluationReplay.executedNow,false);assert.equal(next.item.state,outcome==='passed'?'registration_candidate':'failed');
 for(const key of ['factories','fetches','oracles','evaluationCalls'])assert.equal(next[key],0);
 assert.equal(next.promoteCode,'A_CAPABILITY_PACKAGE_REVIEW_REQUIRED');assert.equal(next.activePackageId,'jarvis.local-workflow');assert.equal(next.budget.remainingCalls,0);
 const again=invoke('read');assert.equal(again.errorCode,null);assert.equal(again.evaluationCalls,0);assert.equal(again.item.state,next.item.state);
 t.diagnostic(JSON.stringify({writerPid:first.pid,recoveryPid:next.pid,stageId:next.restore.stageId,outcome,evidenceRef:next.restore.evaluation.evidenceRef,actualDocker:first.evaluationCalls,replayedEvaluations:0,scope:'Signed lifecycle and real persisted receipt; trusted fixture re-admission, synthetic candidate, no activation'}));
});
test('changed admission is rejected before accepting historical evaluation evidence',t=>{
 const {invoke}=fixture(t);invoke('write');const next=invoke('bad-admission');assert.equal(next.errorCode,'A_CAPABILITY_PACKAGE_RECOVERY_IDENTITY_CHANGED');assert.equal(next.restore,null);assert.equal(next.item.state,'evaluating');assert.equal(next.evaluationCalls,0);
});
test('tampered persisted receipt cannot be restored even when JSON contains a passing status',t=>{
 const {root,invoke}=fixture(t);invoke('write');const store=new PersonalOperationsStore({dbPath:join(root,'state.sqlite')});
 store.db.prepare('UPDATE capability_evaluation_receipts SET result_json=?').run('{"status":"passed"}');store.close();
 const next=invoke('read');assert.equal(next.errorCode,'A_EVALUATION_RECEIPT_UNAVAILABLE');assert.equal(next.item.state,'evaluating');assert.equal(next.evaluationCalls,0);
});
test('signed journal truncation blocks recovery and preserves evaluation quota',t=>{
 const {root,invoke}=fixture(t);invoke('write');const path=join(root,'audit/capability-package-promotions.jsonl');const lines=readFileSync(path,'utf8').trimEnd().split('\n');writeFileSync(path,`${lines[0]}\n`);
 const next=invoke('read');assert.equal(next.errorCode,'A_CAPABILITY_PACKAGE_RECOVERY_AUTHORITY_REQUIRED');assert.equal(next.restore,null);assert.equal(next.evaluationCalls,0);assert.equal(next.budget.remainingCalls,0);
});
test('previous completed evaluation is not reused after a later evaluation start without completion',t=>{
 const {invoke}=fixture(t);invoke('write');const next=invoke('incomplete');assert.equal(next.errorCode,'A_CAPABILITY_PACKAGE_RECOVERY_INCOMPLETE');assert.equal(next.restore,null);assert.equal(next.item.state,'evaluating');assert.equal(next.evaluationCalls,0);
});
test('renewed admission cannot widen the protected execution contract during restoration',t=>{
 const {invoke}=fixture(t);invoke('write');const next=invoke('widen');assert.equal(next.errorCode,'A_CAPABILITY_PACKAGE_PROTECTED_CONTRACT_CHANGED');assert.equal(next.restore,null);assert.equal(next.evaluationCalls,0);
});
test('historical reviewed state is deliberately not restored as a live owner authorization',t=>{
 const {invoke}=fixture(t,'reviewed');const first=invoke('write');assert.equal(first.journal.unfinishedStages[0].lastEvent,'owner_reviewed');
 const next=invoke('read');assert.equal(next.errorCode,null);assert.equal(next.restore.review,null);assert.equal(next.restore.reviewRestored,false);assert.equal(next.promoteCode,'A_CAPABILITY_PACKAGE_REVIEW_REQUIRED');assert.equal(next.evaluationCalls,0);
});
test('rewriting both SQL receipt and checksum cannot bypass signed lifecycle receipt binding',t=>{
 const {root,invoke}=fixture(t);invoke('write');const store=new PersonalOperationsStore({dbPath:join(root,'state.sqlite')});
 const row=store.db.prepare('SELECT * FROM capability_evaluation_receipts').get();const forged=JSON.parse(row.result_json);
 forged.status='failed';forged.receipt.status='failed';forged.evidenceRef=`sha256:${createHash('sha256').update(canonical(forged.receipt)).digest('hex')}`;
 const json=JSON.stringify(forged),sha=createHash('sha256').update(json).digest('hex');
 store.db.prepare('UPDATE capability_evaluation_receipts SET result_json=?,result_sha256=? WHERE reservation_id=?').run(json,sha,row.reservation_id);
 store.db.prepare('UPDATE personal_budget_reservations SET receipt_ref=? WHERE id=?').run(`sha256:${sha}`,row.reservation_id);store.close();
 const next=invoke('read');assert.equal(next.errorCode,'A_CAPABILITY_PACKAGE_RECOVERY_RECEIPT_INVALID');assert.equal(next.restore,null);assert.equal(next.item.state,'evaluating');assert.equal(next.evaluationCalls,0);
});
test('actual bundled workflow source and factory are re-admitted across OS restart with real file and boundary evidence',t=>{
 const {invoke}=fixture(t,'real'),first=invoke('write'),next=invoke('read');
 assert.notEqual(first.pid,next.pid);assert.equal(next.errorCode,null);assert.equal(next.restore.artifactSha256,first.item.artifactSha256);
 assert.equal(next.restore.evaluation.receipt.caseCount,2);assert.equal(next.restore.evaluation.receipt.passedCount,2);
 assert.equal(next.restore.evaluation.receipt.resultContract,'local-workflow-files-v1');assert.equal(next.restore.evaluation.receipt.isolationEnforced,true);
 assert.equal(next.restore.review,null);assert.equal(next.promoteCode,'A_CAPABILITY_PACKAGE_REVIEW_REQUIRED');assert.equal(next.item.state,'registration_candidate');
 assert.equal(next.evaluationCalls,0);assert.equal(next.oracles,0);assert.equal(next.fetches,0);assert.equal(next.factories,0);assert.equal(next.budget.remainingCalls,0);assert.equal(next.activePackageId,'jarvis.local-workflow');
 t.diagnostic(JSON.stringify({writerPid:first.pid,readerPid:next.pid,artifactSha256:next.restore.artifactSha256,evidenceRef:next.restore.evaluation.evidenceRef,actualDocker:first.evaluationCalls,caseResults:next.restore.evaluation.receipt.caseResults,scope:'Actual host-built operating workflow factory/source, isolated file readback and outside-root block; no candidate improvement or activation claim'}));
});

for(const mutation of ['missing-leaf','rewritten-aggregate','legacy-channel'])test(`actual OS comparison restart rejects ${mutation} without repeating six Docker calls`,t=>{
 const {root,invoke}=fixture(t,'real-comparison'),first=invoke('write'),store=new PersonalOperationsStore({dbPath:join(root,'state.sqlite')});
 if(mutation==='missing-leaf')store.db.exec('DELETE FROM capability_evaluation_receipts WHERE reservation_id=(SELECT reservation_id FROM capability_evaluation_receipts LIMIT 1)');
 else if(mutation==='legacy-channel'){
  const row=store.db.prepare('SELECT * FROM capability_evaluation_receipts LIMIT 1').get(),result=JSON.parse(row.result_json);
  delete result.receipt.resultChannelVersion;
  const json=JSON.stringify(result),sha=createHash('sha256').update(json).digest('hex');
  store.db.prepare('UPDATE capability_evaluation_receipts SET result_json=?,result_sha256=? WHERE reservation_id=?').run(json,sha,row.reservation_id);
  store.db.prepare('UPDATE personal_budget_reservations SET receipt_ref=? WHERE id=?').run(`sha256:${sha}`,row.reservation_id);
 }
 else{
  const row=store.db.prepare('SELECT result_json FROM capability_comparison_receipts').get(),result=JSON.parse(row.result_json);
  result.receipt.comparison.improved=true;result.receipt.status='passed';result.status='passed';
  result.evidenceRef=`sha256:${createHash('sha256').update(JSON.stringify(result.receipt)).digest('hex')}`;
  const json=JSON.stringify(result);store.db.prepare('UPDATE capability_comparison_receipts SET result_json=?,result_sha256=?').run(json,createHash('sha256').update(json).digest('hex'));
 }
 store.close();const next=invoke('read');assert.notEqual(first.pid,next.pid);
 assert.equal(next.errorCode,mutation==='missing-leaf'?'A_EVALUATION_RECEIPT_UNAVAILABLE':mutation==='legacy-channel'?'A_EVALUATION_RESULT_CHANNEL_REEVALUATION_REQUIRED':'A_COMPARISON_RECEIPT_INVALID');
 assert.equal(next.restore,null);assert.equal(next.item.state,'evaluating');assert.equal(next.evaluationCalls,0);assert.equal(next.oracles,0);assert.equal(next.factories,0);assert.equal(next.fetches,0);
 assert.equal(next.budget.remainingCalls,0);assert.equal(next.activePackageId,'jarvis.local-workflow');
});
