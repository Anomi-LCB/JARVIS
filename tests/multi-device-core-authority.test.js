import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {once} from 'node:events';
import {createConfiguredCoreServiceRuntime} from '../scripts/core-service-runtime.mjs';
import {createCoreBridgeGateway} from '../apps/bridge/src/core-gateway.js';
import {BridgeClient} from '../apps/mobile/src/api/BridgeClient.js';
import {WearableHudAdapter} from '../apps/wearable-hud/src/hud-adapter.js';
import {createBrowserBridgeRequester,createWearableHudBrowserConfig} from '../apps/wearable-hud/src/browser-client.js';
import {createPcExecutionRuntime} from '../apps/runtime-compose/src/create-pc-runtime.js';

async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function close(server){server.closeGatewayConnections?.();server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));}

test('actual mobile, wearable adapter and wearable browser requests share one Core over separate gateways',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-three-core-clients-'));
 const env={JARVIS_TEST_MODE:'1',JARVIS_CORE_ROOT:root,JARVIS_TEST_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_PORT:'0',
  JARVIS_CORE_MOBILE_GATEWAY_ENABLED:'1',JARVIS_DEVICE_TOKEN_SECRET:'isolated-three-client-token-secret-32',JARVIS_BRIDGE_STATE_DIR:join(root,'paired'),
  JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',
  JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const runtime=await createConfiguredCoreServiceRuntime({env}),gateways=[];
 t.after(async()=>{for(const gateway of gateways)await close(gateway);await runtime.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const coreUrl=await listen(runtime.server),urls=[];
 for(let i=0;i<3;i++){const gateway=createCoreBridgeGateway({coreUrl});gateways.push(gateway);urls.push(await listen(gateway));}
 const pair=async(index)=>{const start=await(await fetch(`${urls[index]}/pairing/start`,{method:'POST'})).json();
  const paired=await(await fetch(`${urls[index]}/pairing/confirm`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId:`isolated-device-${index}`,deviceName:`client-${index}`,pairingCode:start.pairingCode})})).json();assert.ok(paired.deviceToken,JSON.stringify(paired));return paired.deviceToken;};
 // Pair sequentially because each challenge has one owner; workload requests are concurrent.
 const tokens=[];for(let i=0;i<3;i++)tokens.push(await pair(i));
 const mobile=new BridgeClient({bridgeUrl:urls[0],tokenProvider:()=>tokens[0],retries:0});
 const wearable=new WearableHudAdapter({bridgeUrl:urls[1],tokenProvider:()=>tokens[1]});
 const browser=createBrowserBridgeRequester({config:createWearableHudBrowserConfig({bridgeUrl:urls[2]}),tokenProvider:()=>tokens[2]});
 const commands=['mobile-core 메모 파일을 만들어줘. 내용은 MOBILE_CORE_FIXED','wearable-core 메모 파일을 만들어줘. 내용은 WEARABLE_CORE_FIXED','browser-core 메모 파일을 만들어줘. 내용은 BROWSER_CORE_FIXED'];
 const results=await Promise.all([mobile.createTask({rawText:commands[0],requestId:'mobile-fixed'}),
  wearable.bridgeClient.createTask({rawText:commands[1],requestId:'wearable-fixed'}),
  browser('/tasks',{method:'POST',body:{rawText:commands[2],requestId:'browser-fixed'}})]);
 assert.equal(new Set(results.map(r=>r.taskId)).size,3);for(const result of results){assert.ok(result.taskId,JSON.stringify(result));assert.ok(runtime.coreFacade.tasks.has(result.taskId));}
 assert.equal(runtime.bridgeRuntime.coreFacade,runtime.coreFacade);assert.equal(runtime.bridgeRuntime.orchestrationWorker,runtime.orchestrationWorker);
 assert.equal(runtime.coreFacade.tasks.size,3);
 const states=await Promise.all([mobile.getTaskStatus(results[2].taskId),wearable.bridgeClient.getTaskStatus(results[0].taskId),browser(`/tasks/${encodeURIComponent(results[1].taskId)}`)]);
 for(const state of states)assert.notEqual(state.success,false,JSON.stringify(state));
 const sync=await wearable.syncOnce({taskId:results[1].taskId});assert.equal(sync.status,'synced');
 const health=await browser('/health');assert.equal(health.executionAuthorityMode,'core-api');
 const requesters=[mobile.request.bind(mobile),wearable.bridgeClient.request.bind(wearable.bridgeClient),browser];
 let workerCalls=0;const originalRun=runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);runtime.orchestrationWorker.runTask=(...args)=>{workerCalls++;return originalRun(...args);};
 const artifacts=[];
 for(let i=0;i<3;i++){
  const requester=requesters[i],approval=(await requester('/approvals')).items.find(item=>item.taskId===results[i].taskId);assert.ok(approval);
  const decision=await requester(`/approvals/${encodeURIComponent(approval.approvalId)}/decision`,{method:'POST',body:{decision:'approve'}});assert.ok(decision.handoffId,JSON.stringify(decision));
  const path=`/execution-handoffs/${encodeURIComponent(decision.handoffId)}/confirm`;
  const completed=await requester(path,{method:'POST'});assert.equal(completed.status,'COMPLETED',JSON.stringify(completed));
  const result=await requester(`/results/${encodeURIComponent(results[i].taskId)}`),paths=result.executionResult.outputPaths;assert.equal(paths.length,1);
  const content=await readFile(paths[0],'utf8');assert.match(content,new RegExp(['MOBILE_CORE_FIXED','WEARABLE_CORE_FIXED','BROWSER_CORE_FIXED'][i]));artifacts.push(paths[0]);
  await requester(path,{method:'POST'});assert.equal(workerCalls,i+1);
 }
 assert.equal(new Set(artifacts).size,3);
 const replay=await mobile.createTask({rawText:commands[0],requestId:'mobile-fixed'});assert.equal(replay.error?.code,'D_REQUEST_REPLAY_BLOCKED');assert.equal(runtime.coreFacade.tasks.size,3);
 const denied=await fetch(`${urls[2]}/tasks`,{headers:{authorization:'Bearer invalid-token'}});assert.equal((await denied.json()).success,false);
 let stopCalls=0,shutdownCalls=0;
 const stop=runtime.workerDaemon.stop.bind(runtime.workerDaemon),shutdown=runtime.missionRuntime.requestShutdown.bind(runtime.missionRuntime);
 runtime.workerDaemon.stop=(...args)=>{stopCalls++;return stop(...args);};
 runtime.missionRuntime.requestShutdown=(...args)=>{shutdownCalls++;return shutdown(...args);};
 await close(runtime.server);
 const disconnected=await Promise.all(requesters.map((request,index)=>request('/tasks',{method:'POST',body:{rawText:'오프라인이면 새로 실행하지 마',requestId:`disconnected-${index}`}})));
 for(const result of disconnected)assert.equal(result.success,false,JSON.stringify(result));
 assert.equal(runtime.coreFacade.tasks.size,3);assert.equal(workerCalls,3);
 await Promise.all([runtime.close(),runtime.close()]);assert.equal(stopCalls,1);assert.equal(shutdownCalls,1);
 console.log(JSON.stringify({multiDeviceCoreAuthority:{clients:['mobile BridgeClient','wearable WearableHudAdapter','wearable browser requester'],gateways:3,coreTaskCount:3,sameFacade:true,sameWorker:true,workerCalls,distinctVerifiedFiles:artifacts.length,actualHttp:true,physicalDevices:false,externalCalls:0}}));
});

test('PC execution composition owns B-local receipts, not a Core Mission or memory SQLite authority',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-pc-authority-only-'));
 t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const runtime=createPcExecutionRuntime({env:{JARVIS_TEST_MODE:'1'},auditRoot:root,allowedRoots:[root]});
 for(const name of ['coreFacade','missionRuntime','missionStore','operationsStore','memoryStore','orchestrationWorker'])assert.equal(Object.hasOwn(runtime,name),false,name);
 assert.ok(runtime.pcAgent);assert.ok(runtime.policyRuntime);assert.ok(runtime.trustKernel);
 const files=await readdir(root);assert.equal(files.some(name=>/mission|personal-operations|growth.*sqlite/iu.test(name)),false);
 // Architecture source check complements the actual runtime construction; it is not a physical device test.
 const source=await readFile('apps/runtime-compose/src/create-pc-runtime.js','utf8');
 assert.doesNotMatch(source,/new\s+(?:CoreFacade|MissionRuntime|SqliteMissionStore|PersonalOperationsStore|SqliteMemoryStore)\b/u);
});
