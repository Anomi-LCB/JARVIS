import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WordCreateToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
for(const mode of ['revoked','cancelled'])test(`Word stops before native authoring when ${mode}`,{
 skip:process.env.JARVIS_NATIVE_WORD_TEST!=='1'||process.platform!=='win32',timeout:120000
},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-word-authority-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'output.docx'),adapter=new WordCreateToolAdapter({allowedRoots:[root]});
 const controller=new AbortController();if(mode==='cancelled')controller.abort();
 const context={signal:controller.signal,assertAccess(){if(mode==='revoked')throw Error('fixture-authority-revoked');}};
 const result=await adapter.execute({path,title:'권한 경계 시험',blocks:[{type:'paragraph',text:'합성 자료입니다.'}]},{},context);
 assert.notEqual(result.status,'success',JSON.stringify(result));
 assert.match(result.error,/fixture-authority-revoked|B_OPERATION_CANCELLED/);
 await assert.rejects(readFile(path),{code:'ENOENT'});
 assert.deepEqual(await readdir(root),[],'denied authoring must create no staging/evidence directory');
});
test('allowed native Word authoring keeps content and rendering evidence',{
 skip:process.env.JARVIS_NATIVE_WORD_TEST!=='1'||process.platform!=='win32',timeout:120000
},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-word-authority-positive-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'document.docx.err'),'existing unrelated file');
 let checks=0;const adapter=new WordCreateToolAdapter({allowedRoots:[root]});
 const result=await adapter.execute({path:join(root,'document.docx'),title:'허용된 문서',blocks:[{type:'paragraph',text:'실제 Word 검증 문장입니다.'}]},{},{assertAccess(){checks++;}});
 assert.equal(result.status,'success',JSON.stringify(result));assert.ok(checks>=5);
 assert.equal(result.nativeReport.status,'verified');assert.equal(result.nativeReport.savedReopenedReadOnly,true);
 assert.equal(result.outputPaths.length,3);
 assert.equal(await readFile(join(root,'document.docx.err'),'utf8'),'existing unrelated file');
});
test('Word adapter cancellation during actual owned native authoring publishes nothing',{
 skip:process.env.JARVIS_NATIVE_WORD_TEST!=='1'||process.platform!=='win32',timeout:120000
},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-word-authority-inflight-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const controller=new AbortController(),path=join(root,'document.docx');
 const adapter=new WordCreateToolAdapter({allowedRoots:[root]});
 const promise=adapter.execute({path,title:'취소 시 원본 보존',blocks:[{type:'table',columns:['번호','값'],rows:Array.from({length:900},(_,n)=>[String(n),'합성 입력'])}]},{},{signal:controller.signal});
 let ownership;
 for(let i=0;i<400;i++){
   const stage=(await readdir(root)).find(name=>name.startsWith('.jarvis-word-stage-'));
   if(stage){try{ownership=JSON.parse((await readFile(join(root,stage,'owned-process.json'),'utf8')).replace(/^\uFEFF/u,''));}catch{}}
   if(ownership)break;
   await new Promise(resolve=>setTimeout(resolve,50));
 }
 controller.abort();const result=await promise;
 assert.ok(ownership,'actual native ownership must be observed before cancelling');
 assert.notEqual(result.status,'success');
 assert.equal(result.nativeRecovery?.jobAssignmentObserved,true);
 await assert.rejects(readFile(path),{code:'ENOENT'});
 assert.deepEqual(await readdir(root),[]);
});
