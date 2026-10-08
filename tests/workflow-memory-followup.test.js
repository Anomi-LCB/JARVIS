import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
for(const mode of ['fail-growth','fail-work-throw','fail-work-false'])test(`workflow ${mode} must persist original memory after actual Core kill without B replay`,async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-workflow-memory-followup-')),children=new Set();
 t.after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){const ended=once(c,'exit');c.kill('SIGKILL');await ended;}assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
 async function run(childMode){const c=fork(new URL('./fixtures/workflow-cognition-process-child.mjs',import.meta.url),[root,childMode],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});children.add(c);let stderr='';c.stderr.on('data',b=>stderr+=b);
  const next=()=>new Promise((accept,reject)=>{const cleanup=()=>{clearTimeout(timer);c.off('message',message);c.off('exit',exit);};const message=m=>{cleanup();m.type==='error'?reject(Error(m.stack)):accept(m);};const exit=code=>{cleanup();reject(Error(`Child exited ${code}: ${stderr}`));};const timer=setTimeout(()=>{cleanup();reject(Error('Child timeout '+stderr));},20000);c.once('message',message);c.once('exit',exit);});
  assert.equal((await next()).type,'ready');const reply=next();c.send('run');return {value:await reply,async kill(){const exited=once(c,'exit');c.kill('SIGKILL');await exited;children.delete(c);}};
 }
 const initial=await run(mode);assert.equal(initial.value.type,'boundary');assert.equal(initial.value.status,'PAUSED',JSON.stringify(initial.value));await initial.kill();
 const repaired=(await run('resume-relocated')).value;assert.equal(repaired.status,'COMPLETED',JSON.stringify(repaired));assert.equal(repaired.episodes,1);assert.equal(repaired.growthEvents,1);assert.equal(repaired.workEntries,1);
 assert.equal(repaired.growthScopes[0].userId,'local_user');assert.equal(repaired.workScopes[0].userId,'local_user');
 assert.equal(repaired.growthScopes[0].conversationId,null);assert.equal(repaired.workScopes[0].conversationId,null);
 const repeated=(await run('resume')).value;assert.equal(repeated.status,'COMPLETED');assert.equal(repeated.growthEvents,1);assert.equal(repeated.workEntries,1);
 assert.equal(readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').length,1);assert.equal(JSON.parse(readFileSync(join(root,'workspace','output.json'),'utf8'))[0].total,7);
 t.diagnostic(JSON.stringify({mode,initial:initial.value,repaired,repeated,workflowCalls:1}));
});
