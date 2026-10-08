import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-rollback-recovery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 return mode=>JSON.parse(execFileSync(process.execPath,[join(import.meta.dirname,'fixtures/rollback-recovery-process.mjs'),mode,root],{encoding:'utf8',timeout:60000,windowsHide:true}));}
test('real process restart restores prior admitted bundle, requires fresh owner and runs restored Core B/G mission without evaluation replay',t=>{
 const invoke=fixture(t),first=invoke('write'),next=invoke('read');
 t.diagnostic(JSON.stringify(next));
 assert.equal(first.status,'promoted');assert.equal(first.evaluations,1);assert.notEqual(first.pid,next.pid);
 assert.equal(next.errorCode,undefined);assert.equal(next.recovery.ownerAuthorizationRestored,false);
 assert.equal(next.withoutOwner,'A_CAPABILITY_PACKAGE_REVIEW_AUTHORIZATION_EXPIRED');
 assert.equal(next.rolled.restoredPriorDigest,true);assert.equal(next.activeDigest,first.priorDigest);assert.equal(next.evaluations,0);
 assert.equal(next.missionStatus,'COMPLETED');assert.equal(next.journal.pendingTransitions.length,0);
 t.diagnostic(JSON.stringify({writerPid:first.pid,readerPid:next.pid,actualDocker:1,restoredPriorDigest:true,evaluationReplay:0,missionStatus:next.missionStatus}));
 const again=invoke('read');assert.equal(again.errorCode,'A_CAPABILITY_PACKAGE_ROLLBACK_RECOVERY_INCOMPLETE');
});
test('modified prior contract is not restored even with valid signed history',t=>{
 const invoke=fixture(t),first=invoke('write'),next=invoke('tampered');assert.equal(next.errorCode,'A_CAPABILITY_PACKAGE_ROLLBACK_RECOVERY_MISMATCH');
 assert.equal(next.activeDigest,first.promotedDigest);assert.equal(next.evaluations,0);
});
test('a restored rollback is invalidated if another recovery already committed it',t=>{
 const invoke=fixture(t),first=invoke('write'),next=invoke('superseded');assert.equal(next.errorCode,'A_CAPABILITY_PACKAGE_ROLLBACK_RECOVERY_SUPERSEDED');
 assert.equal(next.activeDigest,first.promotedDigest);assert.equal(next.evaluations,0);
});
test('a rollback committed during async owner authorization prevents a second mutation',t=>{
 const invoke=fixture(t),first=invoke('write'),next=invoke('authorization-race');assert.equal(next.errorCode,'A_CAPABILITY_PACKAGE_ROLLBACK_RECOVERY_SUPERSEDED');
 assert.equal(next.activeDigest,first.promotedDigest);assert.equal(next.evaluations,0);
});
