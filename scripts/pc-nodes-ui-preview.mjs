// Explicit disposable UI QA fixture: real Core/PC/TLS APIs, synthetic identities, no external network.
import { PcLocalTaskScope } from '../apps/pc-agent/src/pc-local-task-scope.js';
import { ActionType,TaskStatus } from '../packages/shared/src/types.js';
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfiguredCoreServiceRuntime } from './core-service-runtime.mjs';
import { startPcOutboundNodeService } from '../packages/core/src/client/pc-outbound-service.js';
import { createPcOutboundTransport } from '../packages/core/src/client/pc-outbound-https.js';
import { createPcOutboundObserver } from '../apps/pc-agent/src/outbound-observer.js';
import { PcAgentExecutionClient } from '../packages/core/src/client/pc-agent-execution-client.js';
import { createPcAgentServer, PcAgentApiGuard } from '../apps/pc-agent/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

const repo=fileURLToPath(new URL('../',import.meta.url)), root=mkdtempSync(join(tmpdir(),'jarvis-device-ui-'));
const pem=name=>readFileSync(new URL(`../tests/fixtures/google-broker-tls/${name}.pem`,import.meta.url));
const token='device-ui-synthetic-core-admin';let certificateRequests=0,enrollmentRequests=0;
const openCore=expectedToken=>createConfiguredCoreServiceRuntime({env:{JARVIS_TEST_MODE:'1',JARVIS_CORE_ROOT:root,JARVIS_TEST_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_ALLOWED_ROOTS:'workspace',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_CORE_ADMIN_TOKEN:token,JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:String(expectedToken),JARVIS_PERSONAL_OPERATIONS_DB:join(root,'operations.sqlite')},
  pcOutboundServiceFactory:({authorityGuard})=>startPcOutboundNodeService({dbPath:join(root,'nodes.sqlite'),authorityGuard,commandTransport:true,commandExecutionFenceRequired:true,tls:{key:pem('server-key'),cert:pem('server'),ca:pem('ca')}})});
