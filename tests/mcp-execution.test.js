import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpConnectionManager } from '../packages/core/src/personal-operations/mcp-connections.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { renderMcpTools } from '../src/ui/connections/connection-center.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { RuntimeTrustKernel } from '../packages/core/src/security/runtime-trust-kernel.js';

const permit = () => ({allowed:true});
const tool = {name:'sum',inputSchema:{type:'object',properties:{a:{type:'integer'},b:{type:'integer'}},required:['a','b'],additionalProperties:false}};
const input = {tool:'sum',arguments:{a:2,b:3},expectedText:'5',requestId:'request_0000000001'};
async function withManager(fn) {
  const dir=mkdtempSync(join(tmpdir(),'jarvis-mcp-call-')); const path=join(dir,'calls.sqlite');
  const manager=new McpConnectionManager({storePath:path}); let currentTool=structuredClone(tool), calls=0, respond=()=>({content:[{type:'text',text:'5'}]});
  manager.fetchImpl=async(_,options)=>{
    const body=JSON.parse(options.body);
    if(body.method==='tools/list')return Response.json({jsonrpc:'2.0',id:body.id,result:{tools:[currentTool]}});
    calls++;return Response.json({jsonrpc:'2.0',id:body.id,result:respond(body)});
  };
  const entry=manager.add({label:'fixture',endpoint:'http://127.0.0.1:12345/mcp',protocolVersion:'2026-07-28'});
  await manager.probe(entry.id);
  try{await fn({manager,id:entry.id,path,calls:()=>calls,setTool:t=>{currentTool=t;},setResponse:fn=>{respond=fn;}});}
  finally{manager.close();rmSync(dir,{recursive:true,force:true});}
}
test('MCP call requires an exact grant, valid inputs and an allowing trust decision',async()=>withManager(async({manager,id,calls})=>{
  await assert.rejects(manager.call(id,input,permit),/NOT_AUTHORIZED/);
  manager.setAllowedTools(id,{tools:['sum']});
  await assert.rejects(manager.call(id,{...input,arguments:{a:'2',b:3}},permit),/ARGUMENT_INVALID/);
  await assert.rejects(manager.call(id,input,()=>({allowed:false})),/POLICY_DENIED/);
  assert.equal(calls(),0);
  const result=await manager.call(id,input,permit);
  assert.equal(result.status,'expectation-matched');assert.equal(result.businessOutcomeVerified,false);assert.equal(calls(),1);
  await assert.rejects(manager.call(id,input,permit),/ALREADY_USED/);assert.equal(calls(),1);
}));
test('changed tool contract revokes prior permissions before dispatch',async()=>withManager(async({manager,id,setTool,calls})=>{
  manager.setAllowedTools(id,{tools:['sum']});setTool({...tool,description:'Changed contract'});
  await assert.rejects(manager.call(id,input,permit),/NOT_AUTHORIZED/);assert.equal(calls(),0);assert.equal(manager.get(id).executionAuthorized,false);
}));
test('lost outcome is durable and blocks a new request after restart',async()=>withManager(async({manager,id,path,setResponse,calls})=>{
  manager.setAllowedTools(id,{tools:['sum']});setResponse(()=>{throw new Error('network loss');});
  assert.equal((await manager.call(id,input,permit)).status,'outcome-unknown');assert.equal(calls(),1);
  assert.equal(JSON.parse(manager.db().prepare('SELECT value FROM mcp_calls').get().value).status,'outcome-unknown');
  manager.close();const reopened=new McpConnectionManager({storePath:path});
  try{await assert.rejects(reopened.call(id,{...input,requestId:'request_0000000002'},permit),/UNRESOLVED_OUTCOME/);}finally{reopened.close();}
  manager.remove(id);const added=manager.add({label:'Re-added fixture',endpoint:'http://127.0.0.1:12345/mcp',protocolVersion:'2026-07-28'});
  await assert.rejects(manager.call(added.id,{...input,requestId:'request_0000000003'},permit),/UNRESOLVED_OUTCOME/);
}));
test('tool errors and incorrect output do not imply success',async()=>withManager(async({manager,id,setResponse})=>{
  manager.setAllowedTools(id,{tools:['sum']});setResponse(()=>({content:[{type:'text',text:'5'}],isError:true}));
  assert.equal((await manager.call(id,input,permit)).status,'tool-error');
  setResponse(()=>({content:[{type:'text',text:'wrong'}]}));
  assert.equal((await manager.call(id,{...input,requestId:'request_0000000002'},permit)).status,'expectation-failed');
}));
test('unsupported schema cannot be authorized and untrusted output is escaped in UI',async()=>withManager(async({manager,id,setTool})=>{
  setTool({...tool,inputSchema:{type:'object',oneOf:[{}]}});await manager.probe(id);
  assert.throws(()=>manager.setAllowedTools(id,{tools:['sum']}),/SCHEMA_UNSUPPORTED/);
  const html=renderMcpTools(manager.get(id),true,false,{[`${id}:sum`]:{status:'tool-error',result:'<script>unsafe</script>'}});
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
}));
test('real MCP HTTP server receives tools/call and produces the expected calculation',async()=>withManager(async({manager,id})=>{
  const received=[];const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const rpc=JSON.parse(raw);received.push(rpc.method);
    const result=rpc.method==='tools/list'?{tools:[tool]}:{content:[{type:'text',text:String(rpc.params.arguments.a+rpc.params.arguments.b)}]};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  });const address=await listenOnFetchSafePort(server);
  try{manager.remove(id);manager.fetchImpl=fetch;const entry=manager.add({label:'HTTP calculation',endpoint:`http://127.0.0.1:${address.port}/mcp`,protocolVersion:'2026-07-28'});
    await manager.probe(entry.id);manager.setAllowedTools(entry.id,{tools:['sum']});
    assert.equal((await manager.call(entry.id,input,permit)).result.content[0].text,'5');assert.equal(received.filter(x=>x==='tools/call').length,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
}));
test('actual Core API executes through the actual trust kernel and denies lockdown',async()=>withManager(async({manager,id,calls})=>{
  let dispatches=0;
  const mcp=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const rpc=JSON.parse(raw);
    const result=rpc.method==='tools/list'?{tools:[tool]}:{content:[{type:'text',text:String(rpc.params.arguments.a+rpc.params.arguments.b)}]};
    if(rpc.method==='tools/call')dispatches++;
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  });const mcpAddress=await listenOnFetchSafePort(mcp);
  manager.remove(id);manager.fetchImpl=fetch;
  const active=manager.add({label:'Core HTTP fixture',endpoint:`http://127.0.0.1:${mcpAddress.port}/mcp`,protocolVersion:'2026-07-28'});await manager.probe(active.id);
  const trust=new RuntimeTrustKernel({signingSecret:'isolated-test-key',testMode:true});
  const server=createCoreServer(undefined,{adminToken:'isolated-mcp-admin',mcpConnections:manager,trustKernel:trust});
  const address=await listenOnFetchSafePort(server);
  const post=(suffix,body)=>fetch(`http://127.0.0.1:${address.port}/integrations/mcp/${active.id}/${suffix}`,{method:'POST',headers:{authorization:'Bearer isolated-mcp-admin','content-type':'application/json'},body:JSON.stringify(body)});
  try{
    assert.equal((await post('permissions',{tools:['sum']})).status,200);
    const readinessUrl=`http://127.0.0.1:${address.port}/integrations/mcp`;
    assert.equal((await fetch(readinessUrl)).status,401);
    const readinessResponse=await fetch(readinessUrl,{headers:{authorization:'Bearer isolated-mcp-admin'}});
    assert.equal(readinessResponse.status,200);
    const readiness=(await readinessResponse.json()).connections.find(c=>c.id===active.id).capabilityReadiness[0];
    assert.equal(readiness.status,'contract-missing');assert.equal(readiness.packageInstalled,false);assert.equal(readiness.autonomousExecutionAuthorized,false);
    const response=await post('call',input);assert.equal(response.status,200);assert.equal((await response.json()).status,'expectation-matched');
    const historyUrl=`http://127.0.0.1:${address.port}/integrations/mcp/${active.id}/calls`;
    assert.equal((await fetch(historyUrl)).status,401);const historyResponse=await fetch(historyUrl,{headers:{authorization:'Bearer isolated-mcp-admin'}});assert.equal(historyResponse.status,200);assert.equal(historyResponse.headers.get('cache-control'),'no-store');const history=await historyResponse.json();assert.equal(history.items[0].requestId,input.requestId);assert.equal(history.items[0].historicalRecord,true);assert.equal(history.businessOutcomeVerified,false);assert.equal(history.automaticRetryAllowed,false);assert.equal(history.items[0].arguments,undefined);assert.equal(history.items[0].result,undefined);
    trust.engageLockdown({reason:'isolated-chaos-test'});
    const denied=await post('call',{...input,requestId:'request_0000000002'});assert.equal(denied.status,409);assert.equal((await denied.json()).error.code,'A_MCP_POLICY_DENIED');assert.equal(dispatches,1);
  }finally{await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>mcp.close(resolve));}
}));


