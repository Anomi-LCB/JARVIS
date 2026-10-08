import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,unlinkSync,readdirSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {saveDuffelTestCredential} from '../packages/core/src/personal-operations/duffel-credential-setup.js';
import {createDuffelBrokerHttpsTransport} from '../packages/core/src/personal-operations/duffel-broker-https.js';
import {setFixturePrivateAcl} from './fixtures/windows-private-acl.mjs';

test('actual Windows DPAPI stores a test key outside Core; different PID broker reopens it and deletion stops reads',{skip:process.platform!=='win32'},async t=>{
  const root=mkdtempSync(join(tmpdir(),'jarvis-duffel-dpapi-'));setFixturePrivateAcl(root);
  const vaultPath=join(root,'vault.json'),metadataPath=join(root,'metadata.json'),secret='duffel_test_process_synthetic_private_key';
  const args={apiKey:secret,vaultPath,metadataPath,readConsent:true,clock:()=>new Date('2026-10-04T00:00:00Z')};
  assert.throws(()=>saveDuffelTestCredential({...args,readConsent:false}),/READ_CONSENT_REQUIRED/u);
  assert.throws(()=>saveDuffelTestCredential({...args,apiKey:'duffel_live_not_allowed'}),/TEST_KEY_REQUIRED/u);
  assert.throws(()=>saveDuffelTestCredential({...args,metadataPath:vaultPath.toUpperCase()}),/PATHS_INVALID/u);
  const saved=saveDuffelTestCredential(args);
  assert.equal(saved.providerVerified,false);assert.equal(saved.executionAuthorized,false);
  assert.doesNotMatch(readFileSync(vaultPath,'utf8'),/duffel_test_|apiKey/u);
  assert.deepEqual(JSON.parse(readFileSync(metadataPath)),saved.metadata);
  const before=readFileSync(vaultPath);assert.throws(()=>saveDuffelTestCredential(args),/REVISION_CONFLICT/u);
  assert.deepEqual(readFileSync(vaultPath),before);
  const children=[],transports=[];
  t.after(async()=>{
    for(const transport of transports)transport.close();
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const done=new Promise(r=>child.once('exit',r));child.disconnect();await done;}
    for(const name of readdirSync(root))unlinkSync(join(root,name));rmdirSync(root);
  });
  const pem=n=>readFileSync(new URL(`./fixtures/google-broker-tls/${n}.pem`,import.meta.url));
  function message(child,type,action){return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>end(Error('fixture timeout')),30000);
    const exited=()=>end(Error('fixture exit')),received=v=>{if(v.type===type)end(null,v);};
    function end(error,value){clearTimeout(timer);child.off('exit',exited);child.off('message',received);error?reject(error):resolve(value);}
    child.on('message',received);child.once('exit',exited);if(action)child.send({action});
  });}
  async function start(){
    const child=fork(new URL('./fixtures/duffel-broker-process.mjs',import.meta.url),['',vaultPath],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});children.push(child);
    let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);t.after(()=>assert.doesNotMatch(logs,/duffel_test_/u));
    const ready=await message(child,'ready');assert.notEqual(ready.pid,process.pid);
    const transport=createDuffelBrokerHttpsTransport({url:`https://127.0.0.1:${ready.address.port}/v1/duffel/quote`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});transports.push(transport);
    const request={connectionId:saved.metadata.connectionId,expectedRevision:saved.metadata.revision,offerId:'off_process'};
    return {child,ready,transport,request};
  }
  const first=await start();assert.equal((await first.transport.execute(first.request)).offerTotalMinor,45000);
  const stopped=new Promise(r=>first.child.once('exit',r));first.child.disconnect();await stopped;first.transport.close();
  const second=await start();assert.equal((await second.transport.execute(second.request)).offerTotalMinor,45000);
  assert.deepEqual(readFileSync(vaultPath),before,'read and process restart do not rewrite the vault');
  await message(second.child,'revoked-connection','revoke-connection');
  await assert.rejects(second.transport.execute(second.request),/CONNECTION_REQUIRED/u);
  assert.equal((await message(second.child,'stats','stats')).providerCalls,1);
  console.log(JSON.stringify({observedAt:new Date().toISOString(),corePid:process.pid,brokerPids:[first.ready.pid,second.ready.pid],storage:'actual-Windows-DPAPI',provider:'synthetic',keyReturnedToCore:false,externalWrites:0}));
});
