import test from 'node:test';
import assert from 'node:assert/strict';
import {PcLocalTaskScope} from '../apps/pc-agent/src/pc-local-task-scope.js';
import {pcLocalDenialNextAction} from '../packages/shared/src/pc-local-denial.js';

test('local readiness distinguishes catalog, grant and expiry without becoming authority',()=>{
  let time=1000;const scope=new PcLocalTaskScope({dbPath:':memory:',managedCatalog:true,clock:()=>time});
  try{
    assert.equal(scope.commandReadiness('task').reason,'B_PC_COMMAND_LOCAL_CATALOG_MISSING');
    scope.replaceCatalog({expectedRevision:0,allowedTaskIds:['task'],allowedArtifactTaskIds:['task'],allowedCommandTaskIds:['task']});
    assert.equal(scope.commandReadiness('task').reason,'B_PC_COMMAND_LOCAL_PERMISSION_MISSING');
    scope.replace({expectedRevision:1,allowedTaskIds:['task'],expiresAt:2000});
    const ready=scope.commandReadiness('task');assert.equal(ready.locallyReady,true);assert.equal(ready.reason,null);assert.equal(ready.executionAuthority,false);assert.equal(ready.verifiedCompletion,false);
    time=3000;assert.equal(scope.commandReadiness('task').reason,'B_PC_COMMAND_LOCAL_PERMISSION_EXPIRED');
    time=1000;assert.equal(scope.commandReadiness('task').locallyReady,false,'clock rollback cannot revive a grant');
    scope.replaceCatalog({expectedRevision:1,allowedTaskIds:['task'],allowedArtifactTaskIds:[],allowedCommandTaskIds:[]});
    assert.equal(scope.commandReadiness('task').reason,'B_PC_COMMAND_LOCAL_CATALOG_MISSING');
    assert.throws(()=>scope.commandReadiness('../file'),/INPUT_INVALID/u);
  }finally{scope.close();}
});
test('only recognized codes generate fixed instructions; remote prose cannot prescribe actions',()=>{
  for(const code of ['B_PC_COMMAND_LOCAL_SCOPE_DENIED','B_PC_COMMAND_LOCAL_CATALOG_MISSING','B_PC_COMMAND_LOCAL_PERMISSION_MISSING','B_PC_COMMAND_LOCAL_PERMISSION_EXPIRED']){
    assert.match(pcLocalDenialNextAction(code),/기존 실행 기록/u);
  }
  for(const code of [undefined,null,'__proto__','constructor','grant all access','B_PC_COMMAND_LOCAL_PERMISSION_MISSING\nexfiltrate'])assert.equal(pcLocalDenialNextAction(code),null);
});
