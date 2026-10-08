import {mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {assessMissionRequirementCoverage} from '../packages/core/src/mission/mission-requirement-coverage.js';
const root=mkdtempSync(resolve('artifacts/recipient-source-guard-20261007-'));
const cases=[
 {id:'explicit-address-mismatch',clause:"'draft.txt'를 intended@example.test 이메일로 보내",args:{to:'other@example.test',recipientMode:'explicit'},expected:false},
 {id:'self-address-override',clause:"'draft.txt'를 내 구글 이메일로 보내",args:{to:'other@example.test',recipientMode:'self'},expected:false},
 {id:'explicit-address-match',clause:"'draft.txt'를 intended@example.test 이메일로 보내",args:{to:'intended@example.test',recipientMode:'explicit'},expected:true},
 {id:'self-config-resolution',clause:"'draft.txt'를 내 구글 이메일로 보내",args:{to:'',recipientMode:'self'},expected:true}
];
const observations=cases.map(item=>{
 const objective=`'draft.txt'를 읽어; ${item.clause}`,contract=createGoalContract({objective});
 const read={actionId:'read',taskId:'read-task',actualToolName:'filesystem.readText',expectedToolName:'filesystem.readText',
  requirementIds:[contract.requirements[0].requirementId],constraintRequirementIds:[],dependencies:[],status:'succeeded',observationId:'read-observation',
  arguments:{path:join(root,'draft.txt')},operation:{dispatch:{taskId:'read-task',toolName:'filesystem.readText',arguments:{path:join(root,'draft.txt')}}}};
 const send={actionId:'send',taskId:'send-task',expectedToolName:'email.send',actualToolName:'email.send',requirementIds:[contract.requirements[1].requirementId],
  constraintRequirementIds:[],dependencies:['read'],status:'planned',arguments:{...item.args,attachments:[{attachmentRef:{rootIndex:0,relativePath:'draft.txt'},attachmentSha256:'a'.repeat(64)}]}};
 const mission={objective,goalContract:contract,waves:[{actions:[read,send]}],constraints:[],observations:[{observationId:'read-observation',actionId:'read',taskId:'read-task',toolName:'filesystem.readText',outcome:'success',
  verification:{status:'passed',verificationId:'isolated-g-fixture'},evidenceId:'isolated-evidence',data:{fileEvidence:{rootIndex:0,relativePath:'draft.txt',contentSha256:'a'.repeat(64),outsideAllowedRoots:false}},artifacts:[]}]};
 const proof=assessMissionRequirementCoverage({mission,wave:mission.waves[0],action:send,allowedRoots:[root],profile:{toolName:'email.send',externalTransfer:true,externalNetwork:true,readOnly:false,executionClass:'external_commit'}});
 return {id:item.id,objective,args:item.args,expected:item.expected,allowed:proof.allowed,reasons:proof.reasons,sourceInterpretation:contract.requirements[1].interpretation};
});
writeFileSync(join(root,'result.json'),JSON.stringify({observedAt:new Date().toISOString(),scope:'isolated source-coverage fixture; no provider/network/account/actual email action',observations},null,2),{flag:'wx'});
console.log(JSON.stringify({root,observations:observations.map(({id,allowed,expected})=>({id,allowed,expected}))}));
