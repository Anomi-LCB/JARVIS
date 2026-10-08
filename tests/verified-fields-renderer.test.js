import test from 'node:test';import assert from 'node:assert/strict';
import {renderVerifiedFields} from '../src/ui/workspace/verified-fields.js';
const mission={missionId:'m',status:'COMPLETED'};
const preview={missionId:'m',status:'verified',checkedAt:'2026-10-04T00:00:00Z',fields:[{label:'<script>',value:'0',quote:'<img src=x>',unit:'원'}]};
test('verified source projection escapes content and states source-only evidence',()=>{
 const html=renderVerifiedFields(mission,preview);assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('&lt;img src=x&gt;'));assert.ok(html.includes('별도 확인'));assert.equal(html.includes('<img'),false);
});
test('changed file, wrong mission, incomplete mission and malformed fields do not expose prior values',()=>{
 assert.equal(renderVerifiedFields({...mission,status:'PAUSED'},preview),'');
 assert.equal(renderVerifiedFields(mission,{...preview,missionId:'other'}),'');
 assert.equal(renderVerifiedFields(mission,{...preview,fields:[{value:'0'}]}),'');
 const html=renderVerifiedFields(mission,{...preview,status:'changed-or-unavailable'});assert.ok(html.includes('이전'));assert.equal(html.includes('data-verified-fields'),false);
});
