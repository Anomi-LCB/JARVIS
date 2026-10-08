import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {publishHancomRenderDirectory} from '../apps/pc-agent/src/adapters/hwpx/native-pdf-renderer.js';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'jarvis-hancom-final-fence-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'source.hwpx'),scratch=join(root,'.stage'),destination=join(root,'render');
 await writeFile(source,'original');await mkdir(scratch);await writeFile(join(scratch,'manifest.json'),'evidence');
 return {source,scratch,destination,expectedSha256:createHash('sha256').update('original').digest('hex')};
}
test('late authority revocation preserves stage and publishes nothing',async t=>{
 const f=await fixture(t);let calls=0;
 const fence=()=>{if(++calls===2)throw Object.assign(new Error('revoked'),{code:'AUTHORITY_REVOKED'});};
 fence(); // earlier renderer check before asynchronous cleanup
 await assert.rejects(publishHancomRenderDirectory({...f,beforePublish:fence}),{code:'AUTHORITY_REVOKED'});
 assert.equal(calls,2);await assert.rejects(readFile(join(f.destination,'manifest.json')),{code:'ENOENT'});
 assert.equal(await readFile(join(f.scratch,'manifest.json'),'utf8'),'evidence');
});
test('cancellation during final authority check prevents publication',async t=>{
 const f=await fixture(t),controller=new AbortController();
 await assert.rejects(publishHancomRenderDirectory({...f,signal:controller.signal,beforePublish:()=>controller.abort()}),{code:'HANCOM_RENDER_CANCELLED'});
 await assert.rejects(readFile(join(f.destination,'manifest.json')),{code:'ENOENT'});
});
test('source changed during cleanup cannot borrow earlier proof',async t=>{
 const f=await fixture(t);await writeFile(f.source,'changed');
 await assert.rejects(publishHancomRenderDirectory(f),{code:'HANCOM_RENDER_SOURCE_CHANGED'});
});
test('destination created during cleanup is preserved',async t=>{
 const f=await fixture(t);await mkdir(f.destination);await writeFile(join(f.destination,'user.txt'),'user');
 await assert.rejects(publishHancomRenderDirectory(f),{code:'HANCOM_RENDER_OUTPUT_EXISTS'});
 assert.equal(await readFile(join(f.destination,'user.txt'),'utf8'),'user');
});
test('unchanged source and current authority publish actual staged bytes',async t=>{
 const f=await fixture(t);let calls=0;
 await publishHancomRenderDirectory({...f,beforePublish:()=>{calls++;}});
 assert.equal(calls,1);assert.equal(await readFile(join(f.destination,'manifest.json'),'utf8'),'evidence');
 await assert.rejects(readFile(join(f.scratch,'manifest.json')),{code:'ENOENT'});
});
test('source changed while awaiting authority is rejected',async t=>{
 const f=await fixture(t);
 await assert.rejects(publishHancomRenderDirectory({...f,beforePublish:async()=>writeFile(f.source,'late change')}),{code:'HANCOM_RENDER_SOURCE_CHANGED'});
 await assert.rejects(readFile(join(f.destination,'manifest.json')),{code:'ENOENT'});
});
test('destination introduced while awaiting authority is preserved',async t=>{
 const f=await fixture(t);
 await assert.rejects(publishHancomRenderDirectory({...f,beforePublish:async()=>{await mkdir(f.destination);await writeFile(join(f.destination,'user.txt'),'late user');}}),{code:'HANCOM_RENDER_OUTPUT_EXISTS'});
 assert.equal(await readFile(join(f.destination,'user.txt'),'utf8'),'late user');
});
