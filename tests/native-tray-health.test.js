import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeInstallerPackage} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const run=promisify(execFile);
test('compiled native tray health probe rejects nested/text identities and accepts actual product health',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-native-tray-health-')),packageDir=join(root,'package');let payload={};
 let redirectTargetCalls=0;
 const server=createServer((req,res)=>{res.setHeader('content-type','application/json');
  if(req.url==='/redirected'){redirectTargetCalls++;return res.end(JSON.stringify({module:'JARVIS_CONTROL_CENTER',status:'ok'}));}
  if(payload.qaRedirect){res.statusCode=302;res.setHeader('location','/redirected');}
  res.end(JSON.stringify(payload));});
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
 await writeInstallerPackage({...await loadPcAgentInstallConfig(),outputDir:packageDir});
 await run('powershell.exe',['-NoProfile','-File',join(packageDir,'build-tray-exe.ps1')],{windowsHide:true});
 const probe=join(root,'probe.exe');
 await writeFile(join(root,'probe.cs'),`public static class Runner { public static void Main(string[] args) {
 var assembly=System.Reflection.Assembly.LoadFrom(args[0]);
 var type=assembly.GetType("JarvisControlWindow");
 var method=type.GetMethod("ProbeHealthDetailed",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Static);
 var result=method.Invoke(null,new object[]{args[1],"JARVIS_CONTROL_CENTER"});
 System.Console.WriteLine(result.GetType().GetField("Healthy").GetValue(result));
}}
`);
 await run(join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/out:'+probe,join(root,'probe.cs')],{windowsHide:true});
 await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
 for(const [body,expected] of [
  [{module:'JARVIS_CONTROL_CENTER',status:'ok'},'True'],
  [{status:'ok',nested:{module:'JARVIS_CONTROL_CENTER'}},'False'],
  [{status:'ok',message:'JARVIS_CONTROL_CENTER'},'False'],
  [{module:'JARVIS_CONTROL_CENTER',status:'failed'},'False'],
  [{module:'JARVIS_CONTROL_CENTER',status:'ok',padding:'x'.repeat(5000)},'False'],
  [{qaRedirect:true},'False']
 ]){payload=body;const result=await run(probe,[join(packageDir,'JarvisPcAgentTray.exe'),'http://127.0.0.1:'+server.address().port+'/health'],{windowsHide:true});assert.equal(result.stdout.trim(),expected);}
 assert.equal(redirectTargetCalls,0);
});
