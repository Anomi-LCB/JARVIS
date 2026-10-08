import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyDocumentParagraphs} from '../apps/pc-agent/src/adapters/word/table-verifier.js';
import {normalizeVerificationSpec} from '../packages/core/src/mission/criteria-evidence.js';
const expected=['제목','첫 문단','둘째 문단'];
test('paragraph criterion preserves exact order and whitespace',()=>{
 const spec={version:1,kind:'document.paragraphs',path:'report.docx',equals:expected};assert.deepEqual(normalizeVerificationSpec(spec),spec);
 assert.throws(()=>normalizeVerificationSpec({...spec,equals:[]}));
});
test('saved paragraph oracle rejects order changes, duplication, whitespace loss and tracked content',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-paragraph-test-')),path=join(root,'report.docx');
 const save=values=>{const xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+values.map(v=>'<w:p><w:r><w:t>'+v+'</w:t></w:r></w:p>').join('')+'<w:p/></w:body></w:document>';
 execFileSync('python',['-c','import sys,zipfile,base64\nwith zipfile.ZipFile(sys.argv[1],"w") as z:z.writestr("word/document.xml",base64.b64decode(sys.argv[2]))',path,Buffer.from(xml).toString('base64')],{windowsHide:true});};
 try{
  save(expected);assert.equal((await verifyDocumentParagraphs(path,expected,{allowedRoots:[root]})).passed,true);
  for(const values of [[expected[0],expected[2],expected[1]],[...expected,expected[1]],['제목','첫문단','둘째 문단'],['제목','<w:ins>첫 문단</w:ins>','둘째 문단']]){
   save(values);assert.equal((await verifyDocumentParagraphs(path,expected,{allowedRoots:[root]})).passed,false);
  }
  save(expected);assert.equal((await verifyDocumentParagraphs(path,expected,{allowedRoots:[join(root,'other')]})).passed,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
