import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VisualCreateCardsToolAdapter,UndoJournal} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {verifyCardLayout} from '../apps/pc-agent/src/adapters/visual/card-layout-contract.js';
import {verifyNewsCardOcr} from '../scripts/lib/news-card-ocr.mjs';
test('normalization retains all requested words and eight body items instead of silently slicing them',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-card-complete-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const title='중요한 제목 '.repeat(30).trim(),body=Array.from({length:8},(_,i)=>`필수 요구항목 ${i+1}`);
 const n=await new VisualCreateCardsToolAdapter({allowedRoots:[root]}).normalize({outputDirectory:root,cards:[{title,body}]});
 assert.equal(n.cards[0].title,title);assert.deepEqual(n.cards[0].body,body);assert.deepEqual(n.warnings,[]);
 const tooMuch=await new VisualCreateCardsToolAdapter({allowedRoots:[root]}).shadow({outputDirectory:root,cards:[{title:'제목',body:Array(21).fill('값')}]});
 assert.equal(tooMuch.expectedChangesCount,0);assert.match(tooMuch.warnings.join(','),/card-text-limit-exceeded/);
});
test('actual complete card preserves every required field and verifies literal glyph pixels independently of OCR',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-card-eight-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const body=['자료 출처 확인','예산 한도 검토','일정 충돌 검사','개인 정보 보호','보고서 내용 검토','계정 권한 확인','작업 결과 기록','최종 승인 상태'];
 const card={title:'필수 요구사항 전체 검증',body,footer:'검증 출처',fileName:'complete.png'};
 const result=await new VisualCreateCardsToolAdapter({allowedRoots:[root],undoJournal:new UndoJournal({journalPath:join(root,'undo.jsonl')})})
  .execute({outputDirectory:root,width:1200,height:675,cards:[card]},{taskId:'complete-card'});
 assert.equal(result.status,'success',JSON.stringify(result));
 const output=result.cards[0];assert.equal(output.layout.fields.filter(f=>f.role.startsWith('body:')).length,8);
 assert.equal(output.layoutVerification.passed,true);assert.equal(output.layoutVerification.pixelTextVerification,'not-evaluated');
 assert.equal(output.pixelVerification.status,'verified');assert.equal(output.pixelVerification.fields.filter(f=>f.role.startsWith('body:')).length,8);
 assert.equal(output.pixelVerification.sha256,output.sha256);assert.equal(output.pixelVerification.semanticMeaning,'not-evaluated');
 if(process.platform==='win32'){
  const ocr=await verifyNewsCardOcr({allowedRoot:root,verificationScale:2,cards:body.map((title,index)=>({id:`requirement-${index}`,path:output.path,title,source:card.footer}))});
  // Real Windows OCR can misread these synthetic Korean glyphs. Keep that
  // result distinct; do not lower its threshold to make it "verified".
  assert.equal(['passed','failed'].includes(ocr.status),true,JSON.stringify(ocr));assert.equal(ocr.cards.length,8);
  assert.equal(ocr.cards.every(c=>c.sha256===output.sha256&&c.rawOcrTextStored===false),true);
 }
});
test('impossible dense text fails explicitly and cannot be reported as a completed card',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-card-overflow-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const adapter=new VisualCreateCardsToolAdapter({allowedRoots:[root],undoJournal:new UndoJournal({journalPath:join(root,'undo.jsonl')})});
 const result=await adapter.execute({outputDirectory:root,width:640,height:360,cards:[{title:'빠짐 없이 보존해야 할 요구',body:Array(20).fill('매우 긴 필수 설명 '.repeat(30))}]},{taskId:'overflow-card'});
 assert.equal(result.status,'failed');assert.match(result.error,/visual-card-text-overflow/);assert.deepEqual(result.outputPaths,[]);
});
test('forged layout receipts with clipping, overlap, partial text, reordered fields or missing body fail host checks',()=>{
 const card={title:'정확한 제목',body:['필수 항목']};
 const f=()=>({version:1,complete:true,contentBounds:[10,10,590,350],fields:[
  {role:'title',text:card.title,lines:[card.title],fontSize:24,bounds:[[20,20,200,50]]},
  {role:'body:0',text:card.body[0],lines:[card.body[0]],fontSize:20,bounds:[[20,60,200,80]]}]});
 assert.equal(verifyCardLayout(card,f(),640,360).passed,true);
 for(const mutate of [v=>v.fields[1].bounds[0][1]=25,v=>v.fields[0].bounds[0][2]=650,
  v=>v.fields[1].lines=['필수'],v=>v.fields.reverse(),v=>v.fields.pop()]){
  const layout=f();mutate(layout);assert.equal(verifyCardLayout(card,layout,640,360).passed,false);
 }
});
test('independent verifier rejects blank pixels even with a valid producer layout receipt',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-card-pixel-negative-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const card={title:'문구 보존 검사',body:['필수 항목'],fileName:'negative.png'};
 const adapter=new VisualCreateCardsToolAdapter({allowedRoots:[root],undoJournal:new UndoJournal({journalPath:join(root,'undo.jsonl')})});
 const generated=await adapter.execute({outputDirectory:root,cards:[card]},{taskId:'negative-card'});
 assert.equal(generated.status,'success',JSON.stringify(generated));const output=generated.cards[0];
 const run=promisify(execFile),python=process.env.JARVIS_PYTHON??'python';
 await run(python,['-c','from PIL import Image; import sys; Image.new("RGB",(1200,675),(20,29,48)).save(sys.argv[1])',output.path],{windowsHide:true});
 const normalized=await adapter.normalize({outputDirectory:root,cards:[card]});
 const request=Buffer.from(JSON.stringify({entries:[{card:normalized.cards[0],layout:output.layout}]}),'utf8').toString('base64');
 await assert.rejects(run(python,[fileURLToPath(new URL('../apps/pc-agent/src/adapters/visual/verify_card_pixels.py',import.meta.url)),request],{windowsHide:true,encoding:'utf8'}),error=>{
  const result=JSON.parse(error.stdout);return result.status==='failed'&&result.reason==='pixel-verification-glyph-pixels-mismatch';
 });
});
test('publication collision preserves existing file and removes only newly published partial outputs',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-card-collision-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const existing=join(root,'existing.png');
 const adapter=new VisualCreateCardsToolAdapter({allowedRoots:[root],undoJournal:new UndoJournal({journalPath:join(root,'undo.jsonl')})});
 const normalize=adapter.normalize.bind(adapter);
 // Inject a real competing file after the preflight has passed. An existing
 // file present before preflight is correctly blocked even earlier.
 adapter.normalize=async args=>{const result=await normalize(args);await writeFile(existing,'user-owned-original');return result;};
 const result=await adapter.execute({outputDirectory:root,cards:[{title:'첫 카드',fileName:'first.png'},{title:'두 번째 카드',fileName:'existing.png'}]},{taskId:'collision'});
 assert.equal(result.status,'failed');assert.equal(result.error,'visual-card-target-exists');
 assert.equal(await readFile(existing,'utf8'),'user-owned-original');assert.deepEqual(result.outputPaths,[]);
 assert.equal((await readdir(root)).includes('first.png'),false);
 assert.equal((await readdir(root)).some(name=>name.startsWith('.jarvis-card-stage-')),false);
});
