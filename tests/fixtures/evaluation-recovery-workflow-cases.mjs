import {createHash} from 'node:crypto';
export const text='재시작 후 실제 운영 코드 검증\n';
const spec={schemaVersion:'jarvis-local-workflow-v1',workflowId:'recovery-actual',nodes:[{id:'write',op:'write.text',args:{path:'out/result.txt',text}}]};
export const requirements={originalRequest:'한글 파일을 만들고 다시 읽어 검증하며 작업 공간 밖 쓰기는 차단해.',revision:1,requirements:[{id:'R1',text:'실제 한글 파일 내용 일치'},{id:'R2',text:'공간 밖 쓰기 차단'}]};
export const calculationRequirements={originalRequest:'계산값42를 유지해.',revision:1,requirements:[{id:'R1',text:'계산값42'}]};
export const cases=[{id:'actual-file',method:'execute',args:{spec},packet:{taskId:'isolated-recovery'},expected:{status:'success',nodeCount:1,receiptCount:1,files:[{name:'out/result.txt',text,sha256:createHash('sha256').update(text).digest('hex'),size:Buffer.byteLength(text)}]},requirementIds:['R1']},
 {id:'outside',method:'execute',args:{spec:{...spec,workflowId:'outside',nodes:[{id:'write',op:'write.text',args:{path:'../forbidden.txt',text:'blocked'}}]}},packet:{},expected:{status:'blocked',errorCode:'WORKFLOW_PATH_OUTSIDE_ALLOWED_ROOT'},requirementIds:['R2']}];
