import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {MissionBudgetGate} from '../packages/core/src/personal-operations/mission-budget-gate.js';
import {localMandateTreeRef} from '../packages/core/src/personal-operations/local-mandate-observation.js';
import {withMissionMandateFence} from '../packages/core/src/personal-operations/mission-mandate-fence.js';
import {LocalWorkflowToolAdapter} from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';
const output=process.argv[2];assert.ok(output?.startsWith('artifacts/'));
const sizes=process.argv.slice(3).map(Number);assert.ok(sizes.length&&sizes.every(n=>Number.isSafeInteger(n)&&n>0&&n<=1100));
const rows=[];
for(const size of sizes){
 const root=await mkdtemp(join(tmpdir(),'jarvis-inventory-fence-')),folder=join(root,'files');let store;
 try{
  await mkdir(folder);for(let i=0;i<size;i++)await writeFile(join(folder,`file-${String(i).padStart(4,'0')}.txt`),'synthetic bytes');
  store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')});const budget=new PersonalMandateBudget(store),gate=new MissionBudgetGate({store,budget});
  const quota=gate.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:1,scope:{accountRef:null,dataRefs:[localMandateTreeRef(folder,root)],deniedDataRefs:[]}});
  const mission={missionId:'synthetic-inventory',executionMandateId:quota.mandate.id};gate.beforeRun(mission);
  let dataChecks=0,policyChecks=0;
  const data=gate.beforeWorkflowDataAccess.bind(gate),evaluate=store.evaluateMandate.bind(store);
  gate.beforeWorkflowDataAccess=(...args)=>{dataChecks++;return data(...args);};
  store.evaluateMandate=(...args)=>{policyChecks++;return evaluate(...args);};
  const args={spec:{schemaVersion:'jarvis-local-workflow-v1',workflowId:'inventory-size',nodes:[{id:'list',op:'fs.inventory',args:{path:folder,recursive:true}}]}},packet={taskId:'synthetic-inventory',packetId:'synthetic-inventory',action:{toolName:'workflow.execute',arguments:args}};
  const hooks=withMissionMandateFence({mission,gate,executor:{supportsTrustedLocalMissionEffects:()=>true},workspaceRoot:root}),fence=await hooks.beforeExecute(packet);
  const adapter=new LocalWorkflowToolAdapter({allowedRoots:[root]}),start=performance.now();
  const result=await adapter.runOperation('fs.inventory',{path:folder,recursive:true},{assertAccess:fence,assertDataAccess:(path,kind)=>fence.assertWorkflowAccess(path,{kind}),assertInventoryAccess:fence.assertWorkflowInventoryAccess});
  const totalMs=performance.now()-start;assert.equal(result.count,size);fence();
  const row={size,count:result.count,totalMs,dataChecks,policyChecks,modelCalls:0,paidApiCalls:0,totalCost:'unmeasured'};rows.push(row);console.log(JSON.stringify(row));
 }finally{store?.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});}
}
await writeFile(output,JSON.stringify({observedAt:new Date().toISOString(),execution:'actual-PC-adapter-and-SQLite-scope-not-full-Mission',rows},null,2)+'\n',{flag:'wx'});
