import {IntegrationConnectorRegistry,IntegrationCredentialVault} from '../../packages/core/src/personal-operations/integration-security.js';
import {join,resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {createCoreServer} from '../../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../../packages/shared/src/http.js';
import {registerModelProviderConnectors,registerOpenAiAgentsConnector} from '../../packages/core/src/mission/model-provider-vault.js';
const root=process.argv[2],env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
let externalCalls=0;
const nativeFetch=globalThis.fetch;globalThis.fetch=(url,...args)=>{if(!String(url).startsWith('http://127.0.0.1:')){externalCalls++;throw Error('external-request-not-allowed');}return nativeFetch(url,...args);};
let runtime,core,base,vault,seeded=false;
async function start(){
 vault=new IntegrationCredentialVault({path:join(root,'credentials.dpapi.json')});
 const registry=registerOpenAiAgentsConnector(registerModelProviderConnectors(new IntegrationConnectorRegistry()));
 if(!seeded){for(const name of ['xai','meta','gemini','openai-agents'])vault.save({connectorId:name==='openai-agents'?'jarvis-openai-agents':'jarvis-model-'+name,authMethod:'api-key',providerAccountId:'synthetic-account',label:'격리 '+name,scopes:[name==='openai-agents'?'agents.provider.verify':'model.plan'],credentials:{apiKey:'synthetic-private-'+name}});seeded=true;}
 runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false});
 core=createCoreServer(runtime.coreFacade,{integrationVault:vault,integrationRegistry:registry,adminToken:'isolated-ui-admin',missionRuntime:runtime.missionRuntime,a2aServiceRegistry:runtime.a2aServiceRegistry,capabilityPackageRegistry:runtime.capabilityPackageRegistry,trustKernel:runtime.trustKernel});
 const address=await listenOnFetchSafePort(core);base=`http://127.0.0.1:${address.port}`;
}
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
 else break;
}
await new Promise(r=>ui.close(r));await new Promise(r=>core.close(r));runtime.a2aServiceRegistry.close();
