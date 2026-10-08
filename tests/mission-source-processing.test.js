import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareSourceNotes,bindSourcePlanningDelivery,sourceProcessingView} from '../packages/core/src/mission/mission-source-processing.js';
const sha=s=>createHash('sha256').update(s).digest('hex');
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-source-notes-')),path=join(root,'source.txt'),content='abcdef';writeFileSync(path,content);
 t.after(()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
 const mission={missionId:'m1',metadata:{userId:'fixture-user'},goalContract:{revision:1},waves:[{actions:[{actionId:'a1',taskId:'t1',observationId:'o1',status:'succeeded',goalRevision:1,actualToolName:'filesystem.readText',operation:{dispatch:{taskId:'t1',toolName:'filesystem.readText',arguments:{path}}}}]}],observations:[{observationId:'o1',actionId:'a1',taskId:'t1',toolName:'filesystem.readText',outcome:'success',evidenceId:'e1',verification:{status:'passed',verificationId:'g1',failedCheckIds:[]},data:{fileEvidence:{rootIndex:0,relativePath:'source.txt',outsideAllowedRoots:false,contentSha256:sha(content)},textRead:{offset:0,nextOffset:6,sourceSha256:sha(content),sourceChars:6,sourceBytes:6,content}}}]};
 const plan={sourceNotes:[{noteKey:'n1',sourceObservationId:'o1',expectedRevision:0,throughOffset:2,draft:'ab 미검증 메모'}]};
 bindSourcePlanningDelivery(plan,mission,[{observationId:'o1',evidenceFacts:{textRead:{deliveryStatus:'partial',offset:0,deliveredChars:2,content:'ab',sourceSha256:sha(content)}}}]);
 const prepare=()=>prepareSourceNotes({mission,plan,roots:[root],now:'2026-10-03T00:00:00.000Z'});
 return {root,path,mission,plan,prepare};
}
test('notes bind only actual delivered prefix, source, scope and goal, with CAS and idempotent replay',t=>{
 const f=fixture(t);f.mission.sourceProcessing=f.prepare();
 const record=sourceProcessingView(f.mission,[f.root]).records[0];assert.equal(record.status,'current-draft');assert.equal(record.deliveredThrough,2);assert.equal(record.revision,1);assert.equal(record.semanticAccuracyVerified,false);
 assert.equal(f.prepare(),null,'same request is idempotent');
 f.plan.sourceNotes[0].draft='changed with same key';assert.throws(f.prepare,{code:'A_SOURCE_CHECKPOINT_IDEMPOTENCY_CONFLICT'});
 f.plan.sourceNotes[0].noteKey='n2';assert.throws(f.prepare,{code:'A_SOURCE_CHECKPOINT_REVISION_CONFLICT'});
});
test('missing delivery receipt, undelivered suffix, and incorrect G binding reject notes',t=>{
 const f=fixture(t);assert.throws(()=>prepareSourceNotes({mission:f.mission,plan:structuredClone(f.plan),roots:[f.root],now:'now'}),{code:'A_SOURCE_CHECKPOINT_DELIVERY_RECEIPT_MISSING'});
 f.plan.sourceNotes[0].throughOffset=6;assert.throws(f.prepare,{code:'A_SOURCE_CHECKPOINT_RANGE_NOT_DELIVERED'});
 f.plan.sourceNotes[0].throughOffset=2;f.mission.observations[0].taskId='unrelated';assert.throws(f.prepare,{code:'A_SOURCE_CHECKPOINT_READ_EVIDENCE_INVALID'});
});
test('source edit, deletion, scope change, goal revision and draft tampering hide prior notes',t=>{
 const f=fixture(t);f.mission.sourceProcessing=f.prepare();const original=structuredClone(f.mission);
 writeFileSync(f.path,'ABCDEF');assert.equal(sourceProcessingView(f.mission,[f.root]).records[0].reason,'A_SOURCE_CHECKPOINT_SOURCE_CHANGED');assert.throws(f.prepare,{code:'A_SOURCE_CHECKPOINT_SOURCE_CHANGED'});
 writeFileSync(f.path,'abcdef');f.mission.metadata.userId='other-user';assert.equal(sourceProcessingView(f.mission,[f.root]).records[0].draft,undefined);
 f.mission.metadata=original.metadata;f.mission.goalContract.revision=2;assert.equal(sourceProcessingView(f.mission,[f.root]).records[0].status,'scope-or-goal-changed');
 f.mission.goalContract.revision=1;Object.values(f.mission.sourceProcessing.records)[0].draft='tampered';assert.equal(sourceProcessingView(f.mission,[f.root]).records[0].draft,undefined);
 f.mission.sourceProcessing=original.sourceProcessing;rmSync(f.path);assert.equal(sourceProcessingView(f.mission,[f.root]).records[0].status,'unavailable');
});
test('batch preparation is atomic and never mutates original state when a later note fails',t=>{
 const f=fixture(t);f.plan.sourceNotes.push({...f.plan.sourceNotes[0],noteKey:'bad-second',sourceObservationId:'missing'});
 assert.throws(f.prepare,{code:'A_SOURCE_CHECKPOINT_RANGE_NOT_DELIVERED'});assert.equal(f.mission.sourceProcessing,undefined);
});
