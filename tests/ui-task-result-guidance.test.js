import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {taskEmptyResultMessage,renderNativeRecovery} from '../src/ui/task-result-guidance.js';
import {readControlCenterUiPayload} from '../apps/pc-agent/src/install/control-center-ui-payload.js';
const recovery={version:1,phase:'activation-unconfirmed',cleanupConfirmed:false,activationGapUnverified:true,autoRetryAllowed:false,executionAuthority:false};
test('empty failures, cancellation and unknown states never imply completion',()=>{
 for(const status of ['failed','blocked','cancelled','unknown','running','quarantined'])assert.doesNotMatch(taskEmptyResultMessage({status}),/완료된 작업/);
 assert.match(taskEmptyResultMessage({status:'success'}),/완료된 작업/);
 assert.doesNotMatch(taskEmptyResultMessage({status:'success'},{status:'FAILED',executionVerification:{status:'failed'}}),/완료된 작업/);
 assert.doesNotMatch(taskEmptyResultMessage({status:'success'},{status:'EXECUTING'}),/완료된 작업/);
 assert.match(taskEmptyResultMessage({status:'success'},{status:'COMPLETED',executionVerification:{status:'passed'}}),/완료된 작업/);
});
test('native recovery display treats unknown activation and unconfirmed cleanup honestly',()=>{
 const html=renderNativeRecovery({status:'failed',nativeRecovery:{...recovery,cleanupConfirmed:true,secret:'<script>leak</script>',path:'private-file'}});
 assert.match(html,/초기 상태 확인 필요/);assert.match(html,/정리 여부 미확인/);assert.match(html,/자동 재시도 중지/);assert.doesNotMatch(html,/정리 확인됨|private-file|script|leak/);
 const owned=renderNativeRecovery({status:'failed',evidence:{workbook:{renderValidation:{nativeRecovery:{...recovery,phase:'owned-guarded',activationGapUnverified:false,cleanupConfirmed:true}}}}});
 assert.match(owned,/정리 확인됨/);assert.doesNotMatch(owned,/초기 상태 확인 필요/);
 const rendered=renderNativeRecovery({status:'blocked',nativeRecovery:{...recovery,phase:'rendered',activationGapUnverified:false}});assert.match(rendered,/렌더링 이후 작업 중단/);assert.match(rendered,/정리 여부 미확인/);
});
test('invalid diagnostics and stale diagnostics on successful result are not presented as recovery',()=>{
 for(const nativeRecovery of [null,{}, {...recovery,phase:'forged'},{...recovery,executionAuthority:true},{...recovery,autoRetryAllowed:true}])assert.equal(renderNativeRecovery({status:'failed',nativeRecovery}),'');
 assert.equal(renderNativeRecovery({status:'success',nativeRecovery:recovery}),'');
});
test('product result renderer and installed payload both include guidance',async()=>{
 const app=await readFile('src/ui/app.js','utf8');assert.match(app,/\$\{renderNativeRecovery\(result\)\}/);assert.match(app,/taskEmptyResultMessage\(result,task\)/);
 const payload=readControlCenterUiPayload();assert.ok(payload['control-center-ui/src/ui/task-result-guidance.js']);
});
