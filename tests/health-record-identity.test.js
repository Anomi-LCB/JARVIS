import test from 'node:test';import assert from 'node:assert/strict';
import {summarizeHealthRecords} from '../packages/shared/src/health-record-summary.js';
const options={startDate:'2026-02-20',endDate:'2026-02-20',now:'2026-02-21T00:00:00Z'};
const record={recordId:'record-1',dataOrigin:'synthetic.watch.app',metric:'heart_rate',value:70,unit:'bpm',observedAt:'2026-02-20T12:00:00Z',source:'synthetic-watch'};
test('same provider record is counted once and duplicates are disclosed',()=>{
 const summary=summarizeHealthRecords({...options,records:[record,{...record}]});
 assert.equal(summary.recordCount,1);assert.equal(summary.duplicateRecordCount,1);
 assert.equal(summary.metrics.heart_rate.samples[0].recordId,'record-1');
});
test('conflicting values for the same provider identity are never guessed',()=>{
 assert.throws(()=>summarizeHealthRecords({...options,records:[record,{...record,value:90}]}),/health-record-identity-conflict/);
});
test('same ID from different origins remains separate',()=>{
 const result=summarizeHealthRecords({...options,records:[record,{...record,dataOrigin:'synthetic.other.app'}]});
 assert.equal(result.recordCount,2);assert.equal(result.duplicateRecordCount,0);
});
test('unidentified equal samples remain present with identity uncertainty',()=>{
 const {recordId,...unidentified}=record;
 const result=summarizeHealthRecords({...options,records:[unidentified,{...unidentified}]});
 assert.equal(result.recordCount,2);assert.equal(result.unidentifiedRecordCount,2);assert.equal(result.duplicateRecordCount,0);
});
test('empty identity is rejected rather than converted to anonymous input',()=>{
 assert.throws(()=>summarizeHealthRecords({...options,records:[{...record,recordId:''}]}),/health-record-invalid/);
});
test('display source and provider origin do not share an identity namespace',()=>{
 const {dataOrigin,...withoutOrigin}=record;
 const result=summarizeHealthRecords({...options,records:[{...record,dataOrigin:record.source},withoutOrigin]});
 assert.equal(result.recordCount,2);assert.equal(result.duplicateRecordCount,0);
});
