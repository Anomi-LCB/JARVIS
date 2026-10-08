import test from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntimeConnectionStatus,renderRuntimeConnectionStatus} from '../src/ui/connections/runtime-status.js';
test('runtime observes health, authority mode and trust without writes or claiming completion',async()=>{
 const paths=[];
 const status=await loadRuntimeConnectionStatus({request:async path=>{paths.push(path);return path==='/health'?{module:'A_CORE',status:'running'}:path==='/security/trust'?{mode:'trusted'}:{status:{executionMode:'recovery-only'}};}});
 assert.deepEqual(paths,['/health','/missions?limit=1','/security/trust']);assert.equal(status.mode,'recovery-only');assert.equal(status.connected,true);assert.equal(status.workCompletionVerified,false);
 const html=renderRuntimeConnectionStatus(status);assert.match(html,/새 작업을 실행하지 않습니다/);assert.match(html,/기존 실행 결과 확인 전용/);assert.doesNotMatch(html,/data-start|data-resume/);
});
test('saved settings and healthy endpoint alone cannot imply executable or verified work',async()=>{
 const status=await loadRuntimeConnectionStatus({request:async path=>{if(path==='/health')return{module:'A_CORE',status:'ok'};throw new Error('unauthorized');}});
 assert.equal(status.connected,true);assert.equal(status.mode,'unknown');assert.equal(status.trust,'unverified');assert.equal(status.workCompletionVerified,false);assert.match(renderRuntimeConnectionStatus(status),/실행 모드 미확인/);
});
test('arbitrary provider labels and mode values never become runtime UI instructions',()=>{
 const html=renderRuntimeConnectionStatus({connected:true,mode:'<script>unsafe</script>',trust:'trusted'});
 assert.match(html,/실행 모드 미확인/);assert.doesNotMatch(html,/<script>|unsafe/);assert.match(renderRuntimeConnectionStatus(null),/접속 확인 필요/);
});
