import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const child=new URL('./fixtures/source-page-verification-child.mjs',import.meta.url);
for(const provider of ['outlook','teams-chat','gmail','google-calendar'])test('actual new process independently verifies persisted source page '+provider,t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-source-outcome-'));
 const run=phase=>{const r=spawnSync(process.execPath,[fileURLToPath(child),root,provider,phase],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());};
 try{const first=run('prepare'),second=run('verify');assert.notEqual(first.pid,second.pid);assert.deepEqual(second.receipt,first.receipt);assert.equal(second.receipt.status,'passed');t.diagnostic(JSON.stringify({actualNewProcess:true,provider,firstPid:first.pid,secondPid:second.pid,receipt:second.receipt}));}
 finally{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-source-outcome-'));rmSync(root,{recursive:true,force:true});}
});
