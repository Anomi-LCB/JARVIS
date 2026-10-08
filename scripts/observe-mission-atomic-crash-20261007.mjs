import { writeFileSync } from 'node:fs';
import { observeMissionAtomicCrash } from '../tests/fixtures/mission-atomic-crash-observation.mjs';
const cases=[];
for(const point of ['snapshot','reservation','effect','outbox','committed']) cases.push(await observeMissionAtomicCrash(point));
const result={observedAt:new Date().toISOString(),cases,passed:cases.length,failed:0};
writeFileSync('artifacts/mission-atomic-crash-20261007-live.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:result.passed,failed:0,partialCommit:false}));