let core=await openCore(0);
if(process.argv.includes('--mission-task-options')){
  core.missionRuntime.planner={async planNextWave(){return {decision:'continue',summary:'격리 목록 조회',actions:[{id:'saved_catalog',title:'재시작 뒤에도 남는 연구 자료 목록',command:'작업 폴더 파일 목록 보여줘',expectedToolName:'filesystem.listFiles',dependencies:[],successSignal:'파일 목록 반환'}]};}};
  const mission=core.missionRuntime.createMission({objective:'연구 자료 목록을 확인해',successCriteria:['파일 목록 확인'],authorization:{grants:['read_only']}});
  const result=await core.missionRuntime.runMission(mission.missionId,{maxWaves:1});
  const taskId=result.waves?.[0]?.actions?.[0]?.taskId;if(!taskId||result.waves[0].actions[0].status!=='succeeded')throw new Error('Isolated persisted task fixture failed');
  const token=core.missionExecutionAuthority.lease.token;await core.close();core=await openCore(token);
  if(core.coreFacade.getTask(taskId)||!core.missionRuntime.getMission(mission.missionId))throw new Error('Isolated restart fixture failed');
}
if(process.argv.includes('--reserved-task-options')){
 const mission=core.missionRuntime.createMission({objective:'자료를 연구하고 보고서를 저장해',authorization:{grants:['read_only']}});
 core.missionRuntime.createWave(core.missionRuntime.missions.get(mission.missionId),{actions:[{id:'prepare_report',title:'연구 보고서 작성 · 실행 전 준비',command:'result.txt 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:join(root,'workspace','result.txt'),content:'synthetic planned content'},dependencies:[],successSignal:'결과 재조회'}]});
 core.missionRuntime.persist('isolated-planned-task-preview');
}
await listenOnFetchSafePort(core.server,{host:'127.0.0.1',port:0});
if(process.argv.includes('--command-scope')){
  const checked=core.pcOutboundService.controller.previewCertificate({certificatePem:pem('core').toString()});
  core.pcOutboundService.controller.enroll({deviceId:'qa-pc',label:'검증용 PC (임시)',certificateFingerprint:checked.certificateFingerprint,expiresAt:new Date(Date.now()+3600000).toISOString().replace(/\.\d{3}Z$/u,'Z'),allowedTaskIds:['report-draft','read-only'],allowedArtifactTaskIds:['report-draft'],expectedGeneration:0});
}

if(process.argv.includes('--catalog')){
  const workspace=join(root,'workspace');
  const action={actionType:ActionType.CREATE_FILE,toolName:'filesystem.createTextFile',arguments:{path:join(workspace,'qa-report.txt'),content:'Isolated task catalog UI evidence'}};
  const taskId='report-draft',planId='catalog-ui-plan',approvalId='catalog-ui-approval';
  const capabilityToken=core.policyRuntime.capabilities.issue({taskId,planId,approvalId,action,allowedPaths:[workspace]});
  const result=await core.pcAgent.receiveExecutionPacket({packetId:'catalog-ui-packet',taskId,planId,action,capabilityToken,requestedMode:'execute',userConfirmation:{approvalId,confirmed:true,confirmedAt:new Date().toISOString()}});
  if(result.status!==TaskStatus.COMPLETED)throw new Error('Isolated catalog file fixture failed');
}
if(process.argv.includes('--task-options'))core.coreFacade.createTask('workspace/new-note.txt 파일을 만들어줘');
const localTaskIds=process.argv.includes('--local-permissions')?['workspace/report.txt 파일을 만들어줘','작업 폴더 파일 목록 보여줘'].map(command=>core.coreFacade.createTask(command).taskId):[];
if(localTaskIds.some(id=>!id))throw new Error('Isolated named task fixture failed');
const readinessPreview=process.argv.includes('--readiness');
const managedCatalog=readinessPreview||process.argv.includes('--local-catalog');
const localScope=managedCatalog||process.argv.includes('--local-permissions')?new PcLocalTaskScope({dbPath:join(root,'pc-scope.sqlite'),managedCatalog}):null;
if(readinessPreview)localScope.replaceCatalog({expectedRevision:0,allowedTaskIds:['report-draft','read-only'],allowedArtifactTaskIds:['report-draft'],allowedCommandTaskIds:['report-draft']});
const pc=createPcAgentServer(core.pcAgent,{localTaskScope:localScope,localTaskIds:managedCatalog?[]:localTaskIds,apiGuard:new PcAgentApiGuard({apiToken:'device-ui-synthetic-pc-admin',executionToken:'device-ui-synthetic-pc-execution'})});
await listenOnFetchSafePort(pc,{host:'127.0.0.1',port:0});
const transport=createPcOutboundTransport({url:`https://127.0.0.1:${core.pcOutboundService.address.port}/v1/pc/observe`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
const observer=createPcOutboundObserver({transport,taskCatalog:readinessPreview?localScope:null,allowedTaskIds:!readinessPreview&&process.argv.includes('--catalog')?['report-draft','read-only']:[],pcClient:new PcAgentExecutionClient({baseUrl:`http://127.0.0.1:${pc.address().port}`,executionToken:'device-ui-synthetic-pc-execution'})});
let stopped=false;
const timer=setInterval(()=>{if(!stopped)void observer.tick().catch(()=>{});},250);
const ui=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/api/local/capabilities'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({credentialsExposed:false,coreAdminProxyConfigured:true,pcAgentProxyConfigured:true}));}
  if(url.pathname==='/__fixture/state'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({certificateRequests,enrollmentRequests,commandScope:process.argv.includes('--command-scope')?core.pcOutboundService.controller.commandScope('qa-pc'):null,status:core.pcOutboundService.controller.status()}));}
  if(url.pathname.startsWith('/api/pc/')){const upstream=httpRequest({hostname:'127.0.0.1',port:pc.address().port,path:url.pathname.slice('/api/pc'.length)+url.search,method:req.method,headers:{authorization:'Bearer device-ui-synthetic-pc-admin',...(req.headers['content-type']?{'content-type':req.headers['content-type']}:{}),connection:'close'}},incoming=>{res.writeHead(incoming.statusCode,{'content-type':'application/json'});incoming.pipe(res);});upstream.on('error',()=>{res.statusCode=502;res.end('{}');});req.pipe(upstream);return;}
  if(url.pathname.startsWith('/api/core/')){
    if(req.method==='POST'&&url.pathname==='/api/core/pc-nodes/certificate')certificateRequests++;
    if(req.method==='POST'&&url.pathname==='/api/core/pc-nodes')enrollmentRequests++;
    const upstream=httpRequest({hostname:'127.0.0.1',port:core.server.address().port,path:url.pathname.slice('/api/core'.length)+url.search,method:req.method,
      headers:{authorization:`Bearer ${token}`,...(req.headers['content-type']?{'content-type':req.headers['content-type']}:{}),...(req.headers['content-length']?{'content-length':req.headers['content-length']}:{}),connection:'close'}},incoming=>{if(req.method==='POST'&&(process.argv.includes('--delay-command-response')&&url.pathname.endsWith('/command-scope')||process.argv.includes('--delay-task-labels')&&url.pathname.endsWith('/task-labels'))){const chunks=[];incoming.on('data',chunk=>chunks.push(chunk));incoming.on('end',()=>setTimeout(()=>{if(!res.destroyed){res.writeHead(incoming.statusCode,{'content-type':'application/json'});res.end(Buffer.concat(chunks));}},url.pathname.endsWith('/task-labels')?2000:2500));return;}res.writeHead(incoming.statusCode,{'content-type':'application/json'});incoming.pipe(res);});
    upstream.on('error',()=>{res.statusCode=502;res.end('{}');});req.pipe(upstream);return;
  }
  const file=resolve(repo,url.pathname.slice(1));
  if(!file.startsWith(resolve(repo,'src/ui')+'/')&&!file.startsWith(resolve(repo,'src/ui')+'\\')
    &&file!==resolve(repo,'packages/shared/src/control-center-hosting.js')){res.statusCode=404;return res.end('fixture');}
  try{const bytes=await readFile(file);res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]??'application/octet-stream');res.end(bytes);}catch{res.statusCode=404;res.end();}
});
await listenOnFetchSafePort(ui,{host:'127.0.0.1',port:0});
console.log(JSON.stringify({url:`http://127.0.0.1:${ui.address().port}/src/ui/connections/${readinessPreview?'devices':managedCatalog?'pc-tasks':localScope?'pc-permissions':'devices'}.html`,fixture:'synthetic-local-only'}));
async function close(){if(stopped)return;stopped=true;clearInterval(timer);transport.close();ui.closeAllConnections();pc.closeAllConnections();await Promise.all([new Promise(r=>ui.close(r)),new Promise(r=>pc.close(r))]);await core.close();localScope?.close();rmSync(root,{recursive:true,force:true});}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void close().then(()=>process.exit(0)));

process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.trim()==='quit')void close().then(()=>process.exit(0));});
