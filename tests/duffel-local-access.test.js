import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DuffelLocalAccessStore} from '../packages/core/src/personal-operations/duffel-local-access-store.js';
import {createConfiguredDuffelBroker} from '../packages/core/src/personal-operations/configured-duffel-broker.js';
import {setFixturePrivateAcl} from './fixtures/windows-private-acl.mjs';
import {DatabaseSync} from 'node:sqlite';

const spawn=async(name,args=[])=>{
 const child=fork(new URL('./fixtures/'+name,import.meta.url),args,{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
 const ready=await new Promise((r,j)=>{child.once('message',r);child.once('exit',()=>j(Error('fixture exited')));});
 return {child,ready,async stop(){if(child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.disconnect();await end;}}};
};
for(const confirmed of [false,true])test(`actual new Core PID preserves ${confirmed?'confirmed':'unconfirmed'} disconnect hold`,{timeout:30000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-duffel-hold-'));if(process.platform==='win32')setFixturePrivateAcl(root);
 const remote=await spawn('duffel-broker-process.mjs',confirmed?[join(root,'remote.sqlite')]:[]);t.after(()=>remote.stop());
 const pem=n=>fileURLToPath(new URL('./fixtures/google-broker-tls/'+n+'.pem',import.meta.url));
 const key=join(root,'key.pem'),metadata=join(root,'metadata.json'),config=join(root,'config.json');
 writeFileSync(key,readFileSync(pem('core-key')),{mode:0o600});
 const row={schemaVersion:1,connectionId:'process-duffel',revision:'revision-one'};writeFileSync(metadata,JSON.stringify(row));
 const env={JARVIS_CORE_DUFFEL_BROKER_URL:`https://127.0.0.1:${remote.ready.address.port}/v1/duffel/quote`,JARVIS_CORE_DUFFEL_BROKER_TLS_KEY:key,
  JARVIS_CORE_DUFFEL_BROKER_TLS_CERT:pem('core'),JARVIS_CORE_DUFFEL_BROKER_TLS_CA:pem('ca'),JARVIS_CORE_DUFFEL_BROKER_METADATA:metadata};
 writeFileSync(config,JSON.stringify(env));
 const observer=createConfiguredDuffelBroker({env});t.after(()=>observer.close());assert.equal(observer.status().credentialsConfigured,true);
 if(confirmed){
  const stopped=createConfiguredDuffelBroker({env}),lock=new DatabaseSync(join(root,'duffel-local-access.sqlite'));
  lock.exec('BEGIN IMMEDIATE');
  try{
   await assert.rejects(stopped.disconnect(),/LOCAL_ACCESS_STORE_UNAVAILABLE/);
   assert.equal(stopped.status().credentialsConfigured,false);assert.notEqual(stopped.status().localPausePersisted,true);
   const remoteDb=new DatabaseSync(join(root,'remote.sqlite'));
   assert.equal(remoteDb.prepare('SELECT COUNT(*) AS count FROM broker_certificate_revocations').get().count,0);remoteDb.close();
  }finally{lock.exec('ROLLBACK');lock.close();stopped.close();}
 }
 const first=await spawn('duffel-held-core.mjs',[config]);t.after(()=>first.stop());
 const call=(node,path,body)=>fetch(`http://127.0.0.1:${node.ready.port}${path}`,{method:body?'POST':'GET',headers:{authorization:'Bearer synthetic-hold-admin',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const disconnect=await call(first,'/travel/duffel/disconnect',{});assert.equal(disconnect.status,confirmed?200:409);
 assert.equal(observer.status().credentialsConfigured,false);assert.equal(observer.status().brokerAccessRevoked,confirmed);
 await assert.rejects(observer.offer('off_process'),/CONNECTION_CLOSED/);
 await first.stop();
 // Metadata refresh cannot clear an intent associated with the same certificate.
 writeFileSync(metadata,JSON.stringify({...row,revision:'changed-after-disconnect'}));
 const second=await spawn('duffel-held-core.mjs',[config]);t.after(()=>second.stop());assert.notEqual(first.ready.pid,second.ready.pid);
 const status=await (await call(second,'/travel/duffel/status')).json();assert.equal(status.credentialsConfigured,false);assert.equal(status.brokerAccessRevoked,confirmed);assert.equal(status.localPausePersisted,true);
 assert.equal((await call(second,'/travel/duffel/quote',{offerId:'off_process'})).status,409);
 assert.equal((await call(second,'/travel/duffel/disconnect',{})).status,409);
 const stats=await new Promise(r=>{remote.child.once('message',r);remote.child.send({action:'stats'});});assert.equal(stats.providerCalls,0);
 console.log(JSON.stringify({confirmed,firstCorePid:first.ready.pid,restartedCorePid:second.ready.pid,providerCalls:stats.providerCalls,metadataRefreshCannotResume:true}));
});
test('local intent is append-only across connections and corruption refuses startup',()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-duffel-hold-store-')),path=join(root,'holds.sqlite');
 const first=new DuffelLocalAccessStore(path),other=new DuffelLocalAccessStore(path);
 assert.equal(first.state('cert-one'),null);first.hold('cert-one');assert.equal(other.state('cert-one'),'pending');
 first.confirm('cert-one');other.hold('cert-one');assert.equal(other.state('cert-one'),'confirmed');assert.equal(other.state('cert-two'),null);
 first.close();other.close();const reopened=new DuffelLocalAccessStore(path);assert.equal(reopened.state('cert-one'),'confirmed');reopened.close();
 const bad=join(root,'bad.sqlite');writeFileSync(bad,'invalid database');assert.throws(()=>new DuffelLocalAccessStore(bad),/STORE_UNAVAILABLE/);
});
