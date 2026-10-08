import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,rename,mkdir,symlink,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'jarvis-undo-move-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const from=join(root,'source.txt'),to=join(root,'delivered.txt'),journal=join(root,'undo.jsonl');await writeFile(from,'original');await rename(from,to);
 const make=()=>createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),undoJournalPath:journal,env:{},workerDaemonEnabled:false}).pcAgent;
 const agent=make();agent.undoJournal.record({taskId:'move',action:'move_back',from,to});return {root,from,to,agent,make};
}
test('move rollback preserves a later user edit at its current location',async t=>{
 const {from,to,agent}=await fixture(t);await writeFile(to,'user edited');assert.equal((await agent.rollbackTask('move')).success,false);
 assert.equal(await readFile(to,'utf8'),'user edited');await assert.rejects(readFile(from),{code:'ENOENT'});
});
test('move rollback does not move a replacement even if it has identical bytes',async t=>{
 const {root,from,to,agent}=await fixture(t);await rename(to,join(root,'held.txt'));await writeFile(to,'original');
 assert.equal((await agent.rollbackTask('move')).success,false);assert.equal(await readFile(to,'utf8'),'original');await assert.rejects(readFile(from),{code:'ENOENT'});
});
test('move rollback rechecks a source changed after preview',async t=>{
 const {from,to,agent}=await fixture(t),preview=agent.rollbackPlan.bind(agent);
 agent.rollbackPlan=async id=>{const plan=await preview(id);await writeFile(to,'after preview');return plan;};
 assert.equal((await agent.rollbackTask('move')).success,false);assert.equal(await readFile(to,'utf8'),'after preview');await assert.rejects(readFile(from),{code:'ENOENT'});
});
test('move rollback cannot overwrite a new restore target appearing after preview',async t=>{
 const {from,to,agent}=await fixture(t),preview=agent.rollbackPlan.bind(agent);
 agent.rollbackPlan=async id=>{const plan=await preview(id);await writeFile(from,'new target');return plan;};
 assert.equal((await agent.rollbackTask('move')).success,false);assert.equal(await readFile(from,'utf8'),'new target');assert.equal(await readFile(to,'utf8'),'original');
});
test('move rollback rejects historical records without original move evidence',async t=>{
 const {from,to,agent}=await fixture(t);delete agent.undoJournal.entries[0].movedFileSnapshot;
 assert.equal((await agent.rollbackTask('move')).success,false);assert.equal(await readFile(to,'utf8'),'original');await assert.rejects(readFile(from),{code:'ENOENT'});
});
test('unchanged moved file restores after journal reload and repeated rollback is harmless',async t=>{
 const {from,to,make}=await fixture(t),agent=make();assert.equal((await agent.rollbackTask('move')).success,true);
 assert.equal(await readFile(from,'utf8'),'original');await assert.rejects(readFile(to),{code:'ENOENT'});
 assert.equal(agent.undoJournal.list().length,0);assert.equal(agent.undoJournal.verifyChain().status,'valid');
 const repeated=await agent.rollbackTask('move');assert.equal(repeated.error.code,'B_ROLLBACK_NOT_FOUND');assert.equal(await readFile(from,'utf8'),'original');
});
for(const altered of [false,true])test(`actual file move adapter journal survives another PID; altered=${altered}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-undo-move-pid-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const invoke=mode=>JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('./fixtures/rollback-move-process.mjs',import.meta.url)),mode,root],{encoding:'utf8',windowsHide:true,timeout:30000}));
 const first=invoke('write');assert.equal(first.status,'success');
 const next=invoke(altered?'changed':'read');assert.notEqual(first.pid,next.pid);assert.equal(next.success,!altered);
 assert.equal(next.source,altered?null:'original');assert.equal(next.delivered,altered?'user edit':null);assert.equal(next.chain,'valid');
 t.diagnostic(JSON.stringify({writerPid:first.pid,readerPid:next.pid,altered,success:next.success}));
});
test('move rollback preserves targets of a symlink replacement',async t=>{
 const {root,from,to,agent}=await fixture(t),foreign=join(root,'foreign.txt');await writeFile(foreign,'foreign');await rm(to);await symlink(foreign,to);
 assert.equal((await agent.rollbackTask('move')).success,false);assert.equal(await readFile(foreign,'utf8'),'foreign');await assert.rejects(readFile(from),{code:'ENOENT'});
});
test('restore parent junction changing within allowed roots is rejected',async t=>{
 const {root,to,agent}=await fixture(t),first=join(root,'first'),second=join(root,'second'),parent=join(root,'parent');
 await mkdir(first);await mkdir(second);await symlink(first,parent,process.platform==='win32'?'junction':'dir');
 const from=join(parent,'restore.txt');agent.undoJournal.record({taskId:'parent',action:'move_back',from,to});
 await unlink(parent);await symlink(second,parent,process.platform==='win32'?'junction':'dir');
 assert.equal((await agent.rollbackTask('parent')).success,false);assert.equal(await readFile(to,'utf8'),'original');await assert.rejects(readFile(join(second,'restore.txt')),{code:'ENOENT'});
});
