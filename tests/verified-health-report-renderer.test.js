import test from 'node:test';import assert from 'node:assert/strict';
import {renderVerifiedHealthReport} from '../src/ui/workspace/verified-health-report.js';
const mission={missionId:'one',status:'COMPLETED'},preview={missionId:'one',status:'verified',checkedAt:'2026-10-05T00:00:00Z',clinicalInterpretationVerified:false,deviceConnectionVerified:false,reportMarkdown:'# report\n## heart_rate (bpm)\n<script>source</script>\n| UTC 날짜 | 수 | 평균 | 최소 | 최대 | 간격 | 차이 |\n| --- | --- | --- | --- | --- | --- | --- |\n| 2026-02-20 | 1 | 70 | 70 | 70 | 없음 | 없음 |\n'};
test('verified health report renders accessible table and escapes source HTML',()=>{
 const html=renderVerifiedHealthReport(mission,preview);assert.match(html,/심박수/);assert.match(html,/scope="col"/);assert.match(html,/<td>70<\/td>/);assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);assert.match(html,/임상적 해석은 검증하지/);
});
test('changed, wrong-mission and malformed reports never display previous content',()=>{
 assert.equal(renderVerifiedHealthReport({...mission,status:'PAUSED'},preview),'');
 assert.equal(renderVerifiedHealthReport(mission,{...preview,missionId:'other'}),'');
 assert.equal(renderVerifiedHealthReport(mission,{...preview,clinicalInterpretationVerified:true}),'');
 const changed=renderVerifiedHealthReport(mission,{...preview,status:'changed-or-unavailable'});assert.match(changed,/data-health-report-unavailable/);assert.ok(!changed.includes('70'));
});
