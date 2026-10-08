import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ArchiveCreateZipToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';

async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),'jarvis-zip-publication-'));
  try {
    const input=join(root,'input.txt'), output=join(root,'output.zip');
    await writeFile(input,'original source');
    const adapter=new ArchiveCreateZipToolAdapter({allowedRoots:[root]});
    await run({root,input,output,adapter});
  } finally {await rm(root,{recursive:true,force:true});}
}
function afterNormalize(adapter,hook) {
  const original=adapter.normalize.bind(adapter);
  adapter.normalize=async args=>{const plan=await original(args);await hook(plan);return plan;};
}
test('late competing output is preserved without overwrite',()=>fixture(async({adapter,input,output,root})=>{
  afterNormalize(adapter,()=>writeFile(output,'competing owner'));
  const result=await adapter.execute({path:output,inputPaths:[input]});
  assert.notEqual(result.status,'success');
  assert.equal(await readFile(output,'utf8'),'competing owner');
  assert.equal((await readdir(root)).some(n=>n.startsWith('.jarvis-zip-stage-')),false);
}));
test('worker failure does not delete a late competing output',()=>fixture(async({adapter,input,output})=>{
  adapter.pythonExecutable='jarvis-missing-python-test-only';
  afterNormalize(adapter,()=>writeFile(output,'competing owner'));
  const result=await adapter.execute({path:output,inputPaths:[input]});
  assert.notEqual(result.status,'success');
  assert.equal(await readFile(output,'utf8'),'competing owner');
}));
test('source changed after normalization cannot produce a successful archive',()=>fixture(async({adapter,input,output})=>{
  afterNormalize(adapter,()=>writeFile(input,'changed source'));
  const result=await adapter.execute({path:output,inputPaths:[input]});
  assert.notEqual(result.status,'success');
  assert.match(result.error,/archive-input-integrity-mismatch/);
  await assert.rejects(readFile(output),{code:'ENOENT'});
}));
test('actual Python archive round trip preserves names and original content hashes',()=>fixture(async({adapter,input,output})=>{
  const result=await adapter.execute({path:output,inputs:[{path:input,archiveName:'자료/입력.txt'}]});
  assert.equal(result.status,'success',JSON.stringify(result));
  assert.equal(result.entries[0].name,'자료/입력.txt');
  assert.match(result.entries[0].sha256,/^[a-f0-9]{64}$/);
  assert.equal(result.entries[0].sha256,result.evidence.inputs[0].sha256);
}));
test('existing output is blocked and left byte-for-byte unchanged',()=>fixture(async({adapter,input,output})=>{
  await writeFile(output,'existing file');
  const result=await adapter.execute({path:output,inputPaths:[input]});
  assert.equal(result.status,'blocked');
  assert.equal(await readFile(output,'utf8'),'existing file');
}));
test('already cancelled execution creates no staging or output',()=>fixture(async({adapter,input,output,root})=>{
  const controller=new AbortController();controller.abort();
  const result=await adapter.execute({path:output,inputPaths:[input]},{},{signal:controller.signal});
  assert.equal(result.status,'failed');assert.equal(result.error,'B_OPERATION_CANCELLED');
  await assert.rejects(readFile(output),{code:'ENOENT'});
  assert.equal((await readdir(root)).some(n=>n.startsWith('.jarvis-zip-stage-')),false);
}));
test('expected source hash mismatch blocks publication',()=>fixture(async({adapter,input,output})=>{
  const result=await adapter.execute({path:output,inputs:[{path:input,sha256:'0'.repeat(64)}]});
  assert.equal(result.status,'blocked');
  await assert.rejects(readFile(output),{code:'ENOENT'});
}));
test('duplicate normalized entry names are blocked',()=>fixture(async({adapter,input,output})=>{
  const result=await adapter.execute({path:output,inputs:[{path:input,archiveName:'FILE.txt'},{path:input,archiveName:'file.txt'}]});
  assert.equal(result.status,'blocked');
  await assert.rejects(readFile(output),{code:'ENOENT'});
}));
test('journal failure after publication preserves output and reports uncertain side effect',()=>fixture(async({adapter,input,output,root})=>{
  adapter.undoJournal={record(){throw new Error('fixture journal unavailable');}};
  const result=await adapter.execute({path:output,inputPaths:[input]});
  assert.equal(result.status,'failed');
  assert.equal(result.uncertain,true);
  assert.deepEqual(result.outputPaths,[output]);
  assert.equal(result.changedItems[0].uncertain,true);
  assert.ok((await readFile(output)).length>4);
  assert.equal((await readdir(root)).some(n=>n.startsWith('.jarvis-zip-stage-')),false);
}));
for(const name of ['../escape.txt','safe/..','C:/escape.txt','a\u0000b','safe//file']) {
  test(`unsafe ZIP entry ${JSON.stringify(name)} is blocked`,()=>fixture(async({adapter,input,output})=>{
    const result=await adapter.execute({path:output,inputs:[{path:input,archiveName:name}]});
    assert.equal(result.status,'blocked');
    assert.ok(result.warnings.some(w=>w.startsWith('invalid-archive-name:')));
  }));
}
