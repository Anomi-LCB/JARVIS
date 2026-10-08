import test from 'node:test';
import assert from 'node:assert/strict';
import {travelPrerequisites,renderTravelPrerequisites} from '../src/ui/connections/travel-prerequisites.js';
import {renderTravelConnection} from '../src/ui/connections/travel.js';
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
test('official prerequisites preserve scope, missing connection, next action and date for every provider',()=>{
 assert.equal(travelPrerequisites.length,5);assert.equal(new Set(travelPrerequisites.map(x=>x.id)).size,5);
 for(const p of travelPrerequisites){assert.equal(p.checkedAt,'2026-10-04');for(const k of ['scope','conditions','state','next','limit'])assert.ok(p[k].length>0);assert.equal(new URL(p.url).protocol,'https:');assert.ok(Object.isFrozen(p));}
 assert.match(travelPrerequisites[0].limit,/予約|예약/);assert.match(travelPrerequisites[1].limit,/단정은 아닙니다/);
});
test('travel panel shows all prerequisite links without turning research into runtime readiness',()=>{
 const html=renderTravelConnection({credentialsConfigured:false},null,{escape});
 assert.equal((html.match(/data-travel-prerequisite=/g)||[]).length,5);assert.match(html,/공식 안내 열기/);assert.match(html,/예약·결제·취소 미연결/);assert.match(html,/data-travel-quote/);
 assert.doesNotMatch(renderTravelPrerequisites(escape),/name="(?:apiKey|password|otp|pin|cvv)"/i);
});
