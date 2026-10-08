import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPcExecutionRuntime} from '../apps/runtime-compose/src/create-pc-runtime.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createPcAgentServer,PcAgentApiGuard} from '../apps/pc-agent/src/main.mjs';
import {PcAgentExecutionClient} from '../packages/core/src/client/pc-agent-execution-client.js';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
async function setup(t){
 const root=await mkdtemp(join(tmpdir(),'jarvis-remote-mail-'));let now=Date.now(),checks=0,sends=0,coreConfigReads=0;
 const clock=()=>new Date(now);const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const b=createPcExecutionRuntime({allowedRoots:[root],auditRoot:join(root,'b'),env,clock});
 const adapter=b.pcAgent.registry.get('email.send');adapter.smtpConfig=()=>({user:'remote-synthetic@example.test',pass:'PRIVATE_REMOTE_SYNTHETIC',service:'gmail'});
 adapter.loadNodemailer=async()=>({createTransport:()=>({verify:async()=>{checks++;return true;},close(){},sendMail:async()=>{sends++;throw Error('no-send');}})});
 const guard=new PcAgentApiGuard({apiToken:'synthetic-admin',executionToken:'synthetic-executor'});
 const server=createPcAgentServer(b.pcAgent,{apiGuard:guard,emailConnection:b.emailConnection});const address=await listenOnFetchSafePort(server);
 const client=new PcAgentExecutionClient({baseUrl:`http://127.0.0.1:${address.port}`,executionToken:'synthetic-executor'});
 const a=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'a'),env,taskEnv:env,clock,workerDaemonEnabled:false,pcAgentExecutor:client});
 a.pcAgent.registry.get('email.send').smtpConfig=()=>{coreConfigReads++;throw Error('Core credentials must not be substituted');};
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));a.coreFacade.cognition?.close();await rm(root,{recursive:true,force:true});});
 return {a,b,client,guard,adapter,counts:()=>({checks,sends,coreConfigReads}),advance:ms=>{now+=ms;},call:(path,body)=>fetch(client.baseUrl+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer synthetic-executor','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})};
}
test('real B HTTP readiness is read-only and Core never substitutes local SMTP configuration',async t=>{
 const f=await setup(t);assert.equal(f.a.emailConnection,null);
 assert.equal((await f.a.remoteEmailReadiness.resolve()).binding,null);
 assert.equal((await f.call('/email/probe',{})).status,401);assert.equal((await f.call('/email/readiness',{})).status,405);
 await f.b.emailConnection.probe();const source=await f.client.emailReadiness();assert.equal(source.executionAuthorized,false);assert.equal(source.available,true);
 const ready=await f.a.remoteEmailReadiness.resolve();assert.equal(ready.binding.accountRef,source.binding.accountRef);
 assert.equal(f.a.capabilityPackageRegistry.availabilityFor(ready.binding,{permissionRevision:ready.permissionRevision}).available,true);
 assert.doesNotMatch(JSON.stringify(source),/PRIVATE_REMOTE_SYNTHETIC|remote-synthetic@example/);
 const task=f.a.coreFacade.createTask('이메일로 보내줘');task.plan.action.arguments={to:'recipient@example.test',subject:'synthetic',body:'synthetic'};
 const run=await f.a.orchestrationWorker.runTask(task.taskId);assert.equal(run.success,false);assert.match(JSON.stringify(run),/executor-availability-fence-unsupported/);
 assert.deepEqual(f.counts(),{checks:1,sends:0,coreConfigReads:0});
});
test('pause, account changes and expired observations remove remote readiness without freshening SMTP evidence',async t=>{
 const f=await setup(t);await f.b.emailConnection.probe();const ready=await f.a.remoteEmailReadiness.resolve();
 const observedAt=(await f.client.emailReadiness()).observation.observedAt;f.advance(1000);
 assert.equal((await f.client.emailReadiness()).observation.observedAt,observedAt);
 f.b.emailConnection.disconnect();const paused=await f.a.remoteEmailReadiness.resolve();assert.equal(paused.binding,null);assert.notEqual(paused.permissionRevision,ready.permissionRevision);
 assert.equal(f.a.capabilityPackageRegistry.availabilityFor(ready.binding).available,false);
 await f.b.emailConnection.probe();f.advance(61000);assert.equal((await f.a.remoteEmailReadiness.resolve()).binding,null);
 f.advance(1000);await f.b.emailConnection.probe();const original=await f.a.remoteEmailReadiness.resolve();
 f.adapter.smtpConfig=()=>({user:'different@example.test',pass:'different-synthetic',service:'gmail'});
 const changed=await f.a.remoteEmailReadiness.resolve();assert.equal(changed.binding,null);assert.notEqual(changed.permissionRevision,original.permissionRevision);
 assert.equal(f.a.capabilityPackageRegistry.availabilityFor(original.binding).available,false);
 assert.deepEqual(f.counts(),{checks:3,sends:0,coreConfigReads:0});
});
test('revoked execution token and malformed source contracts cannot use previously cached readiness',async t=>{
 const f=await setup(t);await f.b.emailConnection.probe();const source=await f.client.emailReadiness();
 const original=f.client.emailReadiness.bind(f.client);
 for(const mutate of [v=>({...v,password:'forbidden'}),v=>({...v,executionAuthorized:true}),v=>({...v,observation:{...v.observation,codeVersion:'unreviewed'}}),v=>({...v,observation:{...v.observation,observedAccountRef:'wrong-account'}})]){
  f.client.emailReadiness=async()=>mutate(structuredClone(source));await assert.rejects(f.a.remoteEmailReadiness.resolve(),{code:'A_PC_EMAIL_READINESS_INVALID'});
 }
 f.client.emailReadiness=original;await f.a.remoteEmailReadiness.resolve();f.guard.executionTokenStore.tokenHash=null;
 await assert.rejects(f.a.remoteEmailReadiness.resolve(),{code:'A_PC_EMAIL_READINESS_AUTH_REQUIRED'});
 assert.equal(f.a.capabilityPackageRegistry.availabilityFor(source.binding).available,false);
 assert.equal(f.counts().sends,0);
});
test('PC configuration read failures never leak provider text through the readiness endpoint',async t=>{
 const f=await setup(t);f.adapter.smtpConfig=()=>{throw Error('PRIVATE_CONFIG_GETTER_SECRET');};
 const response=await f.call('/email/readiness');assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:{code:'A_EMAIL_STATE_UNAVAILABLE'}});
 await assert.rejects(f.client.emailReadiness(),{code:'A_PC_EMAIL_READINESS_UNAVAILABLE'});
});
test('readiness client disallows remote token destinations and bounded oversized responses',async()=>{
 let calls=0;const remote=new PcAgentExecutionClient({baseUrl:'https://remote.invalid',executionToken:'synthetic',fetchImpl:async()=>{calls++;}});
 await assert.rejects(remote.emailReadiness(),{code:'A_PC_EMAIL_READINESS_ENDPOINT_UNSUPPORTED'});assert.equal(calls,0);
 const local=new PcAgentExecutionClient({executionToken:'synthetic',fetchImpl:async()=>new Response(' '.repeat(17000))});
 await assert.rejects(local.emailReadiness(),{code:'A_PC_EMAIL_READINESS_UNAVAILABLE'});
});
