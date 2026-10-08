import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {OpenMeteoWeatherClient} from '../apps/pc-agent/src/adapters/weather/open-meteo-weather.js';
const limit=1024*1024;
for(const bytes of [limit,limit+1])test(`weather UTF8 response byte boundary ${bytes}`,async()=>{
 const suffix='"}',prefix='{"text":"한';
 const text=prefix+'a'.repeat(bytes-Buffer.byteLength(prefix+suffix))+suffix;
 const client=new OpenMeteoWeatherClient({fetchImpl:async()=>new Response(text)});
 if(bytes===limit)assert.equal(Buffer.byteLength(JSON.stringify(await client.fetchJson(new URL('https://api.open-meteo.com/'),'synthetic'))),limit);
 else await assert.rejects(client.fetchJson(new URL('https://api.open-meteo.com/'),'synthetic'),{code:'B_WEATHER_UPSTREAM_RESPONSE_TOO_LARGE'});
});
test('weather stream stops at byte limit without waiting for EOF',async()=>{
 let pulls=0,cancelled=false;
 const response={ok:true,body:new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(limit+1));},cancel(){cancelled=true;}}),text:async()=>{throw Error('Must not buffer whole text');}};
 const client=new OpenMeteoWeatherClient({fetchImpl:async()=>response});
 await assert.rejects(client.fetchJson(new URL('https://api.open-meteo.com/'),'synthetic'),{code:'B_WEATHER_UPSTREAM_RESPONSE_TOO_LARGE'});
 assert.ok(pulls<=2);assert.equal(cancelled,true);
});
test('weather split UTF8 chunks retain Korean text and exact boundary',async()=>{
 const text=JSON.stringify({text:'한글'}),bytes=Buffer.from(text);
 const response=new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,11));c.enqueue(bytes.subarray(11));c.close();}}));
 const client=new OpenMeteoWeatherClient({fetchImpl:async()=>response});
 assert.deepEqual(await client.fetchJson(new URL('https://api.open-meteo.com/'),'synthetic'),{text:'한글'});
});
test('actual HTTP oversize unfinished response returns size error before timeout',{timeout:5000},async()=>{
 const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write(Buffer.alloc(limit+1,32));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const client=new OpenMeteoWeatherClient({timeoutMs:1000});await assert.rejects(client.fetchJson(new URL(`http://127.0.0.1:${server.address().port}/`),'local'),{code:'B_WEATHER_UPSTREAM_RESPONSE_TOO_LARGE'});}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
