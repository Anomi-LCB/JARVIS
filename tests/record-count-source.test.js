import test from 'node:test';
import assert from 'node:assert/strict';
import {recordCountSource} from '../packages/core/src/mission/mission-record-count.js';
for(const source of ["'a.txt'에 정확히 3건의 기록을 줄바꿈으로 저장해","'a.txt'에 2~4건의 기록을 줄바꿈으로 저장해."])
 test('literal source count '+source,()=>assert.equal(recordCountSource({objective:source}).contract.quantities.length,1));
for(const source of ["'a.txt'에 3명에게 2부씩의 기록을 줄바꿈으로 저장해","'a.txt'에 500mg의 기록을 줄바꿈으로 저장해",
 "'a.txt'에 3건씩의 기록을 줄바꿈으로 저장해","'a.txt'에 3건의 기록을 줄바꿈으로 저장해; 메일로 보내",
 "'3건.txt' 파일을 저장해","'a.txt'에 3건의 기록을 줄바꿈으로 저장해 그리고 내일 보내"])
 test('unbound interpretation remains unsupported '+source,()=>assert.equal(recordCountSource({objective:source}),null));