test('contract changed in the execution session revokes its grant without tools/call',async()=>withManager(async({manager,id,calls})=>{
 manager.setAllowedTools(id,{tools:['sum']});const original=manager.fetchImpl;let lists=0;
 manager.fetchImpl=async(url,options)=>{const rpc=JSON.parse(options.body);if(rpc.method==='tools/list'&&++lists===2)return Response.json({jsonrpc:'2.0',id:rpc.id,result:{tools:[{...tool,description:'new side effect',annotations:{readOnlyHint:true}}]}});return original(url,options);};
 const result=await manager.call(id,input,permit);assert.equal(result.status,'not-dispatched');assert.equal(result.errorCode,'A_MCP_DISPATCH_CONTRACT_CHANGED');assert.equal(calls(),0);assert.equal(manager.get(id).executionAuthorized,false);
}));

test('server read-only hints never reduce the policy capability of manual MCP execution',async()=>withManager(async({manager,id,setTool})=>{
 setTool({...tool,annotations:{readOnlyHint:true,destructiveHint:false}});await manager.probe(id);manager.setAllowedTools(id,{tools:['sum']});const decisions=[];
 const result=await manager.call(id,input,decision=>{decisions.push(decision);return {allowed:true};});assert.equal(result.status,'expectation-matched');
 assert.ok(decisions.length>=2);assert.ok(decisions.every(d=>d.action.capability.externalTransfer===true&&d.action.capability.reversible===false));
}));

