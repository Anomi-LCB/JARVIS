import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {readChatGptExportFile,exportCrc32,exportFileLimits} from '../packages/shared/src/chatgpt-export-file.js';
export function zipFixture(files,{stored=false}={}){
 const result=spawnSync('python',['-X','utf8','-c',"import sys,json,zipfile,io,base64\nx=json.load(sys.stdin);b=io.BytesIO()\nwith zipfile.ZipFile(b,'w',compression=zipfile.ZIP_STORED if x['stored'] else zipfile.ZIP_DEFLATED) as z:\n for name,value in x['files']:z.writestr(name,value)\nprint(base64.b64encode(b.getvalue()).decode())"],{input:JSON.stringify({files,stored}),encoding:'utf8',maxBuffer:100*1024*1024});
 assert.equal(result.status,0,result.stderr);return Buffer.from(result.stdout.trim(),'base64');
}
const data=()=>[{id:'chosen',title:'선택할 대화',current_node:'m1',mapping:{m1:{id:'m1',parent:null,message:{id:'m1',author:{role:'user'},create_time:1790985600,content:{content_type:'text',parts:['선택한 연구 자료']}}}}},{id:'excluded',title:'제외할 대화',private:'NEVER_IMPORT',padding:'p'.repeat(5*1024*1024)}];
test('standard Python deflate/store ZIP and plain >4MB JSON preserve raw source hash without extracting unrelated contents',async()=>{
 const text=JSON.stringify(data());
 for(const stored of [false,true]){const bytes=zipFixture([['conversations.json',text],['user.json','ACCOUNT_PRIVATE'],['chat.html','<script>throw 1</script>']],{stored});
  const parsed=await readChatGptExportFile(bytes,{name:'export.zip'});assert.deepEqual(parsed.document,data());assert.equal(parsed.sourceBytesHash,createHash('sha256').update(bytes).digest('hex'));assert.deepEqual(parsed.entryNames,['conversations.json']);assert.equal(parsed.executionAuthority,false);}
 const bytes=Buffer.from(text),parsed=await readChatGptExportFile(bytes);assert.equal(parsed.document.length,2);assert.equal(parsed.format,'json');
 assert.equal(exportCrc32(Buffer.from('123456789')),0xcbf43926);
});
test('numbered JSON ZIP combines unique IDs and rejects ambiguous base/mixed or duplicate IDs',async()=>{
 const files=[['conversations-001.json','[{"id":"one"}]'],['conversations-002.json','[{"id":"two"}]']];
 assert.deepEqual((await readChatGptExportFile(zipFixture(files))).document.map(c=>c.id),['one','two']);
 for(const extra of [['conversations.json','[]'],['conversations-003.json','[{"id":"one"}]']])await assert.rejects(readChatGptExportFile(zipFixture([...files,extra])));
});
test('ZIP duplicate/path traversal/missing conversation and invalid JSON are refused as a whole',async()=>{
 for(const files of [[['../conversations.json','[]']],[['conversations.json','[]'],['conversations.json','[]']],[['user.json','{}']],[['conversations.json','{broken']],[['conversations.json','{}']]])
  await assert.rejects(readChatGptExportFile(zipFixture(files)));
});
test('CRC/local-name/method/encryption/declared expansion/central bounds corruption cannot be silently imported',async()=>{
 const original=zipFixture([['conversations.json','[{"id":"one"}]']]);const central=original.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
 for(const mutate of [b=>b[30]^=1,b=>{b[14]^=1;b[central+16]^=1;},b=>{b.writeUInt16LE(99,8);b.writeUInt16LE(99,central+10);},b=>{b.writeUInt16LE(1,6);b.writeUInt16LE(1,central+8);},b=>b.writeUInt32LE(exportFileLimits.jsonBytes+1,central+24),b=>b.writeUInt32LE(0xffffffff,b.length-6)]){
  const bytes=Buffer.from(original);mutate(bytes);await assert.rejects(readChatGptExportFile(bytes));
 }
 // A false small expansion is enforced while streaming, not just after allocation.
 const bytes=zipFixture([['conversations.json',' '.repeat(1024*1024)+'[]']]);const c=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes.writeUInt32LE(2,22);bytes.writeUInt32LE(2,c+24);await assert.rejects(readChatGptExportFile(bytes),e=>e.code==='F_CONVERSATION_IMPORT_TOO_LARGE');
});
test('malformed UTF8, excessive JSON bytes and total conversations are blocked',async()=>{
 await assert.rejects(readChatGptExportFile(Uint8Array.of(0xff)));
 await assert.rejects(readChatGptExportFile(new Uint8Array(exportFileLimits.jsonBytes+1)));
 await assert.rejects(readChatGptExportFile(Buffer.from(JSON.stringify(Array.from({length:10001},(_,i)=>({id:String(i)}))))));
});
test('actual ZIP CLI review/commit uses original compressed bytes, imports only selected reference and replays without duplicates',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-zip-export-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'export.zip');
 const bytes=zipFixture([['conversations.json',JSON.stringify(data())],['user.json','UNSELECTED_ACCOUNT']]);writeFileSync(path,bytes);
 const args=['scripts/import-selected-conversations.mjs','--chatgpt-export','--document',path,'--select','chosen','--user','fixture-owner','--workspace',root,'--source-ref','synthetic-zip','--store',join(root,'memory.sqlite')];
 const run=extra=>spawnSync(process.execPath,[...args,...extra],{encoding:'utf8',timeout:20000});const preview=run([]);assert.equal(preview.status,0,preview.stderr);const p=JSON.parse(preview.stdout);assert.equal(p.selectedMessages,1);assert.equal(p.sourceExportHash,createHash('sha256').update(bytes).digest('hex'));assert.ok(!preview.stdout.includes('NEVER_IMPORT'));
 const flags=['--commit','--expected-hash',p.documentHash,'--expected-export-hash',p.sourceExportHash];assert.equal(JSON.parse(run(flags).stdout).imported,1);assert.equal(JSON.parse(run(flags).stdout).replayed,1);
 writeFileSync(path,zipFixture([['conversations.json',JSON.stringify(data())],['user.json','CHANGED_ACCOUNT']]));assert.equal(run(flags).status,1,'same selected contents but changed archive invalidate previous source review');
});
