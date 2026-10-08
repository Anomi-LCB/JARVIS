import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,appendFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createPcAgentServer,PcAgentApiGuard} from '../apps/pc-agent/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';

for(const [mode,endpointChanged] of [['fail-growth',false],['fail-work-throw',false],['fail-work-false',false],['fail-work-false',true],
 ['fail-episode',false],['fail-outcome',false],['fail-goal',false]])test(`remote HTTP workflow ${mode} ${endpointChanged?'rejects changed executor':'recovers'} after Core OS kill without replaying B`,async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-workflow-remote-memory-')),workspace=join(root,'workspace'),children=new Set();mkdirSync(workspace);
 const pc=createAgRuntime({allowedRoots:[workspace],auditRoot:join(root,'pc-audit'),workerDaemonEnabled:false,
  trustSigningSecret:'synthetic-owned-workflow-recovery-fixture-not-production-key',env:{JARVIS_TEST_MODE:'1'}});
 const adapter=pc.pcAgent.registry.get('workflow.execute'),execute=adapter.execute.bind(adapter);
 adapter.execute=async(...args)=>{const result=await execute(...args);appendFileSync(join(root,'calls.jsonl'),JSON.stringify({taskId:args[1]?.taskId,status:result.status})+'\n');return result;};
 const server=createPcAgentServer(pc.pcAgent,{apiGuard:new PcAgentApiGuard({apiToken:'synthetic-workflow-memory-admin-token',executionToken:'synthetic-workflow-memory-execution-token'})});
 await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
 let baseUrl=`http://127.0.0.1:${server.address().port}`,executionPosts=0,alternateServer;
 const count=req=>{if(req.method==='POST'&&['/execution-packets','/operations/execute','/execution-packets/resume-workflow'].includes(req.url))executionPosts++;};
 server.on('request',count);
 t.after(async()=>{
  for(const c of children)if(c.exitCode===null&&c.signalCode===null){const ended=once(c,'exit');c.kill('SIGKILL');await ended;}
  if(alternateServer)await new Promise(resolve=>alternateServer.close(resolve));
  await new Promise(resolve=>server.close(resolve));pc.coreFacade.cognition.close();pc.growthRuntime?.ingestor?.store?.close?.();
  assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});
 });
 async function run(childMode){
  const c=fork(new URL('./fixtures/workflow-cognition-process-child.mjs',import.meta.url),[root,childMode,baseUrl],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});children.add(c);let stderr='';c.stderr.on('data',b=>stderr+=b);
  const next=()=>new Promise((accept,reject)=>{
   const cleanup=()=>{clearTimeout(timer);c.off('message',message);c.off('exit',exit);};
   const message=m=>{cleanup();m.type==='error'?reject(Error(m.stack)):accept(m);};const exit=code=>{cleanup();reject(Error(`Core child exited ${code}: ${stderr}`));};
   const timer=setTimeout(()=>{cleanup();reject(Error('Core child timeout '+stderr));},20000);c.once('message',message);c.once('exit',exit);
  });
  assert.equal((await next()).type,'ready');const reply=next();c.send('run');return{value:await reply,async kill(){if(c.exitCode===null&&c.signalCode===null){const ended=once(c,'exit');c.kill('SIGKILL');await ended;}children.delete(c);}};
 }
 const initial=await run(mode);assert.equal(initial.value.type,'boundary');assert.equal(initial.value.status,'PAUSED',JSON.stringify(initial.value));await initial.kill();
 assert.equal(initial.value.intents,1);
 if(['fail-episode','fail-outcome','fail-goal'].includes(mode)){
  const stalled=(await run('resume-still-failing')).value;
  assert.equal(stalled.status,'PAUSED',JSON.stringify(stalled));assert.equal(stalled.episodes,0);
  assert.equal(readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').length,1);assert.equal(executionPosts,1);
 }
 if(['fail-growth','fail-work-throw','fail-work-false'].includes(mode)&&!endpointChanged){
  const stalled=(await run(`resume-${mode.slice(5)}-still-failing`)).value;
  assert.equal(stalled.status,'PAUSED',JSON.stringify(stalled));
  if(mode==='fail-growth')assert.equal(stalled.growthEvents,0);else assert.equal(stalled.workEntries,0);
  assert.equal(readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').length,1);assert.equal(executionPosts,1);
 }
 if(endpointChanged){
  alternateServer=createPcAgentServer(pc.pcAgent,{apiGuard:new PcAgentApiGuard({apiToken:'synthetic-workflow-memory-admin-token',executionToken:'synthetic-workflow-memory-execution-token'})});
  await listenOnFetchSafePort(alternateServer,{host:'127.0.0.1',port:0});alternateServer.on('request',count);baseUrl=`http://127.0.0.1:${alternateServer.address().port}`;
  const changed=(await run('resume')).value;assert.equal(changed.status,'PAUSED',JSON.stringify(changed));assert.equal(changed.workEntries,0);
  assert.equal(readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').length,1);assert.equal(executionPosts,1);
  t.diagnostic(JSON.stringify({mode,endpointChanged:true,coreWriterPid:initial.value.pid,coreRecoveryPid:changed.pid,executionPosts,workflowCalls:1,scope:'Same live B under changed authenticated loopback endpoint; no original context reassignment'}));return;
 }
 const repaired=(await run('resume-relocated')).value;assert.notEqual(repaired.pid,initial.value.pid);assert.equal(repaired.status,'COMPLETED',JSON.stringify(repaired));
 assert.equal(repaired.episodes,1);assert.equal(repaired.growthEvents,1);assert.equal(repaired.workEntries,1);
 assert.equal(repaired.growthScopes[0].userId,'local_user');assert.equal(repaired.workScopes[0].userId,'local_user');
 const repeated=(await run('resume')).value;assert.equal(repeated.status,'COMPLETED');assert.equal(repeated.growthEvents,1);assert.equal(repeated.workEntries,1);
 assert.equal(readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').length,1);assert.equal(executionPosts,1);
 assert.equal(JSON.parse(readFileSync(join(workspace,'output.json'),'utf8'))[0].total,7);
 t.diagnostic(JSON.stringify({mode,coreWriterPid:initial.value.pid,coreRecoveryPid:repaired.pid,pcServerPid:process.pid,executionPosts,workflowCalls:1,
  recoveredScopes:{growth:repaired.growthScopes,work:repaired.workScopes},scope:'Actual authenticated loopback HTTP B with distinct Core OS processes; synthetic files, no account/device claim'}));
});
