import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpConnectionManager} from '../packages/core/src/personal-operations/mcp-connections.js';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';

for(const mode of ['normal','revoke','regrant','remove','policy-denied','policy-throws','policy-regrant','malformed-result'])test(`actual HTTP MCP result delivery rechecks ${mode}`,async t=>{
  const root=mkdtempSync(join(tmpdir(),'jarvis-mcp-delivery-'));
  const manager=new McpConnectionManager({storePath:join(root,'mcp.sqlite')});
  const peer=new McpConnectionManager({storePath:manager.storePath});
  const tool={name:'read',inputSchema:{type:'object',properties:{},additionalProperties:false}};
  const secret='synthetic-private-result-do-not-log';let entry,calls=0;
  const revoke=()=>{peer.setAllowedTools(entry.id,{tools:[]});};
  const regrant=()=>{revoke();peer.setAllowedTools(entry.id,{tools:['read']});};
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const rpc=JSON.parse(raw);
    let result;
    if(rpc.method==='tools/list')result={tools:[tool]};
    else{
      calls++;if(mode==='revoke')revoke();if(mode==='regrant')regrant();if(mode==='remove')peer.remove(entry.id);
      result={content:[{type:mode==='malformed-result'?'image':'text',text:secret}]};
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  });
  const address=await listenOnFetchSafePort(server);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));peer.close();manager.close();rmSync(root,{recursive:true,force:true});});
  entry=manager.add({label:'격리 결과 검사',endpoint:`http://127.0.0.1:${address.port}/mcp`,protocolVersion:'2026-07-28'});
  await manager.probe(entry.id);manager.setAllowedTools(entry.id,{tools:['read']});
  const sources=[],authorize=({source})=>{
    sources.push(source);
    if(source==='mcp-result-delivery'){
      if(mode==='policy-denied')return {allowed:false};
      if(mode==='policy-throws')throw new Error(secret);
      if(mode==='policy-regrant')regrant();
    }
    return {allowed:true};
  };
  const input={tool:'read',arguments:{},expectedText:secret,requestId:'result_currentness_000001'};
  const result=await manager.call(entry.id,input,authorize);
  assert.equal(calls,1);if(mode!=='malformed-result')assert.ok(sources.includes('mcp-result-delivery'));
  if(mode==='normal'){assert.equal(result.status,'expectation-matched');assert.equal(result.result.content[0].text,secret);}
  else{assert.equal(result.status,mode==='malformed-result'?'outcome-unknown':'result-withheld');assert.equal(result.result,undefined);assert.equal(result.providerResponseReceived,mode==='malformed-result'?undefined:true);assert.equal(result.businessOutcomeVerified,false);assert.equal(result.automaticRetryAllowed,false);assert.ok(!JSON.stringify(result).includes(secret));}
  const persisted=manager.db().prepare('SELECT value FROM mcp_calls WHERE id=?').get(input.requestId).value;
  assert.ok(!persisted.includes(secret));assert.equal(JSON.parse(persisted).status,result.status);
  await assert.rejects(manager.call(entry.id,input,authorize),{code:'A_MCP_REQUEST_ALREADY_USED'});assert.equal(calls,1);
});
