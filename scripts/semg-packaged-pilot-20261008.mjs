import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeInstallerPackage} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';
const root=resolve(process.argv[2]??'artifacts/semg-packaged-pilot-20261008');
if(!root.startsWith(resolve('artifacts')+sep))throw Error('ARTIFACT_ROOT_REQUIRED');
try{await access(root);throw Error('PILOT_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(root);
const packageDir=join(root,'package'),state=join(root,'state'),workspace=join(state,'workspace');await mkdir(workspace,{recursive:true});
const nodeRoot=resolve('artifacts/bundled-node-runtime-20261003/package/runtime');
const provenance=JSON.parse(await readFile(join(nodeRoot,'node-provenance.json'),'utf8'));
const config=await loadPcAgentInstallConfig({daemonConfigPath:'apps/pc-agent/install/daemon-config.json',serviceManifestPath:'apps/pc-agent/install/windows-service-manifest.json'});
const plan=await writeInstallerPackage({...config,outputDir:packageDir,pcAgentStateRoot:state,bundledNodeRuntime:{executablePath:join(nodeRoot,'node.exe'),licensePath:join(nodeRoot,'Node-LICENSE.txt'),expectedSha256:provenance.sha256,version:provenance.version}});
const paths=['pc-agent-runtime/packages/shared/src/semg-waveform.js','pc-agent-runtime/packages/shared/src/health-record-summary.js','pc-agent-runtime/packages/core/src/mission/local-mission-snapshot-recovery.js','pc-agent-runtime/core-launch.mjs','runtime/node.exe'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const files=await Promise.all(paths.map(async path=>({path,sha256:hash(await readFile(join(packageDir,path)))})));
for(const file of files)assert.equal(plan.manifest.fileIntegrity[file.path]?.sha256,file.sha256);
const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',
 JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',
 JARVIS_CORE_STATE_ROOT:state,JARVIS_CORE_AUDIT_ROOT:join(state,'audit'),JARVIS_TEST_AUDIT_ROOT:join(state,'test-audit'),
 JARVIS_CORE_ALLOWED_ROOTS:workspace,JARVIS_CORE_ADMIN_TOKEN:'synthetic-packaged-waveform-admin',JARVIS_CORE_HOST:'0.0.0.0',PORT:'0',
 JARVIS_CORE_PC_AGENT_REMOTE_EXECUTION:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0'};
let active;const processIds=[];
const stop=async()=>{if(active&&active.exitCode===null&&active.signalCode===null){const exit=once(active,'exit');active.kill('SIGKILL');await exit;}active=null;};
const start=async()=>{
 const child=spawn(join(packageDir,'runtime/node.exe'),[join(packageDir,'pc-agent-runtime/core-launch.mjs')],{cwd:state,env,windowsHide:true,stdio:['ignore','pipe','pipe']});active=child;processIds.push(child.pid);
 return await new Promise((resolve,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(Error('PACKAGED_CORE_TIMEOUT:'+errors.slice(-2000))),15000);
  child.stderr.on('data',bytes=>{errors=(errors+bytes).slice(-3000);});child.stdout.on('data',bytes=>{output=(output+bytes).slice(-3000);const match=output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/u);if(match){clearTimeout(timer);resolve(match[1]);}});
  child.once('exit',code=>{clearTimeout(timer);reject(Error(`PACKAGED_CORE_EXIT:${code}:${errors}`));});
 });
};
const headers={authorization:`Bearer ${env.JARVIS_CORE_ADMIN_TOKEN}`,'content-type':'application/json'};
const request=async(base,path,body)=>{const response=await fetch(base+path,{headers,method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});assert.ok(response.ok,`${path}:${response.status}:${await (!response.ok?response.text():Promise.resolve(''))}`);return response.json();};
try{
 const record={metric:'semg_raw',unit:'mV',source:'synthetic-packaged-sensor',recordId:'wave-1',observedAt:'2026-02-20T12:00:00+09:00',measurement:{sampleRateHz:1000},
  waveform:{firstSequence:10,expectedPacketCount:3,expectedSampleCount:6,packets:[{sequence:10,startSample:0,values:[-0.003,0.003]},{sequence:12,startSample:4,values:[-0.004,0.004]}]}};
 const source=JSON.stringify({records:[record]});await writeFile(join(workspace,'records.json'),source,{flag:'wx'});
 let base=await start();
 const owner=await request(base,'/owner-session/activate',{durationMinutes:5,requestedBy:'synthetic-packaged-waveform'});
 const objective="'records.json' 건강 기록을 '2026-02-20'부터 '2026-02-21'까지 요약해 'report.md'에 저장하고 다시 읽어 확인해줘";
 const mission=await request(base,'/missions',{objective,successCriteria:[{criterionId:'current-report',statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`}],authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only','local_reversible','high_impact']}});
 const result=await request(base,`/missions/${mission.missionId}/run`,{maxWaves:3});assert.equal(result.status,'COMPLETED',JSON.stringify(result.stopReason));
 const original=await request(base,`/missions/${mission.missionId}/verified-health-report`);assert.equal(original.status,'verified');assert.match(original.reportMarkdown,/수신 4\/6 표본 · 결측 2 표본/);
 assert.equal(await readFile(join(workspace,'records.json'),'utf8'),source);
 await stop();base=await start();
 const recovered=await request(base,`/missions/${mission.missionId}/verified-health-report`);assert.equal(recovered.status,'verified');assert.equal(recovered.reportMarkdown,original.reportMarkdown);
 record.waveform.packets[0].values[0]=0;await writeFile(join(workspace,'records.json'),JSON.stringify({records:[record]}));
 const changed=await request(base,`/missions/${mission.missionId}/verified-health-report`);assert.equal(changed.status,'changed-or-unavailable');assert.equal(changed.reportMarkdown,undefined);
 await stop();
 // Negative candidate is a separate copy so the reviewed candidate remains unchanged.
 const {cp}=await import('node:fs/promises');const damaged=join(root,'damaged-package');await cp(packageDir,damaged,{recursive:true});
 await writeFile(join(damaged,'pc-agent-runtime/packages/shared/src/semg-waveform.js'),'throw Error("TAMPER_EXECUTED");');
 const child=spawn(join(packageDir,'runtime/node.exe'),[join(damaged,'pc-agent-runtime/core-launch.mjs')],{cwd:state,env,windowsHide:true,stdio:['ignore','ignore','pipe']});active=child;let stderr='';child.stderr.on('data',bytes=>{stderr+=bytes;});
 const timer=setTimeout(()=>child.kill('SIGKILL'),15000);let code;try{[code]=await once(child,'exit');}finally{clearTimeout(timer);}active=null;
 assert.notEqual(code,0);assert.match(stderr,/PC_RUNTIME_INTEGRITY_FAILED/);assert.doesNotMatch(stderr,/TAMPER_EXECUTED/);
 const summary={observedAt:new Date().toISOString(),packageDir,fileCount:Object.keys(plan.manifest.fileIntegrity).length,files,nodeVersion:provenance.version,processIds,
  naturalMissionStatus:result.status,rawReportVerified:true,generatorTerminated:true,freshPidRecovery:true,changedRawHidden:true,sourceInitiallyPreserved:true,
  tamperedModuleRejectedBeforeImport:true,installed:false,scmInstalled:false,nativeExecutablesCompiled:false,windowsSignatureVerified:false,externalProviderVerified:false,realDevice:false,modelCalls:0,actualCost:null};
 await writeFile(join(root,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(summary));
}catch(error){await writeFile(join(root,'failure.json'),JSON.stringify({observedAt:new Date().toISOString(),error:error.message,processIds},null,2),{flag:'wx'});throw error;}
finally{await stop();}
