import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';import {join,resolve,basename,sep} from 'node:path';import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';import {createServer} from 'node:net';
import {writeCoreServicePackage} from '../packages/core/src/install/core-service-packager.js';
const exec=promisify(execFile);
const env={PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,ComSpec:process.env.ComSpec,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,ProgramData:process.env.ProgramData,TEMP:process.env.TEMP,TMP:process.env.TMP};
// Native fixture children must not inherit execFile's output pipes: they outlive the SCM command.
const ps=(file,args=[])=>new Promise((resolve,reject)=>{
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',file,...args],{env,windowsHide:true,stdio:'ignore'});
 const timer=setTimeout(()=>{child.kill();reject(Error('NATIVE_FIXTURE_COMMAND_TIMEOUT'));},60000);
 child.once('error',error=>{clearTimeout(timer);reject(error);});
 child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('NATIVE_FIXTURE_COMMAND_FAILED: '+code));});
});
test('native Core update commits or restores old host with fixed authority and verified Mission intact',{skip:process.platform!=='win32',timeout:600000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-native-authority-update-')),logRoots=[];
 t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-native-authority-update-'));await rm(root,{recursive:true,force:true});for(const logRoot of logRoots){assert.equal(resolve(logRoot),resolve(process.env.ProgramData,'JARVIS','CoreRuntime',basename(logRoot)));assert.ok(basename(logRoot).startsWith('JarvisNativeUpdate'));await rm(logRoot,{recursive:true,force:true});}});
 const runtimeRoot=resolve(process.env.JARVIS_TEST_PC_RUNTIME_PACKAGE??'artifacts/service-authority-continuation-20261008-package/package'),runtimeManifest=JSON.parse(await readFile(join(runtimeRoot,'package-manifest.json'),'utf8'));
 await exec(join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/out:'+join(root,'owner.exe'),resolve('tests/fixtures/native-update-owner.cs')],{windowsHide:true});
 for(const scenario of ['commit','startup-failure']){
  const dir=join(root,scenario),state=join(dir,'state'),serviceName='JarvisNativeUpdate'+randomUUID().replaceAll('-','');logRoots.push(join(process.env.ProgramData,'JARVIS','CoreRuntime',serviceName));await mkdir(join(state,'workspace'),{recursive:true});
  const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const token='synthetic-native-update',serviceAuthority={id:'service:'+randomUUID(),initialExpectedToken:0,ttlMs:30000},binding={packageRoot:runtimeRoot,stateRoot:state,launcherSha256:runtimeManifest.fileIntegrity['pc-agent-runtime/core-launch.mjs'].sha256,nodeSha256:runtimeManifest.fileIntegrity['runtime/node.exe'].sha256};
  for(const version of ['old','new']){
   const pkg=await writeCoreServicePackage({outputDir:join(dir,version),installedRuntime:binding,serviceAuthority,serviceName,port,logs:{workerDaemonAutostart:false,adminTokenHash:createHash('sha256').update(token).digest('hex')}});
   await ps(join(pkg.outputDir,'build-service-host.ps1'));
   if(version==='new'){
    const file=join(pkg.outputDir,'update-service.ps1'),script=(await readFile(file,'utf8')).replace(/\$principal =[^\n]*\nif \(-not \$principal[^\n]*\n/u,'# isolated SCM fixture\n');await writeFile(file,script);
    const m=JSON.parse(await readFile(join(pkg.outputDir,'package-manifest.json'),'utf8'));m.fileIntegrity['update-service.ps1'].sha256=createHash('sha256').update(script).digest('hex');await writeFile(join(pkg.outputDir,'package-manifest.json'),JSON.stringify(m));
   }
  }
  await writeFile(join(dir,'service.json'),JSON.stringify({PathName:'"'+join(dir,'old/JarvisCoreRuntimeHost.exe')+'"',StartName:'SYNTHETIC\\NativeAccount',StartMode:'Manual',State:'Stopped',DelayedAutoStart:false}));
  const fixture=resolve('tests/fixtures/native-update-scm.ps1'),base='http://127.0.0.1:'+port,headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const run=args=>ps(fixture,['-FixtureRoot',dir,...args]);
  const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)}),json=await r.json();assert.ok(r.ok,JSON.stringify({path,status:r.status,json}));return json;};
  try{
   await run(['-Bootstrap']);
   // OnStart returning establishes native ownership, not HTTP readiness.
   let healthy=false;
   for(let attempt=0;attempt<150;attempt++){
    try{healthy=(await fetch(base+'/health',{signal:AbortSignal.timeout(1000)})).ok;}catch{}
    if(healthy)break;
    await new Promise(r=>setTimeout(r,100));
   }
   assert.equal(healthy,true,'native Core HTTP readiness');
   const context=await fetch(base+'/personal-operations/cases/context',{headers}).then(r=>r.json());assert.equal(context.missionConfigured,true);
   const c=await post('/personal-operations/cases',{requestId:'update-case',kind:'return',provider:'shopify',accountRef:'synthetic',providerRef:'synthetic',title:'업데이트 뒤 보존할 합성 업무',dueAt:null}),selection={caseId:c.id,expectedStoreId:context.storeId,expectedRevision:1};
   const quota=await post('/personal-mandates/create-mission-quota',{validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:3,scope:{accountRef:null,dataRefs:['lifecycle-case:'+context.storeId+':'+c.id],deniedDataRefs:[]}});
   const owner=await post('/owner-session/activate',{durationMinutes:5,grants:['read_only']});
   const mission=await post('/missions',{objective:'선택한 생활 업무의 로컬 기록과 마감을 조회해.',lifecycleCase:selection,executionMandateId:quota.mandate.id,authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:['read_only']},metadata:{longTermMemory:false}});
   const path='/missions/'+encodeURIComponent(mission.missionId);
   assert.equal((await post(path+'/run',{})).status,'COMPLETED');
   const keyPath=join(state,'logs/trust/runtime-trust-key.json'),key=await readFile(keyPath),beforeStat=await stat(keyPath);
   await run([]);const result=JSON.parse(await readFile(join(dir,'result.json'),'utf8')),journal=JSON.parse(await readFile(join(dir,'new/service-update-transaction.json'),'utf8'));
   assert.equal(journal.phase,scenario==='commit'?'committed':'rolled_back',JSON.stringify(result));if(scenario==='commit')assert.equal(result.failure,null);else assert.match(result.failure,/CORE_UPDATE_FAILED_ROLLED_BACK/);
   assert.equal(result.service.PathName,'"'+join(dir,scenario==='commit'?'new':'old','JarvisCoreRuntimeHost.exe')+'"');assert.equal(result.service.StartName,'SYNTHETIC\\NativeAccount');
   assert.deepEqual(await readFile(keyPath),key);assert.equal((await stat(keyPath)).mtimeMs,beforeStat.mtimeMs);
   const renewed=await post('/owner-session/activate',{durationMinutes:5,grants:['read_only']});const recovered=await post(path+'/verified-lifecycle-case',{ownerSessionId:renewed.session.sessionId});assert.equal(recovered.success,true,JSON.stringify(recovered));assert.equal(recovered.result.title,c.title);assert.equal(recovered.providerVerified,false);
   const detail=await fetch(base+path,{headers}).then(r=>r.json());assert.equal(detail.metrics.executedActions,1);assert.equal(detail.executionMandateId,quota.mandate.id);
   t.diagnostic(JSON.stringify({scenario,phase:journal.phase,actualNativeCoreHost:true,fixedServiceAuthority:true,missionReadVerified:true,executedActions:1,keyBytesAndMtimePreserved:true,scmInstalled:false}));
  }finally{await run(['-Cleanup']);}
 }
});
