import {mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {classifyMissionEffectScope} from '../packages/core/src/mission/mission-effect-scope.js';
const root=mkdtempSync(resolve('artifacts/external-source-inventory-20261007-'));
const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false});
try{
 const rows=[...runtime.pcAgent.registry.adapters.keys()].map(toolName=>{
  const task={plan:{action:{toolName,arguments:{},capability:{}}}},profile=runtime.missionRuntime.capabilityProfile(task);
  const scope=classifyMissionEffectScope({action:{actualToolName:toolName},profile,arguments:{},allowedRoots:[root]});
  return {toolName,scope:scope.scope,reason:scope.reason,readOnly:profile.readOnly,contractReadOnly:profile.contractReadOnly,
    externalTransfer:profile.externalTransfer,externalNetwork:profile.externalNetwork,executionClass:profile.executionClass};
 });
 writeFileSync(join(root,'result.json'),JSON.stringify({observedAt:new Date().toISOString(),scope:'current actual registry/profile inspection; zero adapter execution or provider calls; empty arguments are conservative admission classification, not usability proof',rows},null,2),{flag:'wx'});
 console.log(JSON.stringify({root,total:rows.length,external:rows.filter(r=>r.scope==='external').map(r=>r.toolName),opaque:rows.filter(r=>r.scope==='opaque').map(r=>r.toolName)}));
}finally{runtime.coreFacade.cognition.close();}
