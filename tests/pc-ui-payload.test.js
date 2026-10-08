import test from 'node:test';
import assert from 'node:assert/strict';
import {readControlCenterUiPayload} from '../apps/pc-agent/src/install/control-center-ui-payload.js';
test('desktop static payload includes updated workspace and independent connection modules without activation claims',()=>{
 const files=readControlCenterUiPayload();
 for(const name of ['index.html','src/ui/workspace/app.js','src/ui/workspace/client.js','src/ui/workspace/clarification-drafts.js','src/ui/connections/runtime-status.js','src/ui/connections/travel.html','src/ui/connections/travel.js','src/ui/connections/microsoft.html','src/ui/connections/microsoft.js','src/ui/connections/microsoft-mission-client.js','src/ui/connections/pc-nodes.js','packages/shared/src/pc-local-denial.js'])assert.ok(files[`control-center-ui/${name}`]);
 assert.match(files['control-center-ui/src/ui/connections/pc-nodes.js'],/renderPcExecutionConfiguration/);
 assert.match(files['control-center-ui/src/ui/connections/runtime-status.js'],/기존 실행 결과 확인 전용/);
 assert.equal(JSON.parse(files['control-center-ui/hosting.json']).automaticallyHosted,false);
 assert.equal(JSON.parse(files['control-center-ui/hosting.json']).apiServerIncluded,true);
 for(const name of Object.keys(files))assert.doesNotMatch(name,/\.sqlite|\.pem|\.log|profile|credential.*\.json/);
});
