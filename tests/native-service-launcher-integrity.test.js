import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeInstallerPackage} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';
const run=promisify(execFile);

test('compiled native service host rejects changed launcher before any Node script effect', {skip:process.platform!=='win32',timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-launcher-integrity-')),packageDir=join(root,'package'),state=join(root,'state');
 t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const config=await loadPcAgentInstallConfig();config.daemonConfig.port=0;
 await writeInstallerPackage({...config,outputDir:packageDir,pcAgentStateRoot:state});
 await run('powershell.exe',['-NoProfile','-File',join(packageDir,'build-service-host.ps1')],{windowsHide:true});
 const marker=join(root,'tamper-effect.txt');
 await writeFile(join(packageDir,'pc-agent-runtime','launch.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'UNVERIFIED_LAUNCHER_EXECUTED');process.exit(41);`);
 const source=join(root,'probe.cs'),probe=join(packageDir,'probe.exe');
 await writeFile(source,`public static class Probe {public static int Main(string[] args) {
 var type=System.Reflection.Assembly.LoadFrom(args[0]).GetType("JarvisPcAgentServiceHost");var host=System.Activator.CreateInstance(type);
 var flags=System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic;
 try {type.GetMethod("OnStart",flags).Invoke(host,new object[]{new string[0]});return 1;}
 catch(System.Reflection.TargetInvocationException error){System.Console.Error.WriteLine(error.InnerException.Message);return 17;}
 finally {type.GetMethod("OnStop",flags).Invoke(host,null);}
 }} `);
 await run(join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/out:'+probe,source],{windowsHide:true});
 const outcome=await run(probe,[join(packageDir,'JarvisPcAgentServiceHost.exe')],{cwd:root,windowsHide:true,timeout:10000}).then(()=>null,error=>error);
 await assert.rejects(readFile(marker),{code:'ENOENT'});
 assert.equal(outcome?.code,17);assert.match(outcome.stderr,/PC_RUNTIME_LAUNCHER_INTEGRITY_FAILED/);
  await unlink(join(packageDir,'pc-agent-runtime','launch.mjs'));
  const missing=await run(probe,[join(packageDir,'JarvisPcAgentServiceHost.exe')],{cwd:root,windowsHide:true,timeout:10000}).then(()=>null,error=>error);
  assert.equal(missing?.code,17);assert.match(missing.stderr,/PC_RUNTIME_LAUNCHER_MISSING/);
  await assert.rejects(readFile(marker),{code:'ENOENT'});
});
