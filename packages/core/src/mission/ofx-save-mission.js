import {createOfxSaveWorkflow} from './ofx-save-workflow.js';
import {compileNaturalWorkflowMission} from './natural-workflow-mission-plan.js';
import {verifyOfxSaveResult} from './ofx-save-result.js';
import {compileNaturalWorkflowObjective} from './natural-workflow-compiler.js';
export function compileOfxSaveMission(mission,prepared,workspaceRoot){
 if(!prepared||mission.objective!==prepared.objective)return null;
 const compiled=compileNaturalWorkflowObjective(prepared.objective,{workspaceRoot});
 if(compiled.status!=='compiled'||compiled.clauses.length!==1)throw Error('Financial request contract missing');
 const {spec}=createOfxSaveWorkflow(prepared.input,{operationId:prepared.operationId});
 const nodeIds=spec.nodes.map(n=>n.id);
 return {...compiled,spec,compilerVersion:'prepared-ofx-save-v1',clauses:compiled.clauses.map(c=>({...c,nodeIds})),goalContract:{...compiled.goalContract,requirements:compiled.goalContract.requirements.map(r=>({...r,nodeIds}))}};
}
export function planOfxSaveMission(context,prepared){
 if(!prepared)return null;
 if(context.mission.objective!==prepared.objective)return {decision:'blocked',blockedReason:'financial-request-changed',summary:'금융 저장 요청이 변경되어 새 요청이 필요합니다.',actions:[],criteriaAssessment:[],question:null};
 return compileNaturalWorkflowMission(context,compileOfxSaveMission(context.mission,prepared,context.workspaceRoot));
}
export function verifyOfxSaveMission({mission,prepared,allowedRoots,observations,statement,includeReport=false,beforeAccess}){
 if(!prepared)return {applicable:false};
 if(mission.objective!==prepared.objective||statement!==`${prepared.objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`)
  return {applicable:true,passed:false,status:'unverified',reasons:['financial-request-changed'],checks:[]};
 const observation=observations.filter(o=>o.toolName==='workflow.execute'&&o.outcome==='success'&&o.verification?.status==='passed').at(-1);
 const proof=verifyOfxSaveResult({...prepared,workspaceRoot:allowedRoots[0],workflow:observation?.data?.workflow,includeReport,beforeAccess});
 return {...proof,applicable:true,reasons:proof.passed?[]:[proof.reason],checks:proof.passed?[{checkId:'current-prepared-ofx-save',...proof}]:[]};
}
