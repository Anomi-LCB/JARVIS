import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
test('runner enforces serial file execution and name filtering rather than passing flags to tests',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-runner-options-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const marker=join(root,'events.jsonl'),report=join(root,'report.json'),paths=[];
 for(const id of ['a','b']){
   const path=join(root,`${id}.test.js`);paths.push(path);
   await writeFile(path,`import test from 'node:test';import {appendFileSync} from 'node:fs';
test('selected',async()=>{appendFileSync(${JSON.stringify(marker)},'${id}:begin\\n');await new Promise(r=>setTimeout(r,350));appendFileSync(${JSON.stringify(marker)},'${id}:end\\n');});
test('excluded',()=>{throw Error('test name filter ignored');});`);
 }
 const result=await run(process.execPath,['scripts/run-tests.mjs',...paths,'--test-concurrency=1','--test-name-pattern=selected'],{
   env:{...process.env,JARVIS_TEST_RUN_REPORT:report},windowsHide:true,timeout:20000,maxBuffer:1024*1024});
 let events;try{events=(await readFile(marker,'utf8')).trim().split('\n');}catch(error){throw Error(`test events missing: ${result.stdout} ${result.stderr}`,{cause:error});}
 assert.ok(JSON.stringify(events)===JSON.stringify(['a:begin','a:end','b:begin','b:end'])||JSON.stringify(events)===JSON.stringify(['b:begin','b:end','a:begin','a:end']),JSON.stringify(events));
 assert.equal(JSON.parse(await readFile(report,'utf8')).status,'passed');
});
