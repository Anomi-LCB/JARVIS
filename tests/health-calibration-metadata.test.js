import test from 'node:test';import assert from 'node:assert/strict';
import {summarizeHealthRecords} from '../packages/shared/src/health-record-summary.js';
const record={metric:'heart_rate',value:70,unit:'bpm',observedAt:'2026-02-20T12:00:00Z',source:'synthetic-watch',sensorId:'sensor-A'};
const options={startDate:'2026-02-20',endDate:'2026-02-20',now:'2026-02-21T00:00:00Z'};
const calibration={status:'calibrated',method:'bench comparison',performedAt:'2026-02-19T12:00:00+09:00',reference:'synthetic calibration report'};
test('calibration conditions and manual recording origin survive summary without becoming verified',()=>{
 const sample=summarizeHealthRecords({...options,records:[{...record,calibration,recordingMethod:3,dataOrigin:'synthetic.manual.app'}]}).metrics.heart_rate.samples[0];
 assert.deepEqual(sample.calibration,calibration);assert.equal(sample.calibrationStatus,'calibrated');
 assert.equal(sample.calibrationVerified,false);assert.equal(sample.calibrationApplied,false);
 assert.equal(sample.recordingMethod,3);assert.equal(sample.dataOrigin,'synthetic.manual.app');assert.equal(sample.value,70);
});
for(const [name,change]of [
 ['conflicting status',{calibration,calibrationStatus:'uncalibrated'}],
 ['future calibration',{calibration:{...calibration,performedAt:'2026-02-21T12:00:00Z'}}],
 ['missing calibrated conditions',{calibration:{status:'calibrated'}}],
 ['unimplemented calibration transform',{calibration:{...calibration,gain:2}}],
 ['invalid recording method',{recordingMethod:9}],
 ['false verification flag',{calibration:{...calibration,verified:true}}]
])test('health metadata rejects '+name,()=>{
 assert.throws(()=>summarizeHealthRecords({...options,records:[{...record,...change}]}),/health-record-invalid/);
});
