import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
for(const provider of ['outlook','teams-chat'])test(`multi-page signed result survives a different Core PID: ${provider}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ms-pages-restart-'));
 t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-ms-pages-restart-'));await rm(root,{recursive:true,force:true});});
 const exec=async phase=>JSON.parse((await run(process.execPath,['tests/fixtures/microsoft-mission-core-restart.mjs',root,phase,provider,'pages'],{windowsHide:true,timeout:45000,maxBuffer:2*1024*1024})).stdout);
 const first=await exec('create'),second=await exec('recover');
 assert.equal(first.status,'COMPLETED');assert.equal(first.archiveRows,3);assert.equal(first.calls,6);
 assert.notEqual(first.pid,second.pid);assert.equal(second.calls,0);assert.equal(second.status,'verified');
 t.diagnostic(JSON.stringify({provider,createPid:first.pid,recoverPid:second.pid,pages:3,providerCallsDuringCollection:6,recoveryProviderCalls:0,realAccountVerified:false}));
});

for(const provider of ['outlook','teams-chat'])for(const mode of ['pages-extended','pages-extension-tampered'])test(`signed limit amendment recovered under a fresh read owner ${provider} ${mode}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ms-pages-restart-'));
 t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-ms-pages-restart-'));await rm(root,{recursive:true,force:true});});
 const exec=async phase=>JSON.parse((await run(process.execPath,['tests/fixtures/microsoft-mission-core-restart.mjs',root,phase,provider,mode],{windowsHide:true,timeout:45000,maxBuffer:2*1024*1024})).stdout);
 const first=await exec('create'),second=await exec('recover');assert.equal(first.status,'COMPLETED');assert.equal(first.archiveRows,3);assert.equal(first.calls,6);
 assert.notEqual(first.pid,second.pid);assert.equal(second.calls,0);assert.equal(second.status,mode==='pages-extended'?'verified':'unverified');
 t.diagnostic(JSON.stringify({provider,mode,firstPid:first.pid,secondPid:second.pid,recoveryProviderCalls:second.calls}));
});
