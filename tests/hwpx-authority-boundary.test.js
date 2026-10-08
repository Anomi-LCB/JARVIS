import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {writeFileSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HwpCreateToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
async function setup(t,options={}){
 const root=await mkdtemp(join(tmpdir(),'jarvis-hwpx-authority-'));t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,path:join(root,'document.hwpx'),adapter:new HwpCreateToolAdapter({allowedRoots:[root],...options})};
}
for(const mode of ['revoked','cancelled'])test(`HWPX ${mode} before authoring creates nothing`,async t=>{
 const {root,path,adapter}=await setup(t),controller=new AbortController();if(mode==='cancelled')controller.abort();
 const result=await adapter.execute({path,title:'합성 권한 검사'}, {}, {signal:controller.signal,assertAccess(){if(mode==='revoked')throw Error('fixture-revoked');}});
 assert.notEqual(result.status,'success',JSON.stringify(result));assert.deepEqual(await readdir(root),[]);
});
test('HWPX preserves published output and reports uncertainty if undo recording fails',async t=>{
 const {path,adapter}=await setup(t,{undoJournal:{record(){throw Error('fixture-undo-failed');}}});
 const result=await adapter.execute({path,title:'합성 자료 보존'});
 assert.equal(result.status,'failed');assert.equal(result.uncertain,true,JSON.stringify(result));assert.deepEqual(result.outputPaths,[path]);
 assert.ok((await readFile(path)).length>0);
});
test('HWPX allowed creation checks current authority after generation and before publication',async t=>{
 const {path,adapter}=await setup(t);let generated=false,checks=0;
 const original=adapter.executeHwpx.bind(adapter);
 adapter.executeHwpx=async(...args)=>{generated=true;return original(...args);};
 const result=await adapter.execute({path,title:'정상 경로'}, {}, {assertAccess(){checks++;}});
 assert.equal(result.status,'success',JSON.stringify(result));assert.ok(generated);assert.ok(checks>=5,`checks=${checks}`);
 if(process.platform==='win32'){assert.equal(result.evidence.hwpx.processGuard.jobAssigned,true);assert.equal(result.evidence.hwpx.processGuard.killOnClose,true);}
});
test('HWPX revoked after actual Python generation publishes nothing',async t=>{
 const {root,path,adapter}=await setup(t);let generated=false;
 const result=await adapter.execute({path,title:'생성 후 권한 철회'}, {}, {assertAccess(){
  if(readdirSync(root).some(name=>name.startsWith('.jarvis-hwpx-')&&existsSync(join(root,name,'document.hwpx')))){generated=true;throw Error('fixture-late-revoked');}
 }});
 assert.ok(generated,'actual Python document must be observed');assert.notEqual(result.status,'success');assert.deepEqual(await readdir(root),[]);
});
test('HWPX late competing output is preserved without claiming ownership',async t=>{
 const {root,path,adapter}=await setup(t);let generated=false;
 const result=await adapter.execute({path,title:'경합 자료'}, {}, {assertAccess(){
  if(!generated&&readdirSync(root).some(name=>name.startsWith('.jarvis-hwpx-')&&existsSync(join(root,name,'document.hwpx')))){generated=true;writeFileSync(path,'competing user output');}
 }});
 assert.ok(generated,'actual Python document must finish before competing output');
 assert.notEqual(result.status,'success');assert.deepEqual(result.outputPaths,[]);assert.equal(result.uncertain,undefined);
 assert.equal(await readFile(path,'utf8'),'competing user output');assert.deepEqual(await readdir(root),['document.hwpx']);
});
test('HWPX signed path denial creates no staging or output',async t=>{
 const {root,path,adapter}=await setup(t);
 const result=await adapter.execute({path,title:'범위 밖'}, {capabilityToken:{scope:{allowedPaths:[join(root,'another.hwpx')]}}});
 assert.notEqual(result.status,'success');assert.deepEqual(await readdir(root),[]);
});
test('HWPX cancellation after observing actual staged document never publishes final file',{timeout:45000},async t=>{
 const {root,path,adapter}=await setup(t),controller=new AbortController();
 let settled=false,observed=false,guard;
 const promise=adapter.execute({path,title:'실제 진행 중 취소',blocks:Array.from({length:40},(_,n)=>({type:'paragraph',text:`합성 항목 ${n}`}))},{},{signal:controller.signal}).finally(()=>{settled=true;});
 const deadline=Date.now()+30000;
 while(!settled&&Date.now()<deadline){
  const stage=(await readdir(root)).find(name=>name.startsWith('.jarvis-hwpx-'));
  if(stage){try{observed=(await readFile(join(root,stage,'document.hwpx'))).length>0;guard=JSON.parse(await readFile(join(root,stage,'process-guard.json'),'utf8'));}catch{}}
  if(observed)break;
  await new Promise(resolve=>setTimeout(resolve,40));
 }
 controller.abort();const result=await promise;
 assert.ok(observed,'must observe actual Python/MCP document before cancellation');
 if(process.platform==='win32'){assert.equal(guard.jobAssigned,true);assert.equal(guard.killOnClose,true);}
 assert.notEqual(result.status,'success',JSON.stringify(result));assert.deepEqual(result.outputPaths,[]);assert.deepEqual(await readdir(root),[]);
});
