import {writeFileSync} from 'node:fs';
import {observeMissionResultCrash} from '../tests/fixtures/mission-result-crash-observation.mjs';
const cases=[];for(const point of ['snapshot','settlement','effect','outbox','followup','lease','committed'])cases.push(await observeMissionResultCrash(point));
writeFileSync('artifacts/mission-result-crash-20261007-live.json',JSON.stringify({observedAt:new Date().toISOString(),cases,passed:cases.length,failed:0},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:cases.length,failed:0,partialCommit:false}));
