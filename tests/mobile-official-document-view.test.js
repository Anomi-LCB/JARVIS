import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {openOfficialDocument} from '../apps/mobile/src/api/android-official-intents.js';
test('screen document callback blocks application schemes and does not retain credentials',async()=>{
 let calls=0;
 for(const uri of ['intent://x/#Intent;end','https://private-user:private-password@example.test/report','javascript:alert(1)','https://example.test/report?access_token=private-password','https://example.test/report#refresh_token=private-password']){
  const value=await openOfficialDocument({uri,openURL:async()=>{calls++;}});
  assert.equal(value.status,'blocked');assert.equal(value.uri,null);assert.ok(!JSON.stringify(value).includes('private-password'));
 }
 assert.equal(calls,0);
});
test('official view distinguishes launch, unavailable and failed from verified content read',async()=>{
 const uri='content://local.eureka.jarvis.fileprovider/cache/report.pdf';let invoked;
 const opened=await openOfficialDocument({uri,openURL:async value=>{invoked=value;}});assert.equal(invoked,uri);assert.equal(opened.status,'opened');assert.equal(opened.verifiedContentRead,false);
 assert.equal((await openOfficialDocument({uri})).status,'unavailable');
 const failed=await openOfficialDocument({uri,openURL:async()=>{throw new Error('private-provider-secret');}});assert.equal(failed.status,'failed');assert.equal(failed.success,false);assert.ok(!JSON.stringify(failed).includes('private-provider-secret'));
});
test('same URL implementation installed by Expo native runtime preserves view rules',async()=>{
 const appRequire=createRequire(new URL('../apps/mobile/package.json',import.meta.url));
 const expoRequire=createRequire(appRequire.resolve('expo/package.json'));
 const codec=expoRequire('whatwg-url-without-unicode'),previousURL=globalThis.URL,previousParams=globalThis.URLSearchParams;
 try{
  globalThis.URL=codec.URL;globalThis.URLSearchParams=codec.URLSearchParams;let calls=0;
  for(const uri of ['https://example.test/report.pdf','content://local.eureka.jarvis.fileprovider/cache/report.pdf','file:///data/user/0/local.eureka.jarvis/cache/report.pdf']){
   const result=await openOfficialDocument({uri,openURL:async()=>{calls++;}});assert.equal(result.status,'opened');
  }
  for(const uri of ['https://user:password@example.test/report','https://example.test/report?access_token=secret','https://example.test/report#refresh_token=secret','intent://x/#Intent;end'])assert.equal((await openOfficialDocument({uri,openURL:async()=>{calls++;}})).status,'blocked');
  assert.equal(calls,3);
 }finally{globalThis.URL=previousURL;globalThis.URLSearchParams=previousParams;}
});
