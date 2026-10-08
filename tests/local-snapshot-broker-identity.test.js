import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';import {join,dirname,basename,resolve} from 'node:path';import {createHash} from 'node:crypto';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {ManagedAgentSessionBroker} from '../packages/core/src/mission/managed-agent-session-broker.js';
import {FileMissionStore} from '../packages/core/src/mission/mission-store.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
for(const changed of [false,true])test('real composition broker reports current artifact loss: '+changed,async()=>{
 const root=fs.mkdtempSync(join(tmpdir(),'jarvis-snapshot-broker-')),file=join(root,'report.txt'),store=new FileMissionStore({filePath:join(root,'missions.json')}),db=new DatabaseSync(join(root,'broker.sqlite'));
 let runtime,broker,calls=0;const nativeOpen=fs.openSync;
 try{
  fs.writeFileSync(file,'persisted product result');
  runtime=createAgRuntime({env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0'},allowedRoots:[root],auditRoot:join(root,'audit'),missionStore:store,workerDaemonEnabled:false,managedAgentSessionBrokerFactory:()=>{
   broker=new ManagedAgentSessionBroker({db,provider:{retrieveSession:async()=>{throw Object.assign(Error('removed'),{status:404});},submitToolResult:async()=>{calls++;}},allowedToolNames:['local.read_verified'],dispatchVerifiedTool:async()=>{calls++;}});return broker;
  }});
  const mission=runtime.missionRuntime.createMission({objective:'로컬 자료의 복구 상태를 확인해',allowedRoot:root});
  const artifact={rootIndex:0,relativePath:'report.txt',outsideAllowedRoots:false,pathHash:hash(file),contentSha256:hash(fs.readFileSync(file))};
  const saved=store.load();saved.find(m=>m.missionId===mission.missionId).observations=[{artifacts:[artifact]}];store.save(saved);
  const before=fs.readFileSync(store.filePath,'utf8');broker.bindSession({missionId:mission.missionId,sessionId:'removed-session'});
  let injected=false;
  fs.openSync=(path,...args)=>{const fd=nativeOpen(path,...args);if(changed&&path===file&&!injected){injected=true;fs.renameSync(file,join(root,'previous.txt'));fs.writeFileSync(file,'different current result');}return fd;};syncBuiltinESMExports();
  const result=await broker.reconcileMission(mission.missionId);
  assert.equal(result.status,'blocked');assert.equal(result.taskVerified,false);assert.equal(result.localRecoveryStatus,'restored');
  assert.deepEqual(result.lostRemoteArtifacts,changed?[artifact.pathHash]:[]);assert.equal(calls,0);assert.equal(injected,changed);
  assert.equal(fs.readFileSync(store.filePath,'utf8'),before,'snapshot inspection must not overwrite persisted Mission');
 }finally{
  fs.openSync=nativeOpen;syncBuiltinESMExports();runtime?.coreFacade.cognition?.close();db.close();
  assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-snapshot-broker-'));fs.rmSync(root,{recursive:true,force:true});
 }
});
