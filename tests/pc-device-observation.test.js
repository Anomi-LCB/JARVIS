import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observePcDevice} from '../apps/pc-agent/src/device-observation.js';
import {createPcAgentServer,PcAgentApiGuard,createPcAgentOpenApiSpec} from '../apps/pc-agent/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';

test('model and elevation come from bounded fixed OS query, never identifiers or execution permission',async()=>{
 const value=await observePcDevice({hostPlatform:'win32',run:async(command,args,options)=>{
  assert.equal(command,'powershell.exe');assert.equal(options.windowsHide,true);assert.equal(options.timeout,10000);
  assert.ok(!args.at(-1).includes('SerialNumber'));assert.ok(!args.at(-1).includes('UserName'));
  return {stdout:JSON.stringify({manufacturer:'Fixture maker',model:'Fixture PC',elevatedToken:false})};
 }});
 assert.equal(value.hardware.model,'Fixture PC');assert.equal(value.permissions.elevatedToken,false);
 assert.equal(value.executionAuthority,false);assert.equal(value.nodeIdentityVerified,false);assert.equal(value.connection.status,'not-evaluated');
 assert.ok(Number.isFinite(Date.parse(value.observedAt)));
});
for(const mode of ['unavailable','malformed','unexpected-field'])test(`OS probe ${mode} stays unknown without false capability`,async()=>{
 const value=await observePcDevice({hostPlatform:'win32',run:async()=>{
  if(mode==='unavailable')throw new Error('private-account-secret');
  return {stdout:mode==='malformed'?'invalid':JSON.stringify({manufacturer:'Fixture',model:'PC',elevatedToken:true,serial:'private-account-secret'})};
 }});
 assert.equal(value.probeStatus,'unavailable');assert.equal(value.hardware,null);assert.equal(value.permissions.elevatedToken,null);assert.ok(!JSON.stringify(value).includes('private-account-secret'));
});
test('non-Windows OS is honestly observed without pretending to probe Windows hardware',async()=>{
 const value=await observePcDevice({hostPlatform:'linux',run:()=>{throw new Error('must not run');}});
 assert.equal(value.probeStatus,'unsupported-platform');assert.equal(value.hardware,null);assert.equal(value.permissions.elevatedToken,null);
});
test('actual PC HTTP diagnostic authenticates before probe and rechecks after token changes',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-device-api-'));let calls=0,armed=false;
 const guard=new PcAgentApiGuard({apiToken:'fixture-admin',executionToken:'fixture-executor'});
 const server=createPcAgentServer({}, {apiGuard:guard,deviceObserver:async()=>{calls++;if(armed)guard.tokenStore.verify=()=>false;return observePcDevice({hostPlatform:'linux'});}});
 const address=await listenOnFetchSafePort(server),url=`http://127.0.0.1:${address.port}/diagnostics/device`;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});});
 assert.equal((await fetch(url)).status,401);assert.equal(calls,0);
 assert.equal((await fetch(url,{headers:{authorization:'Bearer fixture-executor'}})).status,401);assert.equal(calls,0);
 const headers={authorization:'Bearer fixture-admin'};
 assert.equal((await fetch(url+'?model=pretend',{headers})).status,400);assert.equal((await fetch(url,{headers,method:'POST'})).status,405);assert.equal(calls,0);
 const response=await fetch(url,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const value=await response.json();assert.equal(value.connection.status,'authenticated-local-diagnostics');assert.equal(value.connection.executionReady,false);assert.equal(calls,1);
 armed=true;const denied=await fetch(url,{headers});assert.equal(denied.status,401);assert.equal((await denied.json()).observationId,undefined);assert.equal(calls,2);
 assert.ok(createPcAgentOpenApiSpec().paths['/diagnostics/device'].get.security);
});
