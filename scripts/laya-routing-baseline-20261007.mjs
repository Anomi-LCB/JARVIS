import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {classifyCommandLane} from '../packages/shared/src/command-lane.js';
const path='tests/fixtures/laya-routing-holdout-20261007.json';
const bytes=readFileSync(path),cases=JSON.parse(bytes);
const rows=[];
for(let repetition=0;repetition<3;repetition++)for(const entry of cases){
  const start=performance.now(),result=classifyCommandLane(entry.command);
  rows.push({id:entry.id,repetition,expected:entry.expected,actual:result.lane,correct:result.lane===entry.expected,
    elapsedMs:performance.now()-start,reasonCodes:result.reasonCodes});
}
const output={observedAt:new Date().toISOString(),casesPath:path,corpusSha256:createHash('sha256').update(bytes).digest('hex'),
  scope:'routing-only-no-tool-execution',modelCalls:0,rows};
const suffix={'--optimized':'optimized','--optimized-r2':'optimized-r2'}[process.argv[2]]??'baseline';
if(process.argv.slice(2).some(a=>!['--optimized','--optimized-r2'].includes(a))||process.argv.slice(2).length>1)throw new Error('Only --optimized or --optimized-r2 is supported.');
writeFileSync(`artifacts/laya-routing-20261007-${suffix}.json`,JSON.stringify(output,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,executions:rows.length,correct:rows.filter(r=>r.correct).length}));
