import {join,resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {createPcExecutionRuntime} from '../../apps/runtime-compose/src/create-pc-runtime.js';
import {createPcAgentServer,PcAgentApiGuard} from '../../apps/pc-agent/src/main.mjs';
import {createCoreServer} from '../../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../../packages/shared/src/http.js';
const root=process.argv[2],env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
let externalCalls=0;
const nativeFetch=globalThis.fetch;globalThis.fetch=(url,...args)=>{if(!String(url).startsWith('http://127.0.0.1:')){externalCalls++;throw Error('external-request-not-allowed');}return nativeFetch(url,...args);};
let runtime,core,base,checks=0,sends=0,unavailable=false;
async function start(){
 runtime=createPcExecutionRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false});
 const adapter=runtime.pcAgent.registry.get('email.send');
 adapter.smtpConfig=()=>({user:'synthetic@example.test',pass:'synthetic-browser-secret',service:'gmail'});
 adapter.loadNodemailer=async()=>({createTransport:()=>({verify:async()=>{checks++;return true;},close(){},sendMail:async()=>{sends++;throw Error('send forbidden');}})});
 core=createPcAgentServer(runtime.pcAgent,{emailConnection:runtime.emailConnection,apiGuard:new PcAgentApiGuard({apiToken:'isolated-ui-admin',executionToken:'isolated-executor'})});
 const address=await listenOnFetchSafePort(core);base=`http://127.0.0.1:${address.port}`;
}
await start();
const ui=createServer(async(req,res)=>{try{
 if(req.url==='/api/local/capabilities'){res.setHeader('content-type','application/json');res.end(JSON.stringify({credentialsExposed:false,coreAdminProxyConfigured:false,pcAgentProxyConfigured:true}));return;}
 if(unavailable&&req.url==='/api/pc/email/connection'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'A_EMAIL_CONNECTION_UNAVAILABLE'}}));return;}
 if(req.url.startsWith('/api/pc/')){let data='';for await(const chunk of req)data+=chunk;const reply=await fetch(base+req.url.slice('/api/pc'.length),{method:req.method,headers:{authorization:'Bearer isolated-ui-admin','content-type':'application/json'},...(data?{body:data}:{})});res.writeHead(reply.status,{'content-type':'application/json'});res.end(await reply.text());return;}
 const path=new URL(req.url,'http://localhost').pathname;
 if(!path.startsWith('/src/')&&!path.startsWith('/packages/')){res.writeHead(404);res.end();return;}
 const file=resolve('.'+path);if(!['src','packages'].some(dir=>file.startsWith(resolve(dir)+'\\')||file.startsWith(resolve(dir)+'/')))throw Error('outside');
 const data=await readFile(file);res.setHeader('content-type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(data);
}catch{res.writeHead(500);res.end();}});
const u=await listenOnFetchSafePort(ui);console.log(JSON.stringify({status:'ready',url:`http://127.0.0.1:${u.port}`}));
const lines=createInterface({input:process.stdin});
for await(const command of lines){
 if(command==='counts')console.log(JSON.stringify({checks,sends,externalCalls}));
 else if(command==='unavailable'||command==='available'){unavailable=command==='unavailable';console.log(JSON.stringify({unavailable}));}else break;
}
await new Promise(r=>ui.close(r));await new Promise(r=>core.close(r));
