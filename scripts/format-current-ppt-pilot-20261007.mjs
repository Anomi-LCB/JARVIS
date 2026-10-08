import {mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {ActionType} from '../packages/shared/src/types.js';
import {verifyArtifactLayoutCurrent} from '../apps/verification/src/artifact-layout-verifier.js';
import {ExecutionResultVerifier} from '../apps/verification/src/verification-runtime.js';
const root=await mkdtemp(resolve('artifacts/format-current-ppt-20261007-'));
const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false});
try{
 const taskId='format-current-ppt',planId='format-current-plan',approvalId='format-current-approval';
 const action={actionType:ActionType.CREATE_FILE,toolName:'powerpoint.create',arguments:{path:join(root,'current.pptx'),slides:[{title:'형식별 현재 검증',bullets:['저장 구조 확인','실제 렌더링 확인'],notes:'완료 증거를 현재 파일에서 대조한다.'},{title:'오판 방지',bullets:['변조된 파일 거절','미검증 구간 구분'],notes:'일반적 디자인 품질을 보장하지 않는다.'}]}};
 const capabilityToken=runtime.policyRuntime.capabilities.issue({taskId,planId,approvalId,action,allowedPaths:[root]});
 const result=await runtime.pcAgent.receiveExecutionPacket({packetId:'format-current-ppt',taskId,planId,action,capabilityToken,requestedMode:'execute',userConfirmation:{confirmed:true,approvalId},approvalDecision:{approvalId,decision:'approve'}});
 const proof=await verifyArtifactLayoutCurrent({executionResult:{...result.executionResult,toolName:'powerpoint.create'},allowedRoots:[root]});
 const checks=await new ExecutionResultVerifier().verify({executionResult:result.executionResult,evidence:result.evidence,capabilityToken});
 const current=checks.find(c=>c.checkName==='artifact_current_content_layout_verified');
 await writeFile(join(root,'result.json'),JSON.stringify({observedAt:new Date().toISOString(),root,input:action,result,proof,checks,externalModelCalls:0,cost:'미측정'},null,2),{flag:'wx'});
 console.log(JSON.stringify({root,status:result.status,currentG:current?.status,proofPassed:proof?.passed}));
 if(result.status!=='COMPLETED'||current?.status!=='passed'||proof?.passed!==true)process.exitCode=1;
}finally{runtime.coreFacade.cognition.close();}
