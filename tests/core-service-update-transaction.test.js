import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {writeCoreServicePackage} from '../packages/core/src/install/core-service-packager.js';
const run=promisify(execFile);
test('Core generated transaction preserves state and recovers actual process termination across isolated SCM cases',{skip:process.platform!=='win32',timeout:240000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-core-update-한글-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'fixture-host.cs'),stub=join(root,'fixture-host.exe');
 await writeFile(source,'using System; public class Fixture { public static void Main(string[] args) { if(Environment.GetEnvironmentVariable("JARVIS_UPDATE_FIXTURE_PREFLIGHT_FAIL")=="1") Environment.Exit(29); } }');
 await run(join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/target:exe','/out:'+stub,source],{windowsHide:true});
 const runtimeRoot=join(process.cwd(),'artifacts/core-installed-runtime-binding-20261003/pc-package');
 const runtimeManifest=JSON.parse(await readFile(join(runtimeRoot,'package-manifest.json'),'utf8'));
 const serviceName='JarvisCoreUpdate'+randomUUID().replaceAll('-','');
 const cases=['changed-authority-id','running','stopped','disabled','delayed-auto','start-failed','wrong-health','stale-health','auth-unconfigured','partial-config-failed',
  'changed-state','in-place','missing-state','previous-recovery','changed-vault','runtime-in-place','preflight-failed','build-failed','nonlocal-endpoint',
  'crash','crash-stop','crash-config','crash-account','crash-code','crash-external','crash-journal','rollback-health-failed',
  'changed-authority-token','changed-personal-db','changed-trust-root','changed-mission-store'];
 const observations=[];
 for(const scenario of cases){
  const dir=join(root,scenario),oldDir=join(dir,'old'),newDir=join(dir,'new'),state=join(dir,'state');
  await Promise.all([mkdir(oldDir,{recursive:true}),mkdir(newDir,{recursive:true}),mkdir(state,{recursive:true})]);
  const oldExe=join(oldDir,'JarvisCoreRuntimeHost.exe'),newExe=join(newDir,'JarvisCoreRuntimeHost.exe');await copyFile(stub,oldExe);await copyFile(stub,newExe);
  await writeFile(join(state,'synthetic-encrypted-vault'),'CIPHERTEXT ONLY');
  const binding={packageRoot:runtimeRoot,stateRoot:state,launcherSha256:runtimeManifest.fileIntegrity['pc-agent-runtime/core-launch.mjs'].sha256,nodeSha256:runtimeManifest.fileIntegrity['runtime/node.exe'].sha256};
  const generated=await writeCoreServicePackage({outputDir:newDir,installedRuntime:binding,serviceName});
  const old={...generated.manifest,installedRuntime:{...binding},environment:{...generated.manifest.environment}};
  if(scenario==='changed-state')old.installedRuntime.stateRoot=join(dir,'different-state');
  if(scenario==='missing-state')delete old.installedRuntime;
  if(scenario==='changed-vault')old.environment.JARVIS_CORE_INTEGRATION_VAULT='DIFFERENT SYNTHETIC VAULT';
  const changedKeys={'changed-authority-id':'JARVIS_CORE_MISSION_AUTHORITY_SERVICE_ID','changed-authority-token':'JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN','changed-personal-db':'JARVIS_PERSONAL_OPERATIONS_DB','changed-trust-root':'JARVIS_TRUST_ROOT','changed-mission-store':'JARVIS_CORE_MISSION_STORE'};
  if(changedKeys[scenario])old.environment[changedKeys[scenario]]='DIFFERENT REVIEW REQUIRED';
  if(scenario==='runtime-in-place')old.installedRuntime.launcherSha256='0'.repeat(64);
  await writeFile(join(oldDir,'package-manifest.json'),JSON.stringify(old));
  if(scenario==='previous-recovery')await writeFile(join(oldDir,'service-update-transaction.json'),JSON.stringify({version:1,serviceName,phase:'rolling_back'}));
  if(scenario==='nonlocal-endpoint'){
   const candidate={...generated.manifest,endpoint:'https://outside.invalid/health'};await writeFile(join(newDir,'package-manifest.json'),JSON.stringify(candidate));
  }
  let script=String(await readFile(join(newDir,'update-service.ps1'),'utf8')).replace(/^\uFEFF/u,'');
  // Test-only elevation removal and explicit SCM/package/compiler/health fixtures. Production guards stay intact.
  script=script.replace(/\$principal =[^\n]*\nif \(-not \$principal[^\n]*\n/u,'# isolated fixture; no SCM access\n');
  await writeFile(join(newDir,'update-service.ps1'),'\uFEFF'+script);
  await writeFile(join(newDir,'verify-package.ps1'),'$global:fixtureVerified++');
  await writeFile(join(newDir,'build-service-host.ps1'),"$global:fixtureBuilds++; if ((Split-Path $fixtureRoot -Leaf) -eq 'build-failed') {throw 'SYNTHETIC BUILD FAILURE'}");
  const initial={PathName:'"'+(scenario==='in-place'?newExe:oldExe)+'"',StartName:'SYNTHETIC\\CoreAccount',StartMode:scenario==='disabled'?'Disabled':scenario==='delayed-auto'?'Auto':'Manual',
   DelayedAutoStart:scenario==='delayed-auto',State:['stopped','disabled'].includes(scenario)?'Stopped':'Running',startedAt:'2000-01-01T00:00:00Z'};
  await writeFile(join(dir,'service.json'),JSON.stringify(initial));
  const fixture=String.raw`param([switch]$Recover)
$ErrorActionPreference='Stop'
$global:fixtureRecovery=$Recover
$fixtureRoot=Split-Path -Parent $MyInvocation.MyCommand.Path
$global:fixtureScenario=Split-Path $fixtureRoot -Leaf
$env:JARVIS_UPDATE_FIXTURE_PREFLIGHT_FAIL=if($global:fixtureScenario -eq 'preflight-failed'){'1'}else{'0'}
$global:fixtureSvc=Get-Content (Join-Path $fixtureRoot 'service.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$global:fixtureVerified=0; $global:fixtureStops=0; $global:fixtureStarts=0; $global:fixtureBuilds=0
function global:Save-Service { [IO.File]::WriteAllText((Join-Path $fixtureRoot 'service.json'),($global:fixtureSvc | ConvertTo-Json)) }
function global:Get-CimInstance {return $global:fixtureSvc}
function global:Get-Service { $v=[pscustomobject]@{Status=$global:fixtureSvc.State};$v|Add-Member ScriptMethod WaitForStatus {param($status,$timeout)};return $v }
function global:Stop-Service {
 $global:fixtureStops++;$global:fixtureSvc.State='Stopped';Save-Service
 if($global:fixtureScenario -eq 'crash-stop' -and -not $global:fixtureRecovery){[Environment]::Exit(37)}
}
function global:sc.exe {
 if($args[0] -ne 'config'){throw 'UNEXPECTED SCM COMMAND'}
 $global:fixtureSvc.PathName=$args[3];$global:fixtureSvc.StartMode=@{auto='Auto';'delayed-auto'='Auto';demand='Manual';disabled='Disabled'}[$args[5]]
 $global:fixtureSvc.DelayedAutoStart=$args[5] -eq 'delayed-auto';Save-Service
 if($global:fixtureSvc.PathName.Contains('\new\')){
  if($global:fixtureScenario -eq 'crash-config' -and -not $global:fixtureRecovery){[Environment]::Exit(37)}
  if($global:fixtureScenario -eq 'partial-config-failed'){$global:LASTEXITCODE=5;return}
 }
 $global:LASTEXITCODE=0
}
function global:Start-Service {
 $global:fixtureStarts++
 if($global:fixtureSvc.PathName.Contains('\new\')){
  if($global:fixtureScenario -like 'crash*' -and -not $global:fixtureRecovery){[Environment]::Exit(37)}
  if($global:fixtureScenario -eq 'start-failed'){throw 'SYNTHETIC START FAILURE'}
 }
 $global:fixtureSvc.State='Running';$global:fixtureSvc.startedAt=[DateTime]::UtcNow.ToString('o');Save-Service
}
function global:Invoke-RestMethod {
 $new=$global:fixtureSvc.PathName.Contains('\new\')
 if(($new -and $global:fixtureScenario -eq 'wrong-health') -or $global:fixtureScenario -eq 'rollback-health-failed'){return @{module='OTHER'}}
 $started=$global:fixtureSvc.startedAt
 if($new -and $global:fixtureScenario -eq 'stale-health'){$started='2000-01-01T00:00:00Z'}
 return @{module='A_CORE';status='running';initialized=$true;startedAt=$started;apiAuthentication=@{configured=-not($new -and $global:fixtureScenario -eq 'auth-unconfigured')}}
}
$failure=$null
try {if($Recover){& (Join-Path $fixtureRoot 'new/update-service.ps1') -RollbackOnly}else{& (Join-Path $fixtureRoot 'new/update-service.ps1')}} catch {$failure=$_.Exception.Message}
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'observation.json'),(@{failure=$failure;service=$global:fixtureSvc;verified=$global:fixtureVerified;stops=$global:fixtureStops;starts=$global:fixtureStarts;builds=$global:fixtureBuilds}|ConvertTo-Json -Depth 8))
`;
  await writeFile(join(dir,'fixture.ps1'),fixture);
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot};
  const error=await run('powershell.exe',['-NoProfile','-NonInteractive','-File',join(dir,'fixture.ps1')],{windowsHide:true,env}).then(()=>null,e=>e);
  if(scenario.startsWith('crash')){
   assert.equal(error?.code,37,scenario);
   const journalPath=join(newDir,'service-update-transaction.json');const journal=JSON.parse(await readFile(journalPath,'utf8'));
   assert.equal(journal.phase,['crash-stop','crash-config'].includes(scenario)?'prepared':'switched');
   if(scenario==='crash'){
    await run('powershell.exe',['-NoProfile','-NonInteractive','-File',join(dir,'fixture.ps1')],{windowsHide:true,env});
    const pending=JSON.parse(await readFile(join(dir,'observation.json'),'utf8'));assert.match(pending.failure,/CORE_UPDATE_RECOVERY_REQUIRED/);assert.equal(pending.stops,0);
   }
   if(scenario==='crash-code')await writeFile(oldExe,'CHANGED OLD CODE');
   if(['crash-account','crash-external'].includes(scenario)){
    const current=JSON.parse(await readFile(join(dir,'service.json'),'utf8'));if(scenario==='crash-account')current.StartName='SYNTHETIC\\Other';else current.PathName='"'+join(dir,'external.exe')+'"';
    await writeFile(join(dir,'service.json'),JSON.stringify(current));
   }
   if(scenario==='crash-journal'){journal.wasRunning='false';await writeFile(journalPath,JSON.stringify(journal));}
   await run('powershell.exe',['-NoProfile','-NonInteractive','-File',join(dir,'fixture.ps1'),'-Recover'],{windowsHide:true,env});
  }else assert.equal(error,null,scenario);
  const observation=JSON.parse(await readFile(join(dir,'observation.json'),'utf8'));
  console.log(JSON.stringify({scenario,failure:observation.failure}));
  assert.equal(await readFile(join(state,'synthetic-encrypted-vault'),'utf8'),'CIPHERTEXT ONLY');
  if(scenario!=='crash-account')assert.equal(observation.service.StartName,initial.StartName);
  if(['running','stopped','disabled','delayed-auto'].includes(scenario)){
   assert.equal(observation.failure,null,scenario);assert.equal(observation.service.PathName,'"'+newExe+'"');assert.equal(observation.service.State,initial.State);
   assert.equal(observation.service.StartMode,initial.StartMode);assert.equal(observation.service.DelayedAutoStart,initial.DelayedAutoStart);
   if(['stopped','disabled'].includes(scenario))assert.equal(observation.starts,0);
   assert.equal(JSON.parse(await readFile(join(newDir,'service-update-transaction.json'),'utf8')).phase,'committed');
  }else if(['start-failed','wrong-health','stale-health','auth-unconfigured','partial-config-failed','crash','crash-stop','crash-config'].includes(scenario)){
   if(!scenario.startsWith('crash'))assert.match(observation.failure,/CORE_UPDATE_FAILED_ROLLED_BACK/,scenario);else assert.equal(observation.failure,null,scenario);
   assert.equal(observation.service.PathName,initial.PathName);assert.equal(observation.service.State,initial.State);
   assert.equal(JSON.parse(await readFile(join(newDir,'service-update-transaction.json'),'utf8')).phase,'rolled_back');
  }else if(scenario==='rollback-health-failed'){
   assert.match(observation.failure,/CORE_UPDATE_ROLLBACK_FAILED/);assert.equal(JSON.parse(await readFile(join(newDir,'service-update-transaction.json'),'utf8')).phase,'rolling_back');
  }else if(scenario.startsWith('crash')){
   assert.match(observation.failure,/CORE_UPDATE_(ACCOUNT_CHANGED|ROLLBACK_CODE_CHANGED|EXTERNAL_CONFIGURATION_CHANGED|JOURNAL_INVALID)/,scenario);
   assert.equal(observation.stops,0);assert.equal(observation.starts,0);
  }else{
   assert.ok(observation.failure,scenario);assert.equal(observation.stops,0,scenario);assert.equal(observation.starts,0,scenario);assert.deepEqual(observation.service,initial);
  }
  observations.push({scenario,failure:observation.failure,stops:observation.stops,starts:observation.starts});
 }
 console.log(JSON.stringify({coreUpdateEvidence:{cases:observations.length,SCMSimulated:true,compilerAndHealthSimulated:true,actualPowerShellExecution:true,actualProcessKilled:true,syntheticCredentialBytesUnchanged:true,observations}}));
});
