import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpConnectionManager} from '../packages/core/src/personal-operations/mcp-connections.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'mcp-install-'));
 const manager=new McpConnectionManager({storePath:join(root,'mcp.sqlite'),fetchImpl:async(_,options)=>{const rpc=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:rpc.id,result:{tools:[{name:'sum',inputSchema:{type:'object',properties:{a:{type:'integer'},b:{type:'integer'}},required:['a','b']}}]}});}});
 t.after(()=>{manager.close();rmSync(root,{recursive:true,force:true});});
 const entry=manager.add({label:'install fixture',endpoint:'http://127.0.0.1:12345/mcp',protocolVersion:'2026-07-28'});await manager.probe(entry.id);
 manager.registerCapabilityContract(entry.id,{tool:'sum',contractHash:manager.get(entry.id).tools[0].contractHash,packageId:'install.sum',version:'1.0.0',source:'https://example.org/source',effect:'read',verifierId:'sum.oracle',verifierFingerprint:'b'.repeat(64)});
 const catalog=new Map([['reviewed.sum',{packageId:'install.sum',version:'1.0.0',tool:'sum',fingerprint:'c'.repeat(64),authorize:()=>({allowed:false}),verifiers:new Map([['sum.oracle',{fingerprint:'b'.repeat(64),verify:()=>({valid:false})}]])}]]);
 const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const runtime=()=>createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,mcpConnections:manager,mcpReviewedPackageCatalog:catalog});
 return {root,manager,entry,catalog,runtime,input:{connectionId:entry.id,tool:'sum',catalogId:'reviewed.sum'}};
}
test('reviewed package selection persists and rehydrates code without granting tool execution',async t=>{
 const f=await fixture(t),r=f.runtime();assert.equal(r.mcpPackageInstaller.install(f.input).status,'installed');
 assert.equal(f.manager.get(f.entry.id).allowedTools.length,0);
 const restored=f.runtime();assert.equal(restored.mcpPackageInstaller.status().installations[0].status,'installed');
 assert.equal(restored.mcpPackageInstaller.status().autonomousExecutionAuthorized,false);
 const {endpointHash,registeredAt,...binding}=f.manager.capabilityReadiness(f.entry.id,'sum').contract;
 f.manager.registerCapabilityContract(f.entry.id,{...binding,version:'1.0.1'});
 assert.equal(f.runtime().mcpPackageInstaller.status().installations[0].reasonCode,'A_MCP_INSTALL_CONTRACT_CHANGED');
});
test('unreviewed code, bad verifier and input paths never persist installation selections',async t=>{
 const f=await fixture(t),r=f.runtime();
 assert.throws(()=>r.mcpPackageInstaller.install({...f.input,catalogId:'https://bad.example/module.js'}),/REVIEWED_CODE_MISSING/);
 assert.throws(()=>r.mcpPackageInstaller.install({...f.input,modulePath:'C:/bad.mjs'}),/INPUT_INVALID/);
 f.catalog.get('reviewed.sum').verifiers.clear();
 assert.throws(()=>r.mcpPackageInstaller.install(f.input),/VERIFIER_REQUIRED/);
 assert.equal(r.mcpPackageInstaller.entries().length,0);
 assert.throws(()=>createAgRuntime({pcAgentExecutor:{},mcpReviewedPackageCatalog:f.catalog}),/local executor/);
 assert.throws(()=>createAgRuntime({mcpReviewedPackageCatalog:{modulePath:'unsafe'}}),/local Map/);
});
test('removed connection and changed reviewed fingerprint block restoration without loading remote code',async t=>{
 const f=await fixture(t),r=f.runtime();r.mcpPackageInstaller.install(f.input);
 f.catalog.get('reviewed.sum').fingerprint='d'.repeat(64);
 assert.equal(f.runtime().mcpPackageInstaller.status().installations[0].reasonCode,'A_MCP_INSTALL_REVIEWED_CODE_MISSING');
 f.catalog.get('reviewed.sum').fingerprint='c'.repeat(64);f.manager.remove(f.entry.id);
 assert.equal(f.runtime().mcpPackageInstaller.status().installations[0].reasonCode,'A_MCP_NOT_FOUND');
});
test('actual Core installation route requires admin and selects only an existing local catalog item',async t=>{
 const f=await fixture(t),r=f.runtime();
 const server=createCoreServer(r.coreFacade,{adminToken:'installer-test',missionRuntime:r.missionRuntime,mcpConnections:f.manager,mcpPackageInstaller:r.mcpPackageInstaller,capabilityPackageRegistry:r.capabilityPackageRegistry});
 const address=await listenOnFetchSafePort(server),base=`http://127.0.0.1:${address.port}/integrations/mcp`;
 try{
  const post=(body,auth=true)=>fetch(`${base}/${f.entry.id}/install`,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer installer-test'}:{})},body:JSON.stringify(body)});
  assert.equal((await post({tool:'sum',catalogId:'reviewed.sum'},false)).status,401);
  assert.equal((await post({tool:'sum',catalogId:'reviewed.sum',modulePath:'unsafe'})).status,400);
  const response=await post({tool:'sum',catalogId:'reviewed.sum'});assert.equal(response.status,200);assert.equal((await response.json()).status,'installed');
  const status=await fetch(base+'/packages',{headers:{authorization:'Bearer installer-test'}});assert.equal(status.status,200);assert.equal((await status.json()).installations[0].status,'installed');
  const tools=await fetch(base,{headers:{authorization:'Bearer installer-test'}});assert.equal((await tools.json()).connections[0].capabilityReadiness[0].packageInstalled,true);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
