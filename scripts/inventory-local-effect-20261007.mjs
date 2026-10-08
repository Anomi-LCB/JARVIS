import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=await mkdtemp(join(tmpdir(),'jarvis-effect-inventory-'));
let operations;
try{
 operations=new PersonalOperationsStore({dbPath:join(root,'operations.sqlite')});
 const runtime=createAgRuntime({missionStore:new SqliteMissionStore({operationsStore:operations}),allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,env:{}});
 const coordinator=runtime.missionRuntime.effectCoordinator;
 const tools=runtime.pcAgent.registry.capabilityMatrix().map(contract=>{
  const toolName=contract.toolName;
  const eligible=coordinator.supported({operation:{dispatch:{actionNodeCount:1,profile:{externalTransfer:false}}}},{plan:{action:{toolName,arguments:{path:join(root,'synthetic.txt')}}}});
  return {toolName,readOnly:contract.readOnly??null,mutatesSystem:contract.mutatesSystem??null,localSingleActionEffectEligible:eligible};
 });
 const result={observedAt:new Date().toISOString(),scope:'isolated actual runtime registry; trusted local SQL, single-action synthetic configuration only',coordinatorEnabled:coordinator.enabled,tools,limitations:'Eligibility is not execution evidence. Arguments except synthetic path are not validated here. Remote, plan graphs, installed executable and provider-specific ledgers are not evaluated. No tool was executed.'};
 await writeFile('artifacts/rollback-overwrite-20261007-tool-inventory.json',JSON.stringify(result,null,2),{flag:'wx'});
 console.log(JSON.stringify({enabled:coordinator.enabled,total:tools.length,eligible:tools.filter(t=>t.localSingleActionEffectEligible).map(t=>t.toolName),ineligible:tools.filter(t=>!t.localSingleActionEffectEligible&&t.mutatesSystem!==false).map(t=>t.toolName)}));
}finally{operations?.close();await rm(root,{recursive:true,force:true});}
