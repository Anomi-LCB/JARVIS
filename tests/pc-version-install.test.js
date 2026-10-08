import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInstallerPackagePlan} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';
import {CapabilityTokenVault,WindowsDpapiVaultKeyProvider} from '../apps/pc-agent/src/pc-agent-runtime.js';
const run=promisify(execFile);
test('version layout stays stable and changes with execution settings without overwriting old code',async()=>{
 const config=await loadPcAgentInstallConfig();const first=createInstallerPackagePlan(config),second=createInstallerPackagePlan({...config,generatedAt:'2030-01-01T00:00:00Z'});
 assert.equal(first.manifest.releaseLayout.id,second.manifest.releaseLayout.id);
 const changed=createInstallerPackagePlan({...config,daemonConfig:{...config.daemonConfig,port:17999}});
 assert.notEqual(first.manifest.releaseLayout.id,changed.manifest.releaseLayout.id);
 const script=String(first.files['installer.nsi']);assert.ok(script.includes('$PROGRAMFILES64\\JARVIS\\PC-Agent\\releases\\'+first.manifest.releaseLayout.id));
 assert.ok(script.indexOf('existing_code:')<script.search(/^  File "/mu));
 assert.ok(script.includes('install-all.ps1'));assert.ok(!script.includes('\\start-service.ps1'));
 assert.ok(script.indexOf('\\uninstall-service.ps1')<script.indexOf('\\uninstall-tray-shortcut.ps1'));
});
test('actual generated install entry preserves stopped services and old uninstallers cannot delete newer services',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jarvis-version-install-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const plan=createInstallerPackagePlan({...await loadPcAgentInstallConfig(),outputDir:join(dir,'candidate')});
 const vaultPath=join(dir,'isolated-vault.jsonl'),cachePath=vaultPath+'.dpapi-key';
 const vault=new CapabilityTokenVault({vaultPath,keyProvider:new WindowsDpapiVaultKeyProvider({cachePath,allowInsecureFallback:false})});
 const syntheticToken={tokenId:'SYNTHETIC-INSTALL-PRESERVATION-TOKEN',scope:['isolated-test']};
 vault.sealCapabilityToken(syntheticToken,{taskId:'isolated-install-test'});
 const vaultBytes=await readFile(vaultPath),keyBytes=await readFile(cachePath);
 assert.equal(vault.status().keyProvider.protectedByOs,true);
 assert.equal(vaultBytes.toString().includes(syntheticToken.tokenId),false);
 await writeFile(join(dir,'install-all.ps1'),plan.files['install-all.ps1']);
 for(const file of ['verify-package','install-service','start-service','verify-installed-service','install-tray-shortcut'])await writeFile(join(dir,file+'.ps1'),`$global:fixtureCalls.Add('${file}')`);
 const uninstall=String(plan.files['uninstall-service.ps1']).replace(/^\uFEFF/u,'').replace(/\$principal =[^\n]*\nif \(-not \$principal[^\n]*\n\s*throw[^\n]*\n\s*\}\n/u,'# isolated fixture: no elevation or SCM\n');
 await writeFile(join(dir,'uninstall-service.ps1'),'\uFEFF'+uninstall);
 const fixture=String.raw`param([string]$Scenario)
$ErrorActionPreference='Stop'
$global:fixtureCalls=New-Object 'Collections.Generic.List[string]'
$global:fixtureScenario=$Scenario
function Get-CimInstance {
 if($global:fixtureScenario -eq 'fresh'){return $null}
 return [pscustomobject]@{State= $(if($global:fixtureScenario -eq 'running'){'Running'}else{'Stopped'});PathName='"C:\SYNTHETIC-OTHER-VERSION\JarvisPcAgentServiceHost.exe"'}
}
function Stop-Service {$global:fixtureCalls.Add('UNEXPECTED STOP')}
function sc.exe {$global:fixtureCalls.Add('UNEXPECTED DELETE')}
$failure=$null
try {
 if($Scenario -eq 'old-uninstaller'){& (Join-Path $PSScriptRoot 'uninstall-service.ps1')}
 else {& (Join-Path $PSScriptRoot 'install-all.ps1')}
}catch {$failure=$_.Exception.Message}
@{failure=$failure;calls=@($global:fixtureCalls.ToArray())} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $PSScriptRoot 'observation.json')
`;
 await writeFile(join(dir,'fixture.ps1'),fixture);
 for(const scenario of ['fresh','running','stopped','old-uninstaller']){
  await run('powershell.exe',['-NoProfile','-File',join(dir,'fixture.ps1'),'-Scenario',scenario],{windowsHide:true});
  const observed=JSON.parse(await readFile(join(dir,'observation.json'),'utf8'));
  if(scenario==='old-uninstaller'){assert.match(observed.failure,/PC_UNINSTALL_OTHER_VERSION_ACTIVE/);assert.deepEqual(observed.calls,[]);}
  else {assert.equal(observed.failure,null);assert.ok(observed.calls.includes('install-service'));assert.equal(observed.calls.includes('start-service'),scenario==='fresh');assert.equal(observed.calls.includes('verify-installed-service'),scenario!=='stopped');}
 }
 assert.deepEqual(await readFile(vaultPath),vaultBytes);assert.deepEqual(await readFile(cachePath),keyBytes);
 const reopened=new CapabilityTokenVault({vaultPath,keyProvider:new WindowsDpapiVaultKeyProvider({cachePath,allowInsecureFallback:false})});
 assert.deepEqual(reopened.open(reopened.records[0]),syntheticToken);
 console.log(JSON.stringify({versionInstallEvidence:{PowerShellExecuted:true,SCMSimulated:true,freshStarts:true,stoppedDoesNotStart:true,oldUninstallerBlocked:true,actualWindowsDpapiRoundTrip:true,vaultAndKeyBytesUnchanged:true,scope:'same-Windows-user-and-machine'}}));
});
