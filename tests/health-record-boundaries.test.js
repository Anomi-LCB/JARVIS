import test from 'node:test';import assert from 'node:assert/strict';
import {summarizeHealthRecords} from '../apps/wearable-hud/src/health-record-summary.js';
const options={startDate:'2026-02-01',endDate:'2026-02-28',now:'2026-03-01T00:00:00Z'};
const record={metric:'sleep_duration',value:1,unit:'h',observedAt:'2026-02-20T12:00:00Z',source:'synthetic-sensor'};
for(const [name,change]of [['impossible calendar',{observedAt:'2026-02-30T12:00:00Z'}],['missing timezone',{observedAt:'2026-02-20T12:00:00'}],['future measurement',{observedAt:'2026-03-02T12:00:00Z'}],['conversion overflow',{value:Number.MAX_VALUE}]])test('health records reject '+name,()=>{
 assert.throws(()=>summarizeHealthRecords({...options,records:[{...record,...change}]}),/health-record-invalid/);
});
test('invalid range calendar is not normalized silently',()=>{
 assert.throws(()=>summarizeHealthRecords({...options,endDate:'2026-02-30',records:[]}),/range-or-clock-invalid/);
});
test('explicit timezone is preserved with normalized UTC and measurement metadata',()=>{
 const summary=summarizeHealthRecords({...options,records:[{...record,observedAt:'2026-02-20T12:00:00+09:00',sensorId:'test-sensor',calibrationStatus:'uncalibrated'}]});
 const sample=summary.metrics.sleep_duration.samples[0];
 assert.equal(sample.observedAt,'2026-02-20T03:00:00.000Z');
 assert.equal(sample.originalObservedAt,'2026-02-20T12:00:00+09:00');
 assert.equal(sample.sensorId,'test-sensor');assert.equal(sample.calibrationStatus,'uncalibrated');
});
