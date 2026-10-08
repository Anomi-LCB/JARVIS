import test from 'node:test';
import assert from 'node:assert/strict';
import {pcExecutionConfigurationStatus} from '../packages/core/src/client/pc-execution-configuration-status.js';
import {renderPcExecutionConfiguration} from '../src/ui/connections/pc-nodes.js';
import {escape} from '../src/ui/connections/connection-center.js';
const binding={deviceId:'pc',deviceGeneration:1,certificateFingerprint:'AA:BB',allowedRoots:['private-path']};
test('selected binding match excludes paths and never proves permission or completion',()=>{
 const value=pcExecutionConfigurationStatus({binding,controller:{scope:()=>({generation:1,certificateFingerprint:'AABB'})},executionMode:'recovery-only'});
 assert.equal(value.registrationMatch,true);assert.equal(value.executionAuthorized,false);assert.equal(value.completionVerified,false);assert.doesNotMatch(JSON.stringify(value),/private-path|AA:BB/);
 assert.match(renderPcExecutionConfiguration({executionConfiguration:value},escape),/새 업무 실행은 중지/);
});
test('changed registration or unavailable scope cannot become a configuration match',()=>{
 for(const scope of [{generation:2,certificateFingerprint:'AABB'},{generation:1,certificateFingerprint:'CCDD'}])assert.equal(pcExecutionConfigurationStatus({binding,controller:{scope:()=>scope}}).registrationMatch,false);
 assert.equal(pcExecutionConfigurationStatus({binding,controller:{scope:()=>{throw new Error('authority lost');}}}).registrationMatch,null);
 assert.equal(pcExecutionConfigurationStatus().configured,false);
 assert.match(renderPcExecutionConfiguration({},escape),/미확인/);
 assert.doesNotMatch(renderPcExecutionConfiguration({executionConfiguration:{configured:true,deviceId:'<script>unsafe</script>',deviceGeneration:1}},escape),/<script>/);
});
