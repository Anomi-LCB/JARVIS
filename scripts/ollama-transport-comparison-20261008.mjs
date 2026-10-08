// Isolated scaled reproduction; Node internals are never used by product code.
import {createServer,request} from 'node:http';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createOllamaLoopbackFetch} from '../packages/core/src/mission/ollama-loopback-transport.js';
const require=createRequire(import.meta.url),u=require('internal/deps/undici/undici');
const Agent=u.getGlobalDispatcher().constructor;
const dispatcher=new Agent({headersTimeout:50,bodyTimeout:50});
const server=createServer((_req,res)=>setTimeout(()=>res.end('{"synthetic":true}'),1500));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const results=[];
try{
 const url=`http://127.0.0.1:${server.address().port}/api/tags`;
 for(const mode of ['global-fetch-scaled-headers-deadline','native-caller-deadline']){
  const start=performance.now();let code=null,text=null;
  try{
   const fetchImpl=mode.startsWith('global')?globalThis.fetch:createOllamaLoopbackFetch({requestImpl:(_url,opts,cb)=>request(url,opts,cb)});
   const r=await fetchImpl(mode.startsWith('global')?url:'http://127.0.0.1:11434/api/tags',{
    method:'GET',headers:{Accept:'application/json'},redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(5000),
    ...(mode.startsWith('global')?{dispatcher}:{})});text=await r.text();
  }catch(e){code=e.cause?.code??e.code??e.name;}
  results.push({mode,elapsedMs:performance.now()-start,code,text,callerDeadlineMs:5000,serverHeadersDelayMs:1500});
 }
 assert.equal(results[0].code,'UND_ERR_HEADERS_TIMEOUT');assert.equal(results[1].text,'{"synthetic":true}');
 await writeFile('artifacts/ollama-transport-comparison-20261008.json',JSON.stringify({observedAt:new Date().toISOString(),node:process.version,
  scaledReproduction:true,originalFailureCauseConfirmed:false,results},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(results));
}finally{await dispatcher.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
