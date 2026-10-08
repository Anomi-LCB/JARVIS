import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,rename,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'jarvis-undo-content-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'created.txt'),journalPath=join(root,'undo.jsonl');await writeFile(path,'original');
 const make=()=>createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),undoJournalPath:journalPath,env:{},workerDaemonEnabled:false}).pcAgent;
 const agent=make();agent.undoJournal.record({taskId:'created',action:'delete_created_file',path});return {root,path,agent,make};
}
test('Rollback preserves a created file subsequently edited by its user',async t=>{
 const {path,agent}=await fixture(t);await writeFile(path,'user changes');
 const result=await agent.rollbackTask('created');assert.equal(result.success,false);assert.equal(await readFile(path,'utf8'),'user changes');
});
test('Rollback deletes the unchanged created file after journal reload',async t=>{
 const {path,make}=await fixture(t);const agent=make();const result=await agent.rollbackTask('created');assert.equal(result.success,true);await assert.rejects(readFile(path),{code:'ENOENT'});
});
test('Rollback preserves a different file occupying the original path even with identical bytes',async t=>{
 const {root,path,agent}=await fixture(t);await rename(path,join(root,'original-held.txt'));await writeFile(path,'original');
 assert.equal((await agent.rollbackTask('created')).success,false);assert.equal(await readFile(path,'utf8'),'original');
});
test('Rollback rechecks changes occurring after its preview',async t=>{
 const {path,agent}=await fixture(t);
 const preview=agent.rollbackPlan.bind(agent);agent.rollbackPlan=async id=>{const result=await preview(id);await writeFile(path,'changed after preview');return result;};
 const result=await agent.rollbackTask('created');assert.equal(result.success,false);assert.equal(result.error.causeCode,'B_ROLLBACK_FILE_CHANGED');assert.equal(await readFile(path,'utf8'),'changed after preview');
});
test('Rollback refuses historical records lacking original file evidence',async t=>{
 const {path,agent}=await fixture(t);delete agent.undoJournal.entries[0].createdFileSnapshot;
 const plan=await agent.rollbackPlan('created');assert.equal(plan.blockedCount,1);assert.equal(plan.steps[0].blockedReason,'B_ROLLBACK_FILE_EVIDENCE_UNAVAILABLE');
 assert.equal((await agent.rollbackTask('created')).success,false);assert.equal(await readFile(path,'utf8'),'original');
});
test('Rollback missing-file no-op cannot delete a new file appearing after preview',async t=>{
 const {path,agent}=await fixture(t);await rm(path);const preview=agent.rollbackPlan.bind(agent);
 agent.rollbackPlan=async id=>{const result=await preview(id);assert.equal(result.noopCount,1);await writeFile(path,'new file');return result;};
 assert.equal((await agent.rollbackTask('created')).success,false);assert.equal(await readFile(path,'utf8'),'new file');
});
test('Rollback rejects a symlink replacement and preserves its target',async t=>{
 const {root,path,agent}=await fixture(t);const target=join(root,'foreign.txt');await writeFile(target,'foreign');await rm(path);
 await symlink(target,path);assert.equal((await agent.rollbackTask('created')).success,false);assert.equal(await readFile(target,'utf8'),'foreign');
});
test('Rollback safely previews and executes creation followed by a move',async t=>{
 const {root,path,agent}=await fixture(t);const delivered=join(root,'delivered.txt');await rename(path,delivered);
 agent.undoJournal.record({taskId:'created',action:'move_back',from:path,to:delivered});
 const plan=await agent.rollbackPlan('created');assert.equal(plan.readyCount,2);assert.equal(plan.blockedCount,0);
 const result=await agent.rollbackTask('created');assert.equal(result.success,true);assert.equal(result.rolledBack.length,2);await assert.rejects(readFile(path),{code:'ENOENT'});
});
test('Rollback missing original file remains a successful no-op',async t=>{
 const {path,agent}=await fixture(t);await rm(path);const result=await agent.rollbackTask('created');assert.equal(result.success,true);assert.equal(result.rolledBack.length,1);
 assert.equal(agent.undoJournal.list().length,0);assert.equal(agent.undoJournal.verifyChain().status,'valid');
});
