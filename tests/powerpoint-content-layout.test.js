import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,copyFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {PowerPointCreateToolAdapter,UndoJournal} from '../apps/pc-agent/src/pc-agent-runtime.js';
const run=promisify(execFile),native={skip:process.platform!=='win32',timeout:60000};
test('presentation rejects malformed slides instead of silently removing requirements',()=>{
 const adapter=new PowerPointCreateToolAdapter();
 assert.throws(()=>adapter.normalizeSlides({slides:[null]}),/powerpoint-slide-input-invalid/);
 assert.throws(()=>adapter.normalizeSlides({slides:[{title:'제목',bullets:[null]}]}),/powerpoint-slide-input-invalid/);
 const normalized=adapter.normalizeSlides({slides:[{title:'',bullets:[],notes:'메모만 있는 장'}]});assert.equal(normalized.slides.length,1);assert.equal(normalized.slides[0].notes,'메모만 있는 장');
});
test('real saved PPTX verifies title body notes, native bounds and rendered ink; blank raster is rejected',native,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ppt-content-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const deck={slides:[{title:'전체 문구 확인',bullets:['필수 항목 하나','필수 항목 둘','개인 자료 보호'],notes:'발표 메모 보존'}]};
 const outputPath=join(root,'presentation.pptx');
 const result=await new PowerPointCreateToolAdapter({allowedRoots:[root],undoJournal:new UndoJournal({journalPath:join(root,'undo.jsonl')})}).execute({path:outputPath,...deck},{taskId:'ppt-content'});
 assert.equal(result.status,'success',JSON.stringify(result));assert.equal(result.contentVerification.status,'verified');
 assert.equal(result.contentVerification.slides[0].exactContent,true);assert.equal(result.evidence.presentation.actualRenderingExecuted,true);assert.equal(result.evidence.presentation.jobAssigned,true);
 assert.equal(result.contentVerification.pixelTextRecognition,'not-evaluated');
 for(const file of await readdir(result.renderDirectory))await copyFile(join(result.renderDirectory,file),join(root,file));
 const requestPath=join(root,'request.json');await writeFile(requestPath,JSON.stringify({staging:root,deck}),'utf8');
 const python=process.env.JARVIS_PYTHON??'python';
 const verifier=fileURLToPath(new URL('../apps/pc-agent/src/adapters/powerpoint/verify_presentation.py',import.meta.url));
 await run(python,['-c','from PIL import Image;import sys;Image.new("RGB",(1600,900),(255,255,255)).save(sys.argv[1])',join(root,'slide-1.png')],{windowsHide:true});
 await assert.rejects(run(python,[verifier,requestPath],{encoding:'utf8',windowsHide:true}),error=>JSON.parse(error.stdout).reason==='presentation-render-text-missing');
 // Restore raster, mutate actual saved body and update only the native hash:
 // the independent OOXML content oracle must still reject the false claim.
 await copyFile(join(result.renderDirectory,'slide-1.png'),join(root,'slide-1.png'));
 const originalPackage=await readFile(outputPath);
 const mutate='import sys,zipfile,hashlib,json,os; p=sys.argv[1]; z=zipfile.ZipFile(p); entries={n:z.read(n) for n in z.namelist()};z.close(); entries["ppt/slides/slide1.xml"]=entries["ppt/slides/slide1.xml"].replace(sys.argv[2].encode(),sys.argv[3].encode(),1);z=zipfile.ZipFile(p,"w",zipfile.ZIP_DEFLATED);[z.writestr(n,b) for n,b in entries.items()];z.close(); r=os.path.join(os.path.dirname(p),"native-report.json"); d=json.load(open(r,encoding="utf-8-sig"));d["sourceSha256"]=hashlib.sha256(open(p,"rb").read()).hexdigest();json.dump(d,open(r,"w",encoding="utf-8"),ensure_ascii=False)';
 await run(python,['-c',mutate,outputPath,'x="609600"','x="0"'],{windowsHide:true});
 await assert.rejects(run(python,[verifier,requestPath],{encoding:'utf8',windowsHide:true}),error=>JSON.parse(error.stdout).reason==='presentation-ooxml-layout-mismatch');
 await writeFile(outputPath,originalPackage);
 await run(python,['-c',mutate,outputPath,'필수 항목 하나','조작된 본문'],{windowsHide:true});
 await assert.rejects(run(python,[verifier,requestPath],{encoding:'utf8',windowsHide:true}),error=>JSON.parse(error.stdout).reason==='presentation-ooxml-body-mismatch');
});
test('native overflowing body fails with no published presentation',native,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ppt-overflow-'));t.after(()=>rm(root,{recursive:true,force:true}));const outputPath=join(root,'overflow.pptx');
 const result=await new PowerPointCreateToolAdapter({allowedRoots:[root]}).execute({path:outputPath,slides:[{title:'빠짐없는 요구',bullets:Array(60).fill('넘치는 본문을 임의로 삭제하면 안 됩니다'),notes:''}]});
 assert.equal(result.status,'failed');assert.match(result.error,/powerpoint-text-overflow/);assert.deepEqual(result.outputPaths,[]);
 await assert.rejects(readFile(outputPath),{code:'ENOENT'});assert.equal((await readdir(root)).length,0);
});
test('existing presentation is preserved instead of becoming false successful output',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ppt-existing-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'original.pptx');await writeFile(path,'user-original');
 const result=await new PowerPointCreateToolAdapter({allowedRoots:[root]}).execute({path,slides:[{title:'새 제목',bullets:[]}]});
 assert.equal(result.status,'failed');assert.match(result.error,/powerpoint-target-exists/);assert.equal(await readFile(path,'utf8'),'user-original');
});
