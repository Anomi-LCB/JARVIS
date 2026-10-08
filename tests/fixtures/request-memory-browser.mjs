import {createServer,request as upstreamRequest} from 'node:http';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,extname,sep} from 'node:path';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {SqliteMemoryStore} from '../../apps/growth-memory/src/db/sqlite-store.js';
import {createCoreServer} from '../../packages/core/src/main.mjs';
import {DurableRoutineScheduler} from '../../packages/core/src/runtime/durable-routine-scheduler.js';
import {MemoryDurableRoutineStore} from '../../packages/core/src/runtime/durable-routine-store.js';
const root=mkdtempSync(join(tmpdir(),'jarvis-request-memory-browser-'));
writeFileSync(join(root,'synthetic-input.txt'),'격리 파일 관측');
const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const runtime=createAgRuntime({memoryStore:store,allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,
 env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_MISSION_EXECUTIVE:'0'},personalContextProvider:()=>null,
 missionPlanner:{async planNextWave(context){return context.observations.length ? {decision:'pause',summary:'실제 목록 관측 후 다음 자료 대기',actions:[]} : {
  decision:'continue',actions:[{id:'listing',command:'파일 목록 보여줘',expectedToolName:'filesystem.listFiles',arguments:{directory:root},dependencies:[]}]};}}});
const scheduler=new DurableRoutineScheduler({store:new MemoryDurableRoutineStore(),missionRuntime:runtime.missionRuntime});
const core=createCoreServer(runtime.coreFacade,{adminToken:'synthetic-browser-only',missionRuntime:runtime.missionRuntime,routineScheduler:scheduler,
 trustKernel:runtime.trustKernel,ownerSessionManager:runtime.personalOwnerSession});
await new Promise(r=>core.listen(0,'127.0.0.1',r));
const repo=resolve('.');
const outer=createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/api/local/capabilities'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({credentialsExposed:false,coreAdminProxyConfigured:true}));}
 if(url.pathname.startsWith('/api/core')){
  const headers={...req.headers,authorization:'Bearer synthetic-browser-only',host:`127.0.0.1:${core.address().port}`};
  for(const name of ['origin','referer','sec-fetch-site','sec-fetch-mode','sec-fetch-dest','forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','cookie'])delete headers[name];
  const proxy=upstreamRequest({host:'127.0.0.1',port:core.address().port,path:url.pathname.slice('/api/core'.length)+url.search,method:req.method,
   headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  proxy.on('error',()=>{res.statusCode=503;res.end();});req.pipe(proxy);return;
 }
 const file=resolve(repo,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
 if(!file.startsWith(repo+sep)){res.statusCode=403;return res.end();}
 try{res.setHeader('content-type',({'.html':'text/html;charset=utf-8','.css':'text/css;charset=utf-8','.js':'text/javascript;charset=utf-8'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file));}catch{res.statusCode=404;res.end();}
});
await new Promise(r=>outer.listen(0,'127.0.0.1',r));
console.log(JSON.stringify({url:`http://127.0.0.1:${outer.address().port}/`,isolated:true}));
process.stdin.once('data',async()=>{outer.closeAllConnections();core.closeAllConnections();await Promise.all([new Promise(r=>outer.close(r)),new Promise(r=>core.close(r))]);runtime.coreFacade.cognition?.close();store.close();rmSync(root,{recursive:true,force:true});process.exit(0);});
