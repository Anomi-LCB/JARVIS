import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {VisualCreateCardsToolAdapter,UndoJournal} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {verifyArtifactLayoutCurrent} from '../apps/verification/src/artifact-layout-verifier.js';
import {normalizeVerificationSpec,verifyTypedCriterion} from '../packages/core/src/mission/criteria-evidence.js';
const sha=value=>createHash('sha256').update(value).digest('hex');
test('layout criterion rejects unknown clauses and invalid formats rather than discarding them',()=>{
 const base={version:1,kind:'presentation.contentLayout',path:'test.pptx',equals:[{title:'제목',bullets:['필수'],notes:'메모'}]};
 assert.deepEqual(normalizeVerificationSpec(base),base);
 for(const invalid of [{...base,equals:[{...base.equals[0],sendEmail:true}]},{...base,equals:[]},{...base,equals:[{title:'제목',bullets:[null],notes:''}]}])assert.throws(()=>normalizeVerificationSpec(invalid));
});
test('actual G card oracle and typed completion require exact expected content and current bounded files',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-g-card-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const result=await new VisualCreateCardsToolAdapter({allowedRoots:[root],undoJournal:new UndoJournal({journalPath:join(root,'undo.jsonl')})})
  .execute({outputDirectory:root,cards:[{title:'실제 파일 검증',body:['첫 요구','둘째 요구'],fileName:'card.png'},{title:'본문 없음',body:'',fileName:'empty.png'}]},{taskId:'card-current'});
 assert.equal(result.status,'success',JSON.stringify(result));
 assert.deepEqual(result.cards[1].requiredContent.body,[]);
 const executionResult={...result,toolName:'visual.createCards'};
 const checked=await verifyArtifactLayoutCurrent({executionResult,allowedRoots:[root]});assert.equal(checked.passed,true,JSON.stringify(checked));
 assert.equal(checked.proofs.length,2);
 const card=result.cards[0],ref=file=>({name:'card.png',relativePath:relative(root,file.path).replaceAll('\\','/'),rootIndex:0,pathHash:sha(resolve(file.path)),contentSha256:file.sha256,outsideAllowedRoots:false});
 const proof=checked.proofs[0];const observation={actionId:'card',outcome:'success',verification:{status:'passed'},artifacts:proof.files.map(ref),data:{artifactLayoutProofs:[{
  kind:proof.kind,pathHash:sha(proof.path),requirementsSha256:proof.requirementsSha256,width:proof.width,height:proof.height,files:proof.files.map(ref)}]}};
 const criterion={verificationSpec:{version:1,kind:'image.cardLayout',path:'card.png',equals:card.requiredContent,width:1200,height:675}};
 const verify=(change=criterion,extra={})=>verifyTypedCriterion({criterion:change,observations:[observation],evidenceActionIds:['card'],allowedRoots:[root],...extra});
 assert.equal(verify().passed,true);
 const resultReads=[];assert.equal(verify(criterion,{beforeAccess:access=>{resultReads.push(access);if(access.path!==card.path||access.kind!=='read')throw Error('bad permission target');}}).passed,true);
 assert.equal(resultReads.length,1);
 const wrong=structuredClone(criterion);wrong.verificationSpec.equals.body[1]='실행하지 않은 요구';assert.equal(verify(wrong).passed,false);
 const dimensions=structuredClone(criterion);dimensions.verificationSpec.height=800;assert.equal(verify(dimensions).passed,false);
 assert.equal(verify(criterion,{beforeAccess:()=>{throw Error('revoked');}}).passed,false);
 const original=await readFile(card.path);await writeFile(card.path,'actual content changed');
 assert.equal(verify().passed,false);assert.equal((await verifyArtifactLayoutCurrent({executionResult,allowedRoots:[root]})).passed,false);
 // A new file hash does not renew an old semantic proof.
 observation.artifacts[0].contentSha256=sha('actual content changed');
 assert.ok(verify().reasons.includes('criterion-layout-proof-digest-unbound'));
 await writeFile(card.path,original);
 const outside=await mkdtemp(join(tmpdir(),'jarvis-g-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
 assert.equal((await verifyArtifactLayoutCurrent({executionResult,allowedRoots:[outside]})).passed,false);
});
