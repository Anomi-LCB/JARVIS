import { PcLocalTaskScope } from './pc-local-task-scope.js';

export function createPcLocalScopeSettings({scope=null,allowedTaskIds=[]}={}) {
  if((scope!==null&&!(scope instanceof PcLocalTaskScope))||!Array.isArray(allowedTaskIds)
    ||allowedTaskIds.length>1000||new Set(allowedTaskIds).size!==allowedTaskIds.length
    ||allowedTaskIds.some(id=>typeof id!=='string'||!/^[\p{L}\p{N}._-]{1,128}$/u.test(id)))throw new Error('B_PC_LOCAL_SCOPE_CONFIG_INVALID');
  if(scope?.catalogEnabled&&allowedTaskIds.length)throw new Error('B_PC_LOCAL_SCOPE_CONFIG_INVALID');
  const ceiling=()=>new Set(scope?.catalogEnabled?scope.catalog().allowedCommandTaskIds:allowedTaskIds);
  if(scope?.snapshot().allowedTaskIds.some(id=>!ceiling().has(id)))throw new Error('B_PC_LOCAL_SCOPE_CONFIG_INVALID');
  const response=value=>({configured:true,...value,selectableTaskIds:[...ceiling()].sort(),executionAuthority:false,verifiedCompletion:false});
  const assertConfigured=()=>{if(!scope)throw Object.assign(new Error('B_PC_LOCAL_SCOPE_NOT_CONFIGURED'),{code:'B_PC_LOCAL_SCOPE_NOT_CONFIGURED'});};
  return {
    read(){assertConfigured();return response(scope.snapshot());},
    readCatalog(){assertConfigured();return {configured:true,...scope.catalog(),executionAuthority:false,verifiedCompletion:false};},
    replaceCatalog(input){assertConfigured();return {configured:true,...scope.replaceCatalog(input),executionAuthority:false,verifiedCompletion:false};},
    replace(input){
      assertConfigured();
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==3
        ||!['expectedRevision','allowedTaskIds','expiresAt'].every(key=>Object.hasOwn(input,key)))throw Object.assign(new Error('B_PC_LOCAL_SCOPE_INPUT_INVALID'),{code:'B_PC_LOCAL_SCOPE_INPUT_INVALID'});
      if(!Array.isArray(input.allowedTaskIds)||input.allowedTaskIds.some(id=>!ceiling().has(id)))throw Object.assign(new Error('B_PC_LOCAL_SCOPE_TARGET_NOT_CONFIGURED'),{code:'B_PC_LOCAL_SCOPE_TARGET_NOT_CONFIGURED'});
      return response(scope.replace(input));
    }
  };
}
