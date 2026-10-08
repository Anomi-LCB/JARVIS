import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rename,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {MissionBudgetGate} from '../packages/core/src/personal-operations/mission-budget-gate.js';
import {localMandateTreeRef} from '../packages/core/src/personal-operations/local-mandate-observation.js';
import {withMissionMandateFence} from '../packages/core/src/personal-operations/mission-mandate-fence.js';

for(const mode of ['allowed','revoked','excluded','past-alias-change','current-alias-change'])test(`private inventory fence retains authority and final physical reconciliation: ${mode}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-inventory-boundary-')),folder=join(root,'files'),visited=join(folder,'visited'),other=join(root,'other');
 await mkdir(visited,{recursive:true});await mkdir(other);
 const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),budget=new PersonalMandateBudget(store),gate=new MissionBudgetGate({store,budget});
 t.after(async()=>{store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const childRef=localMandateTreeRef(visited,root);
 const quota=gate.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:1,scope:{accountRef:null,dataRefs:[localMandateTreeRef(folder,root),childRef,localMandateTreeRef(other,root)],deniedDataRefs:mode==='excluded'?[childRef]:[]}});
 const mission={missionId:'synthetic',executionMandateId:quota.mandate.id};gate.beforeRun(mission);
 const packet={action:{toolName:'workflow.execute',arguments:{spec:{schemaVersion:'jarvis-local-workflow-v1',workflowId:'synthetic-inventory',nodes:[{id:'list',op:'fs.inventory',args:{path:folder}}]}}}};
 const fence=await withMissionMandateFence({mission,gate,executor:{supportsTrustedLocalMissionEffects:()=>true},workspaceRoot:root}).beforeExecute(packet);
 if(mode==='excluded'){assert.throws(()=>fence.assertWorkflowInventoryAccess(visited),/DATA_SCOPE_DENIED/);return;}
 fence.assertWorkflowInventoryAccess(visited);
 if(mode==='revoked'){store.revokeMandate(quota.mandate.id);assert.throws(()=>fence.assertWorkflowInventoryAccess(folder),/MANDATE_EXECUTION_DENIED/);return;}
 if(mode.endsWith('alias-change')){
  await rename(visited,join(folder,'saved'));await symlink(other,visited,process.platform==='win32'?'junction':'dir');
  if(mode==='current-alias-change')assert.throws(()=>fence.assertWorkflowInventoryAccess(visited),/FILE_IDENTITY_CHANGED/);
  else fence.assertWorkflowInventoryAccess(folder);
  assert.throws(fence,/FILE_IDENTITY_CHANGED/);return;
 }
 fence();assert.equal(budget.summary(quota.mandate.id).usedOrHeldCalls,1);
});
