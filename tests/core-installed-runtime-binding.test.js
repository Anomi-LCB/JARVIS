import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,symlink,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validateCoreInstalledRuntimeBinding,installedBindingPreflightLines} from '../packages/core/src/install/core-installed-runtime-binding.js';
import {createCoreServicePackagePlan,writeCoreServicePackage} from '../packages/core/src/install/core-service-packager.js';
const exec=promisify(execFile);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('service binding pins runtime, isolates state, retains identity and rejects altered or aliased packages',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-core-installed-binding-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const packageRoot=join(root,'runtime-package'),stateRoot=join(root,'state');
 await mkdir(join(packageRoot,'pc-agent-runtime'),{recursive:true});await mkdir(join(packageRoot,'runtime'),{recursive:true});
 const launcher='reviewed-launcher',node='reviewed-node';
 const input={packageRoot,stateRoot,launcherSha256:sha(launcher),nodeSha256:sha(node)};
 await writeFile(join(packageRoot,'pc-agent-runtime/core-launch.mjs'),launcher);await writeFile(join(packageRoot,'runtime/node.exe'),node);
 await writeFile(join(packageRoot,'package-manifest.json'),JSON.stringify({packageId:'jarvis-pc-agent-windows-service',fileIntegrity:{'pc-agent-runtime/core-launch.mjs':{sha256:input.launcherSha256},'runtime/node.exe':{sha256:input.nodeSha256}}}));
 const plan=createCoreServicePackagePlan({cwd:process.cwd(),outputDir:join(root,'service'),installedRuntime:input});
 assert.equal(plan.installPlan.workspaceRoot,stateRoot);assert.equal(plan.installPlan.environment.JARVIS_CORE_STATE_ROOT,stateRoot);
 assert.equal(plan.manifest.nodeExecutable,join(packageRoot,'runtime/node.exe'));assert.equal(plan.manifest.runtimeEntry,'pc-agent-runtime/core-launch.mjs');
 assert.equal(plan.updatePlan.serviceAccount,'preserve');assert.equal(plan.updatePlan.environment.JARVIS_CORE_STATE_ROOT,stateRoot);assert.match(plan.updatePlan.commands.join('\n'),/update-service\.ps1/);
 assert.ok(plan.files['update-service.ps1'].indexOf('$checkInfo=New-Object Diagnostics.ProcessStartInfo')<plan.files['update-service.ps1'].indexOf(' $transaction=[pscustomobject]'));
 assert.doesNotMatch(plan.files['service-host.cs'],new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 assert.match(plan.files['service-host.cs'],/VerifyRuntimeBinding\(\);/);
 assert.throws(()=>createCoreServicePackagePlan({installedRuntime:input,updateServiceAccount:'local-system'}),/IDENTITY_MUST_PRESERVE/);
 assert.throws(()=>validateCoreInstalledRuntimeBinding({...input,stateRoot:join(packageRoot,'new-state')}),/STATE_IS_CODE/);
 assert.throws(()=>createCoreServicePackagePlan({installedRuntime:input,logs:{allowedRoot:packageRoot}}),/STATE_IS_CODE/);
 const alias=join(root,'alias');await symlink(packageRoot,alias,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>validateCoreInstalledRuntimeBinding({...input,stateRoot:join(alias,'new-state')}),/STATE_IS_CODE/);
 assert.throws(()=>validateCoreInstalledRuntimeBinding({...input,packageRoot:alias}),/LINK_DENIED/);
 assert.throws(()=>validateCoreInstalledRuntimeBinding({...input,nodeSha256:''}),/PIN_REQUIRED/);
 if(process.platform==='win32'){
  const preflight=join(root,'check.ps1');await writeFile(preflight,installedBindingPreflightLines(validateCoreInstalledRuntimeBinding(input)).join('\n'));
  await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',preflight],{windowsHide:true});
 }
 await writeFile(join(packageRoot,'runtime/node.exe'),'changed-node');
 assert.throws(()=>validateCoreInstalledRuntimeBinding(input),/INTEGRITY_FAILED/);
 if(process.platform==='win32')await assert.rejects(exec('powershell.exe',['-NoProfile','-NonInteractive','-File',join(root,'check.ps1')],{windowsHide:true}),error=>/integrity failed/i.test(error.stderr));
});