test('caller mutation during async discovery never changes the checked arguments, request identity or expected result',async()=>withManager(async({manager,id,calls})=>{
 manager.setAllowedTools(id,{tools:['sum']});const selected=structuredClone(input),original=manager.fetchImpl,decisions=[];
 manager.fetchImpl=async(url,options)=>{const rpc=JSON.parse(options.body);
   if(rpc.method==='tools/list'){selected.arguments.a=900;selected.requestId='request_other_000001';selected.expectedText='wrong';}
   if(rpc.method==='tools/call'){assert.deepEqual(rpc.params.arguments,{a:2,b:3});assert.equal(rpc.id,input.requestId);}
   return original(url,options);
 };
 const result=await manager.call(id,selected,decision=>{decisions.push(decision);selected.arguments.b=800;return {allowed:true};});
 assert.equal(result.status,'expectation-matched');assert.equal(result.requestId,input.requestId);assert.equal(calls(),1);
 assert.equal(decisions.length,3);assert.deepEqual(decisions.map(d=>d.source),['mcp-manual-call','mcp-manual-dispatch','mcp-result-delivery']);
 for(const d of decisions){assert.deepEqual(d.action.arguments,{a:2,b:3});assert.ok(Object.isFrozen(d.action.arguments));
   assert.equal(d.action.context.requestId,input.requestId);assert.equal(d.action.context.argumentsSha256,result.inputHash);}
 const history=manager.callHistory(id).items;assert.equal(history.length,1);assert.equal(history[0].inputHash,result.inputHash);
 assert.equal(history[0].arguments,undefined);assert.equal(history[0].context,undefined);
}));

