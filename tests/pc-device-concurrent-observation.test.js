import test from 'node:test';
import assert from 'node:assert/strict';
import {createPcAgentServer,PcAgentApiGuard} from '../apps/pc-agent/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

for(const revoke of [false,true])test(`concurrent device readers share one in-flight probe; revoked=${revoke}`,async t=>{
 const entered=deferred(),release=deferred();let requests=0,calls=0;
 const guard=new PcAgentApiGuard({apiToken:'fixture-admin',executionToken:'fixture-executor'});
 const original=guard.check.bind(guard);
 guard.check=(...args)=>{const result=original(...args);if(result.allowed&&++requests===3)entered.resolve();return result;};
 const server=createPcAgentServer({}, {apiGuard:guard,deviceObserver:async()=>{
  calls++;await release.promise;return {observationId:`probe-${calls}`,executionAuthority:false};
 }});
 const address=await listenOnFetchSafePort(server),url=`http://127.0.0.1:${address.port}/diagnostics/device`;
 t.after(async()=>{release.resolve();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const headers={authorization:'Bearer fixture-admin'};
 const responses=Promise.all([fetch(url,{headers}),fetch(url,{headers}),fetch(url,{headers})]);
 await entered.promise;
 const simultaneousCalls=calls;
 if(revoke)guard.tokenStore.verify=()=>false;
 release.resolve();
 const results=await responses;
 assert.equal(simultaneousCalls,1,'do not start a PowerShell process for every simultaneous reader');
 for(const response of results){
  assert.equal(response.status,revoke?401:200);
  const value=await response.json();assert.equal(value.observationId,revoke?undefined:'probe-1');
 }
 if(!revoke){const next=await fetch(url,{headers});assert.equal(next.status,200);assert.equal((await next.json()).observationId,'probe-2');assert.equal(calls,2,'completed observations must not be cached');}
});

test('rejected probe does not poison the next authenticated observation',async t=>{
 let calls=0;
 const server=createPcAgentServer({}, {apiGuard:new PcAgentApiGuard({apiToken:'fixture-admin'}),deviceObserver:async()=>{
  if(++calls===1)throw new Error('probe failed');return {observationId:'recovered',executionAuthority:false};
 }});
 const address=await listenOnFetchSafePort(server),url=`http://127.0.0.1:${address.port}/diagnostics/device`,headers={authorization:'Bearer fixture-admin'};
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 assert.equal((await fetch(url,{headers})).status,500);
 const response=await fetch(url,{headers});assert.equal(response.status,200);assert.equal((await response.json()).observationId,'recovered');assert.equal(calls,2);
});
