import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {readAcceptanceProgressSummary} from '../scripts/acceptance-progress-summary.mjs';
import {readControlCenterHostPayload} from '../apps/pc-agent/src/install/control-center-host-payload.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const makeLedger=()=>({stages:[{gates:Array.from({length:100},(_,i)=>({id:`V3-${String(i+1).padStart(3,'0')}`,status:i<60?'verified':i<85?'in_progress':'pending'}))}]});
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'jarvis-acceptance-summary-'));
 t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-acceptance-summary-'));await rm(root,{recursive:true,force:true});});
 await mkdir(join(root,'docs'));return root;
}
test('reports the exact original 100 gate counts without altering the source or claiming independent validation',async t=>{
 const root=await fixture(t),path=join(root,'docs/universal-control-v3-acceptance.json'),raw='\uFEFF'+JSON.stringify(makeLedger());await writeFile(path,raw);
 const summary=await readAcceptanceProgressSummary(root);
 assert.equal(summary.status,'available');assert.deepEqual(summary.counts,{verified:60,in_progress:25,pending:15});
 assert.equal(summary.recordedAcceptancePercent,60);assert.equal(summary.independentValidation,false);
 assert.equal(summary.sourceSha256,createHash('sha256').update(raw).digest('hex'));assert.equal(await readFile(path,'utf8'),raw);
});
for(const kind of ['missing','json','count','duplicate','foreign','status','stage'])test('does not invent a percentage from '+kind+' ledger',async t=>{
 const root=await fixture(t),ledger=makeLedger(),gates=ledger.stages[0].gates;
 if(kind==='count')gates.pop();if(kind==='duplicate')gates[99].id='V3-001';if(kind==='foreign')gates[99].id='V3-101';
 if(kind==='status')gates[99].status='passed';if(kind==='stage')ledger.stages[0].gates={};
 if(kind!=='missing')await writeFile(join(root,'docs/universal-control-v3-acceptance.json'),kind==='json'?'{':JSON.stringify(ledger));
 const summary=await readAcceptanceProgressSummary(root);assert.equal(summary.status,'unavailable');assert.equal(Object.hasOwn(summary,'recordedAcceptancePercent'),false);
});
test('reviewed PC host payload imports the diagnostic in a separate process without repository fallback',async t=>{
 const root=await fixture(t),payload=readControlCenterHostPayload();
 assert.ok(payload['control-center-host/scripts/acceptance-progress-summary.mjs']);
 for(const [name,bytes] of Object.entries(payload)){const path=join(root,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes,{flag:'wx'});}
 const entry=pathToFileURL(join(root,'control-center-host/scripts/product-support-bundle.mjs')).href;
 const summary=pathToFileURL(join(root,'control-center-host/scripts/acceptance-progress-summary.mjs')).href;
 const output=await promisify(execFile)(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(entry)});if(typeof m.createProductSupportBundle!=='function')throw Error('MISSING_BUNDLE');const s=await import(${JSON.stringify(summary)});const result=await s.readAcceptanceProgressSummary(process.cwd());if(result.status!=='unavailable'||Object.hasOwn(result,'recordedAcceptancePercent'))throw Error('FALSE_PERCENT');console.log(JSON.stringify({imported:true,acceptance:result.status}));`],{cwd:join(root,'control-center-host'),windowsHide:true,timeout:10000,maxBuffer:32768});
 assert.deepEqual(JSON.parse(output.stdout),{imported:true,acceptance:'unavailable'});
});
