export function validPcReadiness(value,taskId){
  if(!value||Object.keys(value).sort().join(',')!=='catalogRevision,executionAuthority,expiresAt,granted,locallyReady,permissionRevision,reason,registered,taskId,verifiedCompletion'
    ||value.taskId!==taskId||value.executionAuthority!==false||value.verifiedCompletion!==false
    ||![value.catalogRevision,value.permissionRevision,value.expiresAt].every(n=>Number.isSafeInteger(n)&&n>=0)
    ||![value.registered,value.granted,value.locallyReady].every(n=>typeof n==='boolean')||value.granted&&(!value.registered||value.expiresAt===0))return false;
  if(value.locallyReady)return value.registered&&value.granted&&value.expiresAt>0&&value.reason===null;
  return !value.registered?value.reason==='B_PC_COMMAND_LOCAL_CATALOG_MISSING'
    :!value.granted?value.reason==='B_PC_COMMAND_LOCAL_PERMISSION_MISSING':value.reason==='B_PC_COMMAND_LOCAL_PERMISSION_EXPIRED';
}
