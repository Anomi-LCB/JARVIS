import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createConfiguredCoreServiceRuntime} from '../scripts/core-service-runtime.mjs';

for(const denied of [null,'second'])test(`trusted packet prerequisite checks every graph node; denial=${denied}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-packet-prerequisite-'));
 const env={JARVIS_TEST_MODE:'1',JARVIS_TEST_AUDIT_ROOT:root,JARVIS_CORE_ROOT:root,JARVIS_CORE_ALLOWED_ROOTS:root,
  JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
 const runtime=await createConfiguredCoreServiceRuntime({env});
 t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
 await writeFile(join(root,'material.txt'),'synthetic material');
 const task=runtime.coreFacade.createTask('파일 목록 보여줘 그리고 파일 목록 보여줘');
 const nodes=task.plan.planGraph.nodes.filter(x=>x.nodeId.startsWith('action_'));
 assert.equal(nodes.length,2);
 // A declared sequential topology lets the second denial prove the first B/G
 // observation is retained rather than erased by a rejected Promise.all.
 const graph=task.plan.planGraph;
 graph.edges=graph.edges.filter(x=>!(x.from?.startsWith('action_')&&x.to?.startsWith('action_')));
 graph.edges.push({from:nodes[0].nodeId,to:nodes[1].nodeId,condition:'success',dependencyType:'hard_dependency'});
 graph.scheduler=runtime.coreFacade.localTaskPlanner.planGraphScheduleFor({nodes:graph.nodes,edges:graph.edges,executionMode:'sequential_safe'});
 const worker=runtime.orchestrationWorker,packets=[],checks=[];
 const receive=worker.pcAgent.receiveExecutionPacket.bind(worker.pcAgent);
 worker.pcAgent.receiveExecutionPacket=async(packet,options)=>{packets.push(packet.planGraphNodeId);return receive(packet,options);};
 const run=await worker.runTask(task.taskId,{beforePacketDispatch:async packet=>{
  checks.push(packet.planGraphNodeId??'base');
  if(denied&&packet.planGraphNodeId===nodes[1].nodeId)throw Object.assign(new Error('synthetic revocation'),{code:'A_MISSION_CAPABILITY_UNAVAILABLE',notDispatched:true});
 }});
 assert.deepEqual(checks,['base',...nodes.map(x=>x.nodeId)]);
 assert.deepEqual(packets,denied?[nodes[0].nodeId]:nodes.map(x=>x.nodeId));
 assert.equal(run.success,!denied);
 if(denied){
  const first=run.planGraphRun.nodeRuns.find(x=>x.nodeId===nodes[0].nodeId);
  const second=run.planGraphRun.nodeRuns.find(x=>x.nodeId===nodes[1].nodeId);
  assert.equal(first.status,'completed');assert.equal(first.verificationStatus,'passed');
  assert.equal(second.status,'failed');assert.equal(second.notDispatched,true);
  assert.equal(second.verificationStatus,null);
 }else assert.equal(run.executionVerification.status,'passed');
});
