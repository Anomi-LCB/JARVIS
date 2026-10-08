import {join,resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {McpConnectionManager} from '../../packages/core/src/personal-operations/mcp-connections.js';
import {createCoreServer} from '../../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../../packages/shared/src/http.js';
import {PcOutboundMailbox} from '../../packages/core/src/client/pc-outbound-mailbox.js';
import {PcOutboundNodeController} from '../../packages/core/src/client/pc-outbound-service.js';
const root=process.argv[2],env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
let externalCalls=0;
const nativeFetch=globalThis.fetch;globalThis.fetch=(url,...args)=>{if(!String(url).startsWith('http://127.0.0.1:')){externalCalls++;throw Error('external-request-not-allowed');}return nativeFetch(url,...args);};
let runtime,core,base;
const mailbox=new PcOutboundMailbox({dbPath:join(root,'pc-nodes.sqlite'),authorityGuard:()=>({token:1})});
const nodes=new PcOutboundNodeController({mailbox,authorityGuard:()=>({token:1}),ca:await readFile(new URL('./google-broker-tls/ca.pem',import.meta.url),'utf8')});
nodes.enroll({deviceId:'isolated-pc',label:'격리 PC',certificateFingerprint:'AB:'.repeat(31)+'AB',expiresAt:new Date(Date.now()+3600000).toISOString().replace(/\.\d{3}Z$/u,'Z'),allowedTaskIds:[],allowedArtifactTaskIds:[],expectedGeneration:0});
async function start(){runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,});core=createCoreServer(runtime.coreFacade,{pcOutboundNodes:nodes,adminToken:'isolated-ui-admin',missionRuntime:runtime.missionRuntime,a2aServiceRegistry:runtime.a2aServiceRegistry,capabilityPackageRegistry:runtime.capabilityPackageRegistry,trustKernel:runtime.trustKernel});const address=await listenOnFetchSafePort(core);base=`http://127.0.0.1:${address.port}`;}
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
 if(command==='restart'){await new Promise(r=>core.close(r));runtime.a2aServiceRegistry.close();await start();console.log(JSON.stringify({status:'restarted',externalCalls}));}
 else if(command==='review'){const service=runtime.a2aServiceRegistry.list().services[0];runtime.a2aServiceRegistry.registerReviewedContract(service.id,{skillId:'research',cardHash:service.cardHash,agentVersion:'1.2.0',version:'1.0.0',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']},outputSchema:{type:'object',properties:{answer:{type:'string'}},required:['answer']},effect:'read',source:'https://example.org/reviewed',verifierId:'research.oracle',verifierFingerprint:'c'.repeat(64)});console.log(JSON.stringify({status:'reviewed',externalCalls}));}
 else if(command==='change'){const service=runtime.a2aServiceRegistry.list().services[0],card={...service.card,capabilities:{},version:'2.0.0'};runtime.a2aServiceRegistry.replaceCard(service.id,{card,expectedRevision:service.revision});console.log(JSON.stringify({status:'changed',externalCalls}));}
 else break;
}
await new Promise(r=>ui.close(r));await new Promise(r=>core.close(r));runtime.a2aServiceRegistry.close();mailbox.close();
