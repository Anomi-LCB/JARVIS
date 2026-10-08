import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
const launch=(root,mode,now)=>{const child=spawn(process.execPath,['tests/fixtures/managed-egress-process-child.mjs',root,mode,now],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));return{child,exit,get out(){return out;},get err(){return err;}};};
for(const mode of ['retry','revoke','rotate','goal'])test('actual DPAPI egress result process recovery '+mode,{skip:process.platform!=='win32',timeout:45000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-egress-process-'));await mkdir(join(root,'workspace'));await writeFile(join(root,'workspace','notes.txt'),'public synthetic memo');let initial;
 t.after(async()=>{if(initial?.child.exitCode===null){initial.child.kill('SIGTERM');await initial.exit;}assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const before=new Date();initial=launch(root,'hold',before.toISOString());
 const deadline=Date.now()+25000;while(!initial.out.includes('ACCEPTED:')){assert.equal(initial.child.exitCode,null,initial.out+initial.err);assert.ok(Date.now()<deadline,initial.out+initial.err);await new Promise(r=>setTimeout(r,30));}
 initial.child.kill('SIGTERM');await initial.exit;
 const next=launch(root,mode,new Date(before.getTime()+30000).toISOString());const done=await next.exit;assert.equal(done.code,0,next.out+next.err);
 const result=JSON.parse(next.out.trim().split(/\r?\n/u).at(-1));assert.equal(result.reads,0);assert.equal(result.key.protectedByOs,true);assert.notEqual(next.child.pid,initial.child.pid);
 const journal=(await readFile(join(root,'provider.jsonl'),'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
 if(mode==='retry'){assert.equal(result.status,'submitted',JSON.stringify(result));assert.equal(journal.length,2);assert.deepEqual(journal[0].payload,journal[1].payload);assert.equal(journal[1].duplicateKey,true);}else{assert.equal(result.code,'A_MANAGED_AGENT_EGRESS_RESUBMISSION_DENIED');assert.equal(journal.length,1);}
 console.log(JSON.stringify({mode,initialPid:initial.child.pid,nextPid:next.child.pid,result,providerAttempts:journal.length,actualSqlite:true,actualDPAPI:true}));
});
