import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {renderTravelConnection} from '../src/ui/connections/travel.js';
import {escape} from '../src/ui/connections/connection-center.js';
test('disconnect requires admin and empty input and never turns an unconfirmed failure into success',async t=>{
 let calls=0,closed=false;
 const broker={status:()=>({credentialsConfigured:!closed,reason:closed?'connection-closed':'provider-call-unverified'}),disconnect:async()=>{calls++;closed=true;throw Error('private provider error');}};
 const server=createCoreServer(undefined,{adminToken:'test-duffel-disconnect',duffelBroker:broker});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const url=`http://127.0.0.1:${server.address().port}/travel/duffel/disconnect`;
 const call=(body,auth=true)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer test-duffel-disconnect'}:{})},body:JSON.stringify(body)});
 assert.equal((await call({},false)).status,401);assert.equal((await call({fingerprint:'another-client'})).status,400);assert.equal((await call([])).status,400);assert.equal(calls,0);
 const result=await call({});assert.equal(result.status,409);const value=await result.json();assert.equal(value.error.code,'A_DUFFEL_DISCONNECT_UNCONFIRMED');assert.equal(value.localReadsPaused,true);assert.equal(calls,1);assert.ok(!JSON.stringify(value).includes('private provider'));
 const html=renderTravelConnection({...broker.status(),brokerDisconnectSupported:true},null,{escape,enabled:true});assert.match(html,/자동 재시도하지 않습니다/);assert.match(html,/data-travel-disconnect disabled/);
});
