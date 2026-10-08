import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PowerPointCreateToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
for(const mode of ['revoked','cancelled'])test(`PowerPoint ${mode} before native authoring creates no output or staging`,{skip:process.platform!=='win32'||process.env.JARVIS_NATIVE_POWERPOINT_TEST!=='1',timeout:120000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ppt-authority-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const controller=new AbortController();if(mode==='cancelled')controller.abort();
 const result=await new PowerPointCreateToolAdapter({allowedRoots:[root]}).execute({path:join(root,'document.pptx'),slides:[{title:'권한 경계 시험',bullets:['합성 자료입니다.']}]},{},{signal:controller.signal,assertAccess(){if(mode==='revoked')throw Error('fixture-authority-revoked');}});
 assert.notEqual(result.status,'success');assert.match(result.error,/fixture-authority-revoked|B_OPERATION_CANCELLED/);assert.deepEqual(await readdir(root),[]);
});
test('PowerPoint cancellation after owned native process observation publishes nothing',{skip:process.platform!=='win32'||process.env.JARVIS_NATIVE_POWERPOINT_TEST!=='1',timeout:120000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ppt-inflight-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const controller=new AbortController();
 const promise=new PowerPointCreateToolAdapter({allowedRoots:[root]}).execute({path:join(root,'presentation.pptx'),slides:Array.from({length:40},(_,n)=>({title:`취소 시험 ${n}`,bullets:['합성 자료입니다.']}))},{},{signal:controller.signal});
 let owned;
 for(let i=0;i<400;i++){
  const stage=(await readdir(root)).find(name=>name.startsWith('.jarvis-ppt-stage-'));
  if(stage){try{owned=JSON.parse((await readFile(join(root,stage,'owned-process.json'),'utf8')).replace(/^\uFEFF/u,''));}catch{}}
  if(owned)break;await new Promise(resolve=>setTimeout(resolve,50));
 }
 controller.abort();const result=await promise;
 assert.ok(owned,'native guard ownership must be observed before cancellation');assert.equal(owned.jobAssigned,true);
 assert.notEqual(result.status,'success');assert.deepEqual(result.outputPaths,[]);assert.deepEqual(await readdir(root),[]);
});
