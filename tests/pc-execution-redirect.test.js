import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { PcAgentExecutionClient } from '../packages/core/src/client/pc-agent-execution-client.js';

test('execution POST redirects cannot replay an effect or transmit its credential to another path',async t=>{
  let executed=0,redirectedToken=null,received=0;
  const server=createServer((req,res)=>{
    received++;
    if(req.url==='/operations/execute'){
      req.resume();res.writeHead(307,{location:'/unintended-action'});res.end();
    }else{executed++;redirectedToken=req.headers.authorization;res.end('{}');}
  });
  await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const client=new PcAgentExecutionClient({baseUrl:`http://127.0.0.1:${server.address().port}`,executionToken:'synthetic-redirect-token'});
  await assert.rejects(client.request('/operations/execute',{method:'POST',body:{packet:{taskId:'synthetic-task'}}}),{code:'A_PC_AGENT_UNREACHABLE'});
  assert.equal(received,1);assert.equal(executed,0);assert.equal(redirectedToken,null);
});

test('observation redirects do not escape the explicitly selected local endpoint',async t=>{
  let calls=0;
  const destination=createServer((req,res)=>{calls++;res.end('{"status":"ok"}');});
  await listenOnFetchSafePort(destination,{host:'127.0.0.1',port:0});
  const origin=createServer((req,res)=>{res.writeHead(302,{location:`http://127.0.0.1:${destination.address().port}/health`});res.end();});
  await listenOnFetchSafePort(origin,{host:'127.0.0.1',port:0});
  t.after(async()=>{for(const server of [origin,destination])await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});});
  const client=new PcAgentExecutionClient({baseUrl:`http://127.0.0.1:${origin.address().port}`,executionToken:'synthetic-observation-token'});
  await assert.rejects(client.health(),{code:'A_PC_AGENT_UNREACHABLE'});
  assert.equal(calls,0);
});
