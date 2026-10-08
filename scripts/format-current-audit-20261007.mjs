import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {normalizeDocBlocks} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {verifyHancomRenderingCurrent} from '../apps/verification/src/hancom-render-verifier.js';
import {verifyOfficeDocumentRenderingCurrent} from '../apps/verification/src/office-document-render-verifier.js';
import {verifyArtifactLayoutCurrent} from '../apps/verification/src/artifact-layout-verifier.js';
const read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/u,''));
const rows=[];
for(const [format,path] of [['hwp','artifacts/hwp-owned-publication-20261007/pilot.json'],['hwpx','artifacts/hwpx-content-20261007/pilot.json']]){
 const pilot=await read(path),native=await read(`artifacts/hancom-native-render-20261007-structure/${format}-result.json`);
 const proof=await verifyHancomRenderingCurrent({executionResult:{targetPath:pilot.result.outputPaths[0],sha256:pilot.result.sha256,document:normalizeDocBlocks(pilot.args),nativeRendering:native.result},allowedRoots:[resolve('artifacts')]});
 assert.equal(proof.passed,true,JSON.stringify(proof));assert.equal(proof.tableStructureVerified,true);assert.equal(proof.pagePixelsMatchPdf,true);
 rows.push({format,source:path,nativeSource:`artifacts/hancom-native-render-20261007-structure/${format}-result.json`,proof});
}
for(const format of ['docx','pdf']){
 const path=`artifacts/office-current-render-20261007/${format}-pilot.json`,pilot=await read(path);
 const proof=await verifyOfficeDocumentRenderingCurrent({executionResult:pilot.result,allowedRoots:[resolve('artifacts/office-current-render-20261007')]});
 assert.equal(proof.passed,true,JSON.stringify(proof));assert.equal(proof.savedStructureVerified,true);assert.equal(proof.requiredPdfTextVerified,true);
 rows.push({format,source:path,proof});
}
const pptPath='artifacts/format-current-ppt-20261007-Yp0xQU/result.json',ppt=await read(pptPath);
const proof=await verifyArtifactLayoutCurrent({executionResult:{...ppt.result.executionResult,toolName:'powerpoint.create'},allowedRoots:[ppt.root]});
assert.equal(proof.passed,true,JSON.stringify(proof));
const g=await read('artifacts/format-current-ppt-20261007-Yp0xQU/current-g.json');assert.equal(g.current.status,'passed');
rows.push({format:'pptx',source:pptPath,proof,currentG:g.current});
await writeFile('artifacts/format-current-render-20261007-audit.json',JSON.stringify({observedAt:new Date().toISOString(),rows,allCurrentPassed:true,scope:'Synthetic generated structured documents on this Windows PC; installed Hancom and Word/PPT COM, current files independently reread; no arbitrary documents, visual taste, other-PC installation or live accounts.'},null,2),{flag:'wx'});
console.log(JSON.stringify({formats:rows.map(r=>r.format),allCurrentPassed:true}));
