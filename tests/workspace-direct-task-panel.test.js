import test from 'node:test';
import assert from 'node:assert/strict';
import {renderDirectTasks} from '../src/ui/workspace/direct-task-panel.js';
import {readControlCenterUiPayload} from '../apps/pc-agent/src/install/control-center-ui-payload.js';
const nativeRecovery={version:1,phase:'owned-guarded',cleanupConfirmed:true,activationGapUnverified:false,autoRetryAllowed:false,executionAuthority:false};
test('tool success and partial task states cannot assert independent completion',()=>{
 for(const status of ['FAILED','EXECUTING','COMPLETED']){
  const html=renderDirectTasks({active:{taskId:'t',status,executionResult:{executionResult:{status:'success'}},executionVerification:null}});
  assert.match(html,/전체 작업 완료가 검증되지/);assert.doesNotMatch(html,/독립 검증 통과/);
 }
 assert.match(renderDirectTasks({active:{taskId:'t',status:'COMPLETED',executionVerification:{status:'passed'}}}),/독립 검증 통과/);
});
test('failed Core envelope displays sanitized recovery and escapes titles and IDs',()=>{
 const html=renderDirectTasks({items:[{taskId:'t" onclick="bad',title:'<script>bad</script>',status:'FAILED'}],active:{taskId:'t',status:'FAILED',executionResult:{executionResult:{status:'blocked',nativeRecovery:{...nativeRecovery,secret:'do-not-show'}}}}});
 assert.match(html,/정리 확인됨/);assert.match(html,/자동 재시도 중지/);assert.doesNotMatch(html,/<script>|do-not-show|data-direct-task="t" onclick/);
 assert.match(renderDirectTasks({active:{taskId:'t',status:'FAILED',executionResult:{executionResult:{status:'blocked',nativeRecovery}}},language:'en'}),/Automatic retry stopped/);
});
test('failed list and detail reads are explicit and offer no automatic effect controls',()=>{
 const html=renderDirectTasks({listFailed:true,detailFailed:true,active:{taskId:'old',status:'FAILED'}});
 assert.match(html,/마지막 조회 결과/);assert.match(html,/이전에 조회한 결과/);assert.doesNotMatch(html,/data-resume|data-cancel|data-reconcile/);
 assert.doesNotMatch(html,/조회된 PC 작업이 없습니다/);
});
test('installed UI contains the primary workspace renderer',()=>{
 const payload=readControlCenterUiPayload();
 assert.ok(payload['control-center-ui/src/ui/workspace/direct-task-panel.js']);
});
test('pending and failed reads never replace observation times or present old verification as current',()=>{
 const pending=renderDirectTasks({loading:true});assert.match(pending,/조회하고 있습니다/);assert.doesNotMatch(pending,/작업이 없습니다/);
 const html=renderDirectTasks({listFailed:true,detailFailed:true,listObservedAt:'old-list-time',detailObservedAt:'old-detail-time',active:{taskId:'t',status:'COMPLETED',executionVerification:{status:'passed'}}});
 assert.match(html,/old-list-time/);assert.match(html,/old-detail-time/);assert.match(html,/이전 조회 당시/);assert.match(html,/현재 상태는 확인되지/);assert.doesNotMatch(html,/<p>독립 검증 통과<\/p>/);
});
test('a failed current artifact read hides an earlier preview and read control',()=>{
 const html=renderDirectTasks({detailFailed:true,active:{taskId:'t',status:'COMPLETED',artifactObservations:[{index:0,name:'report.txt',state:'unchanged'}]},preview:{taskId:'t',index:0,text:'earlier-private-preview'}});
 assert.doesNotMatch(html,/earlier-private-preview|data-artifact-task/);assert.match(html,/이전에 조회한 결과/);
});
