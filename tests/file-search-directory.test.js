import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FileSearchToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';

test('explicit workspace directory is honored without widening configured or token roots',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-search-directory-'));
 try{
  const first=join(root,'first'),second=join(root,'second'),outside=join(root,'outside');
  await Promise.all([first,second,outside].map(p=>mkdir(p)));
  await writeFile(join(first,'target.txt'),'first');await writeFile(join(second,'target.txt'),'second');await writeFile(join(outside,'target.txt'),'outside');
  const adapter=new FileSearchToolAdapter({allowedRoots:[first,second]});
  const args={scope:'workspace',directory:second,query:'target.txt'};
  const found=await adapter.execute(args);assert.equal(found.status,'success');assert.deepEqual(found.matches.map(m=>m.path),[join(second,'target.txt')]);
  assert.equal((await adapter.shadow(args)).root,second);
  assert.deepEqual((await adapter.execute({scope:'workspace',query:'target.txt'})).matches.map(m=>m.path),[join(first,'target.txt')]);
  for(const bad of [outside,'',4,second+'\n'])assert.equal((await adapter.execute({...args,directory:bad})).status,'failed');
  assert.equal((await adapter.execute({...args,scope:'home'})).status,'failed');
  assert.equal((await adapter.execute(args,{capabilityToken:{scope:{allowedPaths:[first]}}})).status,'failed');
  assert.equal((await adapter.execute(args,{capabilityToken:{scope:{allowedPaths:[second]}}})).status,'success');
  await symlink(outside,join(second,'escape'),process.platform==='win32'?'junction':'dir');
  assert.equal((await adapter.execute({...args,directory:join(second,'escape')})).status,'failed');
  assert.deepEqual((await adapter.execute(args)).matches.map(m=>m.path),[join(second,'target.txt')]);
 }finally{await rm(root,{recursive:true,force:true});}
});
