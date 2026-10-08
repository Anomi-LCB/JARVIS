import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {pcTaskOptions} from '../packages/core/src/client/pc-task-options.js';
import {TaskPlanner} from '../packages/core/src/planning/task-planner.js';
import {ActionType,InputSource,ModuleId} from '../packages/shared/src/types.js';
import {reservedMissionTaskId} from '../packages/core/src/mission/mission-task-reservation.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'jarvis-task-reservation-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,env,taskEnv:env,missionStorePath:join(root,'missions.json')});
 const mission=runtime.missionRuntime.createMission({objective:'보고서 파일을 생성하고 다시 확인해',authorization:{grants:[MissionGrant.READ_ONLY]}});
 const owned=runtime.missionRuntime.missions.get(mission.missionId);
 const wave=runtime.missionRuntime.createWave(owned,{actions:[{id:'write',title:'보고서 파일 작성',command:'result.txt 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:join(root,'result.txt'),content:'verified reservation'},dependencies:[],successSignal:'내용 재조회'}]});
 runtime.missionRuntime.persist('reservation-test-plan');
 return {root,env,runtime,mission,wave,owned};
}
test('planned Mission IDs are visible before any task or effect and survive a new runtime',async t=>{
 const f=await fixture(t),action=f.wave.actions[0];
 assert.match(action.reservedTaskId,/^mission_task_[a-f0-9]{32}$/u);assert.equal(action.taskId,null);assert.equal(f.runtime.coreFacade.tasks.size,0);
 const options=pcTaskOptions(f.runtime.coreFacade.tasks,new URLSearchParams(),f.runtime.missionRuntime.missions);
 assert.equal(options.items[0].taskId,action.reservedTaskId);assert.equal(options.items[0].status,'RESERVED');assert.equal(options.executionAuthority,false);
 await assert.rejects(access(join(f.root,'result.txt')));
 const reopened=createAgRuntime({allowedRoots:[f.root],auditRoot:join(f.root,'second-audit'),workerDaemonEnabled:false,env:f.env,taskEnv:f.env,missionStorePath:join(f.root,'missions.json')});
 assert.equal(reopened.missionRuntime.getMission(f.mission.missionId).waves[0].actions[0].reservedTaskId,action.reservedTaskId);
 assert.equal(pcTaskOptions(reopened.coreFacade.tasks,new URLSearchParams(),reopened.missionRuntime.missions).items[0].taskId,action.reservedTaskId);
});
test('reservation is used by actual gated task creation and never silently changes on collision',async t=>{
 const f=await fixture(t),action=f.wave.actions[0];
 await f.runtime.missionRuntime.executeWave(f.owned,f.wave);
 assert.equal(action.taskId,action.reservedTaskId);assert.equal(f.runtime.coreFacade.getTask(action.taskId).taskId,action.reservedTaskId);
 await assert.rejects(access(join(f.root,'result.txt')),'read-only Mission cannot write');
 assert.throws(()=>f.runtime.coreFacade.createMissionActionTask(action.command,{reservedTaskId:action.reservedTaskId,metadata:{missionId:f.mission.missionId,missionActionId:action.actionId},source:InputSource.TRIGGER,sourceModule:ModuleId.CORE,deviceId:'mission_executive'}),/RESERVATION_CONFLICT/u);
});

test('reserved task identity reaches actual E B G execution after explicit scoped owner authorization',async t=>{
 const f=await fixture(t),action=f.wave.actions[0];
 const owner=f.runtime.personalOwnerSession.activate({requestedBy:'isolated-reservation-test',durationMinutes:5});
 f.runtime.missionRuntime.updateMission(f.mission.missionId,{authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]}});
 await f.runtime.missionRuntime.executeWave(f.owned,f.wave);
 assert.equal(action.status,'succeeded',JSON.stringify({action,observations:f.owned.observations}));assert.equal(action.taskId,action.reservedTaskId);
 assert.equal(await readFile(join(f.root,'result.txt'),'utf8'),'verified reservation');
 assert.equal(f.runtime.coreFacade.getTask(action.taskId).status,'COMPLETED');
 const item=pcTaskOptions(f.runtime.coreFacade.tasks,new URLSearchParams(),f.runtime.missionRuntime.missions).items[0];
 assert.equal(item.taskId,action.reservedTaskId);assert.equal(item.recordSource,'current-core-mission');assert.notEqual(item.status,'RESERVED');
});
test('tampered reservations and public task options cannot select a reserved identity',async t=>{
 const f=await fixture(t),action=f.wave.actions[0],original=action.reservedTaskId;
 const publicTask=f.runtime.coreFacade.createTask('작업 폴더 파일 목록 보여줘',{reservedTaskId:original});
 assert.notEqual(publicTask.taskId,original);
 action.reservedTaskId=reservedMissionTaskId(f.mission.missionId,'different-action');
 assert.throws(()=>pcTaskOptions(f.runtime.coreFacade.tasks,new URLSearchParams(),f.runtime.missionRuntime.missions),/TASK_OPTIONS_INVALID/u);
 await assert.rejects(f.runtime.missionRuntime.executeWave(f.owned,f.wave),/RESERVATION_INVALID/u);
 await assert.rejects(access(join(f.root,'result.txt')));
});

test('explicit search directories retain their exact identity without collapsing sibling or child paths to the root',()=>{
 const planner=new TaskPlanner({workspaceRoot:join(tmpdir(),'project.[a]+ b')});
 const intent={actionType:ActionType.SEARCH_FILES,slots:{fileName:'package.json'}};
 const args=rawText=>planner.argumentsFor(intent,{command:{rawText}},{});
 assert.equal(args(`"${planner.workspaceRoot}" 폴더에서 package.json 파일을 찾아줘`).scope,'workspace');
 assert.equal(args(`${planner.workspaceRoot} 폴더에서 package.json 파일을 찾아줘`).scope,'workspace');
 assert.equal(args(`"${planner.workspaceRoot}-sibling" 폴더에서 package.json 파일을 찾아줘`).directory,`${planner.workspaceRoot}-sibling`);
 assert.equal(args(`"${join(planner.workspaceRoot,'child')}" 폴더에서 package.json 파일을 찾아줘`).directory,join(planner.workspaceRoot,'child'));
});
