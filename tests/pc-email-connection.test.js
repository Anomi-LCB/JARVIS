import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPcExecutionRuntime} from '../apps/runtime-compose/src/create-pc-runtime.js';
import {createPcAgentServer,PcAgentApiGuard,createPcAgentOpenApiSpec} from '../apps/pc-agent/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
async function setup(t){
 const root=await mkdtemp(join(tmpdir(),'jarvis-pc-email-'));let checks=0,sends=0;
 const runtime=createPcExecutionRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env:{JARVIS_TEST_MODE:'1'}});
 const adapter=runtime.pcAgent.registry.get('email.send');adapter.smtpConfig=()=>({user:'pc-synthetic@example.test',pass:'PC_PRIVATE_SYNTHETIC',service:'gmail'});
 adapter.loadNodemailer=async()=>({createTransport:()=>({verify:async()=>{checks++;return true;},close(){},sendMail:async()=>{sends++;throw Error('must not send');}})});
 const guard=new PcAgentApiGuard({apiToken:'synthetic-admin',executionToken:'synthetic-executor'});
 const server=createPcAgentServer(runtime.pcAgent,{apiGuard:guard,emailConnection:runtime.emailConnection});
 const address=await listenOnFetchSafePort(server);const base=`http://127.0.0.1:${address.port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
 const call=(path,body,token='synthetic-admin')=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {runtime,guard,adapter,call,counts:()=>({checks,sends})};
}
test('standalone B owns its email config and administrator-only no-send readiness management',async t=>{
 const f=await setup(t);
 for(const [path,body] of [['/email/connection',undefined],['/email/probe',{}],['/email/pause',{}]])assert.equal((await f.call(path,body,'synthetic-executor')).status,401);
 assert.deepEqual(f.counts(),{checks:0,sends:0});
 const before=await(await f.call('/email/connection')).json();assert.equal(before.configured,true);assert.equal(before.available,false);
 const verified=await(await f.call('/email/probe',{})).json();assert.equal(verified.available,true);assert.equal(verified.executionAuthorized,false);assert.equal(verified.mailSent,false);
 assert.equal(f.runtime.capabilityPackageRegistry.activations.has('email.send'),true);
 const paused=await(await f.call('/email/pause',{})).json();assert.equal(paused.available,false);assert.equal(paused.localExecutionPaused,true);assert.equal(paused.credentialsDeleted,false);
 assert.deepEqual(f.counts(),{checks:1,sends:0});assert.doesNotMatch(JSON.stringify([before,verified,paused]),/PC_PRIVATE_SYNTHETIC|pc-synthetic@example/);
});
test('PC email management rejects credential payloads, queries, wrong verbs and leaks no provider text',async t=>{
 const f=await setup(t);
 for(const body of [{pass:'forbidden'},[],null])assert.equal((await f.call('/email/probe',body)).status,400);
 assert.equal((await f.call('/email/probe?pass=forbidden',{})).status,400);
 assert.equal((await f.call('/email/probe')).status,405);assert.deepEqual(f.counts(),{checks:0,sends:0});
 f.adapter.loadNodemailer=async()=>({createTransport:()=>({verify:async()=>{throw Error('PROVIDER_PRIVATE_CREDENTIAL');},close(){}})});
 const result=await f.call('/email/probe',{});assert.equal(result.status,409);assert.deepEqual(await result.json(),{error:{code:'A_EMAIL_CHECK_FAILED'}});
 assert.equal((await(await f.call('/email/connection')).json()).available,false);
});
test('admin token revoked during remote verify cannot publish enabled readiness',async t=>{
 const f=await setup(t);
 f.adapter.loadNodemailer=async()=>({createTransport:()=>({verify:async()=>{f.guard.tokenStore.tokenHash=null;return true;},close(){}})});
 assert.equal((await f.call('/email/probe',{})).status,401);assert.equal(f.runtime.emailConnection.status().status,'paused');assert.equal(f.runtime.emailConnection.status().available,false);
});
test('PC email contract specifies admin-only authorization and empty bodies',()=>{
 const spec=createPcAgentOpenApiSpec();
 for(const [path,method] of [['connection','get'],['probe','post'],['pause','post']]){
  const op=spec.paths[`/email/${path}`][method];assert.deepEqual(op.security,[{bearerAuth:[]}]);assert.match(op.description,/administrator/);
  if(method==='post')assert.equal(op.requestBody.content['application/json'].schema.additionalProperties,false);
 }
});
