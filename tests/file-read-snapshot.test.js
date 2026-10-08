import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {FileReadTextToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {readTextSnapshot} from '../apps/pc-agent/src/adapters/filesystem/read-text-snapshot.js';

async function fixture(t,source='자료 원문'){
 const root=await mkdtemp(join(tmpdir(),'jarvis-read-snapshot-')),path=join(root,'source.txt');await writeFile(path,source);
 t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 return {root,path,adapter:new FileReadTextToolAdapter({allowedRoots:[root]})};
}
test('malformed ranges are blocked rather than silently substituted or capped',async t=>{
 const f=await fixture(t);
 for(const args of [{offset:-1},{offset:0.5},{offset:NaN},{offset:Infinity},{offset:'1'},{offset:null},{maxChars:0},{maxChars:-1},{maxChars:0.5},{maxChars:50001},{maxChars:'12'},{maxChars:null}]){
  const result=await f.adapter.execute({path:f.path,...args});assert.equal(result.status,'blocked',JSON.stringify(args));assert.equal(result.stdoutPreview,undefined);
 }
});
test('empty, exact byte limit, and EOF are valid while past EOF is explicit',async t=>{
 const f=await fixture(t,'');assert.equal((await f.adapter.execute({path:f.path})).stdoutPreview,'');
 f.adapter.maxFileBytes=4;await writeFile(f.path,'가A');
 const full=await f.adapter.execute({path:f.path});assert.equal(full.status,'success');assert.equal(full.bytes,4);assert.equal(full.stdoutPreview,'가A');
 assert.equal((await f.adapter.execute({path:f.path,offset:2})).stdoutPreview,'');
 const past=await f.adapter.execute({path:f.path,offset:3});assert.equal(past.status,'blocked');assert.ok(past.warnings.includes('text-offset-out-of-range'));
});
test('replacement after open and rewrite after read are rejected with no snapshot returned',async t=>{
 const f=await fixture(t,'original');let checks=0;
 await assert.rejects(readTextSnapshot({path:f.path,maxBytes:1024,checkAllowedPath:async()=>{
  if(++checks===2){await rename(f.path,join(f.root,'old.txt'));await writeFile(f.path,'replacement');}
 }}),{code:'text-source-changed'});
 checks=0;
 await assert.rejects(readTextSnapshot({path:f.path,maxBytes:1024,checkAllowedPath:async()=>{
  if(++checks===3)await writeFile(f.path,'changed after read');
 }}),{code:'text-source-changed'});
 // Handles must close on both rejected paths, including on Windows.
 await rename(f.path,join(f.root,'closed.txt'));
});
test('invalid UTF8 is blocked instead of being reported as a successful replacement-character read',async t=>{
 const f=await fixture(t,Buffer.from([0x61,0xc3,0x28]));const result=await f.adapter.execute({path:f.path});
 assert.equal(result.status,'blocked');assert.ok(result.warnings.includes('text-encoding-invalid'));assert.equal(result.stdoutPreview,undefined);
});
test('file growth after normalization cannot bypass the configured byte budget',async t=>{
 const f=await fixture(t);f.adapter.maxFileBytes=32;
 const normalize=f.adapter.normalize.bind(f.adapter);f.adapter.normalize=async args=>{const normalized=await normalize(args);await writeFile(f.path,'x'.repeat(100));return normalized;};
 const result=await f.adapter.execute({path:f.path});assert.equal(result.status,'blocked');assert.ok(result.warnings.includes('text-file-too-large'));
 assert.equal(result.stdoutPreview,undefined);
});
test('UTF16 range respects complete scalar boundaries and preserves BOM and raw file hash',async t=>{
 const source='\uFEFFA😀한글',f=await fixture(t,source),bytes=await readFile(f.path);
 const first=await f.adapter.execute({path:f.path,maxChars:3});
 assert.equal(first.status,'success');assert.equal(first.stdoutPreview,'\uFEFFA');assert.equal(first.returnedChars,2);assert.equal(first.truncated,true);
 const second=await f.adapter.execute({path:f.path,offset:first.returnedChars,maxChars:2});
 assert.equal(second.status,'success');assert.equal(second.stdoutPreview,'😀');
 const last=await f.adapter.execute({path:f.path,offset:4,maxChars:2});assert.equal(last.stdoutPreview,'한글');assert.equal(last.truncated,false);
 for(const result of [first,second,last])assert.equal(result.contentSha256,createHash('sha256').update(bytes).digest('hex'));
 assert.equal((await f.adapter.execute({path:f.path,offset:3,maxChars:2})).status,'blocked');
 assert.equal((await f.adapter.execute({path:f.path,offset:2,maxChars:1})).status,'blocked');
});
