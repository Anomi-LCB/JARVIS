import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createConfiguredDuffelBroker} from '../packages/core/src/personal-operations/configured-duffel-broker.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {setFixturePrivateAcl} from './fixtures/windows-private-acl.mjs';
import {renderTravelConnection} from '../src/ui/connections/travel.js';
import {escape} from '../src/ui/connections/connection-center.js';

test('product Core HTTP calls a distinct credential broker PID; auth, input and metadata changes prevent dispatch',async t=>{
  const child=fork(new URL('./fixtures/duffel-broker-process.mjs',import.meta.url),[],
    {env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const ended=new Promise(r=>child.once('exit',r));child.disconnect();await ended;}});
  const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('broker timeout')),10000);child.once('message',v=>{clearTimeout(timer);resolve(v);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('broker exit'));});});
  const root=mkdtempSync(join(tmpdir(),'jarvis-duffel-product-'));
  const key=join(root,'core-key.pem'),metadata=join(root,'metadata.json');
  const pem=name=>fileURLToPath(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url));
  writeFileSync(key,readFileSync(pem('core-key')),{mode:0o600});
  if(process.platform==='win32'){setFixturePrivateAcl(root);setFixturePrivateAcl(key);}
  const data={schemaVersion:1,connectionId:'process-duffel',revision:'revision-one'};
  writeFileSync(metadata,JSON.stringify(data));
  const env={JARVIS_CORE_DUFFEL_BROKER_URL:`https://127.0.0.1:${ready.address.port}/v1/duffel/quote`,
    JARVIS_CORE_DUFFEL_BROKER_TLS_KEY:key,JARVIS_CORE_DUFFEL_BROKER_TLS_CERT:pem('core'),
    JARVIS_CORE_DUFFEL_BROKER_TLS_CA:pem('ca'),JARVIS_CORE_DUFFEL_BROKER_METADATA:metadata};
  let now=new Date('2026-10-03T00:00:00Z');
  const broker=createConfiguredDuffelBroker({env,clock:()=>now});t.after(()=>broker.close());
  const server=createCoreServer(undefined,{adminToken:'synthetic-duffel-product-admin',duffelBroker:broker});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const url=`http://127.0.0.1:${server.address().port}`;
  const call=(path,body,auth=true)=>fetch(url+path,{method:body?'POST':'GET',headers:{...(auth?{authorization:'Bearer synthetic-duffel-product-admin'}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await call('/travel/duffel/status',null,false)).status,401);
  assert.equal((await call('/travel/duffel/quote',{offerId:'off_process',apiKey:'never-send'})).status,400);
  const before=await (await call('/travel/duffel/status')).json();assert.equal(before.credentialsConfigured,true);assert.equal(before.providerVerified,false);
  const response=await call('/travel/duffel/quote',{offerId:'off_process'});assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.quote.offerTotalMinor,45000);assert.equal(result.executionAuthority,false);
  assert.doesNotMatch(JSON.stringify(result),/duffel_test_/u);assert.notEqual(ready.pid,process.pid);
  now=new Date('2026-10-03T00:30:00Z');
  const expired=await call('/travel/duffel/quote',{offerId:'off_process'});assert.equal(expired.status,409);
  assert.equal((await expired.json()).error.code,'A_DUFFEL_OFFER_EXPIRED');now=new Date('2026-10-03T00:00:00Z');
  writeFileSync(metadata,JSON.stringify({...data,revision:'changed'}));
  assert.equal((await call('/travel/duffel/quote',{offerId:'off_process'})).status,409);
  writeFileSync(metadata,'{}');assert.equal((await (await call('/travel/duffel/status')).json()).reason,'metadata-invalid');
  assert.equal((await call('/travel/duffel/quote',{offerId:'off_process'})).status,409);
  console.log(JSON.stringify({corePid:process.pid,brokerPid:ready.pid,priceMinor:45000,transport:'Core HTTP to mTLS child',provider:'synthetic',externalWrites:0}));
});
test('no implicit activation and no misleading UI when account or broker is missing',()=>{
  assert.equal(createConfiguredDuffelBroker({env:{}}),null);
  assert.throws(()=>createConfiguredDuffelBroker({env:{JARVIS_CORE_DUFFEL_BROKER_URL:'http://example.com'}}),/CONFIG_INCOMPLETE/u);
  const html=renderTravelConnection({reason:'broker-not-configured'},null,{escape,enabled:true});
  assert.match(html,/disabled/u);assert.match(html,/보호 연결 설정 도우미는 아직 준비 중/u);
  const result=renderTravelConnection({credentialsConfigured:true,reason:'provider-call-unverified'},{offerId:'<script>bad</script>',offerTotalAmount:'45000',currency:'KRW',expiresAt:'2026-10-04'},{escape,enabled:true});
  assert.doesNotMatch(result,/<script>/u);assert.match(result,/최종 총액은 미검증/u);
});
