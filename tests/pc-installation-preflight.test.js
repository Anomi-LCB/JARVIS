import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeInstallerPackage} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';
const run=promisify(execFile);
test('Windows readonly install preflight and compiled UI formatter keep missing proof distinct from readiness',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jarvis-install-preflight-')),packageDir=join(dir,'package');t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeInstallerPackage({...await loadPcAgentInstallConfig(),outputDir:packageDir});
 const snapshot=await run('powershell.exe',['-NoProfile','-File',join(packageDir,'installation-preflight.ps1')],{windowsHide:true,maxBuffer:1024*1024});
 const actual=JSON.parse(snapshot.stdout);assert.equal(actual.module,'PC_INSTALLATION_PREFLIGHT');assert.equal(actual.readOnly,true);assert.equal(actual.installationPerformed,false);assert.equal(actual.status,'blocked');assert.equal(actual.certificates.chainAndRevocationVerified,false);
 assert.ok(actual.checks.some(c=>c.id==='signature:JarvisPcAgentServiceHost.exe'&&c.status==='blocked'));
 assert.equal(/thumbprint|BEGIN PRIVATE KEY|refresh_token|Subject|StartName/u.test(snapshot.stdout),false);
 await run('powershell.exe',['-NoProfile','-File',join(packageDir,'build-tray-exe.ps1')],{windowsHide:true});
 const runner=join(dir,'formatter.exe');await writeFile(join(dir,'formatter.cs'),`public static class Runner { public static void Main(string[] args) {
 System.Console.OutputEncoding=new System.Text.UTF8Encoding(false);
 var type=System.Reflection.Assembly.LoadFrom(args[0]).GetType("JarvisControlWindow");
 var method=type.GetMethod("DescribeInstallationPreflight",System.Reflection.BindingFlags.Public|System.Reflection.BindingFlags.Static);
 try { System.Console.Write(method.Invoke(null,new object[]{System.IO.File.ReadAllText(args[1])})); }
 catch(System.Reflection.TargetInvocationException){System.Console.Write("REJECTED");}
}}
`);
 await run(join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/out:'+runner,join(dir,'formatter.cs')],{windowsHide:true});
 const cases=[actual,{...actual,status:'ready'},{...actual,readOnly:false},{...actual,installationPerformed:true},{...actual,version:2},{...actual,checks:null}];
 for(const [i,data] of cases.entries()){
  const input=join(dir,'input.json');await writeFile(input,JSON.stringify(data));
  const output=(await run(runner,[join(packageDir,'JarvisPcAgentTray.exe'),input],{windowsHide:true})).stdout;
  if(i===0)assert.match(output,/설치 전 준비 필요/);else assert.equal(output,'REJECTED');
 }
 console.log(JSON.stringify({installPreflightEvidence:{actualWindowsInventory:true,noInstallOrCredentialMutation:true,missingSignatureBlocked:true,rawCertificateOrAccountIdentifiersOmitted:true,nativeFormatterCases:6,readyClaimRejected:true,actualGUINotObserved:true}}));
});
