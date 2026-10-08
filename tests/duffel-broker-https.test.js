import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {request as httpsRequest} from 'node:https';
import {createServer as httpsServer} from 'node:https';
import {writeFileSync} from 'node:fs';
import {createDuffelBrokerHttpsTransport} from '../packages/core/src/personal-operations/duffel-broker-https.js';
import {createDuffelBrokerQuoteClient} from '../packages/core/src/personal-operations/duffel-quote-broker.js';
import {startDuffelCredentialBroker} from '../packages/core/src/personal-operations/duffel-broker-host.js';

const pem=name=>readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url));
const input={connectionId:'process-duffel',expectedRevision:'revision-one',offerId:'off_process'};
test('read transport reconnects once for a reset pooled socket but never replays a partial response',async t=>{
  const seen=new WeakSet();let requests=0,reads=0,partial=false;
  const server=httpsServer({key:pem('server-key'),cert:pem('server'),ca:pem('ca'),requestCert:true,rejectUnauthorized:true},async(req,res)=>{
    requests++;for await(const bytes of req){}
    if(partial){res.writeHead(200,{'content-type':'application/json'});res.write('{');setImmediate(()=>res.destroy());return;}
    if(seen.has(req.socket)){req.socket.destroy();return;}
    seen.add(req.socket);reads++;res.setHeader('content-type','application/json');res.end(JSON.stringify({result:{read:true}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const transport=createDuffelBrokerHttpsTransport({url:`https://127.0.0.1:${server.address().port}/v1/duffel/quote`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});t.after(()=>transport.close());
  assert.deepEqual(await transport.execute(input),{read:true});assert.deepEqual(await transport.execute(input),{read:true});
  assert.equal(requests,3);assert.equal(reads,2);
  partial=true;const before=requests;
  await assert.rejects(transport.execute(input),/NETWORK/u);assert.equal(requests-before,1);
});
function message(child,type,action) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error('child message timeout')),10000);
    const onExit=()=>finish(new Error('child exited'));
    const onMessage=value=>{if(value.type===type)finish(null,value);};
    function finish(error,value){clearTimeout(timer);child.off('exit',onExit);child.off('message',onMessage);error?reject(error):resolve(value);}
    child.once('exit',onExit);child.on('message',onMessage);
    if(action)child.send({action});
  });
}
async function fixture(t,revocationPath) {
  const child=fork(new URL('./fixtures/duffel-broker-process.mjs',import.meta.url),revocationPath?[revocationPath]:[],
    {env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let logs='';child.stdout.on('data',bytes=>{logs+=bytes;});child.stderr.on('data',bytes=>{logs+=bytes;});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.disconnect();await exited;}
    assert.doesNotMatch(logs,/duffel_test_process_/u);
  });
  const ready=await message(child,'ready');
  const url=`https://127.0.0.1:${ready.address.port}/v1/duffel/quote`;
  const transport=createDuffelBrokerHttpsTransport({url,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
  t.after(()=>transport.close());
  return {child,ready,url,transport};
}

test('different PID broker returns a scoped test quote over actual mTLS without sending provider key to Core',async t=>{
  const f=await fixture(t);
  assert.notEqual(f.ready.pid,process.pid);
  const client=createDuffelBrokerQuoteClient({connectionMetadata:()=>f.ready.metadata,execute:f.transport.execute});
  const result=await client.offer('off_process');
  assert.equal(result.offerTotalMinor,45000);
  assert.equal(result.allInTotalVerified,false);
  assert.equal(result.bookingAvailable,false);
  assert.doesNotMatch(JSON.stringify({metadata:f.ready.metadata,result}),/duffel_test_/u);
  assert.deepEqual(await message(f.child,'stats','stats'),{type:'stats',credentialReads:1,providerCalls:1});
  const evidence={observedAt:new Date().toISOString(),corePid:process.pid,brokerPid:f.ready.pid,transport:'actual-loopback-mTLS-TLS1.3',
    providerResponse:'synthetic',credentialStorage:'child-process-memory-fixture',priceMinor:45000,currency:'KRW',
    keyReturnedToCore:false,actualProviderCalls:0,externalWrites:0,bookingAvailable:false,
    differentOsIdentityVerified:false,productionDeployment:false};
  console.log(JSON.stringify({duffelMtlsEvidence:evidence}));
  if(process.env.JARVIS_DUFFEL_MTLS_EVIDENCE_PATH)writeFileSync(process.env.JARVIS_DUFFEL_MTLS_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
});

test('missing certificate, unlisted CA-valid client and wrong connection do not read a key',async t=>{
  const f=await fixture(t);
  await assert.rejects(new Promise((resolve,reject)=>{
    const req=httpsRequest(f.url,{method:'POST',ca:pem('ca'),minVersion:'TLSv1.3'},resolve);req.on('error',reject);req.end('{}');
  }));
  const other=createDuffelBrokerHttpsTransport({url:f.url,key:pem('other-key'),cert:pem('other'),ca:pem('ca')});
  t.after(()=>other.close());
  await assert.rejects(other.execute(input),/A_DUFFEL_BROKER_CLIENT_DENIED/);
  await assert.rejects(f.transport.execute({...input,connectionId:'other-account'}),/A_DUFFEL_BROKER_CLIENT_DENIED/);
  assert.equal((await message(f.child,'stats','stats')).credentialReads,0);
});

test('unsupported URL/header/operation crosses mTLS as a safe failure before secret access',async t=>{
  const f=await fixture(t);
  for(const patch of [{url:'https://example.test'},{method:'POST'},{headers:{authorization:'bad'}}])
    await assert.rejects(f.transport.execute({...input,...patch}),/A_DUFFEL_REQUEST_INVALID/);
  assert.equal((await message(f.child,'stats','stats')).credentialReads,0);
  await message(f.child,'revoked-connection','revoke-connection');
  await assert.rejects(f.transport.execute(input),/A_DUFFEL_CONNECTION_REQUIRED/);
  assert.equal((await message(f.child,'stats','stats')).providerCalls,0);
});

test('plaintext and Google protocol overrides are rejected without a fallback',async t=>{
  const f=await fixture(t);
  const tls={key:pem('core-key'),cert:pem('core'),ca:pem('ca')};
  assert.throws(()=>createDuffelBrokerHttpsTransport({...tls,url:f.url.replace('https:','http:')}),/A_DUFFEL_BROKER_TLS_CONFIG_INVALID/);
  assert.throws(()=>createDuffelBrokerHttpsTransport({...tls,url:f.url.replace('/v1/duffel/quote','/v1/google/read'),family:'google'}),/A_DUFFEL_BROKER_TLS_CONFIG_INVALID/);
  await assert.rejects(f.transport.execute({...input,padding:'x'.repeat(8192)}),/A_DUFFEL_BROKER_REQUEST_TOO_LARGE/);
  assert.equal((await message(f.child,'stats','stats')).providerCalls,0);
});

test('host never opens an unrestricted address or guesses a vault configuration',async()=>{
  await assert.rejects(startDuffelCredentialBroker({host:'0.0.0.0'}),/A_DUFFEL_BROKER_LISTEN_CONFIG_INVALID/);
  await assert.rejects(startDuffelCredentialBroker({}),/Trusted registry and vault required/);
});

test('certificate revocation survives actual broker restart and blocks an existing keepalive connection',async t=>{
  const root=mkdtempSync(join(tmpdir(),'jarvis-duffel-revocation-')),path=join(root,'revocations.sqlite');
  const first=await fixture(t,path);
  await first.transport.execute(input);
  await message(first.child,'revoked-client','revoke-client');
  await assert.rejects(first.transport.execute(input),/A_DUFFEL_BROKER_CLIENT_DENIED/);
  const exited=new Promise(resolve=>first.child.once('exit',resolve));first.child.disconnect();await exited;
  const second=await fixture(t,path);
  await assert.rejects(second.transport.execute(input),/A_DUFFEL_BROKER_CLIENT_DENIED/);
  assert.equal((await message(second.child,'stats','stats')).credentialReads,0);
  t.after(()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
});
