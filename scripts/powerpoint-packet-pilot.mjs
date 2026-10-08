import {mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {ActionType} from '../packages/shared/src/types.js';
const root=mkdtempSync(resolve('artifacts/powerpoint-packet-live-20261007-'));
const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env:{},workerDaemonEnabled:false});
const taskId='presentation-live-packet',planId='presentation-live-plan',approvalId='presentation-live-approval';
const action={actionType:ActionType.CREATE_FILE,toolName:'powerpoint.create',arguments:{path:join(root,'연구발표.pptx'),slides:[
 {title:'전체 요구사항 보존',bullets:['자료 출처와 확인 시각','본문과 해석을 구분','계정 권한과 예산 한도'],notes:'발표자 메모도 실제 저장 파일에서 확인한다.'},
 {title:'검증 결과와 다음 행동',bullets:['완료한 일과 남은 일을 구분','재시작 후 결과를 다시 확인'],notes:'추론과 사실을 혼동하지 않는다.'}]}};
const capabilityToken=runtime.policyRuntime.capabilities.issue({taskId,planId,approvalId,action,allowedPaths:[root]});
const packet={packetId:'presentation-live-packet',taskId,planId,action,capabilityToken,requestedMode:'execute',userConfirmation:{confirmed:true,approvalId},approvalDecision:{approvalId,decision:'approve'}};
const result=await runtime.pcAgent.receiveExecutionPacket(packet);
// Never serialize capability secrets/tokens into the report.
writeFileSync(join(root,'result.json'),JSON.stringify({observedAt:new Date().toISOString(),input:action,mode:'signed-local-packet-not-natural-language-mission',result},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({root,status:result.status,verification:result.verification?.status,contentVerification:result.executionResult?.contentVerification?.status}));
