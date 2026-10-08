import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoogleCollection} from '../src/ui/google-collection.js';
function fixture(request,{status='not-started',paused=false}={}){
 const handlers={},calls=[],state={adapterAvailable:true,paused,connectionBinding:{connectionId:'connection',revision:'revision'},providers:[{provider:'gmail',status,mandateId:'new-grant',...(status==='renewal-required'?{transfer:{expectedMandateId:'old-grant',expectedRevision:2}}:{})}]};let refreshes=0;
 const ui=createGoogleCollection({escape:x=>String(x).replaceAll('<','&lt;'),request:async(...args)=>{calls.push(args);return request(...args);},changed:()=>{},refresh:async()=>{refreshes++;},id:()=> 'fixed-request',now:()=>new Date('2026-10-08T00:00:00Z')});ui.update(state);ui.attach({addEventListener:(name,handler)=>handlers[name]=handler});
 return {ui,calls,state,refreshes:()=>refreshes,click:action=>handlers.click({target:{closest:()=>({dataset:{provider:'gmail',googleCollectionAction:action}})}}),submit:fields=>handlers.submit({preventDefault(){},target:{dataset:{googleCollectionGrant:'gmail'},fields}})};
}
test('separate collection screen describes full metadata scope and never renders hidden binding or tokens',()=>{
 const f=fixture(()=>({}));assert.match(f.ui.render(),/스팸·휴지통/);assert.match(f.ui.render(),/로컬 저장 확인/);assert.doesNotMatch(f.ui.render(),/old-grant|new-grant|syncToken|pageToken|반짝/);
});
test('one collection click submits only provider and never automatically advances another page',async()=>{
 const f=fixture(()=>({status:'partial'}));await f.click('collect');assert.deepEqual(f.calls,[['/personal-google/collection-sync',{method:'POST',body:{provider:'gmail'}}]]);assert.equal(f.refreshes(),1);assert.match(f.ui.render(),/다음 페이지를 이어서/);
});
test('lost collection response is not retried as a new page',async()=>{
 const f=fixture(()=>{throw Error('response lost');});await f.click('collect');assert.equal(f.calls.length,1);assert.match(f.ui.render(),/완료를 확인하지 못/);
});
test('only the documented final collection status can claim final page storage',async()=>{
 for(const result of [{status:'busy'},{status:'complete'},{status:'reset-required'},{},null]){
  const f=fixture(()=>result);await f.click('collect');assert.equal(f.calls.length,1);assert.match(f.ui.render(),/완료를 확인하지 못/);assert.doesNotMatch(f.ui.render(),/마지막 페이지를 저장했습니다/);
 }
 const f=fixture(()=>({status:'window-complete'}));await f.click('collect');assert.match(f.ui.render(),/마지막 페이지를 저장했습니다/);
});
test('transfer retries the same idempotent request and a historical receipt never collects',async()=>{
 let calls=0;const f=fixture(()=>{if(!calls++)throw Error('lost');return {replayed:true};},{status:'renewal-required'});await f.click('transfer');assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);assert.deepEqual(f.calls[0][1].body,{requestId:'fixed-request',provider:'gmail',expectedMandateId:'old-grant',expectedRevision:2});assert.match(f.ui.render(),/이전 요청의 기록/);
});
test('paused and reset-required states cannot collect even if a click is synthesized',async()=>{
 for(const options of [{paused:true},{status:'reset-required'}]){const f=fixture(()=>({}),options);await f.click('collect');assert.equal(f.calls.length,0);}
});
test('pending collection suppresses double-click dispatch',async()=>{
 let release;const held=new Promise(r=>release=r),f=fixture(async()=>{await held;return {status:'complete'};});const pending=f.click('collect');await f.click('collect');assert.equal(f.calls.length,1);release();await pending;
});
test('scope form creates explicit consent with current binding and does not start collection',async t=>{
 const previous=globalThis.FormData;globalThis.FormData=class{constructor(form){this.fields=form.fields;}get(k){return this.fields[k];}};t.after(()=>globalThis.FormData=previous);
 const f=fixture(()=>({replayed:false}));await f.submit({maxPages:'12',expiresAt:'2099-10-09T00:00'});assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'/personal-google/collection-delegation');assert.equal(f.calls[0][1].body.scope,'gmail-all-message-metadata-v1');assert.equal(f.calls[0][1].body.connectionId,'connection');assert.equal(f.calls[0][1].body.replaceMandateId,'new-grant');
});
test('reset uses only server-observed expected versions, explains archival and never starts collection',async()=>{
 const f=fixture(()=>({status:'recollection-required'}),{status:'reset-required'});f.state.providers[0].reset={expectedMandateId:'expired-grant',expectedRevision:4};f.ui.update(f.state);assert.match(f.ui.render(),/현재 목록을 비웁니다/);await f.click('reset');assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0],[ '/personal-google/collection-reset',{method:'POST',body:{requestId:'fixed-request',provider:'gmail',expectedMandateId:'expired-grant',expectedRevision:4}}]);assert.match(f.ui.render(),/전체 재수집을 시작/);
});
