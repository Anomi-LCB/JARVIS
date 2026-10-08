import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
async function fixture(t,original=Buffer.from('original')){const root=await mkdtemp(join(tmpdir(),'jarvis-overwrite-rollback-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'source.txt');await writeFile(path,original);const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env:{},workerDaemonEnabled:false}),agent=runtime.pcAgent;const result=await agent.fileSystemAdapter.execute({path,content:'replacement',allowOverwrite:true},{taskId:'overwrite'});assert.equal(result.status,'success');return {root,path,agent,original};}
test('Overwrite rollback preserves later user changes',async t=>{const f=await fixture(t);await writeFile(f.path,'user changes');assert.equal((await f.agent.rollbackTask('overwrite')).success,false);assert.equal(await readFile(f.path,'utf8'),'user changes');});
test('Overwrite rollback restores original binary bytes without UTF8 corruption',async t=>{const f=await fixture(t,Buffer.from([255,254,0,1,128,195]));assert.equal((await f.agent.rollbackTask('overwrite')).success,true);assert.deepEqual(await readFile(f.path),f.original);});
test('Overwrite rollback checks current file again after preview',async t=>{const f=await fixture(t),preview=f.agent.rollbackPlan.bind(f.agent);f.agent.rollbackPlan=async id=>{const plan=await preview(id);await writeFile(f.path,'later changes');return plan;};assert.equal((await f.agent.rollbackTask('overwrite')).success,false);assert.equal(await readFile(f.path,'utf8'),'later changes');});
test('Overwrite rollback preserves replacement file with identical text',async t=>{const f=await fixture(t);await rename(f.path,join(f.root,'held.txt'));await writeFile(f.path,'replacement');assert.equal((await f.agent.rollbackTask('overwrite')).success,false);assert.equal(await readFile(f.path,'utf8'),'replacement');});
test('Unchanged overwritten text can still be restored',async t=>{const f=await fixture(t);assert.equal((await f.agent.rollbackTask('overwrite')).success,true);assert.deepEqual(await readFile(f.path),f.original);});
test('Missing current file is not silently recreated by overwrite rollback',async t=>{const f=await fixture(t);await rm(f.path);assert.equal((await f.agent.rollbackTask('overwrite')).success,false);await assert.rejects(readFile(f.path),{code:'ENOENT'});});
test('Tampered saved original bytes cannot be restored',async t=>{const f=await fixture(t);f.agent.undoJournal.entries[0].previousBytesBase64=Buffer.from('tampered').toString('base64');assert.equal((await f.agent.rollbackTask('overwrite')).success,false);assert.equal(await readFile(f.path,'utf8'),'replacement');});
test('Saved binary original survives actual fresh process rollback',async t=>{
 const f=await fixture(t,Buffer.from([0,255,254,195,128,42]));const code="import {createAgRuntime} from './apps/runtime-compose/src/create-runtime.js';import {join} from 'node:path';const root=process.argv[1],runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env:{},workerDaemonEnabled:false});const result=await runtime.pcAgent.rollbackTask('overwrite');console.log(JSON.stringify({success:result.success,pid:process.pid,chain:runtime.pcAgent.undoJournal.verifyChain().status}));";
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code,f.root],{windowsHide:true,timeout:20000});const result=JSON.parse(stdout.trim());assert.notEqual(result.pid,process.pid);assert.equal(result.success,true);assert.equal(result.chain,'valid');assert.deepEqual(await readFile(f.path),f.original);
});
