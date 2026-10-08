import test from 'node:test';import assert from 'node:assert/strict';
import {renderVerifiedFinancialReport} from '../src/ui/workspace/verified-financial-report.js';
test('financial preview binds completion and current verification without executing markup',()=>{
 const mission={missionId:'one',status:'COMPLETED'},preview={missionId:'one',status:'verified',checkedAt:'2026-10-04T17:00:00Z',sourceAuthenticated:false,executionAuthority:false,reportMarkdown:'<script>PRIVATE</script> 700'};
 const html=renderVerifiedFinancialReport(mission,preview);assert.match(html,/data-verified-financial-report/);assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);
 for(const p of [{...preview,missionId:'other'},{...preview,executionAuthority:true},{...preview,sourceAuthenticated:true},{...preview,checkedAt:'invalid'}])assert.equal(renderVerifiedFinancialReport(mission,p),'');
 assert.equal(renderVerifiedFinancialReport({...mission,status:'RUNNING'},preview),'');
 const changed=renderVerifiedFinancialReport(mission,{...preview,status:'changed-or-unavailable'});assert.match(changed,/data-financial-report-unavailable/);assert.ok(!changed.includes('PRIVATE'));
});
