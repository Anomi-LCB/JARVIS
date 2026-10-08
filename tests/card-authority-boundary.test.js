import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VisualCreateCardsToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'jarvis-card-authority-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,path:join(root,'card.png'),adapter:new VisualCreateCardsToolAdapter({allowedRoots:[root]}),args:{outputDirectory:root,cards:[{title:'검증 문구',body:['원래 요구'],fileName:'card.png'}]}};}
test('Card creation checks current authority before creating files',async t=>{
 const {root,adapter,args}=await fixture(t);const result=await adapter.execute(args,{}, {assertAccess(){throw Error('fixture-revoked');}});
 assert.notEqual(result.status,'success');assert.deepEqual(await readdir(root),[]);
});
test('Card creation honors signed path scope rather than only adapter roots',async t=>{
 const {root,adapter,args}=await fixture(t);const result=await adapter.execute(args,{capabilityToken:{scope:{allowedPaths:[join(root,'other.png')]}}});
 assert.notEqual(result.status,'success');assert.deepEqual(await readdir(root),[]);
});
test('Postpublication authority revocation retains uncertain file evidence without unauthorized cleanup',async t=>{
 const {path,adapter,args}=await fixture(t);let observed=false;
 const result=await adapter.execute(args,{}, {assertAccess(){if(existsSync(path)){observed=true;throw Error('fixture-postpublish-revoked');}}});
 assert.ok(observed);assert.equal(result.status,'failed');assert.equal(result.uncertain,true);assert.deepEqual(result.outputPaths,[path]);
 assert.ok((await readFile(path)).length>24);
});
test('Changed published file is preserved when final verification and compensation fail',async t=>{
 const {path,args,adapter}=await fixture(t);
 adapter.undoJournal={record(){writeFileSync(path,'external changed bytes');return {undoJournalId:'synthetic-undo'};}};
 const result=await adapter.execute(args);
 assert.equal(result.status,'failed');assert.equal(result.uncertain,true);assert.deepEqual(result.outputPaths,[path]);
 assert.equal(await readFile(path,'utf8'),'external changed bytes');
});
test('Cancelled card request creates no staging or output',async t=>{
 const {root,args,adapter}=await fixture(t),controller=new AbortController();controller.abort();
 const result=await adapter.execute(args,{}, {signal:controller.signal});
 assert.equal(result.status,'blocked');assert.deepEqual(await readdir(root),[]);
});
test('Complete card contract is checked before authoring',async t=>{
 const {root,args,adapter}=await fixture(t);let calls=0;
 const result=await adapter.execute(args,{}, {beforeArtifactWrite(plan){calls++;assert.equal(plan.prepared.manifestVersion,'jarvis-card-publication-v1');assert.deepEqual(plan.paths,plan.prepared.cards.map(card=>card.path));throw Error('original-plan-changed');}});
 assert.equal(calls,1);assert.equal(result.status,'blocked');assert.deepEqual(await readdir(root),[]);
});
test('Unsupported accent is rejected instead of silently truncating user styling',async t=>{
 const {root,args,adapter}=await fixture(t);args.cards[0].accent='#112233extra';
 const result=await adapter.execute(args);
 assert.equal(result.status,'blocked');assert.match(result.warnings.join(','),/invalid-card-accent/);assert.deepEqual(await readdir(root),[]);
});
test('Actual Python card staging cancellation publishes no final file',{timeout:20000},async t=>{
 const {root,path,args,adapter}=await fixture(t),controller=new AbortController();let observed=false,settled=false;
 const promise=adapter.execute(args,{}, {signal:controller.signal}).finally(()=>{settled=true;});
 for(let i=0;i<1000&&!settled;i++){
  for(const name of await readdir(root))if(name.startsWith('.jarvis-card-stage-')&&existsSync(join(root,name,'card.png')))observed=true;
  if(observed)break;await new Promise(resolve=>setTimeout(resolve,5));
 }
 controller.abort();const result=await promise;
 assert.ok(observed,'actual Python PNG must be observed in staging');assert.notEqual(result.status,'success');assert.equal(existsSync(path),false);
 assert.deepEqual(await readdir(root),[]);
});