test('non-JSON, accessor, circular and oversized direct call inputs are rejected before discovery',async()=>withManager(async({manager,id,calls})=>{
 manager.setAllowedTools(id,{tools:['sum']});let discoveries=0;const original=manager.fetchImpl;
 manager.fetchImpl=async(...args)=>{discoveries++;return original(...args);};
 const accessor={...input,arguments:{a:2,b:3}};Object.defineProperty(accessor.arguments,'secret',{enumerable:true,get(){throw Error('getter must not run');}});
 const cycle={...input,arguments:{a:2,b:3}};cycle.arguments.self=cycle;
 for(const selected of [accessor,cycle,{...input,arguments:{a:2,b:Infinity}},{...input,arguments:{a:2,b:()=>3}},
   {...input,arguments:{a:2,b:3,extra:'x'.repeat(40000)}}]) await assert.rejects(manager.call(id,selected,permit),/A_MCP_CALL_INVALID/);
 assert.equal(discoveries,0);assert.equal(calls(),0);assert.equal(manager.callHistory(id).items.length,0);
}));

test('real HTTP discovery-time mutation still dispatches only the selected payload and matching journal hash',async()=>withManager(async({manager,id})=>{
 const selected=structuredClone(input),received=[];
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const rpc=JSON.parse(raw);
   if(rpc.method==='tools/list'){selected.arguments.a=999;selected.requestId='changed_request_00001';}
   else received.push(rpc);
   res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:rpc.method==='tools/list'?{tools:[tool]}:{content:[{type:'text',text:String(rpc.params.arguments.a+rpc.params.arguments.b)}]}}));
 });const address=await listenOnFetchSafePort(server);
 try{manager.remove(id);manager.fetchImpl=fetch;const entry=manager.add({label:'isolated mutation test',endpoint:`http://127.0.0.1:${address.port}/mcp`,protocolVersion:'2026-07-28'});
   await manager.probe(entry.id);manager.setAllowedTools(entry.id,{tools:['sum']});selected.arguments.a=2;selected.requestId=input.requestId;
   const result=await manager.call(entry.id,selected,permit);assert.equal(result.status,'expectation-matched');assert.equal(received.length,1);
   assert.deepEqual(received[0].params.arguments,{a:2,b:3});assert.equal(received[0].id,input.requestId);
   assert.equal(manager.callHistory(entry.id).items[0].inputHash,result.inputHash);
 }finally{await new Promise(resolve=>server.close(resolve));}
}));

test('real MCP session rollover blocks a changed manifest before any remote tool effect',async()=>withManager(async({manager,id})=>{
 let sessions=0,effects=0;const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const rpc=JSON.parse(raw);res.setHeader('content-type','application/json');
  if(rpc.method==='notifications/initialized'){res.writeHead(204);res.end();return;}
  let result;if(rpc.method==='initialize'){sessions++;res.setHeader('mcp-session-id','session-'+sessions);result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'isolated',version:'1'}};}
  else if(rpc.method==='tools/list')result={tools:[req.headers['mcp-session-id']==='session-3'?{...tool,description:'changed in execution session'}:tool]};
  else{effects++;result={content:[{type:'text',text:'5'}]};}
  res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });await listenOnFetchSafePort(server);try{
  manager.remove(id);manager.fetchImpl=fetch;const entry=manager.add({label:'session-change',endpoint:`http://127.0.0.1:${server.address().port}/mcp`,protocolVersion:'2025-11-25'});
  await manager.probe(entry.id);manager.setAllowedTools(entry.id,{tools:['sum']});const result=await manager.call(entry.id,input,permit);
  assert.equal(sessions,3);assert.equal(effects,0);assert.equal(result.status,'not-dispatched');assert.equal(result.errorCode,'A_MCP_DISPATCH_CONTRACT_CHANGED');assert.equal(manager.get(entry.id).executionAuthorized,false);
 }finally{await new Promise(r=>server.close(r));}
}));


test('a separate manager revoking grants during discovery cannot be overwritten by stale probe data',async()=>withManager(async({manager,id,path})=>{
 manager.setAllowedTools(id,{tools:['sum']});const original=manager.fetchImpl;let release,entered;const waiting=new Promise(r=>{entered=r;});
 manager.fetchImpl=async(url,options)=>{entered();await new Promise(r=>{release=r;});return original(url,options);};
 const probe=manager.probe(id);await waiting;const second=new McpConnectionManager({storePath:path});try{second.setAllowedTools(id,{tools:[]});release();const observed=await probe;assert.equal(observed.executionAuthorized,false);assert.deepEqual(observed.allowedTools,[]);assert.deepEqual(second.get(id).allowedTools,[]);}finally{second.close();}
}));
