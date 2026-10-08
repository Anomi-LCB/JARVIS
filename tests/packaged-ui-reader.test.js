import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createPackagedUiReader} from '../scripts/packaged-ui-reader.mjs';
test('package static reader serves only hashed inventory and rejects tampering, unknown files and traversal',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-package-static-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'control-center-ui'));const contents='<html>packaged only</html>';
 await writeFile(join(root,'control-center-ui/index.html'),contents);await writeFile(join(root,'secret.txt'),'not public');
 await writeFile(join(root,'package-manifest.json'),JSON.stringify({packageId:'jarvis-pc-agent-windows-service',fileIntegrity:{'control-center-ui/index.html':{sha256:createHash('sha256').update(contents).digest('hex')}}}));
 const read=await createPackagedUiReader(root);assert.equal((await read('/')).toString(),contents);
 for(const path of ['/secret.txt','/../secret.txt','/src/ui/unknown.js','/..\\secret.txt'])await assert.rejects(read(path));
 await writeFile(join(root,'control-center-ui/index.html'),'tampered');await assert.rejects(read('/'),/INTEGRITY_FAILED/);
});
