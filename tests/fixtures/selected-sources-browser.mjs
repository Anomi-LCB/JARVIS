import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {createCoreServer} from '../../packages/core/src/main.mjs';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../../packages/core/src/personal-operations/source-inbox.js';
import {readSelectedSourceStream} from '../../packages/core/src/personal-operations/selected-source-stream.js';
import {SelectedSourceClient} from '../../apps/pc-agent/src/adapters/selected-source-client.js';
import {listenOnFetchSafePort,sendJson} from '../../packages/shared/src/http.js';
const root=mkdtempSync(join(tmpdir(),'jarvis-sources-browser-')),store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')}),inbox=new PersonalSourceInbox(store);
const stream=inbox.ingest({provider:'outlook',account:'synthetic',scope:'metadata.read',observedAt:'2026-10-07T00:00:00Z',items:Array.from({length:51},(_,i)=>({id:'s'+i,title:i?'합성 자료 '+i:'<img src=x onerror=alert(1)> 합성 안전 검증'}))}).stream;
let current=true,client,reads=0;
const binding={capabilityId:'source.readSelectedInbox',providerId:'core-inbox',accountRef:stream,deviceRef:null,scopes:['metadata.read']};
const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
const runtime=createAgRuntime({env,taskEnv:env,allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,
 capabilityBindingResolver:({toolName})=>toolName==='source.readSelectedInbox'?{required:true,binding,permissionRevision:'one'}:{required:false},
 selectedSourceAccess:{client:{read:(...args)=>{reads++;return client.read(...args);}},authorizeRequest:r=>current&&r.provider==='outlook'&&r.streamRef===stream,
 readCurrentSnapshot:r=>readSelectedSourceStream(inbox,r,{checkAuthorized:()=>current})}});
runtime.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:'one',observedAt:new Date().toISOString(),accountStatus:'connected',observedAccountRef:stream,deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'test:isolated-core'});
runtime.personalOwnerSession.activate({durationMinutes:5,requestedBy:'isolated-browser-test'});
const core=createCoreServer(runtime.coreFacade,{adminToken:'isolated-source-admin',missionRuntime:runtime.missionRuntime,personalInbox:inbox,ownerSessionManager:runtime.personalOwnerSession});
await listenOnFetchSafePort(core);const coreUrl=`http://127.0.0.1:${core.address().port}`;client=new SelectedSourceClient({baseUrl:coreUrl,tokenProvider:()=>Promise.resolve('isolated-source-admin')});
const repo=resolve('.');const ui=createServer(async(req,res)=>{try{
 const path=new URL(req.url,'http://127.0.0.1').pathname;
 if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}
 if(path==='/api/local/capabilities')return sendJson(res,200,{credentialsExposed:false,coreAdminProxyConfigured:true});
 if(path==='/qa/revoke'){current=false;return sendJson(res,200,{revoked:true});}
 if(path==='/qa/reset'){current=true;return sendJson(res,200,{ready:true});}
 if(path==='/qa/metrics')return sendJson(res,200,{reads,externalProviderCalls:0,missions:[...runtime.missionRuntime.missions.values()].map(m=>({status:m.status,successfulActions:m.metrics.successfulActions}))});
 if(path.startsWith('/api/core/')){const chunks=[];for await(const chunk of req)chunks.push(chunk);const result=await fetch(coreUrl+req.url.slice('/api/core'.length),{method:req.method,headers:{authorization:'Bearer isolated-source-admin','content-type':'application/json'},...(req.method!=='GET'?{body:Buffer.concat(chunks)}:{})});res.writeHead(result.status,{'content-type':'application/json','cache-control':'no-store'});res.end(await result.text());return;}
 if(!path.startsWith('/src/ui/')&&!['control-center-hosting','source-change-view','pc-local-denial','workflow-failure-guidance'].some(name=>path===`/packages/shared/src/${name}.js`))return sendJson(res,404,{error:'not-found'});
 const file=resolve(repo,'.'+path);if(!file.startsWith(repo+sep))throw new Error();
 res.writeHead(200,{'content-type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'text/javascript'});res.end(readFileSync(file));
 }catch{sendJson(res,500,{error:'isolated-fixture-failed'});}});
await listenOnFetchSafePort(ui);console.log(JSON.stringify({url:`http://127.0.0.1:${ui.address().port}/src/ui/connections/sources.html`,origin:`http://127.0.0.1:${ui.address().port}`}));
process.stdin.resume();await new Promise(r=>process.stdin.once('data',r));
ui.closeAllConnections();core.closeAllConnections();await Promise.all([new Promise(r=>ui.close(r)),new Promise(r=>core.close(r))]);runtime.coreFacade.cognition?.close();store.close();
if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!basename(root).startsWith('jarvis-sources-browser-'))throw new Error('cleanup-outside-workspace');rmSync(root,{recursive:true,force:true});
