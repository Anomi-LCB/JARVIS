import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {readPcOutboundExecutionConfiguration,createConfiguredPcOutboundExecutor} from '../packages/core/src/client/configured-pc-outbound-executor.js';
import {createRemoteArtifactBinding} from '../packages/core/src/mission/remote-artifact-contract.js';
import {coreServiceRuntimeOptionsFromEnv,createConfiguredCoreServiceRuntime} from '../scripts/core-service-runtime.mjs';
import {startPcOutboundNodeService} from '../packages/core/src/client/pc-outbound-service.js';
import {PcOutboundExecutionClient} from '../packages/core/src/client/pc-outbound-execution-client.js';

const pem=name=>readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url));
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-configured-outbound-')),runtimes=[];
 const binding=createRemoteArtifactBinding({deviceId:'configured-pc',deviceGeneration:1,certificateFingerprint:new X509Certificate(pem('core')).fingerprint256,pathPlatform:'posix',allowedRoots:['/isolated-pc-workspace'],rootScopeSha256:'a'.repeat(64)});
 const path=join(root,'binding.json');writeFileSync(path,JSON.stringify(binding));
 const env={JARVIS_TEST_MODE:'1',JARVIS_CORE_ROOT:root,JARVIS_TEST_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_PORT:'0',JARVIS_CORE_ALLOWED_ROOTS:'workspace',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_OPERATIONS_DB:join(root,'operations.sqlite'),JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:'0',JARVIS_CORE_PC_OUTBOUND_ENABLED:'1',JARVIS_CORE_PC_OUTBOUND_COMMAND_ENABLED:'1',JARVIS_CORE_PC_OUTBOUND_EXECUTION_ENABLED:'1',JARVIS_CORE_PC_OUTBOUND_EXECUTION_BINDING_PATH:path};
 const open=async(overrides={},fenced=true)=>{const runtime=await createConfiguredCoreServiceRuntime({env:{...env,...overrides},pcOutboundServiceFactory:({authorityGuard})=>startPcOutboundNodeService({dbPath:join(root,'relay.sqlite'),authorityGuard,commandTransport:true,commandExecutionFenceRequired:fenced,tls:{key:pem('server-key'),cert:pem('server'),ca:pem('ca')}})});runtimes.push(runtime);return runtime;};
 t.after(async()=>{for(const r of runtimes)await r.close();rmSync(root,{recursive:true,force:true});});
 return {root,path,binding,env,open};
}

test('outbound execution is explicit and accepts only the pinned canonical v2 binding',t=>{
 const f=fixture(t);assert.equal(readPcOutboundExecutionConfiguration({}),null);
 assert.deepEqual(readPcOutboundExecutionConfiguration(f.env),f.binding);
 for(const enabled of ['yes','true','',1])assert.throws(()=>readPcOutboundExecutionConfiguration({...f.env,JARVIS_CORE_PC_OUTBOUND_EXECUTION_ENABLED:enabled}),/CONFIG_INVALID/);
 assert.throws(()=>readPcOutboundExecutionConfiguration({...f.env,JARVIS_CORE_PC_OUTBOUND_EXECUTION_ENABLED:'0'}),/DISABLED_BINDING_PRESENT/);
 assert.throws(()=>readPcOutboundExecutionConfiguration({...f.env,JARVIS_CORE_PC_OUTBOUND_EXECUTION_BINDING_PATH:'binding.json'}),/BINDING_PATH_INVALID/);
 for(const value of [{...f.binding,version:'remote-artifact-binding-v1'},{...f.binding,secret:'must-not-be-accepted'},{...f.binding,certificateFingerprint:f.binding.certificateFingerprint.toLowerCase()},{...f.binding,rootScopeSha256:null},null]){
  writeFileSync(f.path,JSON.stringify(value));assert.throws(()=>readPcOutboundExecutionConfiguration(f.env),/BINDING_INVALID/);
 }
 writeFileSync(f.path,'x'.repeat(16385));assert.throws(()=>readPcOutboundExecutionConfiguration(f.env),/BINDING_FILE_INVALID/);
 writeFileSync(f.path,'{invalid');assert.throws(()=>readPcOutboundExecutionConfiguration(f.env),/BINDING_INVALID/);
 assert.throws(()=>readPcOutboundExecutionConfiguration({...f.env,JARVIS_CORE_PC_OUTBOUND_EXECUTION_BINDING_PATH:f.root}),/BINDING_FILE_INVALID/);
 assert.throws(()=>readPcOutboundExecutionConfiguration({...f.env,JARVIS_CORE_PC_OUTBOUND_EXECUTION_BINDING_PATH:join(f.root,'missing.json')}),/BINDING_INVALID/);
});

