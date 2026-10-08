import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {createDuffelBrokerProcess,duffelChildEnvironment} from '../scripts/duffel-broker-process.mjs';
import {setFixturePrivateAcl} from './fixtures/windows-private-acl.mjs';
import {saveDuffelTestCredential} from '../packages/core/src/personal-operations/duffel-credential-setup.js';
import {createConfiguredDuffelBroker} from '../packages/core/src/personal-operations/configured-duffel-broker.js';

test('child environment strips model/provider secrets and Node injection settings',()=>{
 const env=duffelChildEnvironment({PATH:'os',SystemRoot:'os',JARVIS_DUFFEL_CONNECTION_PROFILE:'profile',OPENAI_API_KEY:'secret',DUFFEL_API_KEY:'secret',NODE_OPTIONS:'--import evil',JARVIS_CORE_ADMIN_TOKEN:'secret'});
 assert.deepEqual(Object.keys(env).sort(),['JARVIS_DUFFEL_CONNECTION_PROFILE','PATH','SystemRoot'].sort());
 assert.throws(()=>createDuffelBrokerProcess({env:{}}),/PROFILE_REQUIRED/);
});
test('fixed production child starts with mTLS, closes, restarts and rejects occupied port without adopting it',{skip:process.platform!=='win32',timeout:90000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-duffel-process-'));setFixturePrivateAcl(root);
 let manager,core,occupied;
 t.after(async()=>{core?.close();await manager?.stop();if(occupied?.listening)await new Promise(r=>occupied.close(r));for(const name of readdirSync(root))unlinkSync(join(root,name));rmdirSync(root);});
 const result=spawnSync('python',[fileURLToPath(new URL('./fixtures/ephemeral-broker-certificates.py',import.meta.url)),root],{windowsHide:true,encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);
 const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const profile=join(root,'profile.json'),vault=join(root,'vault.json'),metadata=join(root,'metadata.json');
 saveDuffelTestCredential({apiKey:'duffel_test_process_evaluation_only',readConsent:true,vaultPath:vault,metadataPath:metadata});
 const bytes=readFileSync(vault);
 writeFileSync(profile,JSON.stringify({schemaVersion:1,port,vault,metadata,revocations:join(root,'revocations.sqlite'),
 serverTls:{key:join(root,'TLS_KEY'),cert:join(root,'TLS_CERT'),ca:join(root,'TLS_CA')},
 coreTls:{key:join(root,'CLIENT_KEY'),cert:join(root,'CLIENT_CERT'),ca:join(root,'TLS_CA')}}));
 const env={...process.env,JARVIS_DUFFEL_CONNECTION_PROFILE:profile};manager=createDuffelBrokerProcess({env});
 const [first,coalesced]=await Promise.all([manager.start(),manager.start()]);assert.equal(first.pid,coalesced.pid);assert.notEqual(first.pid,process.pid);assert.equal(first.status,'ready');
 core=createConfiguredDuffelBroker({env});assert.equal(core.status().credentialsConfigured,true);assert.equal(core.status().providerVerified,false);core.close();
 await Promise.all([manager.stop(),manager.stop()]);assert.equal(manager.snapshot().status,'stopped');
 const second=await manager.start();assert.notEqual(first.pid,second.pid);
 // Unexpected child death must clear readiness; restart is explicit, never retry a provider action.
 process.kill(second.pid);await new Promise(r=>setTimeout(r,300));assert.equal(manager.snapshot().status,'failed');
 const third=await manager.start();assert.equal(third.status,'ready');await manager.stop();
 occupied=createServer();await new Promise(r=>occupied.listen(port,'127.0.0.1',r));
 await assert.rejects(manager.start(),/START_FAILED/);assert.equal(occupied.listening,true);assert.equal(manager.snapshot().pid,null);
 assert.deepEqual(readFileSync(vault),bytes);
 console.log(JSON.stringify({observedAt:new Date().toISOString(),process:'actual separate configured broker',tls:'ephemeral evaluation PKI',storage:'Windows DPAPI',providerCalls:0,externalWrites:0,explicitRestart:true,occupiedPortPreserved:true}));
});
