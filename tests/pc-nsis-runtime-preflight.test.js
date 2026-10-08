import test from 'node:test';import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';import {tmpdir} from 'node:os';
import {createInstallerPackagePlan} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';
import {createHash} from 'node:crypto';
const run=promisify(execFile);
test('Setup builder validates signed runtime before compilation and does not validate an obsolete Setup',async()=>{
 const files=createInstallerPackagePlan(await loadPcAgentInstallConfig()).files;
 const builder=files['build-nsis-installer.ps1'];assert.ok(builder.indexOf('-RuntimeOnly')<builder.indexOf('& $makensis.Source'));
 assert.match(files['verify-package.ps1'],/if \(-not \$SourceOnly -and -not \$RuntimeOnly\)/);
 assert.match(files['verify-package.ps1'],/if \(\$SourceOnly -and \$RuntimeOnly\)/);
});
test('actual compiler still runs after current runtime hash checks with a signature fixture; old Setup is not reused',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-nsis-preflight-'));
 try{
  const files=createInstallerPackagePlan(await loadPcAgentInstallConfig()).files;
  for(const name of ['build-nsis-installer.ps1','verify-package.ps1'])await writeFile(join(root,name),files[name]);
  const manifest=JSON.stringify({fileIntegrity:{}});await writeFile(join(root,'package-manifest.json'),manifest);
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex');const bytes=Buffer.from('unsigned synthetic fixture');
  const names=['JarvisPcAgentTray.exe','JarvisPcAgentServiceHost.exe'];for(const name of names)await writeFile(join(root,name),bytes);
  await writeFile(join(root,'runtime-integrity.psd1'),`@{schema='jarvis-pc-agent-runtime-integrity-v1'; packageManifestSha256='${sha(manifest)}'; artifacts=@(${names.map(name=>`@{name='${name}';sha256='${sha(bytes)}';sizeBytes=${bytes.length}}`).join(',')})}`);
  await writeFile(join(root,'installer.nsi'),'Unicode true\nName "Local compiler fixture"\nOutFile "JARVIS-PC-Agent-Setup.exe"\nSection\nSectionEnd');
  await writeFile(join(root,'JARVIS-PC-Agent-Setup.exe'),'obsolete fixture');
  // Override only the trust oracle in this owned test process. No real certificate
  // is created, trusted or used, and the product verifier is left unchanged.
  await writeFile(join(root,'invoke.ps1'),`function global:Get-AuthenticodeSignature { param([string]$LiteralPath) if([IO.Path]::GetFileName($LiteralPath) -eq 'JARVIS-PC-Agent-Setup.exe'){throw 'STALE_SETUP_CHECKED'}; return [pscustomobject]@{Status='Valid';SignerCertificate=[pscustomobject]@{Thumbprint='SYNTHETIC'}} }; & (Join-Path $PSScriptRoot 'build-nsis-installer.ps1')`);
  const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'invoke.ps1')],{windowsHide:true});
  assert.match(result.stdout,/Processed 1 file, writing output/);const setup=await readFile(join(root,'JARVIS-PC-Agent-Setup.exe'));assert.equal(setup.subarray(0,2).toString(),'MZ');
  console.log(JSON.stringify({actualCompiler:true,hashChecksActual:true,signatureTrust:'fixture-only',obsoleteSetupNotVerified:true,installerNotExecuted:true}));
 }finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-nsis-preflight-'));await rm(root,{recursive:true,force:true});}
});
for(const condition of ['missing-runtime','missing-manifest','unsigned-manifest','source-mismatch'])test('actual PowerShell blocks Setup compilation: '+condition,{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-nsis-preflight-'));
 try{
  const files=createInstallerPackagePlan(await loadPcAgentInstallConfig()).files;
  for(const name of ['build-nsis-installer.ps1','verify-package.ps1'])await writeFile(join(root,name),files[name]);
  await writeFile(join(root,'installer.nsi'),'Unicode true\nName "No unsafe compile"\nOutFile "JARVIS-PC-Agent-Setup.exe"\nSection\nSectionEnd');
  await writeFile(join(root,'package-manifest.json'),JSON.stringify({fileIntegrity:condition==='source-mismatch'?{'source.js':{sha256:'0'.repeat(64)}}:{}}));
  if(condition!=='missing-runtime')for(const name of ['JarvisPcAgentTray.exe','JarvisPcAgentServiceHost.exe'])await writeFile(join(root,name),'unsigned synthetic file');
  if(['unsigned-manifest','source-mismatch'].includes(condition))await writeFile(join(root,'runtime-integrity.psd1'),"@{schema='jarvis-pc-agent-runtime-integrity-v1'}");
  let error;try{await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'build-nsis-installer.ps1')],{windowsHide:true});}catch(e){error=e;}
  assert.ok(error,'Compiler unexpectedly accepted incomplete runtime');assert.notEqual(error.code,0);
  const text=String(error.stderr)+String(error.stdout);assert.doesNotMatch(text,/Processed 1 file|NSIS 설치 파일을 만들었습니다/);
  await assert.rejects(access(join(root,'JARVIS-PC-Agent-Setup.exe')),{code:'ENOENT'});
  console.log(JSON.stringify({condition,actualPowerShell:true,compilerNotInvoked:true,setupAbsent:true}));
 }finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-nsis-preflight-'));await rm(root,{recursive:true,force:true});}
});
