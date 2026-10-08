import test from 'node:test';
import assert from 'node:assert/strict';
import {createArtemisClient} from '../apps/pc-agent/src/adapters/android-artemis/artemis-client.js';
import {NativeDocumentActionAdapter} from '../apps/mobile/src/mobile-runtime.js';
import {officialDocumentViewUri} from '../apps/mobile/src/api/android-official-intents.js';
test('Play configuration denies ARTEMIS transport before contacting any device server',async()=>{
 let calls=0;const client=createArtemisClient({distributionChannel:'play-store',baseUrl:'http://127.0.0.1:8000',fetchImpl:async()=>{calls++;throw new Error('must not call');}});
 assert.equal(client.configured,false);
 await assert.rejects(client.request('/api/devices'),e=>e.code==='B_ARTEMIS_DISTRIBUTION_DENIED');
 assert.throws(()=>{client.distributionChannel='private-lab';},TypeError);
 await assert.rejects(client.listDevices(),e=>e.code==='B_ARTEMIS_DISTRIBUTION_DENIED');assert.equal(calls,0);
});
test('private laboratory keeps its explicit transport and invalid channel cannot silently downgrade',async()=>{
 let calls=0;const client=createArtemisClient({distributionChannel:'private-lab',baseUrl:'http://127.0.0.1:8000',fetchImpl:async()=>{calls++;return new Response(JSON.stringify({devices:[]}),{headers:{'content-type':'application/json'}});}});
 assert.deepEqual(await client.listDevices(),[]);assert.equal(calls,1);
 for(const distributionChannel of ['public','PLAY','',null])assert.throws(()=>createArtemisClient({distributionChannel}),e=>e.code==='B_ARTEMIS_CONFIG_INVALID');
});
test('official document viewing path cannot invoke private device or arbitrary application schemes',async()=>{
 let calls=0;const adapter=new NativeDocumentActionAdapter({linkingModule:{openURL:async uri=>{calls++;assert.ok(uri.startsWith('https:')||uri.startsWith('content:')||uri.startsWith('file:'));}}});
 for(const uri of ['javascript:alert(1)','intent://adb/#Intent;scheme=adb;end','jarvis://execute','tel:119','http://example.test/file','file://foreign-host/private','https://user:password@example.test/file']){
  assert.equal(officialDocumentViewUri(uri),null);const result=await adapter.preview({taskId:'task',preview:{openable:true,uri}});assert.equal(result.status,'blocked');assert.equal(result.uri,null);
 }
 assert.equal(calls,0);
 assert.ok(!JSON.stringify(adapter.actions).includes('password'));
 for(const uri of ['https://example.test/report.pdf','content://local.eureka.jarvis.fileprovider/report.pdf','file:///data/user/0/local.eureka.jarvis/cache/report.pdf']){
  const result=await adapter.preview({taskId:'task',preview:{openable:true,uri}});assert.equal(result.status,'opened');assert.equal(result.success,true);
 }
 assert.equal(calls,3);
});
