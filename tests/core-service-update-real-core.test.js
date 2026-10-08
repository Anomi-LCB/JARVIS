import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {writeCoreServicePackage} from '../packages/core/src/install/core-service-packager.js';
// Background Core must not retain an execFile stdout pipe and keep its parent promise pending.
const ps=(path,args=[])=>new Promise((resolve,reject)=>{
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',path,...args],{windowsHide:true,stdio:'ignore',
  env:{PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}});
 child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Fixture PowerShell exit '+code+' at '+path)));
});

test('generated Core update preserves actual packaged Core task history and output through commit and rollback',
 {skip:process.platform!=='win32',timeout:120000},async t=>{
 const runtimeRoot=resolve('artifacts/core-update-transaction-20261003/pc-package');
 const runtimeManifest=JSON.parse(await readFile(join(runtimeRoot,'package-manifest.json'),'utf8'));
 const root=await mkdtemp(join(tmpdir(),'jarvis-real-core-update-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const scenario of ['commit','startup-failure']){
  const dir=join(root,scenario),state=join(dir,'state'),workspace=join(state,'workspace');
  await mkdir(workspace,{recursive:true});
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;await new Promise(r=>server.close(r));
  const base=`http://127.0.0.1:${port}`,token='isolated-core-update-token';
  const binding={packageRoot:runtimeRoot,stateRoot:state,
   launcherSha256:runtimeManifest.fileIntegrity['pc-agent-runtime/core-launch.mjs'].sha256,
   nodeSha256:runtimeManifest.fileIntegrity['runtime/node.exe'].sha256};
  const serviceName='FixtureCore'+randomUUID().replaceAll('-','');
  for(const version of ['old','new']){
   const pkg=await writeCoreServicePackage({outputDir:join(dir,version),installedRuntime:binding,serviceName,port});
   if(version==='old')await ps(join(pkg.outputDir,'build-service-host.ps1'));
   else{
    // Only the test copy drops elevation. Its manifest is repinned; the shipped guard remains unchanged.
    const file=join(pkg.outputDir,'update-service.ps1');
    const script=(await readFile(file,'utf8')).replace(/\$principal =[^\n]*\nif \(-not \$principal[^\n]*\n/u,'# isolated SCM adapter\n');
    await writeFile(file,script);
    const manifest=JSON.parse(await readFile(join(pkg.outputDir,'package-manifest.json'),'utf8'));
    manifest.fileIntegrity['update-service.ps1'].sha256=createHash('sha256').update(script).digest('hex');
    await writeFile(join(pkg.outputDir,'package-manifest.json'),JSON.stringify(manifest));
   }
  }
  await writeFile(join(dir,'service.json'),JSON.stringify({PathName:'"'+join(dir,'old','JarvisCoreRuntimeHost.exe')+'"',
   StartName:'SYNTHETIC\\CoreAccount',StartMode:'Manual',State:'Stopped',DelayedAutoStart:false}));
  const fixture=String.raw`param([switch]$Bootstrap,[switch]$Cleanup)
$ErrorActionPreference='Stop'
$global:fixtureRoot=Split-Path -Parent $MyInvocation.MyCommand.Path
$global:fixtureSvc=Get-Content (Join-Path $fixtureRoot 'service.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$global:fixtureBinding=Get-Content (Join-Path $fixtureRoot 'new/package-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
function global:Save-Service { [IO.File]::WriteAllText((Join-Path $fixtureRoot 'service.json'),($global:fixtureSvc | ConvertTo-Json)) }
function global:Get-CimInstance {return $global:fixtureSvc}
function global:Get-Service { $v=[pscustomobject]@{Status=$global:fixtureSvc.State};$v|Add-Member ScriptMethod WaitForStatus {param($status,$timeout)};return $v }
function global:Stop-Service {
 $ownerPath=Join-Path $fixtureRoot 'owned-process.json'
 if(Test-Path $ownerPath){
  $owner=Get-Content $ownerPath -Raw | ConvertFrom-Json
  $child=Get-Process -Id $owner.id -ErrorAction SilentlyContinue
  if($child){
   if($child.StartTime.ToUniversalTime().Ticks.ToString() -ne $owner.startedTicks -or $child.Path -ne $owner.executable){throw 'OWNED_PROCESS_MISMATCH'}
   $child.Kill();if(-not $child.WaitForExit(10000)){throw 'OWNED_PROCESS_STOP_TIMEOUT'}
  }
 }
 $global:fixtureSvc.State='Stopped';Save-Service
}
function global:Start-Service {
 $info=New-Object Diagnostics.ProcessStartInfo
 $info.FileName=Join-Path $fixtureBinding.installedRuntime.packageRoot 'runtime/node.exe'
 $info.Arguments='"'+(Join-Path $fixtureBinding.installedRuntime.packageRoot 'pc-agent-runtime/core-launch.mjs')+'"'
 $info.WorkingDirectory=$fixtureBinding.installedRuntime.stateRoot
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.EnvironmentVariables.Clear()
 $info.EnvironmentVariables['PATH']=$env:PATH;$info.EnvironmentVariables['SystemRoot']=$env:SystemRoot
 foreach($entry in $fixtureBinding.environment.PSObject.Properties){$info.EnvironmentVariables[$entry.Name]=[string]$entry.Value}
 $info.EnvironmentVariables['JARVIS_TEST_MODE']='1'
 $info.EnvironmentVariables['JARVIS_TEST_AUDIT_ROOT']=Join-Path $fixtureBinding.installedRuntime.stateRoot 'test-audit'
 $info.EnvironmentVariables['JARVIS_CORE_INTEGRATION_VAULT']=Join-Path $fixtureBinding.installedRuntime.stateRoot 'isolated-vault.json'
 foreach($key in @('JARVIS_LLM_INTENT','JARVIS_LLM_PLANNER','JARVIS_LLM_CONTENT','JARVIS_CORE_WORKER_DAEMON_AUTOSTART','JARVIS_CORE_WORKER_DAEMON_ENABLED')){$info.EnvironmentVariables[$key]='0'}
 $info.EnvironmentVariables['JARVIS_CORE_ADMIN_TOKEN']='isolated-core-update-token'
 $info.EnvironmentVariables.Remove('JARVIS_CORE_ADMIN_TOKEN_SHA256')
 $info.EnvironmentVariables.Remove('JARVIS_CORE_INTEGRATION_HANDOFF_TOKEN_SHA256')
 if((Split-Path $fixtureRoot -Leaf) -eq 'startup-failure' -and $fixtureSvc.PathName.Contains('\new\')){$info.EnvironmentVariables['JARVIS_CORE_MISSION_AUTHORITY_RECOVERY_ONLY']='invalid-fixture-value'}
 foreach($key in @('JARVIS_CORE_ADMIN_TOKEN','JARVIS_CORE_ADMIN_TOKEN_SHA256','JARVIS_CORE_INTEGRATION_HANDOFF_TOKEN_SHA256','JARVIS_CORE_MISSION_AUTHORITY_RECOVERY_ONLY')){[Environment]::SetEnvironmentVariable($key,$null,'Process')}
 foreach($key in $info.EnvironmentVariables.Keys){[Environment]::SetEnvironmentVariable($key,$info.EnvironmentVariables[$key],'Process')}
 $child=Start-Process -FilePath $info.FileName -ArgumentList $info.Arguments -WorkingDirectory $info.WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $fixtureRoot 'core.stdout') -RedirectStandardError (Join-Path $fixtureRoot 'core.stderr') -PassThru
 [IO.File]::WriteAllText((Join-Path $fixtureRoot 'owned-process.json'),(@{id=$child.Id;startedTicks=$child.StartTime.ToUniversalTime().Ticks.ToString();executable=$info.FileName}|ConvertTo-Json))
 $global:fixtureSvc.State='Running';Save-Service
}
function global:sc.exe {
 if($args[0] -ne 'config'){throw 'UNEXPECTED SCM COMMAND'}
 $global:fixtureSvc.PathName=$args[3];Save-Service;$global:LASTEXITCODE=0
}
if($Cleanup){Stop-Service;exit}
if($Bootstrap){Start-Service;exit}
$failure=$null
try {& (Join-Path $fixtureRoot 'new/update-service.ps1')}catch{$failure=$_.Exception.Message}
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'result.json'),(@{failure=$failure;service=$fixtureSvc}|ConvertTo-Json -Depth 8))
`;
  const fixturePath=join(dir,'fixture.ps1');await writeFile(fixturePath,'\uFEFF'+fixture);
  try{
   await ps(fixturePath,['-Bootstrap']);
   let ready=false;for(let i=0;i<100;i++){
    try{ready=(await fetch(base+'/health')).ok;}catch{}
    if(ready)break;await new Promise(r=>setTimeout(r,100));
   }assert.equal(ready,true,'actual Core should start: '+await readFile(join(dir,'core.stderr'),'utf8'));
   const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
   const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
   const output=join(workspace,'result.txt');
   const task=await post('/tasks',{rawText:`"${output}" 텍스트 파일을 만들어줘. 내용은 보존 자료`});
   assert.equal(task.status,201,JSON.stringify(task));
   const run=await post(`/tasks/${task.body.taskId}/run`,{options:{userConfirmation:{confirmed:true}}});
   assert.equal(run.body.success,true,JSON.stringify(run));
   const before=await readFile(output);const beforeStat=await stat(output);
   await ps(fixturePath);
   const result=JSON.parse(await readFile(join(dir,'result.json'),'utf8'));
   const journal=JSON.parse(await readFile(join(dir,'new/service-update-transaction.json'),'utf8'));
   if(scenario==='commit'){assert.equal(result.failure,null);assert.equal(journal.phase,'committed');}
   else{assert.match(result.failure,/CORE_UPDATE_FAILED_ROLLED_BACK/);assert.equal(journal.phase,'rolled_back');}
   assert.equal(result.service.PathName,'"'+join(dir,scenario==='commit'?'new':'old','JarvisCoreRuntimeHost.exe')+'"');
   assert.equal(result.service.StartName,'SYNTHETIC\\CoreAccount');
   assert.equal((await fetch(base+'/health').then(r=>r.json())).apiAuthentication.configured,true);
   const detail=await fetch(base+`/tasks/${task.body.taskId}`,{headers}).then(r=>r.json());
   assert.equal(detail.status,'COMPLETED');assert.equal(detail.archivedObservation,true);
   const preview=await fetch(base+`/tasks/${task.body.taskId}/record-artifacts/0`,{headers});
   assert.equal(preview.status,200);assert.equal((await preview.json()).text,'보존 자료');
   assert.deepEqual(await readFile(output),before);assert.equal((await stat(output)).mtimeMs,beforeStat.mtimeMs);
   assert.equal((await post(`/tasks/${task.body.taskId}/run`,{})).status,404);
   console.log(JSON.stringify({scenario,journal:journal.phase,actualPackagedCore:true,actualHttpHealth:true,actualFilePreserved:true,scmInstalled:false}));
  }finally{await ps(fixturePath,['-Cleanup']);}
 }
});


