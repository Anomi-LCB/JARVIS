import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
test('broker closes an authenticated idle TLS connection within two seconds in separate process runs',async()=>{
 for(const run of [1,2]){
  const child=fork(new URL('./fixtures/duffel-shutdown-probe.mjs',import.meta.url),[],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  let closed=null,errors='';child.stderr.on('data',b=>errors+=b);
  const timeout=setTimeout(()=>child.kill(),10000);
  try{
   await new Promise((resolve,reject)=>{child.on('message',v=>{if(v.type==='closing')resolve();if(v.type==='closed')closed=v;});child.once('exit',code=>{if(!closed)reject(new Error('probe exit '+code+' '+errors));});});
   const deadline=performance.now()+2000;
   while(!closed&&performance.now()<deadline)await new Promise(r=>setTimeout(r,20));
   assert.ok(closed,'close must finish');assert.ok(closed.elapsedMs<2000);
   console.log(JSON.stringify({observedAt:new Date().toISOString(),run,closedWithinTwoSeconds:Boolean(closed),elapsedMs:closed.elapsedMs,performanceImprovementClaim:false}));
  }finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}}
 }
});
