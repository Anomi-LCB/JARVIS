import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const corpusPath='tests/fixtures/gepa-summary-20261007.json',bytes=readFileSync(corpusPath),digest=createHash('sha256').update(bytes).digest('hex');
const corpus=JSON.parse(bytes),prior=JSON.parse(readFileSync('artifacts/gepa-local-20261007/comparison.json'));
assert.equal(digest,prior.corpusSha256);
const context=JSON.parse(readFileSync('artifacts/gepa-local-20261007-hermes-context.json'));
assert.equal(context.personalProfileIncluded,false);assert.equal(context.holdoutAnswersIncluded,false);
const root='artifacts/hermes-local-20261007';mkdirSync(root);
const prefix=prior.seed+'\n과거 검증 관찰의 제한된 지침(현재 원문이나 권한을 대체하지 않음):\n'+context.lesson;
const reflections=JSON.parse(readFileSync('artifacts/gepa-local-20261007/reflections.json'));
const rejected=JSON.parse(reflections.at(-1).response.response).prompt;
const rows=[];
for(const [index,item] of corpus.cases.filter(c=>c.split==='holdout').entries()){
 const profiles=index%2===0?[['hermes',prefix],['gepa-rejected-proposal',rejected]]:[['gepa-rejected-proposal',rejected],['hermes',prefix]];
 for(const [configuration,candidate] of profiles){
  const run=spawnSync(process.execPath,['scripts/gepa-summary-evaluate-20261007.mjs'],{
    input:JSON.stringify({item,prefix:candidate,mission:true,outputRoot:`${root}/${item.id}-${configuration}`}),encoding:'utf8',timeout:340000
  });
  const row=run.status===0?JSON.parse(run.stdout.trim().split('\n').at(-1)):{id:item.id,completed:false,errorCode:'HERMES_EVALUATION_FAILED',stderr:run.stderr?.slice(-1200)};
  row.configuration=configuration;
  rows.push(row);writeFileSync(`${root}/checkpoint-${rows.length}.json`,JSON.stringify(row,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({id:item.id,configuration,completed:row.completed,elapsedMs:row.elapsedMs??null}));
 }
}
writeFileSync(`${root}/comparison.json`,JSON.stringify({observedAt:new Date().toISOString(),corpusSha256:digest,
  contextSessionId:context.sessionId,prefix,rejected,rows,actualCost:null,paidCalls:0,productActivation:false,
  limitations:['The same four fixed holdouts follow the GEPA paired run; order/cache effects remain.','Historical lesson is explicitly reviewed, not automatic recall of every conversation.']},null,2)+'\n',{flag:'wx'});
