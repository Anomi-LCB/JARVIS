import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {McpConnectionManager} from '../packages/core/src/personal-operations/mcp-connections.js';
for(const mode of ['normal','verifier-denied','verifier-throws','final-regrant','cached-denied','cached-regrant'])test(`MCP verifier and cache use current policy ${mode}`,async t=>{
  const root=mkdtempSync(join(tmpdir(),'jarvis-mcp-policy-')),manager=new McpConnectionManager({storePath:join(root,'mcp.sqlite')});
  t.after(()=>{manager.close();rmSync(root,{recursive:true,force:true});});
  const tool={name:'read',inputSchema:{type:'object',properties:{},additionalProperties:false}};
  manager.fetchImpl=async(_,options)=>{const rpc=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:rpc.id,result:rpc.method==='tools/list'?{tools:[tool]}:{content:[{type:'text',text:'private-fixture'}]}});};
  const entry=manager.add({label:'격리 정책 검사',endpoint:'http://127.0.0.1:12345/mcp',protocolVersion:'2026-07-28'});
  await manager.probe(entry.id);manager.setAllowedTools(entry.id,{tools:['read']});
  manager.registerCapabilityContract(entry.id,{tool:'read',contractHash:manager.get(entry.id).tools[0].contractHash,packageId:'policy.read',version:'1.0.0',source:'https://example.org/fixture',effect:'read',verifierId:'policy.oracle',verifierFingerprint:'b'.repeat(64)});
  let phase='initial';const regrant=()=>{manager.setAllowedTools(entry.id,{tools:[]});manager.setAllowedTools(entry.id,{tools:['read']});};
  const authorize=({source})=>{
    if(phase==='verified'&&mode==='verifier-throws')throw new Error('private-fixture');
    if(phase==='verified'&&mode==='verifier-denied')return {allowed:false};
    if(mode==='final-regrant'&&source==='mcp-verified-result-delivery')regrant();
    if(phase==='cached'&&mode==='cached-denied')return {allowed:false};
    if(phase==='cached'&&mode==='cached-regrant')regrant();
    return {allowed:true};
  };
  const verifiers=new Map([['policy.oracle',{fingerprint:'b'.repeat(64),async verify(){await Promise.resolve();phase='verified';return {valid:true,evidenceRef:'local:fixture'};}}]]);
  const input={tool:'read',arguments:{},expectedText:'private-fixture',requestId:'verifier_policy_00000001'};
  if(['verifier-denied','verifier-throws','final-regrant'].includes(mode)){
    await assert.rejects(manager.callVerifiedCapability(entry.id,input,authorize,{verifiers}),/POLICY_DENIED|PERMISSION_CHANGED/);
    assert.equal(manager.verificationReceipt(entry.id,input.requestId),null);assert.equal(manager.verifiedResults.size,0);
  }else{
    const result=await manager.callVerifiedCapability(entry.id,input,authorize,{verifiers});assert.equal(result.businessOutcomeVerified,true);
    phase='cached';
    if(mode==='normal')assert.equal(manager.readVerifiedResult(entry.id,input.requestId).result.content[0].text,'private-fixture');
    else assert.throws(()=>manager.readVerifiedResult(entry.id,input.requestId),/POLICY_DENIED|ACCESS_REVOKED/);
  }
});
