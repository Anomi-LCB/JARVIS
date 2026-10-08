import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const bytes=await readFile('tests/fixtures/gepa-summary-20261007.json');
const sha=createHash('sha256').update(bytes).digest('hex');
assert.equal(sha,'e12d6a80623cffa582890ef5ed9121af5d2c8c2e0a540eb0915c2535912aa8c4');
const corpus=JSON.parse(bytes),root='artifacts/source-question-20261007-live';await mkdir(root,{recursive:true});
const rows=[];
for(const id of ['H1','H3']){
 const item=corpus.cases.find(c=>c.id===id);
 const child=spawn(process.execPath,['scripts/gepa-summary-evaluate-20261007.mjs'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 child.stdin.end(JSON.stringify({item,prefix:'원문만 근거로 질문에 답한다. 수치와 상태를 혼동하지 않는다.',mission:true,outputRoot:`${root}/${id}`}));
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 await writeFile(`${root}/${id}-process.json`,JSON.stringify({code,stdout,stderr},null,2)+'\n',{flag:'wx'});
 assert.equal(code,0);const result=JSON.parse(stdout);const report=result.report;
 assert.ok(report.status==='BLOCKED'||report.status==='COMPLETED');
 if(report.status==='BLOCKED'){assert.equal(report.output,null);assert.equal(report.actions.some(a=>a.toolName==='filesystem.createTextFile'),false);}
 else assert.equal(report.outputMatchesIndependentOracle,true);
 rows.push(result);console.log(JSON.stringify({id,status:report.status,saved:report.output!==null,totalMs:report.totalMs}));
}
await writeFile(`${root}/comparison.json`,JSON.stringify({observedAt:new Date().toISOString(),corpusSha256:sha,rows,
 model:'gemma3:latest',numGpu:0,numThreads:3,falseSavedFiles:0,scope:'previously-exposed-regression-not-independent-holdout',
 paidApiCalls:0,totalCost:null,costMeasurement:'unmeasured'},null,2)+'\n',{flag:'wx'});
