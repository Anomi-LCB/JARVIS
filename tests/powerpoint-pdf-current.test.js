import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PowerPointCreateToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {verifyArtifactLayoutCurrent} from '../apps/verification/src/artifact-layout-verifier.js';
test('actual PowerPoint PDF content is independently re-read and a changed PDF cannot borrow its intact PPTX proof',{skip:process.platform!=='win32'||process.env.JARVIS_NATIVE_POWERPOINT_TEST!=='1',timeout:120000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ppt-pdf-current-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const result=await new PowerPointCreateToolAdapter({allowedRoots:[root]}).execute({path:join(root,'slides.pdf'),outputFormat:'pdf',slides:[{title:'독립 PDF 검증',bullets:['필수 문구 보존'],notes:'발표자 메모'}]});
 assert.equal(result.status,'success',JSON.stringify(result));assert.equal(result.artifactManifest.isPdf,true);
 const verify=()=>verifyArtifactLayoutCurrent({executionResult:{...result,toolName:'powerpoint.create'},allowedRoots:[root]});
 const positive=await verify();assert.equal(positive.passed,true,JSON.stringify(positive));
 assert.ok(positive.proofs[0].files.some(file=>file.path===result.targetPath));
 await writeFile(result.targetPath,Buffer.from('%PDF-1.4\ninvalid changed PDF\n%%EOF\n'));
 const changed=await verify();assert.equal(changed.passed,false);
});
