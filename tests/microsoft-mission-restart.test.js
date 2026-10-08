import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
for(const provider of ['outlook','teams-chat'])for(const mode of ['ready','revoked','changed-sql','tampered-task','missing-task','tampered-effect','goal-changed','auth-changed','verification-changed','duplicate-task','owner-revoked','old-owner','no-current-connection'])test(provider+' actual new Core PID recovery '+mode,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ms-core-restart-'));
 t.after(async()=>{const target=resolve(root);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('jarvis-ms-core-restart-'));await rm(target,{recursive:true,force:true});});
 const exec=async phase=>{const result=await run(process.execPath,['tests/fixtures/microsoft-mission-core-restart.mjs',root,phase,provider,mode],{windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});return JSON.parse(result.stdout);};
 const first=await exec('create'),second=await exec('recover');assert.notEqual(first.pid,second.pid);assert.notEqual(second.pid,process.pid);assert.equal(first.calls,2);assert.equal(second.calls,0);
 assert.equal(second.status,mode==='ready'?'verified':'unverified');t.diagnostic(JSON.stringify({provider,mode,createPid:first.pid,recoveryPid:second.pid,additionalProviderCalls:0}));
});
