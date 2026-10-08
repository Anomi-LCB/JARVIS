import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeInstallerPackage} from '../apps/pc-agent/src/install/installer-packager.js';
import {PcAgentExecutionClient} from '../packages/core/src/client/pc-agent-execution-client.js';
import {CapabilityTokenService} from '../apps/policy-security/src/policy-runtime.js';
import {ActionType} from '../packages/shared/src/types.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';
const run=promisify(execFile);
test('compiled native service host OnStart runs packaged entry and writes diagnostics only to selected state root',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-native-service-payload-')),packageDir=join(root,'package'),state=join(root,'state');let owner,childPid;
 t.after(async()=>{if(owner&&owner.exitCode===null&&owner.signalCode===null){const exited=once(owner,'exit');owner.stdin.end('\n');await exited;}if(childPid){try{process.kill(childPid,'SIGKILL');}catch{}}await rm(root,{recursive:true,force:true});});
 const config=await loadPcAgentInstallConfig();config.daemonConfig.port=0;config.daemonConfig.queueDrain.enabled=false;
 await mkdir(join(state,'workspace'),{recursive:true});
 const bundledNodeRuntime=process.env.JARVIS_TEST_BUNDLED_NODE_LICENSE?{executablePath:process.execPath,licensePath:process.env.JARVIS_TEST_BUNDLED_NODE_LICENSE,version:process.version,expectedSha256:process.env.JARVIS_TEST_BUNDLED_NODE_SHA256}:null;
 if(bundledNodeRuntime)config.daemonConfig.nodePath=join(root,'missing-original-node.exe');
 await writeInstallerPackage({...config,outputDir:packageDir,pcAgentStateRoot:state,bundledNodeRuntime});
 await run('powershell.exe',['-NoProfile','-File',join(packageDir,'build-service-host.ps1')],{windowsHide:true});
 const runner=join(packageDir,'owner.exe');await writeFile(join(root,'owner.cs'),`public static class Runner {
 public static void Main(string[] args) {
 var type=System.Reflection.Assembly.LoadFrom(args[0]).GetType("JarvisPcAgentServiceHost");var host=System.Activator.CreateInstance(type);
 var flags=System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance;
 try { type.GetMethod("OnStart",flags).Invoke(host,new object[]{new string[0]});
  var child=(System.Diagnostics.Process)type.GetField("child",flags).GetValue(host);System.Console.WriteLine("CHILD:"+child.Id);System.Console.Out.Flush();System.Console.ReadLine();
 } finally { type.GetMethod("OnStop",flags).Invoke(host,null); }
 }}
`);
 await run(join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/out:'+runner,join(root,'owner.cs')],{windowsHide:true});
 owner=spawn(runner,[join(packageDir,'JarvisPcAgentServiceHost.exe')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,JARVIS_PC_AGENT_API_TOKEN:'isolated-native-service-admin',JARVIS_CAPABILITY_TOKEN_SECRET:'isolated-native-service-capability-secret'}});
 childPid=await new Promise((resolve,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(new Error('Native start timeout:'+errors)),10000);owner.stderr.on('data',d=>{errors+=d;});owner.stdout.on('data',d=>{output+=d;const match=output.match(/CHILD:(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]));}});owner.once('exit',code=>{clearTimeout(timer);reject(new Error('Native owner exit '+code+':'+errors));});});
 const logPath=join(state,'apps/pc-agent/logs/pc-agent-service-host.log');let base;
 for(let n=0;n<30;n++){const log=await readFile(logPath,'utf8').catch(()=>''),match=log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);if(match){base=match[1];break;}await new Promise(r=>setTimeout(r,100));}
 assert.ok(base);assert.equal((await fetch(base+'/health').then(r=>r.json())).module,'B_PC_AGENT');
 const workspace=join(state,'workspace'),action={actionType:ActionType.CREATE_FILE,toolName:'filesystem.createTextFile',arguments:{path:join(workspace,'native-result.txt'),content:'Native packaged service signed file verified'}};
 const issuer=new CapabilityTokenService({signingSecret:'isolated-native-service-capability-secret'});
 const packet={packetId:'native-payload-packet',taskId:'native-payload-task',planId:'native-payload-plan',action,capabilityToken:issuer.issue({taskId:'native-payload-task',planId:'native-payload-plan',approvalId:'native-payload-approval',action,allowedPaths:[workspace]}),requestedMode:'execute',userConfirmation:{approvalId:'native-payload-approval',confirmed:true,confirmedAt:new Date().toISOString()}};
 const client=new PcAgentExecutionClient({baseUrl:base,executionToken:'isolated-native-service-admin'});
 assert.equal((await client.receiveExecutionPacket(packet)).status,'COMPLETED');
 assert.equal(await readFile(action.arguments.path,'utf8'),action.arguments.content);
 assert.equal((await client.taskResult(packet.taskId)).status,'COMPLETED');
 await assert.rejects(readFile(join(packageDir,'pc-agent-service-host.log')),{code:'ENOENT'});
 const exited=once(owner,'exit');owner.stdin.end('\n');assert.equal((await exited)[0],0);
 await assert.rejects(fetch(base+'/health',{signal:AbortSignal.timeout(500)}));
 childPid=null;
 console.log(JSON.stringify({nativeServicePayloadEvidence:{actualOnStartOnStop:true,workingRootHasNoRepositoryCode:true,stateRootDiagnosticLog:true,installedCodeDirectoryLogAbsent:true,healthObserved:true,signedFileVerified:true,bundledNodeObserved:Boolean(bundledNodeRuntime),missingOriginalNodePath:Boolean(bundledNodeRuntime)}}));
});
