import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {existsSync,readdirSync} from 'node:fs';
import {HwpCreateToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {verifyHancomRenderingCurrent} from '../apps/verification/src/hancom-render-verifier.js';
const native={skip:process.platform!=='win32'||process.env.JARVIS_NATIVE_HWP_TEST!=='1',timeout:120000};
async function fixture(t,options={}){const root=await mkdtemp(join(tmpdir(),'jarvis-hwp-native-authority-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));return {root,path:join(root,'문서.hwp'),adapter:new HwpCreateToolAdapter({allowedRoots:[root],...options})};}
for(const mode of ['revoked','cancelled'])test(`HWP ${mode} starts no worker`,async t=>{
 const {root,path,adapter}=await fixture(t),controller=new AbortController();if(mode==='cancelled')controller.abort();
 const result=await adapter.execute({path,title:'합성 자료'},{},{signal:controller.signal,assertAccess(){if(mode==='revoked')throw Error('fixture-revoked');}});
 assert.notEqual(result.status,'success');assert.deepEqual(await readdir(root),[]);
});
test('HWP native parent publishes verified source from owned child stage',native,async t=>{
 const {root,path,adapter}=await fixture(t);let checks=0;
 const result=await adapter.execute({path,title:'부모 발행 검사',blocks:[{type:'table',columns:['항목','수량'],rows:[['합성','42']]}]},{},{assertAccess(){checks++;}});
 assert.equal(result.status,'success',JSON.stringify(result));assert.equal(result.targetPath,path);assert.deepEqual(result.outputPaths,[path]);
 assert.equal(result.evidence.processGuard.jobAssigned,true);assert.equal(result.evidence.processGuard.parentWatchEnabled,true);assert.ok(checks>=5);
 assert.equal((await readFile(path)).subarray(0,8).toString('hex'),'d0cf11e0a1b11ae1');assert.deepEqual(await readdir(root),['문서.hwp']);
});
test('HWP native late authority revocation preserves only owned staging and never publishes',native,async t=>{
 const {root,path,adapter}=await fixture(t);let generated=false;
 const result=await adapter.execute({path,title:'발행 직전 철회'},{},{assertAccess(){
  const stage=readdirSync(root).find(name=>name.startsWith('.jarvis-hwp-worker-stage-'));
  if(stage&&existsSync(join(root,stage,'document.hwp'))){generated=true;throw Error('fixture-late-revoked');}
 }});
 assert.ok(generated,'real native document must finish in owned staging');assert.notEqual(result.status,'success',JSON.stringify(result));
 assert.deepEqual(result.outputPaths,[]);assert.deepEqual(await readdir(root),[]);
});
test('HWP existing output is preserved before native worker startup',async t=>{
 const {root,path,adapter}=await fixture(t);await writeFile(path,'user original');
 const result=await adapter.execute({path,title:'덮어쓰지 않기'});assert.notEqual(result.status,'success');
 assert.equal(await readFile(path,'utf8'),'user original');assert.deepEqual(await readdir(root),['문서.hwp']);
});
test('HWP cancellation after observing actual owned Hancom process publishes nothing',native,async t=>{
 const {root,path,adapter}=await fixture(t),controller=new AbortController();let ownership,settled=false;
 const promise=adapter.execute({path,title:'진행 중 취소',blocks:[{type:'table',columns:['번호','자료'],rows:Array.from({length:300},(_,i)=>[String(i),'합성'])}]},{},{signal:controller.signal}).finally(()=>{settled=true;});
 for(let i=0;i<600&&!settled;i++){
  const stage=(await readdir(root)).find(name=>name.startsWith('.jarvis-hwp-worker-stage-'));
  if(stage){for(const name of await readdir(join(root,stage))){if(name.endsWith('.owner.json'))try{ownership=JSON.parse((await readFile(join(root,stage,name),'utf8')).replace(/^\uFEFF/u,''));}catch{}}}
  if(ownership)break;await new Promise(resolve=>setTimeout(resolve,50));
 }
 controller.abort();const result=await promise;
 assert.ok(ownership,'real COM ownership must be observed');assert.equal(ownership.jobAssigned,true);assert.equal(ownership.parentWatchEnabled,true);
 assert.notEqual(result.status,'success',JSON.stringify(result));assert.deepEqual(result.outputPaths,[]);assert.deepEqual(await readdir(root),[]);
 let alive=true;for(let i=0;i<100;i++){try{process.kill(ownership.processId,0);}catch(error){assert.equal(error.code,'ESRCH');alive=false;break;}await new Promise(resolve=>setTimeout(resolve,50));}
 assert.equal(alive,false,'owned Hancom must terminate after worker cancellation');
});
test('HWP parent publication retains requested actual rendering and independent G proof',native,async t=>{
 const {root,path,adapter}=await fixture(t);
 const result=await adapter.execute({path,title:'부모 발행과 렌더 검증',verifyRendering:true,blocks:[{type:'paragraph',text:'합성 본문 요구를 보존합니다.'}]});
 assert.equal(result.status,'success',JSON.stringify(result));assert.equal(result.nativeRendering.actualRenderingExecuted,true);
 assert.ok(result.outputPaths.includes(path));assert.ok(result.outputPaths.includes(result.nativeRendering.manifestPath));
 const proof=await verifyHancomRenderingCurrent({executionResult:result,allowedRoots:[root]});assert.equal(proof.passed,true,JSON.stringify(proof));
});
test('HWP direct native route checks signed scope before any intermediate file',async t=>{
 const {root,path,adapter}=await fixture(t,{workerIsolation:false});
 const result=await adapter.execute({path,title:'제외된 범위'},{capabilityToken:{scope:{allowedPaths:[join(root,'another.hwp')]}}});
 assert.notEqual(result.status,'success');assert.deepEqual(result.outputPaths,[]);assert.deepEqual(await readdir(root),[]);
});
test('HWP direct native route preserves uncertain output if undo recording fails',native,async t=>{
 const {root,path,adapter}=await fixture(t,{workerIsolation:false,undoJournal:{record(){throw Error('fixture-undo-failed');}}});
 const result=await adapter.execute({path,title:'직접 경로 부분 결과'});
 assert.equal(result.status,'failed',JSON.stringify(result));assert.equal(result.uncertain,true);assert.deepEqual(result.outputPaths,[path]);
 assert.equal((await readFile(path)).subarray(0,8).toString('hex'),'d0cf11e0a1b11ae1');assert.deepEqual(await readdir(root),['문서.hwp']);
});
