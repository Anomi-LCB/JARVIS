import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {OpenMeteoWeatherClient} from '../apps/pc-agent/src/adapters/weather/open-meteo-weather.js';
test('weather cancelled before local lookup performs no fetch',async()=>{
 let calls=0;const controller=new AbortController();controller.abort();
 const client=new OpenMeteoWeatherClient({fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 await assert.rejects(client.weeklyForecast('서울',{signal:controller.signal}),{code:'B_OPERATION_CANCELLED'});assert.equal(calls,0);
});
test('cancelled geocoding queue returns without waiting for earlier reservation',async()=>{
 const client=new OpenMeteoWeatherClient(),controller=new AbortController();let release;
 client.nominatimSchedule=new Promise(r=>release=r);
 const pending=client.reserveNominatimRequest({signal:controller.signal});controller.abort();
 try{await assert.rejects(pending,{code:'B_OPERATION_CANCELLED'});}finally{release();}
 await client.nominatimSchedule;
});
for(const mode of ['cancel','timeout'])test(`actual local HTTP stalled body ${mode}`,{timeout:5000},async()=>{
 let ready;const entered=new Promise(r=>ready=r);
 const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');ready();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const client=new OpenMeteoWeatherClient({timeoutMs:1000}),controller=new AbortController();
 try{
  const pending=client.fetchJson(new URL(`http://127.0.0.1:${server.address().port}/`),'local-test',{signal:controller.signal});
  await entered;if(mode==='cancel')controller.abort();
  await assert.rejects(pending,{code:mode==='cancel'?'B_OPERATION_CANCELLED':'B_WEATHER_UPSTREAM_TIMEOUT'});
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('weather in-flight fetch receives caller cancellation',async()=>{
 const controller=new AbortController();let entered;
 const started=new Promise(r=>entered=r);
 const client=new OpenMeteoWeatherClient({fetchImpl:async(_url,{signal})=>new Promise((resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true});})});
 const pending=client.weeklyForecast('서울',{signal:controller.signal});await started;controller.abort();
 await assert.rejects(pending,{code:'B_OPERATION_CANCELLED'});
});
test('cancelled Korean geocoder must not fall back to another provider',async()=>{
 const controller=new AbortController();let calls=0;
 const client=new OpenMeteoWeatherClient({fetchImpl:async()=>{calls++;controller.abort();throw Object.assign(Error('aborted'),{name:'AbortError'});}});
 await assert.rejects(client.geocode('성남시 분당구',{signal:controller.signal}),{code:'B_OPERATION_CANCELLED'});assert.equal(calls,1);
});
