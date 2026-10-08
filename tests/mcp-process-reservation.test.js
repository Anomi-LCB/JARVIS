import test from 'node:test';import assert from 'node:assert/strict';import {fork} from 'node:child_process';import {createServer} from 'node:http';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {McpConnectionManager} from '../packages/core/src/personal-operations/mcp-connections.js';import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const tool={name:'sum',inputSchema:{type:'object',properties:{a:{type:'integer'},b:{type:'integer'}},required:['a','b'],additionalProperties:false}};
test('two real processes reserve one MCP effect and response loss blocks retries after reopen',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-mcp-race-')),dbPath=join(root,'mcp.sqlite'),manager=new McpConnectionManager({storePath:dbPath});let barrier=false,effects=0;const held=[],children=[];
 const reply=(res,rpc)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{tools:[tool]}}));};
 const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const rpc=JSON.parse(raw);
  if(rpc.method==='tools/list'){if(barrier&&held.length<2){held.push({res,rpc});if(held.length===2){barrier=false;for(const h of held)reply(h.res,h.rpc);}return;}reply(res,rpc);}
  else{effects++;req.socket.destroy();}
 });await listenOnFetchSafePort(server);t.after(async()=>{for(const child of children)if(child.exitCode===null)child.kill();await new Promise(r=>server.close(r));try{manager.close();}catch{}rmSync(root,{recursive:true,force:true});});
 const endpoint=`http://127.0.0.1:${server.address().port}/mcp`;const entry=manager.add({label:'isolated race',endpoint,protocolVersion:'2026-07-28'});await manager.probe(entry.id);manager.setAllowedTools(entry.id,{tools:['sum']});barrier=true;
 const run=requestId=>new Promise((resolve,reject)=>{const child=fork('tests/fixtures/mcp-call-child.mjs',[dbPath,entry.id,requestId],{silent:true,windowsHide:true});children.push(child);let result,stderr='';child.stderr.on('data',c=>stderr+=c);child.on('message',m=>{result=m;});child.on('error',reject);child.on('exit',code=>code===0&&result?resolve(result):reject(Error('child '+code+' '+stderr)));});
 const results=await Promise.all([run('race_request_00000001'),run('race_request_00000002')]);assert.equal(held.length,2);assert.equal(effects,1);
 assert.equal(results.filter(r=>r.status==='outcome-unknown').length,1);assert.equal(results.filter(r=>r.code==='A_MCP_UNRESOLVED_OUTCOME').length,1);
 assert.equal(manager.db().prepare('SELECT count(*) AS n FROM mcp_calls').get().n,1);manager.close();
 const reopened=new McpConnectionManager({storePath:dbPath});try{await assert.rejects(reopened.call(entry.id,{tool:'sum',arguments:{a:2,b:3},expectedText:'5',requestId:'race_request_00000003'},()=>({allowed:true})),/UNRESOLVED_OUTCOME/);assert.equal(effects,1);}finally{reopened.close();}
 t.diagnostic(JSON.stringify({processes:2,actualHttpEffects:effects,responseLost:true,blockedAfterReopen:true,externalCalls:0}));
});
