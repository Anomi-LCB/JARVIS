import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {request} from 'node:https';
import {createCredentialBrokerHttpsServer,createCredentialBrokerHttpsTransport} from '../packages/core/src/personal-operations/google-broker-https.js';
import {BrokerRevocationStore} from '../packages/core/src/personal-operations/broker-revocation-store.js';
const pem=name=>readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url));
const peer=new X509Certificate(pem('core')).fingerprint256;

for(const family of ['google','duffel']){
const createGoogleBrokerHttpsServer=options=>createCredentialBrokerHttpsServer({...options,family});
const createGoogleBrokerHttpsTransport=options=>createCredentialBrokerHttpsTransport({...options,family,url:options.url.replace('/v1/google/read',family==='google'?'/v1/google/read':'/v1/duffel/quote')});
test(`${family}: actual mTLS self-disconnect commits revocation and restarted broker denies before provider access`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'broker-self-')),path=join(root,'revocations.sqlite');let reads=0,server,store,transport;
 async function start(){store=new BrokerRevocationStore({path});const host=createGoogleBrokerHttpsServer({broker:{execute:async()=>{reads++;return 'synthetic-account';}},key:pem('server-key'),cert:pem('server'),ca:pem('ca'),allowedClientFingerprints:[peer],clientConnectionScopes:{[peer.replaceAll(':','')]:['self-account']},revocationStore:store});server=host.server;await new Promise(r=>server.listen(0,'127.0.0.1',r));transport=createGoogleBrokerHttpsTransport({url:`https://127.0.0.1:${server.address().port}/v1/google/read`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});}
 async function close(){transport?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));store?.close();}
 try{
  await start();assert.equal(await transport.execute({connectionId:'self-account'}),'synthetic-account');
  const denied=await new Promise((resolve,reject)=>{const req=request(`https://127.0.0.1:${server.address().port}/v1/${family}/disconnect`,{method:'POST',key:pem('core-key'),cert:pem('core'),ca:pem('ca'),headers:{'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({fingerprint:'another-client'}));});assert.equal(denied,400);assert.equal(store.isRevoked(peer),false);
  await assert.rejects(()=>transport.execute({fingerprint:'another-client'},{revokeSelf:true}),/REQUEST_INVALID/);
  const receipt=await transport.execute({},{revokeSelf:true});assert.deepEqual(receipt,{brokerAccessRevoked:true,credentialsDeleted:false,providerGrantRevoked:false});assert.equal(store.isRevoked(peer),true);
  await assert.rejects(()=>transport.execute({connectionId:'self-account'}),/CLIENT_DENIED/);await close();server=null;store=null;await start();
  await assert.rejects(()=>transport.execute({connectionId:'self-account'}),/CLIENT_DENIED/);assert.equal(reads,1);
 }finally{await close();rmSync(root,{recursive:true,force:true});}
});

test(`${family}: without a durable revocation store self-disconnect never acknowledges success`,async()=>{
 const {server}=createGoogleBrokerHttpsServer({broker:{execute:async()=> 'read'},key:pem('server-key'),cert:pem('server'),ca:pem('ca'),allowedClientFingerprints:[peer],clientConnectionScopes:{[peer.replaceAll(':','')]:['self-account']}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const transport=createGoogleBrokerHttpsTransport({url:`https://127.0.0.1:${server.address().port}/v1/google/read`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
 try{await assert.rejects(()=>transport.execute({},{revokeSelf:true}),/OPERATION_FAILED/);assert.equal(await transport.execute({connectionId:'self-account'}),'read');}finally{transport.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
}