test('binding symlinks cannot redirect startup configuration',t=>{
 const f=fixture(t),link=join(f.root,'link.json');
 try{symlinkSync(f.path,link);}catch(e){if(e.code==='EPERM'){t.skip('OS requires symlink privilege; Linux test covers this case');return;}throw e;}
 assert.throws(()=>readPcOutboundExecutionConfiguration({...f.env,JARVIS_CORE_PC_OUTBOUND_EXECUTION_BINDING_PATH:link}),/BINDING_FILE_INVALID/);
});

test('authority, command transport and direct HTTP conflict fail before runtime creation',t=>{
 const f=fixture(t);
 for(const [overrides,error] of [[{JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'0'},'AUTHORITY_REQUIRED'],[{JARVIS_CORE_PC_OUTBOUND_ENABLED:'0'},'COMMAND_SERVICE_REQUIRED'],[{JARVIS_CORE_PC_OUTBOUND_COMMAND_ENABLED:'0'},'COMMAND_SERVICE_REQUIRED'],[{JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED:'1'},'CONFLICTING_TRANSPORT'],[{JARVIS_PC_AGENT_API_URL:'http://127.0.0.1:17776',JARVIS_PC_AGENT_EXECUTION_TOKEN:'synthetic'},'CONFLICTING_TRANSPORT']])assert.throws(()=>coreServiceRuntimeOptionsFromEnv({env:{...f.env,...overrides}}),new RegExp(error));
 assert.equal(createConfiguredPcOutboundExecutor(),null);
 assert.throws(()=>createConfiguredPcOutboundExecutor({binding:f.binding,service:{commandMailbox:{executionFenceRequired:false}}}),/FENCED_SERVICE_REQUIRED/);
});

test('actual configured service injects the fenced executor and matching recovery, keeps registration separate, and survives restart',async t=>{
 const f=fixture(t),runtime=await f.open();
 assert.ok(runtime.remotePcAgent instanceof PcOutboundExecutionClient);
 assert.equal(runtime.orchestrationWorker.pcAgent,runtime.remotePcAgent);
 assert.equal(runtime.remotePcAgent.supportsCoreAuthorityFencing(),true);
 assert.equal(runtime.remotePcAgent.matchesRecovery(runtime.missionRuntime.remoteArtifactRecovery),true);
 assert.equal(runtime.options.pcAgentRemoteExecutionEnabled,false);
 const packet={taskId:'unregistered-task',idempotencyKey:'mission_op_'+'b'.repeat(32),action:{toolName:'filesystem.createTextFile',arguments:{path:'/isolated-pc-workspace/output.txt',content:'never execute'}}};
 await assert.rejects(runtime.remotePcAgent.prepareOperation(packet),{code:'A_PC_COMMAND_EXECUTION_SCOPE_DENIED'});
 assert.equal(runtime.coreFacade.tasks.size,0,'failed remote preparation cannot create a local task');
 const enroll=generation=>runtime.pcOutboundService.controller.enroll({deviceId:f.binding.deviceId,certificateFingerprint:f.binding.certificateFingerprint,expiresAt:new Date(Date.now()+60000).toISOString().replace(/\.\d{3}Z$/u,'Z'),allowedTaskIds:[packet.taskId],expectedGeneration:generation});
 enroll(0);runtime.pcOutboundService.commandMailbox.grant({deviceId:f.binding.deviceId,expectedGeneration:1,allowedTaskIds:[packet.taskId],expiresAt:Date.now()+50000});
 runtime.pcOutboundService.controller.revoke(f.binding.deviceId,{expectedGeneration:1});enroll(1);
 runtime.pcOutboundService.commandMailbox.grant({deviceId:f.binding.deviceId,expectedGeneration:2,allowedTaskIds:[packet.taskId],expiresAt:Date.now()+50000});
 await assert.rejects(runtime.remotePcAgent.prepareOperation(packet),{code:'A_PC_COMMAND_CLIENT_DEVICE_CHANGED'});
 const token=runtime.missionExecutionAuthority.lease.token;await runtime.close();
 const restarted=await f.open({JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:String(token)});
 assert.equal(restarted.missionExecutionAuthority.lease.token,token+1);
 assert.equal(restarted.remotePcAgent.matchesRecovery(restarted.missionRuntime.remoteArtifactRecovery),true);
 assert.deepEqual(restarted.options.pcOutboundExecutionBinding,f.binding);
 await assert.rejects(restarted.remotePcAgent.prepareOperation(packet),{code:'A_PC_COMMAND_CLIENT_DEVICE_CHANGED'});
});

test('an unfenced service fails startup and releases its Core authority for explicit recovery',async t=>{
 const f=fixture(t);await assert.rejects(f.open({},false),/FENCED_SERVICE_REQUIRED/);
 const recovered=await f.open({JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:'1'});
 assert.equal(recovered.missionExecutionAuthority.lease.token,2);
 assert.equal(recovered.remotePcAgent.supportsCoreAuthorityFencing(),true);
});
