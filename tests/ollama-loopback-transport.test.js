import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {createOllamaLoopbackFetch} from '../packages/core/src/mission/ollama-loopback-transport.js';
import {createOllamaLocalModelProvider} from '../packages/core/src/mission/ollama-local-model-provider.js';
const origin='http://127.0.0.1:11434';
const init=signal=>({method:'GET',redirect:'error',credentials:'omit',cache:'no-store',headers:{Accept:'application/json'},signal});
async function serverFor(t,handle){
 const server=createServer(handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const requests=[];
 const transport=createOllamaLoopbackFetch({requestImpl:(url,options,callback)=>{
  requests.push({url,agent:options.agent,method:options.method,headers:options.headers});
  assert.ok(url.startsWith(origin+'/api/'));
  // Only this isolated test redirects the native dependency to its owned server.
  const u=new URL(url);u.port=String(server.address().port);return httpRequest(u,options,callback);
 }});
 return {transport,requests};
}
test('scope refuses remote origins redirects credentials and arbitrary paths before network',async()=>{
 let calls=0;const transport=createOllamaLoopbackFetch({requestImpl:()=>{calls++;throw Error('must not connect');}});
 for(const url of ['https://example.com/api/tags',origin+'/api/pull',origin+'/api/tags?extra=1','http://localhost:11434/api/tags'])
  await assert.rejects(transport(url,init()),{code:'A_LOCAL_MODEL_TRANSPORT_SCOPE_INVALID'});
 for(const patch of [{method:'DELETE'},{redirect:'follow'},{credentials:'include'},{cache:'default'},{headers:{Authorization:'Bearer secret'}}])
  await assert.rejects(transport(origin+'/api/tags',{...init(),...patch}),{code:'A_LOCAL_MODEL_TRANSPORT_SCOPE_INVALID'});
 assert.equal(calls,0);
});
test('native transport collects split UTF8 and waits for delayed headers under caller deadline',async t=>{
 const content=Buffer.from('{"message":"합성 자료"}');
 const {transport,requests}=await serverFor(t,(_req,res)=>setTimeout(()=>{res.write(content.subarray(0,15));res.end(content.subarray(15));},150));
 const r=await transport(origin+'/api/tags',init(AbortSignal.timeout(2000)));
 assert.equal(await r.text(),content.toString('utf8'));assert.equal(r.ok,true);assert.equal(requests[0].agent,false);
});
test('native transport aborts while awaiting headers and while receiving a body',async t=>{
 for(const headersSent of [false,true]){
  const {transport}=await serverFor(t,(_req,res)=>{if(headersSent){res.writeHead(200);res.write('{');}});
  const controller=new AbortController();const waiting=transport(origin+'/api/tags',init(controller.signal)).then(r=>r.text());
  setTimeout(()=>controller.abort(),40);
  await assert.rejects(waiting,error=>['ABORT_ERR','ECONNRESET'].includes(error.code));
 }
});
test('native transport enforces body limit during receipt and never follows HTTP redirect',async t=>{
 const {transport,requests}=await serverFor(t,(_req,res)=>{res.writeHead(200);res.end(Buffer.alloc(2*1024*1024+1,65));});
 const response=await transport(origin+'/api/tags',init());await assert.rejects(response.text(),{code:'A_LOCAL_MODEL_RESPONSE_TOO_LARGE'});
 const redirected=await serverFor(t,(_req,res)=>{res.writeHead(302,{Location:'https://example.com/private'});res.end();});
 const r=await redirected.transport(origin+'/api/tags',init());assert.equal(r.ok,false);assert.equal(r.status,302);
 assert.equal(redirected.requests.length,1);assert.equal(requests.length,1);
});
test('real native HTTP reaches local provider validation and preserves measured output without authority',async t=>{
 const {transport,requests}=await serverFor(t,(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/api/tags'){res.end(JSON.stringify({models:[{name:'synthetic:local',size:1000}]}));return;}
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
   const input=JSON.parse(body);assert.equal(input.stream,false);assert.equal(input.options.num_predict,384);
   res.end(JSON.stringify({model:'synthetic:local',done:true,done_reason:'stop',response:'{"ok":true}',prompt_eval_count:12,eval_count:8}));
  });
 });
 const provider=createOllamaLocalModelProvider({model:'synthetic:local',fetchImpl:transport,timeoutMs:2000});
 const r=await provider.generateStructured({prompt:'Synthetic',schema:{type:'object'}});
 assert.deepEqual(r.output,{ok:true});assert.equal(r.usage.totalTokens,20);assert.equal(r.providerCalls,2);
 assert.equal(r.executionAuthorized,false);assert.equal(requests.length,2);
});
