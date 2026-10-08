import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {HwpCreateToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {verifyHwpxContentCurrent} from '../apps/verification/src/hwpx-content-verifier.js';
import {ExecutionResultVerifier} from '../apps/verification/src/verification-runtime.js';

test('actual allowlisted HWPX creation preserves headers, bullets, exact cells and a header-only table; G re-reads current bytes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-hwpx-content-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const args={path:join(root,'actual.hwpx'),title:'필수 본문',blocks:[
  {type:'heading',text:'절 제목'},
  {type:'bullets',items:['첫 번째 요구','둘째 요구']},
  {type:'table',headers:['이름','수량'],rows:[['품목','42']]},
  {type:'table',columns:['빈 자료 머리글'],rows:[]}
 ]};
 const adapter=new HwpCreateToolAdapter({allowedRoots:[root]});
 const result=await adapter.execute(args,{taskId:'hwpx-content'});
 assert.equal(result.status,'success',JSON.stringify(result));
 assert.equal(result.evidence.hwpx.tableCount,2);
 assert.equal(result.evidence.hwpx.rendering.status,'unverified');
 const verify=executionResult=>verifyHwpxContentCurrent({executionResult,allowedRoots:[root]});
 const proof=await verify(result);assert.equal(proof.passed,true,JSON.stringify(proof));
 assert.equal(proof.rendering.status,'unverified');
 const checks=await new ExecutionResultVerifier().verify({executionResult:result,evidence:{toolName:'hwp.create'},capabilityToken:{scope:{allowedPaths:[root]}}});
 assert.equal(checks.find(c=>c.checkName==='hwpx_current_content_structure_verified').status,'passed');
 for(const change of [doc=>doc.blocks[1].items.push('누락된 요구'),doc=>doc.blocks[2].columns.reverse(),doc=>doc.blocks[2].rows[0].reverse(),doc=>doc.blocks.pop()]){
  const wrong=structuredClone(result);change(wrong.hwpxDocument);assert.equal((await verify(wrong)).passed,false);
 }
 assert.equal((await verifyHwpxContentCurrent({executionResult:result,allowedRoots:[]})).passed,false);
 const original=await readFile(result.targetPath);await writeFile(result.targetPath,'changed');
 assert.equal((await verify(result)).passed,false);
 await writeFile(result.targetPath,original);
 // Corrupt an isolated test document: all words still exist, but cells move.
 // A refreshed producer hash must not turn misplaced values into success.
 await promisify(execFile)(process.env.JARVIS_HWPX_PYTHON??'python',['-c',
  "import sys,zipfile,xml.etree.ElementTree as E; p=sys.argv[1]; z=zipfile.ZipFile(p); entries=[(i,z.read(i.filename)) for i in z.infolist()]; z.close(); ns='{http://www.hancom.co.kr/hwpml/2011/paragraph}'; result=[]\nfor i,b in entries:\n if i.filename=='Contents/section0.xml':\n  r=E.fromstring(b); t=next(r.iter(ns+'tbl')); cells=t.findall(ns+'tr')[1].findall(ns+'tc'); a=next(cells[0].iter(ns+'t')); c=next(cells[1].iter(ns+'t')); a.text,c.text=c.text,a.text; b=E.tostring(r,encoding='utf-8',xml_declaration=True)\n result.append((i,b))\nwith zipfile.ZipFile(p,'w') as out:\n for i,b in result: out.writestr(i,b)",result.targetPath],{windowsHide:true,timeout:20000});
 const dishonest={...result,sha256:createHash('sha256').update(await readFile(result.targetPath)).digest('hex')};
 assert.equal((await verify(dishonest)).passed,false);
 await writeFile(result.targetPath,original);
 const overwrite=await adapter.execute(args,{taskId:'duplicate'});assert.equal(overwrite.status,'blocked');
 assert.deepEqual(await readFile(result.targetPath),original);
});
