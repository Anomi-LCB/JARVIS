import {join,resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {McpConnectionManager} from '../../packages/core/src/personal-operations/mcp-connections.js';
import {createCoreServer} from '../../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../../packages/shared/src/http.js';
const root=process.argv[2],env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
let calls=0;
const mcp=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const rpc=JSON.parse(raw);const result=rpc.method==='tools/list'?{tools:[{name:'sum',inputSchema:{type:'object',properties:{a:{type:'integer'},b:{type:'integer'}},required:['a','b']}}]}:(calls++,{structuredContent:{answer:5},content:[{type:'text',text:'5'}]});res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));});
const a=await listenOnFetchSafePort(mcp),manager=new McpConnectionManager({storePath:join(root,'mcp.sqlite')});
const entry=manager.add({label:'격리 계산 도구',endpoint:`http://127.0.0.1:${a.port}/mcp`,protocolVersion:'2026-07-28'});await manager.probe(entry.id);
manager.registerCapabilityContract(entry.id,{tool:'sum',contractHash:manager.get(entry.id).tools[0].contractHash,packageId:'browser.sum',version:'1.0.0',source:'https://example.org/source',effect:'read',verifierId:'sum.oracle',verifierFingerprint:'b'.repeat(64)});
const catalog=new Map([['reviewed.sum',{packageId:'browser.sum',version:'1.0.0',tool:'sum',fingerprint:'c'.repeat(64),authorize:()=>({allowed:false}),verifiers:new Map([['sum.oracle',{fingerprint:'b'.repeat(64),verify:()=>({valid:false})}]])}]]);
let runtime,core,base;
async function start(){runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,mcpConnections:manager,mcpReviewedPackageCatalog:catalog});core=createCoreServer(runtime.coreFacade,{adminToken:'isolated-ui-admin',missionRuntime:runtime.missionRuntime,mcpConnections:manager,mcpPackageInstaller:runtime.mcpPackageInstaller,capabilityPackageRegistry:runtime.capabilityPackageRegistry,trustKernel:runtime.trustKernel});const address=await listenOnFetchSafePort(core);base=`http://127.0.0.1:${address.port}`;}
await start();
const ui=createServer(async(req,res)=>{try{
 if(req.url==='/api/local/capabilities'){res.setHeader('content-type','application/json');res.end(JSON.stringify({credentialsExposed:false,coreAdminProxyConfigured:true}));return;}
 if(req.url.startsWith('/api/core/')){let data='';for await(const chunk of req)data+=chunk;const reply=await fetch(base+req.url.slice('/api/core'.length),{method:req.method,headers:{authorization:'Bearer isolated-ui-admin','content-type':'application/json'},...(data?{body:data}:{})});res.writeHead(reply.status,{'content-type':'application/json'});res.end(await reply.text());return;}
 const path=new URL(req.url,'http://localhost').pathname;
 if(!path.startsWith('/src/')&&!path.startsWith('/packages/')){res.writeHead(404);res.end();return;}
 const file=resolve('.'+path);if(!['src','packages'].some(dir=>file.startsWith(resolve(dir)+'\\')||file.startsWith(resolve(dir)+'/')))throw Error('outside');
 const data=await readFile(file);res.setHeader('content-type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(data);
}catch{res.writeHead(500);res.end();}});
const u=await listenOnFetchSafePort(ui);console.log(JSON.stringify({status:'ready',url:`http://127.0.0.1:${u.port}`}));
const lines=createInterface({input:process.stdin});
for await(const command of lines){
 if(command==='restart'){await new Promise(r=>core.close(r));await start();console.log(JSON.stringify({status:'restarted',calls}));}
 else if(command==='change'){const {endpointHash,registeredAt,...binding}=manager.capabilityReadiness(entry.id,'sum').contract;manager.registerCapabilityContract(entry.id,{...binding,version:'1.0.1'});console.log(JSON.stringify({status:'changed',calls}));}
 else break;
}
await new Promise(r=>ui.close(r));await new Promise(r=>core.close(r));await new Promise(r=>mcp.close(r));manager.close();
