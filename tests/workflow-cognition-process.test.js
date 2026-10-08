import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-workflow-cognition-process-')),children=new Set();
 t.after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){const ended=once(c,'exit');c.kill('SIGKILL');await ended;}assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
 return {root,children,calls:()=>existsSync(join(root,'calls.jsonl'))?readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').length:0};
}
async function launch(f,mode){
 const c=fork(new URL('./fixtures/workflow-cognition-process-child.mjs',import.meta.url),[f.root,mode],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});f.children.add(c);let stderr='';c.stderr.on('data',v=>stderr+=v);
 const next=()=>new Promise((resolveMessage,reject)=>{const cleanup=()=>{clearTimeout(timer);c.off('message',msg);c.off('exit',exit);};const msg=v=>{cleanup();v.type==='error'?reject(Error(v.message+'\n'+v.stack)):resolveMessage(v);};const exit=code=>{cleanup();reject(Error(`child exited ${code}: ${stderr}`));};const timer=setTimeout(()=>{cleanup();reject(Error('child boundary timed out: '+stderr));},20000);c.once('message',msg);c.once('exit',exit);});
 assert.equal((await next()).type,'ready');return {async run(){const reply=next();c.send('run');return reply;},async kill(){const ended=once(c,'exit');c.kill('SIGKILL');await ended;f.children.delete(c);}};
}
for(const mode of ['fail-episode','fail-outcome','fail-goal','fail-before-pause'])test(`actual Core kill at ${mode} repairs workflow cognition without executing it again`,async t=>{
 const f=fixture(t),initial=await launch(f,mode),failed=await initial.run();assert.equal(failed.type,'boundary');assert.equal(f.calls(),1);await initial.kill();
 const repaired=await(await launch(f,'resume')).run();assert.equal(repaired.status,'COMPLETED',JSON.stringify(repaired));assert.equal(repaired.episodes,1);assert.equal(f.calls(),1);
 const repeated=await(await launch(f,'resume')).run();assert.equal(repeated.status,'COMPLETED');assert.equal(repeated.episodes,1);assert.equal(f.calls(),1);
 assert.equal(JSON.parse(readFileSync(join(f.root,'workspace','output.json'),'utf8'))[0].total,7);
 assert.notEqual(failed.pid,repaired.pid);assert.notEqual(repaired.pid,repeated.pid);
 t.diagnostic(JSON.stringify({mode,initialPid:failed.pid,resumedPid:repaired.pid,recheckPid:repeated.pid,calls:f.calls(),episodes:1,missionId:repaired.missionId}));
});
test('repeated storage failure and a changed file cannot cause workflow re-execution after Core kill',async t=>{
 const f=fixture(t),initial=await launch(f,'fail-episode');await initial.run();await initial.kill();
 const still=await(await launch(f,'resume-still-failing')).run();assert.equal(still.status,'PAUSED');assert.equal(still.episodes,0);assert.equal(f.calls(),1);
 writeFileSync(join(f.root,'workspace','output.json'),'[{"total":99}]');
 const changed=await(await launch(f,'resume')).run();assert.equal(changed.status,'PAUSED');assert.equal(changed.episodes,0);assert.equal(f.calls(),1);
});
