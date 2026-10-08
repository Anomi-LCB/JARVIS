import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyTypedCriterion,normalizeVerificationSpec} from '../packages/core/src/mission/criteria-evidence.js';
import {normalizeDocBlocks,WordCreateToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {verifyDocumentTables} from '../apps/pc-agent/src/adapters/word/table-verifier.js';
import {ExecutionResultVerifier} from '../apps/verification/src/verification-runtime.js';
import {readPcAgentRuntimePayload} from '../apps/pc-agent/src/install/pc-agent-runtime-payload.js';
const matrix=[['항목','금액'],['수입','10000'],['지출','2500'],['잔액','7500']];
const xmlFor=table=>'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>'+table.map(row=>'<w:tr>'+row.map(cell=>'<w:tc><w:p><w:r><w:t>'+cell+'</w:t></w:r></w:p></w:tc>').join('')+'</w:tr>').join('')+'</w:tbl></w:body></w:document>';
function save(path,xml,{duplicate=false}={}){
  execFileSync(process.env.JARVIS_PYTHON??'python',['-c','import sys,zipfile,base64\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n z.writestr("word/document.xml",base64.b64decode(sys.argv[2]))\n if sys.argv[3]=="yes": z.writestr("word/document.xml",base64.b64decode(sys.argv[2]))',path,Buffer.from(xml).toString('base64'),duplicate?'yes':'no'],{windowsHide:true,timeout:10000});
}
test('document contracts reject extra/missing/non-array rows before native authoring',()=>{
 for(const rows of [[['a','b','lost']],[['a']],['a']])assert.throws(()=>normalizeDocBlocks({blocks:[{type:'table',columns:['x','y'],rows}]}),{code:'B_DOCUMENT_TABLE_ROW_WIDTH_MISMATCH'});
 assert.deepEqual(normalizeDocBlocks({blocks:[{type:'table',columns:['x','y'],rows:[['','0']]}]}).blocks[0].rows,[['','0']]);
});
test('saved DOCX exact coordinates reject swapped cells, changed numbers and unsupported shapes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-table-oracle-'));const path=join(root,'table.docx');
 try{
  save(path,xmlFor(matrix));assert.equal((await verifyDocumentTables(path,[matrix],{allowedRoots:[root]})).passed,true);
  const swapped=structuredClone(matrix);[swapped[1][1],swapped[2][1]]=[swapped[2][1],swapped[1][1]];
  for(const [xml,reason] of [[xmlFor(swapped),'word-table-cell-value-mismatch'],[xmlFor(matrix.slice(0,3)),'word-table-row-count-mismatch'],[xmlFor(matrix.map(row=>row.slice(0,1))),'word-table-column-count-mismatch'],[xmlFor(matrix).replace('<w:tc>','<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>'),'word-table-merged-or-tracked-unsupported']]){
   save(path,xml);const actual=await verifyDocumentTables(path,[matrix],{allowedRoots:[root]});assert.equal(actual.passed,false);assert.equal(actual.reason,reason);
  }
  save(path,xmlFor(matrix),{duplicate:true});assert.equal((await verifyDocumentTables(path,[matrix],{allowedRoots:[root]})).reason,'word-table-archive-limit');
  save(path,'<!DOCTYPE document [<!ENTITY x "10000">]>'+xmlFor(matrix));
  assert.equal((await verifyDocumentTables(path,[matrix],{allowedRoots:[root]})).reason,'word-table-xml-declaration-denied');
  assert.equal((await verifyDocumentTables(path,[matrix],{allowedRoots:[join(root,'other')]})).passed,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('G rereads current saved table and rejects producer success after cell tampering',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-table-g-'));const path=join(root,'table.docx');
 const verifier=new ExecutionResultVerifier();
 const request={executionResult:{targetPath:path,documentTables:[matrix],status:'success'},evidence:{toolName:'word.create'},capabilityToken:{scope:{allowedPaths:[root]}}};
 try{
  save(path,xmlFor(matrix));let checks=await verifier.verify(request);const check=checks.find(c=>c.checkName==='word_current_table_coordinates_verified');assert.equal(check.status,'passed');
  const proof=check.evidence.proofs[0],sha=value=>createHash('sha256').update(value).digest('hex');
  const ref=file=>({rootIndex:0,relativePath:relative(root,file.path),pathHash:sha(resolve(file.path)),contentSha256:file.sha256,outsideAllowedRoots:false});
  const observation={actionId:'table',outcome:'success',verification:{status:'passed'},artifacts:proof.files.map(ref),data:{artifactLayoutProofs:[{kind:proof.kind,pathHash:sha(resolve(proof.path)),requirementsSha256:proof.requirementsSha256,files:proof.files.map(ref)}]}};
  const criterion={verificationSpec:{version:1,kind:'document.tables',path:'table.docx',equals:[matrix]}};
  assert.deepEqual(normalizeVerificationSpec(criterion.verificationSpec),criterion.verificationSpec);
  const verify=(value=criterion,extras={})=>verifyTypedCriterion({criterion:value,observations:[observation],evidenceActionIds:['table'],allowedRoots:[root],...extras});
  assert.equal(verify().passed,true);const wrong=structuredClone(criterion);wrong.verificationSpec.equals[0][1][1]='99999';assert.equal(verify(wrong).passed,false);
  assert.equal(verify(criterion,{beforeAccess:()=>{throw Error('revoked');}}).passed,false);
  save(path,xmlFor(matrix).replace('10000','99999'));checks=await verifier.verify(request);assert.equal(checks.find(c=>c.checkName==='word_current_table_coordinates_verified').status,'failed');
  assert.equal(verify().passed,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Word existing target preserves original bytes without launching Word',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-table-original-'));const path=join(root,'original.docx');
 try{
  await writeFile(path,'original');const adapter=new WordCreateToolAdapter({allowedRoots:[root]});
  const result=await adapter.execute({path,blocks:[{type:'table',columns:['x'],rows:[['1']]}]});
  assert.equal(result.status,'failed');assert.match(result.error,/original-preserved/);assert.equal(await readFile(path,'utf8'),'original');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('installed payload includes independent Python table helper bytes',async()=>{
 const files=readPcAgentRuntimePayload({root:resolve('.'),daemonConfig:{},serviceManifest:{}});
 const relative='apps/pc-agent/src/adapters/word/verify_tables.py';
 assert.deepEqual(files['pc-agent-runtime/'+relative],await readFile(relative));
});
