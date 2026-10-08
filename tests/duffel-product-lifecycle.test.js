import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync,spawn,fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createServer,connect} from 'node:net';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {setFixturePrivateAcl} from './fixtures/windows-private-acl.mjs';
import {saveDuffelTestCredential} from '../packages/core/src/personal-operations/duffel-credential-setup.js';
import {productServiceDefinitions,startConnectedProductRuntime,createServiceEnvironment} from '../scripts/product-runtime.mjs';

async function port(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const value=server.address().port;await new Promise(r=>server.close(r));return value;}
async function reachable(port){return new Promise(resolve=>{const socket=connect({host:'127.0.0.1',port});socket.setTimeout(300);socket.once('connect',()=>{socket.destroy();resolve(true);});for(const event of ['error','timeout'])socket.once(event,()=>{socket.destroy();resolve(false);});});}
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-duffel-product-lifecycle-'));setFixturePrivateAcl(root);
 const generated=spawnSync('python',[fileURLToPath(new URL('./fixtures/ephemeral-broker-certificates.py',import.meta.url)),root],{windowsHide:true,encoding:'utf8',timeout:10000});assert.equal(generated.status,0,generated.stderr);
 return root;
}
async function profile(root){
 const path=join(root,'profile.json'),vault=join(root,'vault.json'),metadata=join(root,'metadata.json'),listen=await port();
 saveDuffelTestCredential({apiKey:'duffel_test_product_lifecycle_only',readConsent:true,vaultPath:vault,metadataPath:metadata});
 writeFileSync(path,JSON.stringify({schemaVersion:1,port:listen,vault,metadata,revocations:join(root,'revocations.sqlite'),serverTls:{key:join(root,'TLS_KEY'),cert:join(root,'TLS_CERT'),ca:join(root,'TLS_CA')},coreTls:{key:join(root,'CLIENT_KEY'),cert:join(root,'CLIENT_CERT'),ca:join(root,'TLS_CA')}}));
 return {path,listen,vault};
}
test('broker prerequisite failure prevents product service startup',async()=>{
 let spawns=0;
 await assert.rejects(startConnectedProductRuntime({env:{JARVIS_DUFFEL_CONNECTION_PROFILE:'relative-invalid'},definitions:[],spawnImpl:()=>{spawns++;throw new Error('unexpected service start');}}),/PROFILE_INVALID/);
 assert.equal(spawns,0);
});
test('actual Core/PC/bridge/UI services start after configured mTLS broker and close before it',{skip:process.platform!=='win32',timeout:90000},async t=>{
 const root=fixture(t),p=await profile(root),workspace=join(root,'workspace');mkdirSync(workspace);
 const ports=await Promise.all(Array.from({length:4},()=>port()));assert.equal(new Set(ports).size,4);
 const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:root,TMP:root,USERPROFILE:root,LOCALAPPDATA:root,APPDATA:root,
 JARVIS_TEST_MODE:'1',JARVIS_TEST_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_AUDIT_ROOT:join(root,'audit/core'),JARVIS_AUDIT_ROOT:join(root,'audit/pc'),JARVIS_TRUST_ROOT:join(root,'trust'),
 JARVIS_BRIDGE_STATE_DIR:join(root,'bridge'),JARVIS_BRIDGE_REAL_EXECUTION:'0',JARVIS_BRIDGE_OPEN_OUTPUTS:'0',JARVIS_BROWSER_DRIVER:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',
 JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_DUFFEL_CONNECTION_PROFILE:p.path,JARVIS_ALLOWED_ROOTS:workspace,
 JARVIS_UNDO_JOURNAL:join(root,'audit/undo.jsonl'),JARVIS_ROLLBACK_TRANSACTIONS:join(root,'audit/rollback.jsonl'),JARVIS_PACKET_JOURNAL:join(root,'audit/packets.jsonl'),JARVIS_PACKET_QUEUE:join(root,'audit/queue.json'),JARVIS_TOKEN_VAULT:join(root,'audit/vault.json'),
 JARVIS_CORE_PORT:String(ports[0]),JARVIS_PC_AGENT_PORT:String(ports[1]),JARVIS_BRIDGE_PORT:String(ports[2]),JARVIS_UI_PORT:String(ports[3])};
 const definitions=productServiceDefinitions({env});let runtime;const children=[];const events=[];
 t.after(async()=>{await runtime?.stop();for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\'));rmSync(root,{recursive:true,force:true});});
 runtime=await startConnectedProductRuntime({env,definitions,monitorIntervalMs:1000,startupTimeoutMs:30000,
 spawnImpl:(command,args,options)=>{events.push({type:'service-start'});const child=spawn(command,args,{...options,env:createServiceEnvironment(definitions.find(d=>d.args[0]===args[0]),env)});children.push(child);child.once('exit',()=>events.push({type:'service-exit',pid:child.pid,brokerState:runtime?.connections().duffel.status}));return child;},logger:{log(message){if(String(message).includes('Duffel broker transport ready'))events.push({type:'broker-ready'});},error(){},warn(){}}});
 assert.equal(runtime.services().length,4);assert.ok(runtime.services().every(s=>s.status==='started'),JSON.stringify(runtime.services()));
 assert.equal(events[0].type,'broker-ready');
 assert.equal(runtime.connections().duffel.status,'ready');assert.equal(await reachable(p.listen),true);
 const response=await fetch(`http://127.0.0.1:${ports[3]}/api/core/travel/duffel/status`);assert.equal(response.status,200);const status=await response.json();assert.equal(status.credentialsConfigured,true);assert.equal(status.providerVerified,false);
 assert.equal((await fetch(runtime.uiUrl)).status,200);
 const vaultBefore=readFileSync(p.vault);await Promise.all([runtime.stop(),runtime.stop()]);assert.equal(runtime.connections().duffel.status,'stopped');
 for(const value of [...ports,p.listen])assert.equal(await reachable(value),false);assert.deepEqual(readFileSync(p.vault),vaultBefore);
 assert.equal(events.filter(e=>e.type==='service-start').length,4);assert.equal(events.filter(e=>e.type==='service-exit').length,4);
 assert.ok(events.filter(e=>e.type==='service-exit').every(e=>e.brokerState==='ready'));
 console.log(JSON.stringify({observedAt:new Date().toISOString(),services:'actual Core/PC/bridge/UI',configuredBroker:'separate PID/ephemeral PKI',allEndpointsClosed:true,providerCalls:0,externalWrites:0}));
});
test('actual owner process exit disconnects IPC and closes the configured broker',{skip:process.platform!=='win32',timeout:60000},async t=>{
 const root=fixture(t),p=await profile(root);let brokerPid;
 const owner=fork(new URL('./fixtures/duffel-owner-exit.mjs',import.meta.url),[],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,USERPROFILE:process.env.USERPROFILE,JARVIS_DUFFEL_CONNECTION_PROFILE:p.path},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
 t.after(async()=>{if(owner.exitCode===null&&owner.signalCode===null){const exited=once(owner,'exit');owner.kill();await exited;}if(brokerPid&&await reachable(p.listen))try{process.kill(brokerPid);await delay(300);}catch{}assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\'));rmSync(root,{recursive:true,force:true});});
 const message=await Promise.race([once(owner,'message').then(([v])=>v),once(owner,'exit').then(()=>{throw new Error('owner startup failed');})]);assert.equal(message.type,'ready');brokerPid=message.pid;assert.notEqual(brokerPid,owner.pid);
 assert.equal(await reachable(p.listen),true);const exited=once(owner,'exit');owner.send({type:'exit-owner'});await exited;
 const deadline=Date.now()+5000;while(await reachable(p.listen)&&Date.now()<deadline)await delay(50);assert.equal(await reachable(p.listen),false);
 console.log(JSON.stringify({observedAt:new Date().toISOString(),ownerExit:'actual process.exit',brokerPortClosed:true,providerCalls:0}));
});
