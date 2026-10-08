import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {McpConnectionManager} from '../packages/core/src/personal-operations/mcp-connections.js';

async function fixture(t,mode){
 const root=mkdtempSync(join(tmpdir(),'jarvis-mcp-revision-'));
 const manager=new McpConnectionManager({storePath:join(root,'mcp.sqlite')});
 const peer=new McpConnectionManager({storePath:manager.storePath});
 let armed=false,calls=0,entry;
 const tool={name:'sum',inputSchema:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b']}};
 const regrant=()=>{peer.setAllowedTools(entry.id,{tools:[]});peer.setAllowedTools(entry.id,{tools:['sum']});};
 const server=createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const rpc=JSON.parse(raw);
  if(armed&&((mode==='probe'&&rpc.id==='tools-list')||(mode==='dispatch'&&rpc.id==='dispatch-tools-list'))){armed=false;regrant();}
  const result=rpc.method==='tools/list'?{tools:[tool]}:(calls++,{content:[{type:'text',text:'answer'}],structuredContent:{answer:5}});
  res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });
 const address=await listenOnFetchSafePort(server);
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));peer.close();manager.close();rmSync(root,{recursive:true,force:true});});
 entry=manager.add({label:'권한 세대 검사',endpoint:`http://127.0.0.1:${address.port}/mcp`,protocolVersion:'2026-07-28'});
 await manager.probe(entry.id);manager.setAllowedTools(entry.id,{tools:['sum']});
 manager.registerCapabilityContract(entry.id,{tool:'sum',contractHash:manager.get(entry.id).tools[0].contractHash,packageId:'fixture.sum',version:'1.0.0',source:'https://example.org/source',effect:'read',verifierId:'sum.oracle',verifierFingerprint:'b'.repeat(64)});
 const verifiers=new Map([['sum.oracle',{fingerprint:'b'.repeat(64),verify:({arguments:args,result})=>{
  if(mode==='verifier')regrant();return {valid:args.a+args.b===result.structuredContent.answer,evidenceRef:'local:arithmetic'};
 }}]]);
 const input={tool:'sum',arguments:{a:2,b:3},expectedText:'answer',requestId:'revision_request_000001'};
 const before=manager.get(entry.id).permissionRevision;armed=true;
 const authorize=({source})=>{if(mode==='policy'&&source==='mcp-manual-dispatch')regrant();return {allowed:true};};
 if(mode==='probe'||mode==='verifier'){
  await assert.rejects(manager.callVerifiedCapability(entry.id,input,()=>({allowed:true}),{verifiers}),{code:'A_MCP_PERMISSION_CHANGED'});
  assert.equal(calls,mode==='verifier'?1:0);assert.equal(manager.verificationReceipt(entry.id,input.requestId),null);
 }else if(mode==='dispatch'||mode==='policy'){
  const result=await manager.callVerifiedCapability(entry.id,input,authorize,{verifiers});
  assert.equal(result.status,'not-dispatched');assert.equal(result.errorCode,'A_MCP_PERMISSION_CHANGED');assert.equal(calls,0);assert.equal(result.businessOutcomeVerified,false);
 }else{
  const good=await manager.callVerifiedCapability(entry.id,input,()=>({allowed:true}),{verifiers});assert.equal(good.businessOutcomeVerified,true);assert.equal(calls,1);
  assert.equal(manager.readVerifiedResult(entry.id,input.requestId).result.structuredContent.answer,5);
  manager.setAllowedTools(entry.id,{tools:['sum']});assert.equal(manager.get(entry.id).permissionRevision,before,'no-op permission save must not invalidate a result');
  regrant();assert.throws(()=>manager.readVerifiedResult(entry.id,input.requestId),{code:'A_MCP_VERIFIED_RESULT_ACCESS_REVOKED'});
  assert.equal(manager.verificationReceipt(entry.id,input.requestId).status,'verified','historical receipt is retained');
 }
 assert.notEqual(manager.get(entry.id).permissionRevision,before);
 console.log(JSON.stringify({mode,calls,permissionChanged:true,observedAt:new Date().toISOString()}));
}
for(const mode of ['probe','dispatch','policy','verifier','cached'])test(`MCP permission revoke/regrant cannot reuse the old ${mode} authority`,t=>fixture(t,mode));