test('real Windows service host compiles and verifies pinned package without installing SCM',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-core-host-한글 경로-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const sourceRoot=join(process.cwd(),'artifacts/packaged-core-runtime-20261003/package');
 const packageRoot=join(root,'reviewed-preflight-fixture');
 await mkdir(join(packageRoot,'pc-agent-runtime'),{recursive:true});await mkdir(join(packageRoot,'runtime'),{recursive:true});
 for(const name of ['package-manifest.json','pc-agent-runtime/core-launch.mjs','runtime/node.exe'])await copyFile(join(sourceRoot,name),join(packageRoot,name));
 const manifest=JSON.parse(await readFile(join(packageRoot,'package-manifest.json'),'utf8'));
 const input={packageRoot,stateRoot:join(root,'state'),launcherSha256:manifest.fileIntegrity['pc-agent-runtime/core-launch.mjs'].sha256,nodeSha256:manifest.fileIntegrity['runtime/node.exe'].sha256};
 const generated=await writeCoreServicePackage({outputDir:root,installedRuntime:input});
 const actualScript=await readFile(join(root,'install-service.ps1'));
 assert.equal(actualScript.toString('utf8').charCodeAt(0),0xFEFF);
 assert.equal(sha(actualScript),generated.manifest.fileIntegrity['install-service.ps1'].sha256);
 const koreanPreflight=join(root,'runtime-preflight.ps1');
 await writeFile(koreanPreflight,Buffer.concat([actualScript.subarray(0,3),Buffer.from(installedBindingPreflightLines(validateCoreInstalledRuntimeBinding(input)).join('\n'))]));
 await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',koreanPreflight],{windowsHide:true});
 await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',join(root,'build-service-host.ps1')],{windowsHide:true});
 const result=await exec(join(root,'JarvisCoreRuntimeHost.exe'),['--check-runtime'],{windowsHide:true});
 assert.match(result.stdout,/CoreRuntimeBindingVerified/);
 const reflectionPath=join(root,'inspect-argument.ps1');
 await writeFile(reflectionPath,'\uFEFF'+[
  '$ErrorActionPreference="Stop"',
  '[Reflection.Assembly]::LoadWithPartialName("System.ServiceProcess") | Out-Null',
  `$assembly=[Reflection.Assembly]::LoadFile('${join(root,'JarvisCoreRuntimeHost.exe').replaceAll("'","''")}')`,
  '$method=$assembly.GetType("JarvisCoreRuntimeHost").GetMethod("Quote",[Reflection.BindingFlags]"NonPublic,Static")',
  '$method.Invoke($null,@("C:\\space dir\\core-launch.mjs"))'
 ].join('\n'));
 const quoted=await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',reflectionPath],{windowsHide:true});
 assert.equal(quoted.stdout.trim(),'"C:\\space dir\\core-launch.mjs"');
 await writeFile(join(packageRoot,'pc-agent-runtime/core-launch.mjs'),'throw new Error("TAMPER_EXECUTED");');
 await assert.rejects(exec(join(root,'JarvisCoreRuntimeHost.exe'),['--check-runtime'],{windowsHide:true}),error=>/CORE_INSTALLED_RUNTIME_INTEGRITY_FAILED/.test(error.stderr)&&!error.stderr.includes('TAMPER_EXECUTED'));
 console.log(JSON.stringify({actualCsharpCompiled:true,actualPinnedHostPreflight:true,actualHostTamperDenied:true,scmInstalled:false,serviceStarted:false}));
});
