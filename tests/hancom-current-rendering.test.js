import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,writeFile,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyHancomRenderingCurrent} from '../apps/verification/src/hancom-render-verifier.js';
import {HwpCreateToolAdapter,normalizeDocBlocks} from '../apps/pc-agent/src/pc-agent-runtime.js';
const sha=b=>createHash('sha256').update(b).digest('hex');

for(const [format,version] of [['hwp','legacy'],['hwpx','legacy'],['hwp','structure'],['hwpx','structure']])test(`independent G rereads actual Hancom ${format}/${version} PDF and verifies exact page pixels`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-g-hancom-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const original=JSON.parse(await readFile(format==='hwp'?'artifacts/hwp-owned-publication-20261007/pilot.json':'artifacts/hwpx-content-20261007/pilot.json','utf8'));
 const native=JSON.parse(await readFile(`artifacts/hancom-native-render-20261007-${version==='legacy'?'unlocked':'structure'}/${format}-result.json`,'utf8')).result;
 const targetPath=join(root,'document.'+format),outputDirectory=join(root,'render');
 await cp(original.result.outputPaths[0],targetPath);await cp(native.outputDirectory,outputDirectory,{recursive:true});
 const executionResult={...original.result,targetPath,document:normalizeDocBlocks(original.args),nativeRendering:{...native,outputDirectory}};
 const verify=result=>verifyHancomRenderingCurrent({executionResult:result,allowedRoots:[root]});
 const positive=await verify(executionResult);assert.equal(positive.passed,true,JSON.stringify(positive));assert.equal(positive.tableStructureVerified,version==='structure');
 const missing=structuredClone(executionResult);missing.document.blocks.push({type:'paragraph',text:'실행하지 않은 추가 요청'});assert.equal((await verify(missing)).passed,false);
 const badSource=structuredClone(executionResult);badSource.sha256='0'.repeat(64);assert.equal((await verify(badSource)).passed,false);
 assert.equal((await verifyHancomRenderingCurrent({executionResult,allowedRoots:[]})).passed,false);
 const manifestPath=join(outputDirectory,'manifest.json'),originalManifest=await readFile(manifestPath),manifest=JSON.parse(originalManifest);
 if(version==='structure'){
  const path=join(outputDirectory,'structure.hwpx'),originalStructure=await readFile(path);
  await promisify(execFile)(process.env.JARVIS_HWPX_PYTHON??'python',['-c',"import sys,zipfile,xml.etree.ElementTree as E; p=sys.argv[1]; z=zipfile.ZipFile(p); entries=[(i,z.read(i.filename)) for i in z.infolist()]; z.close(); ns='{http://www.hancom.co.kr/hwpml/2011/paragraph}'; result=[]\nfor i,b in entries:\n if i.filename=='Contents/section0.xml':\n  r=E.fromstring(b); t=next(r.iter(ns+'tbl')); cells=t.findall(ns+'tr')[1].findall(ns+'tc'); a=next(cells[0].iter(ns+'t')); c=next(cells[1].iter(ns+'t')); a.text,c.text=c.text,a.text; b=E.tostring(r,encoding='utf-8',xml_declaration=True)\n result.append((i,b))\nwith zipfile.ZipFile(p,'w') as out:\n for i,b in result: out.writestr(i,b)",path],{windowsHide:true,timeout:10000});
  const file=manifest.files.find(f=>f.name==='structure.hwpx');file.sha256=sha(await readFile(path));file.size=(await readFile(path)).length;await writeFile(manifestPath,JSON.stringify(manifest));
  const wrong=await verify(executionResult);assert.equal(wrong.passed,false);assert.match(wrong.reason,/hwpx-table-postcondition-failed/);
  await writeFile(path,originalStructure);Object.assign(manifest,JSON.parse(originalManifest));await writeFile(manifestPath,originalManifest);
 }
 manifest.sourceSha256='0'.repeat(64);await writeFile(manifestPath,JSON.stringify(manifest));assert.equal((await verify(executionResult)).passed,false);await writeFile(manifestPath,originalManifest);
 const png=join(outputDirectory,'page-1.png');
 await promisify(execFile)(process.env.JARVIS_HWPX_PYTHON??'python',['-c',"from PIL import Image; import sys; p=sys.argv[1]; im=Image.open(p).convert('RGB'); im.putpixel((0,0),(0,0,0)); im.save(p)",png],{windowsHide:true,timeout:10000});
 manifest.sourceSha256=executionResult.sha256;manifest.files[1].sha256=sha(await readFile(png));manifest.files[1].size=(await readFile(png)).length;await writeFile(manifestPath,JSON.stringify(manifest));
 const changed=await verify(executionResult);assert.equal(changed.passed,false);assert.match(changed.reason,/hancom-page-pixels-do-not-match-pdf/);
});
test('requested rendering outside signed scope is blocked before authoring',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-hancom-scope-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'new.hwpx'),adapter=new HwpCreateToolAdapter({allowedRoots:[root]});
 const result=await adapter.execute({path,verifyRendering:true,title:'제목'},{capabilityToken:{scope:{allowedPaths:[path]}}});
 assert.equal(result.status,'blocked');await assert.rejects(readFile(path),{code:'ENOENT'});
 assert.equal((await adapter.execute({path,verifyRendering:'yes'})).status,'blocked');
});
