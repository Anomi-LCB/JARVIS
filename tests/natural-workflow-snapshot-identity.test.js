import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {compileNaturalWorkflowObjective} from '../packages/core/src/mission/natural-workflow-compiler.js';
import {compileNaturalWorkflowMission,bindNaturalWorkflowDispatches} from '../packages/core/src/mission/natural-workflow-mission-plan.js';
import {captureMissionGoalContract} from '../packages/core/src/mission/mission-goal-contract.js';
import {assessMissionGoalCompletionCoverage} from '../packages/core/src/mission/mission-requirement-coverage.js';
const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,reorder(value[key])])):value;
const hash=text=>createHash('sha256').update(text).digest('hex');
for(const mode of ['reordered-keys','changed-path','changed-operation','reversed-operations','wrong-task','wrong-receipt'])test(`persisted workflow completion keeps original request identity: ${mode}`,()=>{
 const workspaceRoot=resolve('synthetic-workflow-snapshot'),objective="'input.json' JSON을 '자료'로 읽고; '자료'를 'output.json' JSON으로 저장해";
 const compiled=compileNaturalWorkflowObjective(objective,{workspaceRoot});assert.equal(compiled.status,'compiled');
 const spec=reorder(compiled.spec),dispatch={taskId:'synthetic-task',toolName:'workflow.execute'};
 if(mode==='changed-path')spec.nodes[1].args.path=resolve(workspaceRoot,'other.json');
 if(mode==='changed-operation')spec.nodes[1].op='write.text';
 if(mode==='reversed-operations')spec.nodes.reverse();
 if(mode==='wrong-task')dispatch.taskId='other-task';
 dispatch.workflowSpecSource=JSON.stringify(spec);
 const observation={actionId:'synthetic-action',taskId:'synthetic-task',toolName:'workflow.execute',outcome:'success',verification:{status:'passed'},
  data:{workflow:{workflowId:compiled.spec.workflowId,nodeCount:compiled.spec.nodes.length,specSha256:mode==='wrong-receipt'?'0'.repeat(64):hash(dispatch.workflowSpecSource)}}};
 const mission={objective,successCriteria:[{criterionId:'output'}]};
 const context=bindNaturalWorkflowDispatches({mission,workspaceRoot,observations:[observation],criterionEvidence:[{criterionId:'output',status:'passed',passed:true,evidenceActionIds:[observation.actionId]}]},[{actionId:observation.actionId,status:'succeeded',operation:{dispatch}}]);
 assert.equal(JSON.stringify(context).includes('workflowSpecSource'),false,'local checkpoints must not enter model prompt context');
 const planned=compileNaturalWorkflowMission(context);
 assert.equal(planned.decision,mode==='reordered-keys'?'complete':'blocked');
 if(mode!=='reordered-keys')assert.equal(planned.blockedReason,'natural-workflow-evidence-mismatch');
 const action={actionId:observation.actionId,taskId:observation.taskId,actualToolName:'workflow.execute',expectedToolName:'workflow.execute',
  status:'succeeded',observationId:'synthetic-observation',arguments:{spec},operation:{dispatch:{...dispatch,arguments:{spec}}}};
 Object.assign(observation,{observationId:action.observationId,evidenceId:'synthetic-evidence'});
 observation.verification.verificationId='synthetic-g';
 observation.data.workflow.receipts=spec.nodes.map(node=>({nodeId:node.id,status:'success',op:node.op}));
 const goalContract=captureMissionGoalContract({objective,missionId:'synthetic-mission',createdAt:'2026-10-07T00:00:00Z'});
 const coverage=assessMissionGoalCompletionCoverage({mission:{...mission,goalContract,waves:[{actions:[action]}],observations:[observation],constraints:[]},allowedRoots:[workspaceRoot]});
 assert.equal(coverage.allowed,mode==='reordered-keys',JSON.stringify(coverage));
});
