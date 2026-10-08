const token=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u001f\u007f]/u.test(value);
const recoveryKeys=['version','phase','cleanupConfirmed','activationGapUnverified','autoRetryAllowed','executionAuthority'];
export const APPROVED_FAILURE_CODES=Object.freeze(['EIO','ENOENT','ETIMEDOUT','EXCEL_PDF_EXPORT_FAILED','WORKFLOW_TYPE_MISMATCH','WORKFLOW_NUMBER_INVALID','WORKFLOW_MONEY_INVALID','WORKFLOW_MONEY_PRECISION_LOSS','WORKFLOW_PATH_OUTSIDE_ALLOWED_ROOT','WORKFLOW_SPEC_CHANGED_AFTER_PLANNING','WORKFLOW_REF_MISSING','WORKFLOW_OPERATION_BLOCKED','A_LOCAL_MODEL_RESPONSE_INCOMPLETE','B_TOOL_EXECUTION_EXCEPTION']);
const safeFailureCode=value=>typeof value==='string'&&APPROVED_FAILURE_CODES.includes(value)?value:null;
const codeVersion=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;
export function safeNativeRecovery(value){
 if(value?.version!==1||!['activation-unconfirmed','owned-guarded','rendered'].includes(value.phase)
  ||typeof value.cleanupConfirmed!=='boolean'||typeof value.activationGapUnverified!=='boolean'
  ||value.autoRetryAllowed!==false||value.executionAuthority!==false)return null;
 return Object.fromEntries(recoveryKeys.map(key=>[key,value[key]]));
}
export function observeFailedTask(task,observedAt){
 if(task?.status!=='FAILED'||!token(task.taskId))return null;
 const toolName=task.plan?.action?.toolName;
 const result=task.executionResult?.executionResult;
 return {version:2,taskId:task.taskId,status:'FAILED',observedAt,toolName:typeof toolName==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/u.test(toolName)?toolName:null,
  failureCode:safeFailureCode(result?.error?.code),executionCodeVersion:codeVersion(result?.executionCodeVersion),
  nativeRecovery:['excel.exportPdf','excel.createWorkbook'].includes(toolName)?safeNativeRecovery(result?.nativeRecovery??result?.evidence?.workbook?.renderValidation?.nativeRecovery):null};
}
export function validateFailureObservations(items){
 if(items===undefined)return [];
 if(!Array.isArray(items)||items.length>500)throw Error('Invalid task failure observation collection');
 const ids=new Set();
 for(const item of items){
  if(!item||typeof item!=='object'||Array.isArray(item)||![1,2].includes(item.version)||item.status!=='FAILED'||!token(item.taskId)||ids.has(item.taskId)
   ||typeof item.observedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(item.observedAt)||!Number.isFinite(Date.parse(item.observedAt))
   ||(item.toolName!==null&&(typeof item.toolName!=='string'||!/^[a-zA-Z0-9_.-]{1,80}$/u.test(item.toolName)))
   ||Object.keys(item).some(key=>!['version','taskId','status','observedAt','toolName','nativeRecovery',...(item.version===2?['failureCode','executionCodeVersion']:[])].includes(key))
   ||(item.version===2&&((item.failureCode!==null&&safeFailureCode(item.failureCode)!==item.failureCode)||(item.executionCodeVersion!==null&&codeVersion(item.executionCodeVersion)!==item.executionCodeVersion)))
   ||(item.nativeRecovery!==null&&(!['excel.exportPdf','excel.createWorkbook'].includes(item.toolName)||!safeNativeRecovery(item.nativeRecovery)||Object.keys(item.nativeRecovery).some(key=>!recoveryKeys.includes(key)))))throw Error('Invalid task failure observation');
  ids.add(item.taskId);
 }
 return items;
}
export function archivedFailureTask(item){
 return {taskId:item.taskId,status:'FAILED',archivedObservation:true,observedAt:item.observedAt,
  plan:{title:'PC 작업 실패 기록',action:{toolName:item.toolName}},executionVerification:null,learningResult:null,
  executionResult:{status:'failed',executionResult:{status:'failed',retryable:false,...(item.version===2?{executionCodeVersion:item.executionCodeVersion,error:item.failureCode?{code:item.failureCode}:null}:{}),...(item.nativeRecovery?{nativeRecovery:{...item.nativeRecovery}}:{})}}};
}
