import test from 'node:test';import assert from 'node:assert/strict';
import {buildHealthRecordReport} from '../packages/shared/src/health-record-summary.js';
const record={metric:'heart_rate',unit:'bpm',source:'synthetic-watch',sensorId:'A',dataOrigin:'test.app',recordingMethod:2,value:70,observedAt:'2026-02-20T12:00:00Z'};
const options={startDate:'2026-02-20',endDate:'2026-02-23',now:'2026-02-24T00:00:00Z'};
test('daily observations retain source separation, gaps and arithmetic without health judgments',()=>{
 const result=buildHealthRecordReport({...options,records:[record,{...record,value:90,observedAt:'2026-02-20T13:00:00Z'},{...record,value:60,observedAt:'2026-02-22T12:00:00Z'},{...record,sensorId:'B',value:1000}]});
 const series=result.summary.metrics.heart_rate.sourceSeries;
 assert.equal(series.length,2);assert.deepEqual(series[0].daily[0],{date:'2026-02-20',count:2,mean:80,min:70,max:90,daysSincePreviousObservation:null,changeFromPreviousRecordedMean:null});
 assert.equal(series[0].daily[1].mean,60);assert.equal(series[0].daily[1].changeFromPreviousRecordedMean,-20);assert.equal(series[0].daily[1].daysSincePreviousObservation,2);
 assert.equal(series[0].missingDayCount,2);assert.equal(series[0].comparabilityVerified,false);
 assert.equal(series[1].daily[0].mean,1000);assert.equal(result.summary.diagnosisProvided,false);
 assert.match(result.reportMarkdown,/결측은 0으로 채우지 않습니다/);assert.match(result.reportMarkdown,/하루 전체의 건강 상태나 걸음 총합을 뜻하지 않습니다/);
});
test('changed calibration and manual recording produce separate series',()=>{
 const result=buildHealthRecordReport({...options,records:[record,{...record,calibrationStatus:'uncalibrated'},{...record,recordingMethod:3}]});
 assert.equal(result.summary.metrics.heart_rate.sourceSeries.length,3);
});
test('large finite samples produce a finite mean and report text preserves source safely',()=>{
 const result=buildHealthRecordReport({...options,records:[{...record,value:1e308,source:'<script>|source\nnext'},{...record,value:1.7e308,source:'<script>|source\nnext'}]});
 assert.ok(Number.isFinite(result.summary.metrics.heart_rate.sourceSeries[0].daily[0].mean));
 assert.ok(!result.reportMarkdown.includes('<script>'));assert.match(result.reportMarkdown,/&lt;script&gt;/);
});
