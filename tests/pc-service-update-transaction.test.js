import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {createInstallerPackagePlan} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';
const run=promisify(execFile);
test('generated Windows update preserves state/account, rolls back failures and recovers a killed switch',{skip:process.platform!=='win32',timeout:150000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-update-한글-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=await loadPcAgentInstallConfig();const serviceName='JarvisUpdateTest'+randomUUID().replaceAll('-','');config.serviceManifest.serviceName=serviceName;
 const cases=['running','stopped','disabled','start-failed','wrong-health','changed-state','in-place','missing-state','previous-recovery','crash','crash-account','crash-code','crash-external'];let assertions=0;
 for(const scenario of cases){
  const dir=join(root,scenario),oldDir=join(dir,'old'),newDir=join(dir,'new'),state=join(dir,'state');await Promise.all([mkdir(oldDir,{recursive:true}),mkdir(newDir,{recursive:true}),mkdir(state,{recursive:true})]);
  const oldExe=join(oldDir,'JarvisPcAgentServiceHost.exe');await writeFile(oldExe,'SYNTHETIC OLD CODE');
  await writeFile(join(newDir,'JarvisPcAgentServiceHost.exe'),'SYNTHETIC NEW CODE');
  await writeFile(join(state,'synthetic-encrypted-vault'),'CIPHERTEXT ONLY');
  const plan=createInstallerPackagePlan({...config,outputDir:newDir,pcAgentStateRoot:state});
  assert.match(String(plan.files['install-service.ps1']),/if \(\$null -ne \$existingService\) \{\s*& \(Join-Path \$root "update-service.ps1"\)\s*return/u);
  const nsis=String(plan.files['installer.nsi']);
  assert.ok(nsis.indexOf('existing_code:')<nsis.search(/^  File "/mu));assert.match(nsis,/existing_code:[\s\S]*?Abort[\s\S]*?fresh_install:/u);
  await writeFile(join(newDir,'package-manifest.json'),JSON.stringify(plan.manifest));
  const oldManifest={packageId:plan.manifest.packageId,serviceName,runtimeState:{root:scenario==='changed-state'?join(dir,'different-state'):state}};
  if(scenario==='missing-state')delete oldManifest.runtimeState;
  await writeFile(join(oldDir,'package-manifest.json'),JSON.stringify(oldManifest));
  if(scenario==='previous-recovery')await writeFile(join(oldDir,'service-update-transaction.json'),JSON.stringify({version:1,serviceName,phase:'switched'}));
  let script=String(plan.files['update-service.ps1']).replace(/^\uFEFF/u,'');
  // Only the elevation check is removed. Real SCM commands are replaced by the explicit isolated fixture below.
  script=script.replace(/\$principal =[^\n]*\nif \(-not \$principal[^\n]*\n/u,'# fixture: elevation not required; no SCM access\n');
  await writeFile(join(newDir,'update-service.ps1'),'\uFEFF'+script);
  await writeFile(join(newDir,'verify-package.ps1'),"$global:fixtureVerified++");
  const initial={PathName:'"'+(scenario==='in-place'?join(newDir,'JarvisPcAgentServiceHost.exe'):oldExe)+'"',StartName:'SYNTHETIC\\Account',StartMode:scenario==='disabled'?'Disabled':'Manual',State:['stopped','disabled'].includes(scenario)?'Stopped':'Running'};
  await writeFile(join(dir,'service.json'),JSON.stringify(initial));
  const fixture=String.raw`param([switch]$Recover)
$ErrorActionPreference='Stop'
$global:fixtureRecovery=$Recover
$fixtureRoot=Split-Path -Parent $MyInvocation.MyCommand.Path
$global:fixtureSvc=Get-Content (Join-Path $fixtureRoot 'service.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$global:fixtureVerified=0; $global:fixtureStops=0; $global:fixtureStarts=0
function global:Save-Service { [IO.File]::WriteAllText((Join-Path $fixtureRoot 'service.json'),($global:fixtureSvc | ConvertTo-Json)) }
function global:Get-CimInstance {return $global:fixtureSvc}
function global:Get-Service {
 $v=[pscustomobject]@{Status=$global:fixtureSvc.State}
 $v | Add-Member ScriptMethod WaitForStatus {param($status,$timeout)}
 return $v
}
function global:Stop-Service {$global:fixtureStops++;$global:fixtureSvc.State='Stopped';Save-Service}
function global:sc.exe {
 if ($args[0] -ne 'config') {throw 'UNEXPECTED SCM COMMAND'}
 $global:fixtureSvc.PathName=$args[3];$global:fixtureSvc.StartMode=@{auto='Auto';demand='Manual';disabled='Disabled'}[$args[5]];Save-Service
 $global:LASTEXITCODE=0
}
function global:Start-Service {
 $global:fixtureStarts++
 if ($global:fixtureSvc.PathName.Contains('\new\')) {
  if ((Split-Path $fixtureRoot -Leaf) -like 'crash*' -and -not $global:fixtureRecovery) {[Environment]::Exit(37)}
  if ((Split-Path $fixtureRoot -Leaf) -eq 'start-failed') {throw 'SYNTHETIC START FAILURE'}
 }
 $global:fixtureSvc.State='Running';Save-Service
}
function global:Invoke-RestMethod {
 if ((Split-Path $fixtureRoot -Leaf) -eq 'wrong-health') {return @{module='OTHER';status='ok';localOnly=$true}}
 return @{module='B_PC_AGENT';status='ok';localOnly=$true}
}
$failure=$null
try {if($Recover){& (Join-Path $fixtureRoot 'new/update-service.ps1') -RollbackOnly}else{& (Join-Path $fixtureRoot 'new/update-service.ps1')}} catch {$failure=$_.Exception.Message}
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'observation.json'),(@{failure=$failure;service=$global:fixtureSvc;verified=$global:fixtureVerified;stops=$global:fixtureStops;starts=$global:fixtureStarts} | ConvertTo-Json -Depth 8))
`;
  await writeFile(join(dir,'fixture.ps1'),fixture);
  const executed=await run('powershell.exe',['-NoProfile','-File',join(dir,'fixture.ps1')],{windowsHide:true}).then(()=>null,e=>e);
  if(scenario.startsWith('crash')){
   assert.equal(executed?.code,37);assert.equal(JSON.parse(await readFile(join(newDir,'service-update-transaction.json'),'utf8')).phase,'switched');
   if(scenario==='crash'){
    await run('powershell.exe',['-NoProfile','-File',join(dir,'fixture.ps1')],{windowsHide:true});
    const pending=JSON.parse(await readFile(join(dir,'observation.json'),'utf8'));assert.match(pending.failure,/PC_UPDATE_RECOVERY_REQUIRED/);assert.equal(pending.stops,0);
   }
   if(scenario==='crash-code')await writeFile(oldExe,'CHANGED OLD CODE');
   if(['crash-account','crash-external'].includes(scenario)){
    const current=JSON.parse(await readFile(join(dir,'service.json'),'utf8'));
    if(scenario==='crash-account')current.StartName='SYNTHETIC\\OtherAccount';else current.PathName='"'+join(dir,'external.exe')+'"';
    await writeFile(join(dir,'service.json'),JSON.stringify(current));
   }
   await run('powershell.exe',['-NoProfile','-File',join(dir,'fixture.ps1'),'-Recover'],{windowsHide:true});
  }else assert.equal(executed,null);
  const observation=JSON.parse(await readFile(join(dir,'observation.json'),'utf8'));
  if(scenario!=='crash-account')assert.equal(observation.service.StartName,initial.StartName);
  assert.equal(await readFile(join(state,'synthetic-encrypted-vault'),'utf8'),'CIPHERTEXT ONLY');
  if(['crash-account','crash-code','crash-external'].includes(scenario)){
   assert.match(observation.failure,/PC_UPDATE_(ACCOUNT_CHANGED|ROLLBACK_CODE_CHANGED|EXTERNAL_CONFIGURATION_CHANGED)/);assert.equal(observation.stops,0);assert.equal(observation.starts,0);
   assert.equal(JSON.parse(await readFile(join(newDir,'service-update-transaction.json'),'utf8')).phase,'switched');
  }else if(['running','stopped','disabled'].includes(scenario)){
   assert.equal(observation.failure,null,scenario);assert.match(observation.service.PathName,/new/);assert.equal(observation.service.State,initial.State);assert.equal(observation.service.StartMode,initial.StartMode);
   if(scenario!=='running')assert.equal(observation.starts,0,'stopped/disabled update must not run queued work');
   assert.equal(JSON.parse(await readFile(join(newDir,'service-update-transaction.json'),'utf8')).phase,'committed');
  }else if(['start-failed','wrong-health','crash'].includes(scenario)){
   if(scenario!=='crash')assert.match(observation.failure,/PC_UPDATE_FAILED_ROLLED_BACK/);else assert.equal(observation.failure,null);
   assert.equal(observation.service.PathName,initial.PathName);assert.equal(observation.service.State,initial.State);
   assert.equal(JSON.parse(await readFile(join(newDir,'service-update-transaction.json'),'utf8')).phase,'rolled_back');
  }else {
   assert.match(observation.failure,/PC_UPDATE_(STATE_MIGRATION_REQUIRED|VERSIONED_FOLDER_REQUIRED|EXISTING_STATE_REQUIRED|PREVIOUS_RECOVERY_REQUIRED)/,scenario);assert.equal(observation.stops,0);assert.equal(observation.starts,0);assert.deepEqual(observation.service,initial);
  }
  assertions++;
  console.log(JSON.stringify({pcUpdateScenario:scenario,passed:true}));
 }
 console.log(JSON.stringify({serviceUpdateEvidence:{cases:assertions,generatedPowerShellExecuted:true,SCMSimulated:true,actualProcessKilledAfterSwitch:true,credentialBytesUnchanged:true,koreanFolderPaths:true}}));
});
