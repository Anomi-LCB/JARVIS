import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {FileReadTextToolAdapter,classifyTextReadFailure} from '../apps/pc-agent/src/pc-agent-runtime.js';

test('read preflight separates scope, absence and realpath escape without revealing outside existence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-read-reasons-'));
 try{
  const allowed=join(root,'allowed'),outside=join(root,'outside');await mkdir(allowed);await mkdir(outside);
  const source=join(allowed,'source.txt');await writeFile(source,'synthetic');await writeFile(join(outside,'present.txt'),'outside synthetic');
  await symlink(outside,join(allowed,'escape'),process.platform==='win32'?'junction':'dir');
  const adapter=new FileReadTextToolAdapter({allowedRoots:[allowed]});
  for(const name of ['present.txt','absent.txt']){
   assert.deepEqual((await adapter.shadow({path:join(outside,name)})).warnings,['text-path-outside-allowed-roots']);
  }
  assert.deepEqual((await adapter.shadow({path:join(allowed,'missing.txt')})).warnings,['text-file-missing']);
  assert.deepEqual((await adapter.shadow({path:join(allowed,'escape','present.txt')})).warnings,['text-path-realpath-outside-allowed-roots']);
  assert.equal((await adapter.execute({path:source})).status,'success');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('permission and unknown filesystem errors cannot masquerade as file absence or leak provider messages',()=>{
 for(const code of ['EACCES','EPERM'])assert.equal(classifyTextReadFailure({code,message:'sensitive path'}),'text-file-permission-denied');
 for(const code of ['EIO','ENOTDIR',undefined])assert.equal(classifyTextReadFailure({code,message:'outside-allowed-roots:private'}),'text-file-unreadable');
});
