import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {writeCoreServicePackage} from '../packages/core/src/install/core-service-packager.js';
import {writeInstallerPackage} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';
const exec=promisify(execFile);

test('compiled Core service host runs current local case Mission and recovers after OnStop/OnStart',{skip:process.platform!=='win32',timeout:90000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-native-core-case-')),state=join(root,'state'),coreDir=join(root,'core');
 const serviceName='JarvisCaseFixture'+randomUUID().replaceAll('-','');
 const serviceAuthorityId='service:'+randomUUID();
 const logRoot=join(process.env.ProgramData,'JARVIS','CoreRuntime',serviceName),children=[];
 const stop=async child=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.stdin.end('\n');await done;}};
 t.after(async()=>{for(const child of children)await stop(child);assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-native-core-case-'));await rm(root,{recursive:true,force:true});assert.equal(basename(logRoot),serviceName);assert.equal(resolve(logRoot),resolve(process.env.ProgramData,'JARVIS','CoreRuntime',serviceName));await rm(logRoot,{recursive:true,force:true});});
 await mkdir(join(state,'workspace'),{recursive:true});
 const nodeRoot=resolve('artifacts/bundled-node-runtime-20261003/package/runtime'),provenance=JSON.parse(await readFile(join(nodeRoot,'node-provenance.json'),'utf8'));
 const packageRoot=join(root,'package');
 const {manifest}=await writeInstallerPackage({...await loadPcAgentInstallConfig(),outputDir:packageRoot,pcAgentStateRoot:state,bundledNodeRuntime:{executablePath:join(nodeRoot,'node.exe'),licensePath:join(nodeRoot,'Node-LICENSE.txt'),expectedSha256:provenance.sha256,version:provenance.version}});
 const token='synthetic-native-core-case';
 await writeCoreServicePackage({outputDir:coreDir,serviceName,port:0,serviceAuthority:{id:serviceAuthorityId,initialExpectedToken:0,ttlMs:30000},installedRuntime:{packageRoot,stateRoot:state,launcherSha256:manifest.fileIntegrity['pc-agent-runtime/core-launch.mjs'].sha256,nodeSha256:manifest.fileIntegrity['runtime/node.exe'].sha256},logs:{workerDaemonAutostart:false,adminTokenHash:createHash('sha256').update(token).digest('hex')}});
 await exec('powershell.exe',['-NoProfile','-File',join(coreDir,'build-service-host.ps1')],{windowsHide:true});
 const runner=join(root,'runner.exe');
 await writeFile(join(root,'runner.cs'),`public static class Runner {public static void Main(string[] args) {
 var type=System.Reflection.Assembly.LoadFrom(args[0]).GetType("JarvisCoreRuntimeHost");var host=System.Activator.CreateInstance(type);
 var flags=System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance;
 try {type.GetMethod("OnStart",flags).Invoke(host,new object[]{new string[0]});var child=(System.Diagnostics.Process)type.GetField("child",flags).GetValue(host);System.Console.WriteLine("CHILD:"+child.Id);System.Console.Out.Flush();System.Console.ReadLine();}
 finally {type.GetMethod("OnStop",flags).Invoke(host,null);}
}}`);
 await exec(join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/out:'+runner,join(root,'runner.cs')],{windowsHide:true});
 const start=async()=>{
  await writeFile(join(logRoot,'core-service-host.log'),'').catch(async e=>{if(e.code!=='ENOENT')throw e;});
  const child=spawn(runner,[join(coreDir,'JarvisCoreRuntimeHost.exe')],{cwd:state,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,ProgramData:process.env.ProgramData,TEMP:process.env.TEMP,TMP:process.env.TMP,LOCALAPPDATA:join(state,'local-app-data'),JARVIS_TEST_MODE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_OPERATIONS_DB:join(state,'operations.sqlite')}});children.push(child);
  let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('Native host failed: '+stderr+' '+await readFile(join(logRoot,'core-service-host.log'),'utf8').catch(()=>''));const log=await readFile(join(logRoot,'core-service-host.log'),'utf8').catch(()=>''),match=log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/u);if(match&&/CHILD:\d+/u.test(stdout))return {child,base:match[1],pid:Number(stdout.match(/CHILD:(\d+)/u)[1])};await new Promise(r=>setTimeout(r,100));}throw Error('Native Core timeout: '+stderr);
 };
 const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
 const post=async(base,path,body)=>{const res=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)}),data=await res.json();assert.ok(res.ok,JSON.stringify({path,status:res.status,data}));return data;};
 const first=await start(),context=await fetch(first.base+'/personal-operations/cases/context',{headers}).then(r=>r.json());assert.equal(context.missionConfigured,true);
 const c=await post(first.base,'/personal-operations/cases',{requestId:'native-case',kind:'return',provider:'shopify',accountRef:'synthetic',providerRef:'synthetic',title:'네이티브 호스트 합성 업무',dueAt:null});
 const selection={caseId:c.id,expectedStoreId:context.storeId,expectedRevision:1};
 const quota=await post(first.base,'/personal-mandates/create-mission-quota',{validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:3,scope:{accountRef:null,dataRefs:[`lifecycle-case:${context.storeId}:${c.id}`],deniedDataRefs:[]}});
 const owner=await post(first.base,'/owner-session/activate',{durationMinutes:5,grants:['read_only']});
 const mission=await post(first.base,'/missions',{objective:'선택한 생활 업무의 로컬 기록과 마감을 조회해.',lifecycleCase:selection,executionMandateId:quota.mandate.id,authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only']},metadata:{longTermMemory:false}});
 const resultPath='/missions/'+encodeURIComponent(mission.missionId)+'/verified-lifecycle-case';
 const executed=await post(first.base,'/missions/'+encodeURIComponent(mission.missionId)+'/run',{});assert.equal(executed.status,'COMPLETED',JSON.stringify(executed));
 const before=await fetch(first.base+resultPath,{headers}).then(r=>r.json());assert.equal(before.success,true);
 const key=JSON.parse(await readFile(join(state,'logs/trust/runtime-trust-key.json'),'utf8'));assert.ok(key);
 const diagnostics=await fetch(first.base+'/admin/diagnostics',{headers}).then(r=>r.json());
 assert.equal(diagnostics.runtimeTrust.keyProvider.provider,'windows-dpapi-current-user');
 assert.equal(diagnostics.runtimeTrust.keyProvider.protectedByOs,true);assert.equal(diagnostics.runtimeTrust.keyProvider.persistent,true);assert.equal(diagnostics.runtimeTrust.keyProvider.rawKeyStored,false);
 await stop(first.child);await assert.rejects(fetch(first.base+'/health',{signal:AbortSignal.timeout(500)}));
 const second=await start();assert.notEqual(first.pid,second.pid);
 assert.equal((await fetch(second.base+resultPath,{headers}).then(r=>r.json())).success,false);
 const renewed=await post(second.base,'/owner-session/activate',{durationMinutes:5,grants:['read_only']});
 const recovered=await post(second.base,resultPath,{ownerSessionId:renewed.session.sessionId});assert.equal(recovered.success,true,JSON.stringify(recovered));assert.equal(recovered.result.title,c.title);assert.equal(recovered.providerVerified,false);
 const detail=await fetch(second.base+'/missions/'+encodeURIComponent(mission.missionId),{headers}).then(r=>r.json());assert.equal(detail.metrics.executedActions,1);
 await post(second.base,'/personal-mandates/revoke',{id:quota.mandate.id});assert.equal((await post(second.base,resultPath,{ownerSessionId:renewed.session.sessionId})).success,false);
 await stop(second.child);
 // Owner crash closes the inherited private pipe: child releases authority too.
 const third=await start(),gone=once(third.child,'exit');third.child.kill('SIGKILL');await gone;
 let stopped=false;for(let i=0;i<60;i++){try{await fetch(third.base+'/health',{signal:AbortSignal.timeout(300)});}catch{stopped=true;break;}await new Promise(r=>setTimeout(r,100));}assert.equal(stopped,true,'parent crash left Core listening');
 const fourth=await start();assert.notEqual(third.pid,fourth.pid);await stop(fourth.child);
 t.diagnostic(JSON.stringify({actualCompiledOnStartOnStop:true,parentCrashReleasesAuthority:true,bundledNode:true,createPid:first.pid,recoveryPid:second.pid,executedActions:1,providerVerified:false,scmInstalled:false,serviceAccountTested:false}));
});
