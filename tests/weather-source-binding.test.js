import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {assessMissionRequirementCoverage,assessMissionGoalCompletionCoverage} from '../packages/core/src/mission/mission-requirement-coverage.js';
function fixture(objective='지역: 서울 향후 7일 날씨 통계를 한글 보고서로 만들어줘'){
 const roots=[resolve('workspace')],goalContract=createGoalContract({objective,timeZone:'Asia/Seoul'});
 const action={actionId:'weather',taskId:'task',expectedToolName:'weather.createHwpReport',actualToolName:'weather.createHwpReport',status:'planned',requirementIds:goalContract.requirements.map(r=>r.requirementId),constraintRequirementIds:[],dependencies:[],arguments:{location:'서울',path:resolve('workspace/report.hwpx')}};
 const wave={actions:[action]},mission={objective,goalContract,waves:[wave],observations:[],constraints:[],workspaceRoot:roots[0]};
 const assess=()=>assessMissionRequirementCoverage({mission,wave,action,dispatchToolName:action.expectedToolName,dispatchArguments:action.arguments,allowedRoots:roots,phase:'planning',profile:{toolName:action.expectedToolName,mutatesSystem:true,externalTransfer:false,externalNetwork:true,readOnly:false,executionClass:'local_reversible'}});
 return {mission,wave,action,roots,assess};
}
test('explicit weather source binds only the whole supported request',()=>{const f=fixture();assert.equal(f.assess().allowed,true);assert.equal(assessMissionGoalCompletionCoverage({mission:f.mission,allowedRoots:f.roots}).allowed,false,'a planned contract is not a verified result');});
for(const mode of ['wrong-region','outside-root','additional-command','multiple-actions'])test(`weather source refuses ${mode}`,()=>{
 const f=fixture(mode==='additional-command'?'지역: 서울 향후 7일 날씨 통계를 한글 보고서로 만들어줘; 내 메일로 보내':'지역: 서울 향후 7일 날씨 통계를 한글 보고서로 만들어줘');
 if(mode==='wrong-region')f.action.arguments.location='부산';
 if(mode==='outside-root')f.action.arguments.path=resolve('outside/report.hwpx');
 if(mode==='multiple-actions')f.wave.actions.push({...f.action,actionId:'another'});
 assert.equal(f.assess().allowed,false);
});
