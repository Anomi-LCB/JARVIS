import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {productServiceDefinitions,startProductRuntime,probeProductServices,createServiceEnvironment} from './product-runtime.mjs';
import {resolveProductRuntimeSecrets} from '../packages/shared/src/product-runtime-secrets.js';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const root=await mkdtemp(join(tmpdir(),'jarvis-plain-product-')),output=process.argv[2]??'artifacts/plain-summary-20261007-product';
await mkdir(output,{recursive:true});const ports=[],servers=[],children=[],rows=[];let runtime;
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMSPEC)$/iu.test(key)));
Object.assign(env,{JARVIS_TEST_MODE:'1',JARVIS_PRODUCT_HOST:'127.0.0.1',JARVIS_CORE_ROOT:root,JARVIS_CORE_AUDIT_ROOT:join(root,'core'),
 JARVIS_AUDIT_ROOT:join(root,'pc'),JARVIS_TEST_AUDIT_ROOT:join(root,'test'),JARVIS_ALLOWED_ROOTS:join(root,'workspace'),JARVIS_CORE_ALLOWED_ROOTS:join(root,'workspace'),
 JARVIS_TRUST_ROOT:join(root,'trust'),JARVIS_BRIDGE_STATE_DIR:join(root,'bridge'),JARVIS_UNDO_JOURNAL:join(root,'pc','undo.jsonl'),
 JARVIS_ROLLBACK_TRANSACTIONS:join(root,'pc','rollback.jsonl'),JARVIS_PACKET_JOURNAL:join(root,'pc','packets.jsonl'),
 JARVIS_PACKET_QUEUE:join(root,'pc','queue.jsonl'),JARVIS_TOKEN_VAULT:join(root,'pc','vault.jsonl'),JARVIS_CORE_INTEGRATION_VAULT:join(root,'integrations.dpapi.json'),
 JARVIS_PERSONAL_OPERATIONS_DB:join(root,'personal.sqlite'),JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',
 JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_QUEUE_DRAIN_ENABLED:'0',
 JARVIS_BRIDGE_REAL_EXECUTION:'0',JARVIS_BRIDGE_OPEN_OUTPUTS:'0',JARVIS_BROWSER_DRIVER:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',
 JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED:'1',JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite'});
try{
 await mkdir(join(root,'workspace','하위 자료'),{recursive:true});
 for(let i=0;i<4;i++){const server=createServer();servers.push(server);const address=await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});ports.push(address.port);}
 await Promise.all(servers.map(server=>new Promise(r=>server.close(r))));
 [env.JARVIS_CORE_PORT,env.JARVIS_PC_AGENT_PORT,env.JARVIS_BRIDGE_PORT,env.JARVIS_UI_PORT]=ports.map(String);
 const secrets=resolveProductRuntimeSecrets({env}),seed=randomBytes(32).toString('base64url');
 const definitions=productServiceDefinitions({env,secrets}).map(d=>({...d,environment:{...d.environment,JARVIS_TEST_TRUST_SECRET:seed}}));
 const start=()=>startProductRuntime({definitions,logger:{log(){},warn(){},error(){}},spawnImpl:(command,args,options)=>{
  const d=definitions.find(d=>d.command===command&&JSON.stringify(d.args)===JSON.stringify(args));assert.ok(d);
  const child=spawn(command,args,{...options,windowsHide:true,env:createServiceEnvironment(d,env)});children.push(child);return child;
 }});
 runtime=await start();const health=await probeProductServices({definitions});assert.equal(health.operational,true);
 const core=definitions.find(d=>d.id==='core').endpoint;
 const request=async(path,body)=>{const response=await fetch(core+path,{method:body===undefined?'GET':'POST',
  headers:{authorization:`Bearer ${secrets.coreToken}`,...(body===undefined?{}:{'content-type':'application/json'})},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const data=await response.json();assert.ok(response.ok,`${response.status} ${JSON.stringify(data)}`);return data;};
 const owner=await request('/owner-session/activate',{durationMinutes:5,requestedBy:'isolated-plain-summary-product',grants:['read_only','local_reversible']});
 const authorization={mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','local_reversible']};
 for(const mode of ['normal','nested','conflicting-alias']){
  const name=`${mode}.txt`,file=`${mode}.json`,directory=mode==='nested'?join(root,'workspace','하위 자료'):join(root,'workspace');
  const source='견적은 810000원이다. 실제 지출은 0원이다. 승인 상태는 보류다.'+(mode==='conflicting-alias'?' 실제 지출액은 123원이다.':'');
  await writeFile(join(directory,name),source);
  const objective=`'.' 폴더에서 '${name}' 파일을 찾아 실제 지출액과 승인 상태를 요약해 '${file}'에 JSON으로 저장하고 다시 찾아 읽어 확인해줘`;
  const created=await request('/missions',{objective,successCriteria:[{statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`}],authorization});
  const started=performance.now(),result=await request(`/missions/${created.missionId}/run`,{});let content=null;
  try{content=JSON.parse(await readFile(join(root,'workspace',file),'utf8'));}catch{}
  if(mode==='conflicting-alias'){assert.notEqual(result.status,'COMPLETED');assert.equal(content,null);}
  else{assert.equal(result.status,'COMPLETED',JSON.stringify(result));assert.deepEqual(content.facts,{field1:'0',field2:'보류'});}
  rows.push({mode,missionId:created.missionId,objective,status:result.status,stopReason:result.stopReason,totalMs:performance.now()-started,content,
   result,modelCalls:0,totalCost:null,costMeasurement:'unmeasured'});
 }
 const first=rows[0],path=join(root,'workspace','normal.json'),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 const snapshot=async()=>({outputSha:digest(await readFile(path)),mtime:(await stat(path)).mtimeMs,packetSha:digest(await readFile(join(root,'pc','packets.jsonl')))});
 const before=await snapshot(),journalBefore=(await readFile(join(root,'pc','packets.jsonl'),'utf8')).split(/\r?\n/u).filter(Boolean);
 const replay=await request(`/missions/${first.missionId}/run`,{});
 const afterReplay=await snapshot(),journalAfter=(await readFile(join(root,'pc','packets.jsonl'),'utf8')).split(/\r?\n/u).filter(Boolean);
 const extra=journalAfter.slice(journalBefore.length).map(line=>{
  const record=JSON.parse(line);return {event:record.event??record.type,toolName:record.toolName??record.packet?.toolName??record.details?.toolName,keys:Object.keys(record)};
 });
 assert.equal(replay.status,'COMPLETED');assert.equal(afterReplay.outputSha,before.outputSha);assert.equal(afterReplay.mtime,before.mtime);
 await runtime.stop();runtime=await start();const restoredHealth=await probeProductServices({definitions});assert.equal(restoredHealth.operational,true);
 const restored=await request(`/missions/${first.missionId}`);assert.equal(restored.status,'COMPLETED');
 assert.equal((await request(`/missions/${first.missionId}/run`,{})).status,'COMPLETED');
 const afterRestart=await snapshot();assert.equal(afterRestart.outputSha,before.outputSha);assert.equal(afterRestart.mtime,before.mtime);
 const journalRestart=(await readFile(join(root,'pc','packets.jsonl'),'utf8')).split(/\r?\n/u).filter(Boolean);
 const restartExtra=journalRestart.slice(journalAfter.length).map(line=>{
  const record=JSON.parse(line);
  return {keys:Object.keys(record),fields:Object.fromEntries(Object.entries(record).filter(([key,value])=>/^(event|type|toolName|phase|status|action)$/u.test(key)&&typeof value==='string')),
   toolName:record.packet?.toolName??record.details?.toolName??record.dispatch?.toolName};
 });
 await writeFile(`${output}/replay-packet-projection.json`,JSON.stringify({beforeLines:journalBefore.length,afterLines:journalAfter.length,afterRestartLines:journalRestart.length,extra,restartExtra},null,2)+'\n',{flag:'wx'});
 await writeFile(`${output}/comparison.json`,JSON.stringify({observedAt:new Date().toISOString(),rows,
  health,restoredHealth,replay:{status:replay.status,restoredStatus:restored.status,before,afterReplay,afterRestart,packetJournalChanged:before.packetSha!==afterReplay.packetSha},
  scope:'actual-loopback-Core-HTTP-E-separate-PC-B-G-SQL-restart-not-native-install-or-live-account',paidApiCalls:0,totalCost:null},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({statuses:rows.map(r=>[r.mode,r.status]),restartRestored:true,replayNoNewEffect:true}));
}finally{
 await runtime?.stop();for(const server of servers)if(server.listening)await new Promise(r=>server.close(r));
 assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));assert.ok(children.every(c=>c.exitCode!==null||c.signalCode!==null));
 await writeFile(`${output}/cleanup.json`,JSON.stringify({observedAt:new Date().toISOString(),ownedChildren:children.map(c=>({pid:c.pid,exitCode:c.exitCode,signalCode:c.signalCode})),allTerminal:true},null,2)+'\n',{flag:'wx'});
 await rm(root,{recursive:true,force:true});
}
