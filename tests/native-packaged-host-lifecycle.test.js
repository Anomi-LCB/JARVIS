import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm,mkdir,copyFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {renderPackagedControlCenterHostSource} from '../apps/pc-agent/src/install/packaged-control-center-host.js';
import {writeInstallerPackage} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const run=promisify(execFile);
test('actual Windows native host owner starts once, kills only owned child on crash and preserves occupied/existing servers',{skip:process.platform!=='win32',timeout:45000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-native-host-')),packageDir=join(root,'package'),exe=join(root,'owner.exe');
 const children=new Set(),servers=new Set();
 t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}for(const server of servers){server.closeAllConnections();await new Promise(r=>server.close(r));}await rm(root,{recursive:true,force:true});});
 await writeInstallerPackage({...await loadPcAgentInstallConfig(),outputDir:packageDir});
 await writeFile(join(root,'owner.cs'),renderPackagedControlCenterHostSource()+`
public static class Runner { public static void Main(string[] args) {
 try { using(var owner=new PackagedControlCenterHost(args[0],args[1],System.Int32.Parse(args[2]),args.Length>3?args[3]:null)) {
   owner.EnsureReady(); int first=owner.OwnedProcessId; owner.EnsureReady();
   if(first!=owner.OwnedProcessId)throw new System.Exception("DUPLICATE_START");
   System.Console.WriteLine("READY:"+first); System.Console.Out.Flush(); System.Console.ReadLine();
 }} catch(System.Exception error) { System.Console.Error.WriteLine(error.Message); System.Environment.Exit(1); }
}}
`);
 await run(join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/reference:System.Web.Extensions.dll','/out:'+exe,join(root,'owner.cs')],{windowsHide:true});
 async function freePort(){const server=createServer();await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});const port=server.address().port;await new Promise(r=>server.close(r));return port;}
 function startOwner(port,hash=null){const child=spawn(exe,[packageDir,hash?join(root,'missing-external-node.exe'):process.execPath,String(port),...(hash?[hash]:[])],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});children.add(child);return child;}
 async function ready(child){return new Promise((resolve,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(new Error('native owner readiness timeout')),15000);child.stderr.on('data',data=>{errors+=data;});child.stdout.on('data',data=>{output+=data;const match=output.match(/READY:(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]));}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Native owner exit '+code+':'+errors));});});}
 async function stop(child,crash=false){const done=once(child,'exit');if(crash)child.kill('SIGKILL');else child.stdin.end('\n');await done;}
 async function waitGone(port){const start=Date.now();while(Date.now()-start<5000){try{await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(300)});}catch{return;}await new Promise(r=>setTimeout(r,50));}throw new Error('owned child still listening after owner exit');}
 const port=await freePort(),first=startOwner(port),other=startOwner(port),pids=await Promise.all([ready(first),ready(other)]);
 assert.equal(pids.filter(pid=>pid>0).length,1);assert.equal(pids.filter(pid=>pid===0).length,1);
 const owner=pids[0]>0?first:other,attached=pids[0]>0?other:first;
 assert.equal((await fetch('http://127.0.0.1:'+port+'/health').then(r=>r.json())).module,'JARVIS_CONTROL_CENTER');
 await stop(attached);
 assert.equal((await fetch('http://127.0.0.1:'+port+'/health')).status,200);
 await stop(owner,true);await waitGone(port);
 const second=startOwner(port);assert.ok(await ready(second)>0);await stop(second);await waitGone(port);
 const conflict=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',nested:{module:'JARVIS_CONTROL_CENTER'}}));});servers.add(conflict);await listenOnFetchSafePort(conflict,{host:'127.0.0.1',port:0});
 const denied=startOwner(conflict.address().port);let error='';denied.stderr.on('data',data=>{error+=data;});const [code]=await once(denied,'exit');assert.equal(code,1);assert.match(error,/PC_UI_HOST_PORT_CONFLICT/);
 assert.equal((await fetch('http://127.0.0.1:'+conflict.address().port+'/health')).status,200);
 await mkdir(join(packageDir,'runtime'));const bundled=join(packageDir,'runtime/node.exe');await copyFile(process.execPath,bundled);
 const hash=createHash('sha256').update(await readFile(bundled)).digest('hex'),bundledOwner=startOwner(port,hash);assert.ok(await ready(bundledOwner)>0);await stop(bundledOwner);await waitGone(port);
 await writeFile(bundled,'damaged-runtime');const damaged=startOwner(port,hash);let damagedError='';damaged.stderr.on('data',data=>{damagedError+=data;});assert.equal((await once(damaged,'exit'))[0],1);assert.match(damagedError,/PC_NODE_BUNDLE_INTEGRITY_FAILED/);
 console.log(JSON.stringify({nativeHostLifetimeEvidence:{concurrentOwnersCreatedOneHost:true,ownedStartedOnce:true,existingReused:true,attachedDisposePreservedOwner:true,ownerCrashKilledChild:true,gracefulExitKilledChild:true,conflictDeniedWithoutTermination:true,bundledNodeWorksWithoutExternalPath:true,damagedBundleBlocked:true}}));
});
