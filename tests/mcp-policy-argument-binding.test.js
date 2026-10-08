import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {McpConnectionManager} from '../packages/core/src/personal-operations/mcp-connections.js';

async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-mcp-policy-binding-'));
 const received=[];
 const tool={name:'read_document',inputSchema:{type:'object',properties:{documentId:{type:'string'}},required:['documentId'],additionalProperties:false}};
 const server=createServer(async(req,res)=>{
  let bytes='';for await(const part of req)bytes+=part;const body=JSON.parse(bytes);
  const result=body.method==='tools/list'?{tools:[tool]}:{content:[{type:'text',text:'documentId original'}],structuredContent:{documentId:body.params.arguments.documentId}};
  if(body.method==='tools/call')received.push(structuredClone(body.params.arguments));
  res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
 });
 const {port}=await listenOnFetchSafePort(server);
 const manager=new McpConnectionManager({storePath:join(root,'mcp.sqlite')});
 t.after(async()=>{manager.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});});
 const entry=manager.add({label:'synthetic local document service',endpoint:`http://127.0.0.1:${port}/mcp`,protocolVersion:'2026-07-28'});
 await manager.probe(entry.id);manager.setAllowedTools(entry.id,{tools:['read_document']});
 const input=()=>({tool:'read_document',arguments:{documentId:'original'},requestId:'binding_request_'+Math.random().toString(36).slice(2).padEnd(16,'0'),expectedText:'documentId'});
 return {root,manager,entry,received,input};
}

for(const source of ['mcp-manual-call','mcp-manual-dispatch'])test(`policy hook cannot retarget arguments at ${source}`,async t=>{
 const {manager,entry,received,input}=await fixture(t);const request=input();
 let result,error;
 try{result=await manager.call(entry.id,request,policy=>{if(policy.source===source)policy.action.arguments.documentId='different-private-document';return {allowed:true};});}catch(e){error=e;}
 assert.equal(received.length,0,'a changed policy argument must never reach the provider');
 assert.equal(request.arguments.documentId,'original');
 if(source==='mcp-manual-call')assert.equal(error?.code,'A_MCP_POLICY_EVALUATION_FAILED');
 else{assert.equal(result.status,'not-dispatched');assert.equal(result.errorCode,'A_MCP_POLICY_EVALUATION_FAILED');}
});

test('a policy hook cannot replace the bound purpose or request hash before dispatch',async t=>{
 const {manager,entry,received,input}=await fixture(t);
 const result=await manager.call(entry.id,input(),policy=>{
  if(policy.source==='mcp-manual-dispatch'){policy.action.context.purpose='different-purpose';policy.action.context.argumentsSha256='a'.repeat(64);}
  return {allowed:true};
 });
 assert.equal(received.length,0);assert.equal(result.status,'not-dispatched');assert.equal(result.errorCode,'A_MCP_POLICY_EVALUATION_FAILED');
});

test('ordinary policy leaves the exact original provider request and persistent input hash intact',async t=>{
 const {manager,entry,received,input,root}=await fixture(t);const request=input();const requests=[];
 const result=await manager.call(entry.id,request,p=>{requests.push(structuredClone(p));return {allowed:true};});
 assert.equal(result.status,'expectation-matched');assert.deepEqual(received,[{documentId:'original'}]);
 assert.deepEqual(requests.map(p=>p.source),['mcp-manual-call','mcp-manual-dispatch','mcp-result-delivery']);
 assert.ok(requests.every(p=>p.action.context.argumentsSha256===result.inputHash));
 const row=JSON.parse(manager.db().prepare('SELECT value FROM mcp_calls WHERE id=?').get(request.requestId).value);
 assert.equal(row.inputHash,result.inputHash);assert.equal(row.status,'expectation-matched');
 assert.equal(readFileSync(join(root,'mcp.sqlite')).includes(Buffer.from('different-private-document')),false);
});

for(const [field,value] of [['purpose','unrelated-purpose'],['destinationType','unrelated-recipient'],['endpointHash','b'.repeat(64)],['requestId','another_request_00000001'],['argumentsSha256','c'.repeat(64)]]){
 test(`full immutable policy context preserves ${field} at initial, dispatch and result delivery`,async t=>{
  const {manager,entry,received,input}=await fixture(t);
  for(const source of ['mcp-manual-call','mcp-manual-dispatch','mcp-result-delivery']){
   let result,error;
   try{result=await manager.call(entry.id,input(),policy=>{
    if(policy.source===source)policy.action.context[field]=value;
    return {allowed:true};
   });}catch(e){error=e;}
   if(source==='mcp-manual-call')assert.equal(error?.code,'A_MCP_POLICY_EVALUATION_FAILED');
   else if(source==='mcp-manual-dispatch'){assert.equal(result.status,'not-dispatched');assert.equal(result.errorCode,'A_MCP_POLICY_EVALUATION_FAILED');}
   else{assert.equal(result.status,'result-withheld');assert.equal(result.errorCode,'A_MCP_RESULT_POLICY_DENIED');assert.equal(result.result,undefined);assert.equal(result.providerResponseReceived,true);}
  }
  assert.deepEqual(received,[{documentId:'original'}],'only the original read before the result-delivery denial was dispatched');
 });
}

test('policy exceptions are sanitized while recognized local authority denial is preserved',async t=>{
 const {manager,entry,input,received,root}=await fixture(t);
 const secret='synthetic-policy-exception-secret';
 const result=await manager.call(entry.id,input(),policy=>{if(policy.source==='mcp-manual-dispatch')throw new Error(secret);return {allowed:true};});
 assert.equal(result.status,'not-dispatched');assert.equal(result.errorCode,'A_MCP_POLICY_EVALUATION_FAILED');
 assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(readFileSync(join(root,'mcp.sqlite')).includes(Buffer.from(secret)),false);
 await assert.rejects(manager.call(entry.id,input(),()=>{throw Object.assign(new Error(secret),{code:'A_MCP_LOCAL_EXECUTION_AUTHORITY_CHANGED'});}),{code:'A_MCP_LOCAL_EXECUTION_AUTHORITY_CHANGED'});
 assert.equal(received.length,0);
});

test('policy references are distinct frozen snapshots for every evaluation',async t=>{
 const {manager,entry,input}=await fixture(t);const seen=[];
 const result=await manager.call(entry.id,input(),policy=>{seen.push(policy);return {allowed:true};});
 assert.equal(result.status,'expectation-matched');assert.equal(seen.length,3);
 for(const request of seen){assert.equal(Object.isFrozen(request),true);assert.equal(Object.isFrozen(request.action),true);assert.equal(Object.isFrozen(request.action.context),true);assert.equal(Object.isFrozen(request.action.arguments),true);}
 assert.notEqual(seen[0].action.context,seen[1].action.context);assert.notEqual(seen[1].action.context,seen[2].action.context);
});
