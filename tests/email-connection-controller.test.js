import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createCoreServer,createCoreOpenApiSpec} from '../packages/core/src/main.mjs';import {listenOnFetchSafePort} from '../packages/shared/src/http.js';

test('email OpenAPI declares authenticated no-credential and no-send operations',async t=>{
 const f=await setup(t);const spec=createCoreOpenApiSpec(f.runtime.coreFacade);
 for(const [path,method] of [['connection','get'],['probe','post'],['pause','post']]){
  const operation=spec.paths[`/personal-email/${path}`][method];assert.deepEqual(operation.security,[{bearerAuth:[]}]);
  assert.ok(operation.responses[503]);
  if(method==='post'){const schema=operation.requestBody.content['application/json'].schema;assert.equal(schema.additionalProperties,false);assert.equal(schema.type,'object');}
 }
 assert.match(spec.paths['/personal-email/probe'].post.description,/Never sends/);
 assert.match(spec.paths['/personal-email/pause'].post.description,/Does not delete/);
});

async function setup(t,timeoutMs=1000){
 const root=await mkdtemp(join(tmpdir(),'jarvis-email-connect-'));let now=Date.now(),sends=0,checks=0,closes=0;
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,
  clock:()=>new Date(++now),emailConnectionTimeoutMs:timeoutMs});
 t.after(async()=>{runtime.coreFacade.cognition?.close();await rm(root,{recursive:true,force:true});});
 const adapter=runtime.pcAgent.registry.get('email.send');let config={user:'sender@example.test',pass:'synthetic-password',service:'gmail'};
 adapter.smtpConfig=()=>config;
 adapter.loadNodemailer=async()=>({createTransport:options=>{
  assert.equal(options.requireTLS,true);assert.equal(options.tls.rejectUnauthorized,true);assert.equal(options.debug,false);assert.equal(options.logger,false);
  return {verify:async()=>{checks++;return true;},close:()=>{closes++;},sendMail:async()=>{sends++;return {accepted:['recipient@example.test'],rejected:[],pending:[],response:'250 accepted',messageId:'synthetic'};}};
 }});
 const task=()=>{const value=runtime.coreFacade.createTask('이메일로 보내줘');value.plan.action.arguments={to:'recipient@example.test',subject:'synthetic',body:'synthetic'};return value;};
 return {runtime,adapter,controller:runtime.emailConnection,task,setConfig:value=>config=value,counts:()=>({sends,checks,closes})};
}
test('configured is not connected; explicit no-send check enables the default Core/E/B/G path',async t=>{
 const f=await setup(t);assert.equal(f.controller.status().configured,true);assert.equal(f.controller.status().available,false);
 const blocked=await f.runtime.orchestrationWorker.runTask(f.task().taskId);assert.equal(blocked.success,false);assert.equal(f.counts().checks,0);
 const connected=await f.controller.probe();assert.equal(connected.available,true);assert.equal(connected.mailSent,false);assert.equal(f.counts().sends,0);
 assert.equal(JSON.stringify(connected).includes('synthetic-password'),false);assert.equal(JSON.stringify(connected).includes('sender@example.test'),false);
 const run=await f.runtime.orchestrationWorker.runTask(f.task().taskId);assert.equal(run.success,true,JSON.stringify({error:run.error,execution:run.execution?.executionResult,blocked:run.execution?.blockedReason,counts:f.counts()}));assert.equal(run.executionVerification.status,'passed');
 assert.equal(f.counts().sends,1);assert.ok(f.counts().checks>=2);assert.equal(f.counts().checks,f.counts().closes);
 const paused=f.controller.disconnect();assert.equal(paused.localExecutionPaused,true);assert.equal(paused.providerCredentialRevoked,false);
 const denied=await f.runtime.orchestrationWorker.runTask(f.task().taskId);assert.equal(denied.success,false);assert.equal(f.counts().sends,1);
});
test('pause during verification cannot reconnect from a late response',async t=>{
 const f=await setup(t);let release,reached;const gate=new Promise(r=>release=r),at=new Promise(r=>reached=r);
 f.adapter.loadNodemailer=async()=>({createTransport:()=>({verify:async()=>{reached();await gate;return true;},close(){}})});
 const checking=f.controller.probe();await at;f.controller.disconnect();release();
 await assert.rejects(checking,{code:'A_EMAIL_CONNECTION_CHANGED'});assert.equal(f.controller.status().available,false);assert.equal(f.controller.status().status,'paused');
});
test('changed configuration during check cannot publish readiness for the old account',async t=>{
 const f=await setup(t);
 f.adapter.loadNodemailer=async()=>({createTransport:()=>({verify:async()=>{f.setConfig({user:'other@example.test',pass:'other-secret',service:'gmail'});return true;},close(){}})});
 await assert.rejects(f.controller.probe(),{code:'A_EMAIL_CONNECTION_CHANGED'});assert.equal(f.controller.status().available,false);
});
test('loaded send configuration changed during adapter preparation causes zero sends',async t=>{
 const f=await setup(t);await f.controller.probe();const load=f.adapter.loadNodemailer.bind(f.adapter);let loads=0;
 f.adapter.loadNodemailer=async()=>{const value=await load();if(++loads===3)f.setConfig(null);return value;};
 const run=await f.runtime.orchestrationWorker.runTask(f.task().taskId);
 assert.equal(run.success,false);assert.equal(f.counts().sends,0);assert.match(JSON.stringify({error:run.error,execution:run.execution?.executionResult,blocked:run.execution?.blockedReason}),/A_EMAIL_CONNECTION_CHANGED/);
});
for(const phase of ['load','verify'])test(`bounded ${phase} timeout never marks connected`,async t=>{
 const f=await setup(t,5),never=new Promise(()=>{});
 f.adapter.loadNodemailer=phase==='load'?()=>never:async()=>({createTransport:()=>({verify:()=>never,close(){}})});
 await assert.rejects(f.controller.probe(),{code:'A_EMAIL_CHECK_TIMEOUT'});assert.equal(f.controller.status().available,false);
});
test('admin API refuses credentials and exposes no provider error text or secret',async t=>{
 const f=await setup(t),server=createCoreServer(f.runtime.coreFacade,{adminToken:'synthetic-email-admin',orchestrationWorker:f.runtime.orchestrationWorker,emailConnection:f.controller});
 await listenOnFetchSafePort(server);t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`;
 const get=await fetch(`${base}/personal-email/connection`);assert.equal(get.status,401);
 const call=(path,body)=>fetch(`${base}${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer synthetic-email-admin','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal((await call('/personal-email/probe',{password:'must-not-store'})).status,400);
 assert.equal((await (await call('/personal-email/probe',{})).json()).available,true);
 assert.equal(f.counts().sends,0);
 f.adapter.loadNodemailer=async()=>({createTransport:()=>({verify:async()=>{throw new Error('PRIVATE_PROVIDER_SECRET synthetic-password');},close(){}})});
 const failed=await call('/personal-email/probe',{});assert.equal(failed.status,409);
 assert.deepEqual(await failed.json(),{error:{code:'A_EMAIL_CHECK_FAILED'}});
 assert.equal((await (await call('/personal-email/connection')).json()).available,false);
 assert.equal((await (await call('/personal-email/pause',{})).json()).localExecutionPaused,true);
});
test('default email resolver preserves other tools static binding contracts',async t=>{
 const f=await setup(t),binding={capabilityId:'workflow.execute',providerId:'isolated-read',accountRef:'synthetic-read',deviceRef:null,scopes:['synthetic.read']};
 f.runtime.pcAgent.registry.contractFor('filesystem.listFiles').availabilityBinding=binding;
 f.runtime.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:f.runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,
  observedAt:f.controller.clock().toISOString(),permissionRevision:'read-1',accountStatus:'connected',observedAccountRef:binding.accountRef,
  deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'isolated-static-read'});
 const task=f.runtime.coreFacade.createTask('파일 목록 보여줘'),run=await f.runtime.orchestrationWorker.runTask(task.taskId);
 assert.equal(run.success,true,JSON.stringify(run.error));assert.equal(run.executionVerification.status,'passed');assert.equal(f.counts().checks,0);
});
